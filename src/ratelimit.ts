import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as vscode from 'vscode';

// ─── Types ───

export interface RateLimitInfo {
  util5h: number;     // 0-100
  util7d: number;     // 0-100
  reset5h: string;    // ISO 8601
  reset7d: string;    // ISO 8601
  fetchedAt: number;  // Date.now()
}

interface Credentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // Unix ms
  };
}

// ─── Constants ───

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const MIN_FETCH_INTERVAL_MS = 60_000;
const BACKOFF_MS = 300_000;
const TOKEN_EXPIRY_MARGIN_MS = 300_000; // 5min margin, same as Claude Code

// ─── State ───

let cached: RateLimitInfo | null = null;
let lastFetchMs = 0;
let backoffUntil = 0;
let inFlight: Promise<RateLimitInfo | null> | null = null;
let lastCredMtimeMs = 0;
let lastAccessToken = '';
let lastDiskAccessToken = '';
let credWatcher: fs.FSWatcher | null = null;
let fetchGeneration = 0;

// ─── Helpers ───

function readCredentials(): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  } catch { return null; }
}

function isTokenExpired(expiresAt: number | undefined): boolean {
  if (!expiresAt) { return false; } // unknown expiry → try anyway
  return Date.now() + TOKEN_EXPIRY_MARGIN_MS >= expiresAt;
}

/** Read CLAUDE_CODE_OAUTH_TOKEN from env, trimming whitespace and rejecting control characters.
 *  Returns empty string if the value is absent, blank, or contains \r / \n. */
function readEnvToken(): string {
  const raw = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!raw) { return ''; }
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) { return ''; }
  return trimmed;
}

function httpsRequest(url: string, options: https.RequestOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      // Without this the promise can hang: a response stream that errors after headers
      // (premature close, malformed chunked encoding) emits neither 'end' here nor,
      // in some cases, 'error' on the request. inFlight would then never clear and
      // every later fetchRateLimits() would return the same pending promise until the
      // extension restarts. Settling twice is harmless — the first call wins.
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function fetchUsage(token: string): Promise<RateLimitInfo> {
  const data = await httpsRequest(USAGE_URL, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': OAUTH_BETA,
    },
  });
  const resp = JSON.parse(data);
  return {
    util5h: resp.five_hour?.utilization ?? 0,
    util7d: resp.seven_day?.utilization ?? 0,
    reset5h: resp.five_hour?.resets_at ?? '',
    reset7d: resp.seven_day?.resets_at ?? '',
    fetchedAt: Date.now(),
  };
}

// ─── Credentials watch ───

let onCredentialsRefreshed: (() => void) | null = null;

/** Start watching .credentials.json for changes.
 *  When Claude Code refreshes the token, we detect the new file and clear backoff. */
export function startCredentialsWatch(onRefreshed?: () => void): void {
  if (credWatcher) { return; }
  if (onRefreshed) { onCredentialsRefreshed = onRefreshed; }

  // Record initial state
  const cred = readCredentials();
  lastDiskAccessToken = cred?.claudeAiOauth?.accessToken || '';
  try { lastCredMtimeMs = fs.statSync(CRED_PATH).mtimeMs; } catch { /* ignore */ }

  // Try watching the file directly; fall back to parent dir if file doesn't exist yet
  try {
    credWatcher = fs.watch(CRED_PATH, () => { onCredentialsChanged(); });
  } catch {
    try {
      const credDir = path.dirname(CRED_PATH);
      credWatcher = fs.watch(credDir, (_: string, filename: string | null) => {
        if (filename === path.basename(CRED_PATH)) { onCredentialsChanged(); }
      });
    } catch { /* ~/.claude doesn't exist */ }
  }
}

export function stopCredentialsWatch(): void {
  if (credWatcher) { credWatcher.close(); credWatcher = null; }
}

function onCredentialsChanged(): void {
  try {
    const stat = fs.statSync(CRED_PATH);
    if (stat.mtimeMs === lastCredMtimeMs) { return; }
    lastCredMtimeMs = stat.mtimeMs;

    const cred = readCredentials();
    const newToken = cred?.claudeAiOauth?.accessToken || '';
    if (newToken && newToken !== lastDiskAccessToken) {
      lastDiskAccessToken = newToken;
      // Skip backoff reset and notification when env token is active
      const useEnvOauthToken = vscode.workspace.getConfiguration('claudeCodeVitals').get<boolean>('useEnvOauthToken', false);
      if (useEnvOauthToken && readEnvToken()) { return; }
      // Claude Code refreshed the disk token — clear backoff and notify
      backoffUntil = 0;
      if (onCredentialsRefreshed) { onCredentialsRefreshed(); }
    }
  } catch { /* ignore */ }
}

// ─── Public API ───

export function getCachedRateLimits(): RateLimitInfo | null {
  return cached;
}

export async function fetchRateLimits(force?: boolean): Promise<RateLimitInfo | null> {
  const now = Date.now();

  // Deduplicate concurrent requests (must be before interval check)
  if (!force && inFlight) { return inFlight; }

  const useEnvOauthToken = vscode.workspace.getConfiguration('claudeCodeVitals').get<boolean>('useEnvOauthToken', false);
  let token = '';
  let expiresAt: number | undefined;
  if (useEnvOauthToken) {
    token = readEnvToken();
  }

  if (!token) {
    const cred = readCredentials();
    const oauth = cred?.claudeAiOauth;
    token = oauth?.accessToken || '';
    expiresAt = oauth?.expiresAt;
  }
  if (!token) { return cached; }

  const tokenChanged = token !== lastAccessToken;
  if (tokenChanged) { backoffUntil = 0; }

  // Rate limiting: skip if within interval or backoff unless the active token changed.
  if (!force && !tokenChanged && now - lastFetchMs < MIN_FETCH_INTERVAL_MS) { return cached; }
  if (!force && now < backoffUntil) { return cached; }

  // Skip API call if token is expired or expiring soon — wait for Claude Code to refresh
  if (isTokenExpired(expiresAt)) { return cached; }

  // Track token for change detection
  if (tokenChanged) { lastAccessToken = token; }

  // Update lastFetchMs only when actually starting a fetch
  lastFetchMs = now;

  const myGeneration = ++fetchGeneration;
  const promise = fetchUsage(token).then(info => {
    if (myGeneration === fetchGeneration) {
      cached = info;
      inFlight = null;
    }
    return info;
  }).catch(() => {
    if (myGeneration === fetchGeneration) {
      backoffUntil = Date.now() + BACKOFF_MS;
      inFlight = null;
    }
    return cached;
  });
  inFlight = promise;
  return promise;
}

export function formatResetTime(isoTimestamp: string): string {
  if (!isoTimestamp) { return '-'; }
  try {
    const reset = new Date(isoTimestamp);
    const diff = reset.getTime() - Date.now();
    if (diff <= 0) { return '-'; }
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) { return '<1m'; }
    if (minutes < 60) { return minutes + 'm'; }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  } catch { return '-'; }
}
