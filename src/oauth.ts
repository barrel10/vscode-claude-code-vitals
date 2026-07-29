import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

export interface Credentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

export interface ResolvedOauthToken {
  token: string;
  expiresAt: number | undefined;
}

export const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
export const TOKEN_EXPIRY_MARGIN_MS = 300_000;

export function readCredentials(): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  } catch { return null; }
}

export function readEnvToken(): string {
  const raw = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!raw) { return ''; }
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) { return ''; }
  return trimmed;
}

export function isTokenExpired(expiresAt: number | undefined): boolean {
  if (!expiresAt) { return false; }
  return Date.now() + TOKEN_EXPIRY_MARGIN_MS >= expiresAt;
}

export function resolveOauthToken(useEnvToken: boolean): ResolvedOauthToken {
  let token = useEnvToken ? readEnvToken() : '';
  let expiresAt: number | undefined;
  if (!token) {
    const oauth = readCredentials()?.claudeAiOauth;
    token = oauth?.accessToken || '';
    expiresAt = oauth?.expiresAt;
  }
  return { token, expiresAt };
}

export function httpsRequest(url: string, options: https.RequestOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
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
