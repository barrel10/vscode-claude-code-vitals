import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

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

// ─── State ───

let cached: RateLimitInfo | null = null;
let lastFetchMs = 0;
let backoffUntil = 0;
let inFlight: Promise<RateLimitInfo | null> | null = null;

// ─── Helpers ───

// Read-only access to credentials. Never write back.
// Token refresh is Claude Code's responsibility — we just read and retry on failure.
function readAccessToken(): string | null {
  try {
    const cred: Credentials = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    return cred?.claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

function httpsRequest(url: string, options: https.RequestOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
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

// ─── Public API ───

export function getCachedRateLimits(): RateLimitInfo | null {
  return cached;
}

export async function fetchRateLimits(): Promise<RateLimitInfo | null> {
  const now = Date.now();

  // Deduplicate concurrent requests (must be before interval check)
  if (inFlight) { return inFlight; }

  // Rate limiting: skip if within interval or backoff (regardless of cached state)
  if (now - lastFetchMs < MIN_FETCH_INTERVAL_MS) { return cached; }
  if (now < backoffUntil) { return cached; }

  lastFetchMs = now;

  const token = readAccessToken();
  if (!token) { return cached; }

  inFlight = fetchUsage(token).then(info => {
    cached = info;
    inFlight = null;
    return info;
  }).catch(() => {
    // Token expired or invalid — backoff and wait for Claude Code to refresh it
    backoffUntil = Date.now() + BACKOFF_MS;
    inFlight = null;
    return cached;
  });

  return inFlight;
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
