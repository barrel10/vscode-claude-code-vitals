import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

// ─── Types ───

interface CachedModel {
  maxInputTokens: number;
  maxOutputTokens: number | null;
}

interface ModelsCacheFile {
  fetchedAt: number;
  models: Record<string, CachedModel>;
}

interface Credentials {
  claudeAiOauth?: {
    accessToken: string;
    expiresAt?: number;
  };
}

// ─── Constants ───

const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';
const CACHE_FILE_NAME = 'model-windows.json';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BACKOFF_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

// ─── State ───

let cachePath = '';
let cached: ModelsCacheFile = { fetchedAt: 0, models: {} };
let backoffUntil = 0;
let inFlight: Promise<boolean> | null = null;
let _log: (msg: string) => void = () => {};

export function setModelsApiLogger(logger: (msg: string) => void): void { _log = logger; }

// ─── Helpers ───

export function normalizeModelId(model: string): string {
  // Strip an optional [1m]/(1m) suffix (with any leading whitespace, e.g. "opus [1m]")
  // and a trailing -YYYYMMDD date stamp, then trim so model-id comparisons are exact.
  return model.trim().replace(/\s*[\[(]1[mM][\])]$/, '').replace(/-\d{8}$/, '').trim();
}

function readCache(filePath: string): ModelsCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Number.isFinite(parsed?.fetchedAt) || !parsed?.models || typeof parsed.models !== 'object') {
      return { fetchedAt: 0, models: {} };
    }
    const models: Record<string, CachedModel> = {};
    for (const [id, value] of Object.entries(parsed.models)) {
      const item = value as CachedModel;
      if (Number.isFinite(item?.maxInputTokens) && item.maxInputTokens > 0) {
        models[id] = {
          maxInputTokens: item.maxInputTokens,
          maxOutputTokens: typeof item.maxOutputTokens === 'number' && Number.isFinite(item.maxOutputTokens) && item.maxOutputTokens > 0 ? item.maxOutputTokens : null,
        };
      }
    }
    // A future fetchedAt (clock rewind, corrupted cache) must not read as fresh: normalize
    // to 0 so the 24h interval check in refreshModelsApi treats it as due for refresh.
    const fetchedAt = parsed.fetchedAt > Date.now() ? 0 : parsed.fetchedAt;
    return { fetchedAt, models };
  } catch { return { fetchedAt: 0, models: {} }; }
}

function writeCache(): void {
  if (!cachePath) { return; }
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cached), 'utf8');
  } catch { /* memory cache remains available */ }
}

function readEnvToken(): string {
  const raw = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!raw) { return ''; }
  const token = raw.trim();
  return token && !/[\r\n]/.test(token) ? token : '';
}

function readCredentials(): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
  } catch { return null; }
}

function isTokenExpired(expiresAt: number | undefined): boolean {
  return expiresAt !== undefined && Date.now() + TOKEN_EXPIRY_MARGIN_MS >= expiresAt;
}

function httpsRequest(url: string, options: https.RequestOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, options, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) { resolve(body); }
        else { reject(new Error(`HTTP ${response.statusCode}`)); }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(10_000, () => { request.destroy(); reject(new Error('timeout')); });
    request.end();
  });
}

// Compares only maxInputTokens: maxOutputTokens has no reading consumer, so a change to
// it alone should not trigger clearSessionCache() + a full session reparse.
function sameContextWindows(a: Record<string, CachedModel>, b: Record<string, CachedModel>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) { return false; }
  return aKeys.every(key => a[key].maxInputTokens === b[key]?.maxInputTokens);
}

function parseModels(body: string): Record<string, CachedModel> {
  const response = JSON.parse(body);
  const models: Record<string, CachedModel> = {};
  if (!Array.isArray(response?.data)) { return models; }
  const items: { id: string; value: CachedModel }[] = [];
  for (const item of response.data) {
    if (typeof item?.id !== 'string' || !Number.isFinite(item.max_input_tokens) || item.max_input_tokens <= 0) { continue; }
    items.push({
      id: item.id,
      value: {
        maxInputTokens: item.max_input_tokens,
        maxOutputTokens: Number.isFinite(item.max_tokens) && item.max_tokens > 0 ? item.max_tokens : null,
      },
    });
  }
  // Pass 1: raw IDs always win, regardless of order.
  for (const { id, value } of items) { models[id] = value; }
  // Pass 2: normalized keys, first-come priority among the normalized forms (first entry
  // in `data` wins), and never overwriting a raw ID. First-come priority assumes the
  // Models API returns newer models first in `data` — an observed-behavior assumption,
  // not a documented API contract.
  const rawIds = new Set(items.map(entry => entry.id));
  for (const { id, value } of items) {
    const normalized = normalizeModelId(id);
    if (!rawIds.has(normalized) && !(normalized in models)) { models[normalized] = value; }
  }
  return models;
}

// ─── Public API ───

export function initializeModelsApi(globalStoragePath: string): string {
  cachePath = path.join(globalStoragePath, CACHE_FILE_NAME);
  cached = readCache(cachePath);
  return cachePath;
}

/** Resolved cache file path. Not called from the extension itself — the path is an
 *  absolute one containing the OS user name, so it is only written to the log on the
 *  failure path. This accessor exists for the out-of-repo verification scripts. */
export function getModelsApiCachePath(): string {
  return cachePath;
}


export function getMaxInputTokens(model: string): number | null {
  const value = cached.models[model] ?? cached.models[normalizeModelId(model)];
  return value && Number.isFinite(value.maxInputTokens) && value.maxInputTokens > 0 ? value.maxInputTokens : null;
}

export function clearModelsApiBackoff(): void {
  backoffUntil = 0;
}

export async function refreshModelsApi(useEnvOauthToken: boolean, force = false): Promise<boolean> {
  const now = Date.now();
  if (inFlight) { return inFlight; }
  if (!force && now - cached.fetchedAt < REFRESH_INTERVAL_MS) { return false; }
  if (!force && now < backoffUntil) { return false; }

  let token = useEnvOauthToken ? readEnvToken() : '';
  let expiresAt: number | undefined;
  if (!token) {
    const oauth = readCredentials()?.claudeAiOauth;
    token = oauth?.accessToken || '';
    expiresAt = oauth?.expiresAt;
  }
  if (!token || isTokenExpired(expiresAt)) {
    _log('[models-api] no usable token (missing or expiring soon); skipping refresh');
    return false;
  }

  inFlight = httpsRequest(MODELS_URL, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
  }).then(body => {
    const models = parseModels(body);
    if (Object.keys(models).length === 0) { throw new Error('No valid models'); }
    const changed = !sameContextWindows(cached.models, models);
    cached = { fetchedAt: Date.now(), models };
    writeCache();
    backoffUntil = 0;
    _log(`[models-api] refresh succeeded: ${Object.keys(models).length} models, changed=${changed}`);
    return changed;
  }).catch(err => {
    backoffUntil = Date.now() + BACKOFF_MS;
    _log(`[models-api] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    _log(`[models-api] backing off until ${new Date(backoffUntil).toISOString()}`);
    // Only surfaced on the failure path: this is an absolute path that contains the OS
    // user name, and it is the one thing needed to inspect what the fallback is using.
    _log(`[models-api] cache path: ${cachePath || '(not initialized)'}`);
    return false;
  }).finally(() => { inFlight = null; });
  return inFlight;
}
