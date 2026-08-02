import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getMaxInputTokens, normalizeModelId } from './models-api';

// ─── Types ───

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
}

export interface ClaudeSettings {
  maxTokensOverride: number | null;
  autocompactPct: number;
  contextWindowOverride: number | null;
  settingsModelNormalized: string | null;
  cleanupPeriodDays: number;
  autoCompactWindow?: number | null;
  autoCompactEnabled?: boolean;
  autoCompactWindowEnv?: number | null;
  maxOutputTokensEnv?: number | null;
  disableCompact?: boolean;
  disableAutoCompact?: boolean;
}

export type SessionStatus = 'thinking' | 'waiting' | 'idle' | 'inactive';

// ─── Hook-driven state markers ───

const MONITOR_DIR = path.join(os.homedir(), '.claude', 'ide', 'monitor');

function hookStatePath(sessionId: string): string {
  return path.join(MONITOR_DIR, path.basename(sessionId) + '.state');
}

export type HookState = 'thinking' | 'waiting' | 'idle';

const VALID_HOOK_STATES: ReadonlySet<string> = new Set(['thinking', 'waiting', 'idle']);

export function readHookState(sessionId: string): { state: HookState; mtimeMs: number; jsonlMtimeMs: number } | null {
  if (!sessionId) { return null; }
  try {
    const p = hookStatePath(sessionId);
    const content = fs.readFileSync(p, 'utf8').trim();
    let state: HookState;
    let jsonlMtimeMs = 0;
    if (content === 'stopped') {
      state = 'idle';
    } else if (content.startsWith('waiting')) {
      state = 'waiting';
      // Format: "waiting:<jsonlMtimeMs>" — extract timestamp for resume detection
      const parts = content.split(':');
      if (parts[1]) {
        const raw = parseInt(parts[1], 10);
        if (!isNaN(raw)) { jsonlMtimeMs = raw > 9_999_999_999 ? raw : raw * 1000; }
      }
    } else if (VALID_HOOK_STATES.has(content)) {
      state = content as HookState;
    } else {
      return null;
    }
    return { state, mtimeMs: fs.statSync(p).mtimeMs, jsonlMtimeMs };
  } catch { /* file doesn't exist = no hook state */ }
  return null;
}

export function clearHookState(sessionId: string): void {
  if (!sessionId) { return; }
  try { fs.unlinkSync(hookStatePath(sessionId)); } catch { /* ignore */ }
}

export function getMonitorDir(): string {
  return MONITOR_DIR;
}

export interface SessionInfo {
  sessionId: string;
  sessionName: string;
  model: string;
  contextUsed: number;
  contextMax: number;
  usagePercent: number;
  messageCount: number;
  autocompactPct: number;
  tokensUntilCompact: number;
  autoCompactActive: boolean;
  autoCompactSource: AutoCompactSource;
  autoCompactWindow: number;
  effectiveWindow: number;
  compactThreshold: number;
  outputReserve: number;
  mtimeMs: number;
  displayMtimeMs: number;
  fileSize: number;
  filePath: string;
  projectDir: string;
  projectLabel: string;
  isActiveTurn: boolean;
  lastStopReason: string;
  status: SessionStatus;
  // Token totals (session cumulative, including subagents)
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  totalCacheWrite5m: number;
  totalCacheWrite1h: number;
  totalCacheWriteNoBreakdown: number;
  // Compact detection
  compactCount: number;
  compactAutoCount: number;
  compactManualCount: number;
  lastCompactFreed: number;
  // Agent activity
  activeAgentCount: number;
  totalAgentCount: number;
  /** @internal agent timestamps for recalculating activeAgentCount on cache hit */
  _agentTimestamps: number[];
  /** @internal subagent IDs and activity times for state calculation */
  _subagentActivities: SubagentActivity[];
  /** @internal task-notification completion signals from the parent JSONL */
  _completedAgentIds: ReadonlySet<string>;
  /** @internal completed synchronous Agent tool-use IDs from the parent JSONL */
  _finishedAgentToolUseIds: ReadonlySet<string>;
  /** @internal tasks dir max mtime for activity detection */
  tasksMtimeMs: number;
  /** @internal subagent dir max mtime for cache invalidation */
  subagentMtimeMs: number;
  /** @internal settings fingerprint for cache invalidation */
  settingsCacheKey: string;
}

export interface SubagentActivity {
  agentId: string;
  toolUseId: string | null;
  lastActivityMs: number;
}

export type SubagentState = 'running' | 'stale' | 'completed';

export const STALE_SUBAGENT_MS = 600_000;

export function getSubagentState(
  agentId: string,
  toolUseId: string | null,
  lastActivityMs: number,
  completedAgentIds: ReadonlySet<string>,
  finishedAgentToolUseIds: ReadonlySet<string>,
  now: number,
): SubagentState {
  if ((agentId && completedAgentIds.has(agentId)) || (toolUseId && finishedAgentToolUseIds.has(toolUseId))) {
    return 'completed';
  }
  if (lastActivityMs === 0 || now - lastActivityMs > STALE_SUBAGENT_MS) { return 'stale'; }
  return 'running';
}

function countRunningSubagents(info: SessionInfo, now: number): number {
  return info._subagentActivities.filter(activity =>
    getSubagentState(activity.agentId, activity.toolUseId, activity.lastActivityMs, info._completedAgentIds, info._finishedAgentToolUseIds, now) === 'running'
  ).length;
}

interface SessionParseState {
  _byteOffset: number;
  lastUsage: Usage | null;
  lastModel: string;
  totalInput: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalOutput: number;
  totalCacheWrite5m: number;
  totalCacheWrite1h: number;
  totalCacheWriteNoBreakdown: number;
  compactCount: number;
  compactAutoCount: number;
  compactManualCount: number;
  lastCompactFreed: number;
  prevContext: number;
  maxContextSeen: number;
  hasCompactAbove200K: boolean;
  latestAutoCompactPreTokens: number | null;
  compactBoundaryPending: boolean;
  agentIds: Set<string>;
  agentLastSeen: Map<string, number>;
  completedAgentIds: Set<string>;
  agentToolUseIds: Set<string>;
  finishedAgentToolUseIds: Set<string>;
  assistantCount: number;
  sessionId: string;
  firstUserText: string;
  aiTitle: string;
  customTitle: string;
  lastUserIdx: number;
  lastAssistantIdx: number;
  lastStopReason: string;
  lineIdx: number;
  countedMessageIds: Set<string>;
}

interface CachedSessionInfo extends SessionInfo {
  _parseState?: SessionParseState;
  _subagentFileCache?: Map<string, SubagentFileCache>;
}

export type SortMode = 'time' | 'usage' | 'compact';
export type FilterMode = 'all' | 'warning' | 'critical';
export type ModelFilter = 'all' | 'fable' | 'opus' | 'sonnet' | 'haiku';
export type GroupMode = 'none' | 'project' | 'status' | 'custom';
export type AutoCompactSource = 'env' | 'settings' | 'default';

export interface AutoCompactSettings {
  autoCompactWindowEnv?: number;
  autoCompactWindowSettings?: number;
  autoCompactEnabled?: boolean;
  maxOutputTokensEnv?: number;
  disableCompact?: boolean;
  disableAutoCompact?: boolean;
}

export interface AutoCompactInfo {
  active: boolean;
  source: AutoCompactSource;
  window: number;
  effectiveWindow: number;
  compactThreshold: number;
  outputReserve: number;
}

// ─── Constants ───

const TASKS_DIR_BASE = path.join(os.tmpdir(), 'claude');
const DEFAULT_CONTEXT_SIZE = 200000;
const OUTPUT_RESERVE_CAP = 20_000;
const MIN_AUTO_COMPACT_WINDOW = 100_000;
const MAX_AUTO_COMPACT_WINDOW = 1_000_000;
const COMPACT_BUFFER = 13_000;

const SKIP_PREFIXES = [
  'This session is being continued',
  'The user opened the file',
  'The user selected the lines',
  'The user opened a folder',
];

// ─── Helpers ───

function parsePositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && isFinite(value) && value > 0) { return value; }
  if (typeof value === 'string' && value.trim()) {
    const n = parseFloat(value);
    if (isFinite(n) && n > 0) { return n; }
  }
  return null;
}

function envTruthy(value: unknown): boolean {
  if (typeof value === 'boolean') { return value; }
  if (typeof value === 'number') { return value !== 0; }
  if (typeof value !== 'string') { return false; }
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no' && normalized !== 'off';
}

function envValue(name: string, settingsEnv: Record<string, unknown>): unknown {
  return process.env[name] ?? settingsEnv[name];
}

export function getSettingsCacheKey(settings: ClaudeSettings): string {
  return JSON.stringify({
    maxTokensOverride: settings.maxTokensOverride,
    autocompactPct: settings.autocompactPct,
    contextWindowOverride: settings.contextWindowOverride,
    settingsModelNormalized: settings.settingsModelNormalized,
    autoCompactWindow: settings.autoCompactWindow ?? null,
    autoCompactEnabled: settings.autoCompactEnabled !== false,
    autoCompactWindowEnv: settings.autoCompactWindowEnv ?? null,
    maxOutputTokensEnv: settings.maxOutputTokensEnv ?? null,
    disableCompact: !!settings.disableCompact,
    disableAutoCompact: !!settings.disableAutoCompact,
  });
}

export function readClaudeSettings(): ClaudeSettings {
  let maxTokensOverride: number | null = null;
  let autocompactPct = 95;
  let contextWindowOverride: number | null = null;
  let cleanupPeriodDays = 30;
  let autoCompactWindow: number | null = null;
  let autoCompactEnabled = true;
  let autoCompactWindowEnv: number | null = null;
  let maxOutputTokensEnv: number | null = null;
  let disableCompact = false;
  let disableAutoCompact = false;
  let settingsEnv: Record<string, unknown> = {};
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')
    );
    if (settings?.env && typeof settings.env === 'object') {
      settingsEnv = settings.env;
    }
    if (settings?.maxTokens && typeof settings.maxTokens === 'number') {
      maxTokensOverride = settings.maxTokens;
    }
    if (typeof settings?.cleanupPeriodDays === 'number' && Number.isFinite(settings.cleanupPeriodDays) && settings.cleanupPeriodDays > 0) {
      cleanupPeriodDays = Math.floor(settings.cleanupPeriodDays);
    }
    if (typeof settings?.autoCompactWindow === 'number' && Number.isInteger(settings.autoCompactWindow) && settings.autoCompactWindow > 0) {
      autoCompactWindow = settings.autoCompactWindow;
    }
    autoCompactEnabled = settings?.autoCompactEnabled === false ? false : true;
  } catch { /* ignore */ }

  autoCompactWindowEnv = parsePositiveNumber(envValue('CLAUDE_CODE_AUTO_COMPACT_WINDOW', settingsEnv));
  maxOutputTokensEnv = parsePositiveNumber(envValue('CLAUDE_CODE_MAX_OUTPUT_TOKENS', settingsEnv));
  disableCompact = envTruthy(envValue('DISABLE_COMPACT', settingsEnv));
  disableAutoCompact = envTruthy(envValue('DISABLE_AUTO_COMPACT', settingsEnv));

  // Detect a 1M context window opt-in from the configured model name.
  // Priority: settings.local.json model [1m] > settings.json model [1m]
  // settingsModelNormalized tracks which model the [1m] was configured for, so that
  // contextWindowOverride is only applied to sessions running that same model family.
  // A GrowthBook fallback (cachedGrowthBookFeatures.tengu_hawthorn_window) used to sit
  // after these two. It was removed on 2026-07-29: the flag read 200000 on an account
  // whose sessions demonstrably held 724K tokens, with the feature cache only 2h old —
  // so the value does not represent the session context window despite its name, and
  // feeding it into contextMax was the direct cause of 1M models reading as 200K.
  // Models API + [1m] + evidenced usage cover the promotion cases it was meant to serve.
  let settingsModelNormalized: string | null = null;
  if (contextWindowOverride === null) {
    const re1m = /[\[(]1[mM][\])]/;
    const localSettingsPath = path.join(os.homedir(), '.claude', 'settings.local.json');
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      const local = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
      if (typeof local?.model === 'string' && re1m.test(local.model)) {
        contextWindowOverride = 1_000_000;
        settingsModelNormalized = normalizeModelId(local.model);
      }
    } catch { /* ignore */ }
    if (contextWindowOverride === null) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (typeof settings?.model === 'string' && re1m.test(settings.model)) {
          contextWindowOverride = 1_000_000;
          settingsModelNormalized = normalizeModelId(settings.model);
        }
      } catch { /* ignore */ }
    }
  }


  return {
    maxTokensOverride, autocompactPct, contextWindowOverride,
    settingsModelNormalized,
    cleanupPeriodDays,
    autoCompactWindow, autoCompactEnabled,
    autoCompactWindowEnv, maxOutputTokensEnv,
    disableCompact, disableAutoCompact,
  };
}

// Model info: base context size and whether the model can run at 1M context at all.
// The base size is each model's own documented context window, applied from the first
// message of a session — it is not a floor that waits for evidence. per-session signals
// in parseSessionJsonl (explicit [1m] / evidenced usage / matching settings model) only
// ever promote above this base; they never lower it.
// Models documenting a 1M window carry 1M here. Earlier revisions kept the current 1M
// generation at a conservative 200K base on the theory that a 200K-capped environment
// would otherwise have real compact pressure hidden. That was dropped: it under-reported
// every session below 200K by 5x (a 54K-token session read as 27% instead of 5.6%), and
// the guard only ever corrected itself after a session had already crossed 200K — the
// point where the warning is least useful. A genuinely 200K-capped environment is still
// handled by settings.maxTokens / the [1m]-carrying settings model / the Models API,
// all of which are read before this table.
// supportsExtended marks models that can reach 1M at all; it gates the settings-derived
// override in parseSessionJsonl and stays true for the 1M generation.
// Aliases (fable/opus/sonnet/haiku) map to the current default version.
// (2026-04-17 verified against docs.anthropic.com; claude-fable-5 added 2026-06-10;
//  claude-opus-5 added 2026-07-25; 2026-07-29 every entry re-verified against the live
//  Models API (GET /v1/models -> max_input_tokens), which is authoritative and caught a
//  wrong hand-maintained value (sonnet-4-5 is 1M, not 200K). fable-5 / opus-5 / opus-4-8 /
//  opus-4-7 / opus-4-6 / sonnet-5 / sonnet-4-6 / sonnet-4-5 are 1M; opus-4-5 / opus-4-1 /
//  haiku-4-5 are 200K. Treat this table as a stale-by-design offline fallback and re-verify
//  against /v1/models rather than against prose docs when touching it.
//  claude-mythos-5 is deliberately absent: it is Project Glasswing-only, and
//  shortenModel/MODEL_PRICING have no entry for it, so listing it here alone would
//  give it a context window but no price and a "claude" model badge.)
interface ModelInfo {
  contextSize: number;
  supportsExtended: boolean;
  defaultMaxOutputTokens?: number;
}

const MODEL_INFO: Record<string, ModelInfo> = {
  'claude-fable-5':    { contextSize: 1_000_000, supportsExtended: true, defaultMaxOutputTokens: 64_000 },
  'claude-opus-5':     { contextSize: 1_000_000, supportsExtended: true, defaultMaxOutputTokens: 128_000 },
  'claude-opus-4-8':   { contextSize: 1_000_000, supportsExtended: true, defaultMaxOutputTokens: 64_000 },
  'claude-opus-4-7':   { contextSize: 1_000_000, supportsExtended: true, defaultMaxOutputTokens: 64_000 },
  'claude-opus-4-6':   { contextSize: 1_000_000, supportsExtended: true, defaultMaxOutputTokens: 64_000 },
  'claude-sonnet-5':   { contextSize: 1_000_000, supportsExtended: true },
  'claude-sonnet-4-6': { contextSize: 1_000_000, supportsExtended: true },
  'claude-sonnet-4-5': { contextSize: 1_000_000, supportsExtended: true },
  'claude-opus-4-5':   { contextSize: 200_000, supportsExtended: false },
  'claude-opus-4-1':   { contextSize: 200_000, supportsExtended: false },
  'claude-opus-4':     { contextSize: 200_000, supportsExtended: false },
  'claude-sonnet-4':   { contextSize: 200_000, supportsExtended: false },
  'claude-haiku-4-5':  { contextSize: 200_000, supportsExtended: false },
  // Short aliases → current default version
  'fable':  { contextSize: 1_000_000, supportsExtended: true },
  'opus':   { contextSize: 1_000_000, supportsExtended: true },
  'sonnet': { contextSize: 1_000_000, supportsExtended: true },
  'haiku':  { contextSize: 200_000, supportsExtended: false },
};

// API pricing per million tokens (2026-04-17 verified against docs.anthropic.com)
// Aliases (fable/opus/sonnet/haiku) apply to the current default version and any newer
// model that shares the alias's pricing. Per-ID entries override the alias in two cases:
// (a) legacy versions whose pricing differs (e.g. Opus 4.1 is 3x the Opus 4.6 rate), and
// (b) current models pinned so their rate survives the alias moving to a newer generation.
interface ModelPricing {
  inputPerMToken: number;
  cacheWrite5mPerMToken: number;
  cacheWrite1hPerMToken: number;
  cacheReadPerMToken: number;
  outputPerMToken: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Fable 5: $10/$50 per MTok (2026-06-10 verified against platform.claude.com docs).
  // Cache rates follow the standard multipliers (5m write 1.25x, 1h write 2x, read 0.1x).
  'fable': { inputPerMToken: 10, cacheWrite5mPerMToken: 12.5, cacheWrite1hPerMToken: 20, cacheReadPerMToken: 1, outputPerMToken: 50 },
  // Opus 5: $5/$25 per MTok (2026-07-25 verified against platform.claude.com docs).
  // Case (b): identical to the 'opus' alias today, pinned so claude-opus-5 sessions keep
  // Opus 5 rates once that alias moves on. claude-fable-5 has no such pin yet.
  'claude-opus-5': { inputPerMToken: 5, cacheWrite5mPerMToken: 6.25, cacheWrite1hPerMToken: 10, cacheReadPerMToken: 0.5, outputPerMToken: 25 },
  'opus': { inputPerMToken: 5, cacheWrite5mPerMToken: 6.25, cacheWrite1hPerMToken: 10, cacheReadPerMToken: 0.5, outputPerMToken: 25 },
  'sonnet': { inputPerMToken: 3, cacheWrite5mPerMToken: 3.75, cacheWrite1hPerMToken: 6, cacheReadPerMToken: 0.3, outputPerMToken: 15 },
  'haiku': { inputPerMToken: 1, cacheWrite5mPerMToken: 1.25, cacheWrite1hPerMToken: 2, cacheReadPerMToken: 0.1, outputPerMToken: 5 },
  // Legacy Opus versions priced 3x higher than Opus 4.6+. Listed explicitly so
  // the alias fallback does not underprice them.
  'claude-opus-4-1': { inputPerMToken: 15, cacheWrite5mPerMToken: 18.75, cacheWrite1hPerMToken: 30, cacheReadPerMToken: 1.5, outputPerMToken: 75 },
  'claude-opus-4': { inputPerMToken: 15, cacheWrite5mPerMToken: 18.75, cacheWrite1hPerMToken: 30, cacheReadPerMToken: 1.5, outputPerMToken: 75 },
};

function lookupPricing(model: string): ModelPricing | undefined {
  const exact = normalizeModelId(model);
  if (Object.prototype.hasOwnProperty.call(MODEL_PRICING, exact)) { return MODEL_PRICING[exact]; }
  const short = shortenModel(model);
  if (Object.prototype.hasOwnProperty.call(MODEL_PRICING, short)) { return MODEL_PRICING[short]; }
  return undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getDefaultMaxOutputTokens(model: string): number {
  return MODEL_INFO[normalizeModelId(model)]?.defaultMaxOutputTokens ?? 32_000;
}

export function computeAutoCompact(
  model: string,
  contextMax: number,
  settings: AutoCompactSettings = {},
): AutoCompactInfo {
  const modelMaxWindow = Math.max(1, contextMax);
  let source: AutoCompactSource = 'default';
  let window = modelMaxWindow;

  if (settings.autoCompactWindowEnv !== undefined) {
    const envWindow = parsePositiveNumber(settings.autoCompactWindowEnv);
    if (envWindow !== null) {
      window = Math.min(modelMaxWindow, clampNumber(envWindow, MIN_AUTO_COMPACT_WINDOW, MAX_AUTO_COMPACT_WINDOW));
      source = 'env';
    }
  }

  if (source === 'default' && settings.autoCompactWindowSettings !== undefined) {
    const settingsWindow = parsePositiveNumber(settings.autoCompactWindowSettings);
    if (settingsWindow !== null) {
      window = Math.min(modelMaxWindow, clampNumber(settingsWindow, MIN_AUTO_COMPACT_WINDOW, MAX_AUTO_COMPACT_WINDOW));
      source = 'settings';
    }
  }

  const maxOutputTokens = parsePositiveNumber(settings.maxOutputTokensEnv) ?? getDefaultMaxOutputTokens(model);
  const outputReserve = Math.min(maxOutputTokens, OUTPUT_RESERVE_CAP);
  const effectiveWindow = Math.max(1, window - outputReserve);
  const compactCeiling = Math.max(1, effectiveWindow - COMPACT_BUFFER);
  const compactThreshold = compactCeiling;

  const autoCompactEnabled = settings.autoCompactEnabled !== false && !settings.disableCompact && !settings.disableAutoCompact;
  const active = !!autoCompactEnabled;

  return { active, source, window, effectiveWindow, compactThreshold, outputReserve };
}

export function getContextMaxForModel(model: string): number {
  // If model explicitly has [1m] suffix, return 1M (future-proofing)
  if (/[\[(]1[mM][\])]$/.test(model)) { return 1_000_000; }
  const normalized = normalizeModelId(model);
  return MODEL_INFO[normalized]?.contextSize ?? DEFAULT_CONTEXT_SIZE;
}

export function isExtendedContextModel(model: string): boolean {
  const normalized = normalizeModelId(model);
  return MODEL_INFO[normalized]?.supportsExtended ?? false;
}

function settingsModelsMatch(sessionModel: string, settingsModel: string): boolean {
  const sNorm = normalizeModelId(sessionModel);
  const tNorm = normalizeModelId(settingsModel);
  if (sNorm === tNorm) { return true; }
  // Alias matching: settings "opus" matches session "claude-opus-4-8", etc.
  if (shortenModel(sNorm) === tNorm || sNorm === shortenModel(tNorm)) { return true; }
  return false;
}

export function formatTokens(n: number): string {
  if (n >= 1000000) { return (n / 1000000).toFixed(1) + 'M'; }
  if (n >= 1000) { return (n / 1000).toFixed(1) + 'k'; }
  return String(n);
}

export function calculateCost(s: SessionInfo): number | null {
  // Prefer exact normalized model ID (covers legacy versions with distinct pricing),
  // then fall back to the family alias (fable/opus/sonnet/haiku) for current-gen models.
  const pricing = lookupPricing(s.model);
  if (!pricing) { return null; }
  // Breakdown-tracked writes use exact pricing; non-breakdown writes fall back to 1h pricing
  const cacheWriteCost =
    s.totalCacheWrite5m * pricing.cacheWrite5mPerMToken +
    s.totalCacheWrite1h * pricing.cacheWrite1hPerMToken +
    s.totalCacheWriteNoBreakdown * pricing.cacheWrite1hPerMToken;
  return (
    (s.inputTokens * pricing.inputPerMToken +
     cacheWriteCost +
     s.cacheReadTokens * pricing.cacheReadPerMToken +
     s.outputTokens * pricing.outputPerMToken) / 1_000_000
  );
}

export function findUnknownPricingModels(sessions: SessionInfo[]): string[] {
  const unknown = new Set<string>();
  for (const s of sessions) {
    if (!s.model) { continue; }
    if (!lookupPricing(s.model)) { unknown.add(s.model); }
  }
  return [...unknown];
}

export function formatRelativeTime(mtimeMs: number): string {
  const diff = Date.now() - mtimeMs;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) { return '<1m'; }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) { return minutes + 'm'; }
  const hours = Math.floor(minutes / 60);
  return hours + 'h';
}

export function shortenModel(model: string): string {
  if (!model) { return ''; }
  if (model.includes('fable')) { return 'fable'; }
  if (model.includes('opus')) { return 'opus'; }
  if (model.includes('sonnet')) { return 'sonnet'; }
  if (model.includes('haiku')) { return 'haiku'; }
  return model.split('-')[0] || model;
}

export function decodeProjectDir(dirName: string): string {
  // Claude Code encodes paths by replacing :, /, \ with -
  // Strip encoded homedir prefix to get relative project path
  const homeEncoded = os.homedir().replace(/[:\/\\]/g, '-');
  let remainder = dirName;
  if (dirName.startsWith(homeEncoded)) {
    remainder = dirName.substring(homeEncoded.length);
    if (remainder.startsWith('-')) { remainder = remainder.substring(1); }
  }
  return remainder || dirName;
}

function cleanSessionName(name: string): string {
  let cleaned = name.replace(/^["'`]+|["'`]+$/g, '');
  if (/^[A-Za-z]:[\\/]/.test(cleaned) || cleaned.startsWith('/') || cleaned.startsWith('~')) {
    const parts = cleaned.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length > 1) {
      cleaned = parts[parts.length - 1];
    }
  }
  return cleaned;
}

const ACTIVE_THRESHOLD_MS = 15_000;
const ACTIVE_TURN_TIMEOUT_MS = 60_000; // extended thinking window for active turns (tool_use) without hooks
const INACTIVE_THRESHOLD_MS = 300_000;
const HOOK_STATE_TTL_MS = INACTIVE_THRESHOLD_MS;
const HOOK_MTIME_TOLERANCE_MS = 50; // small margin for FS timestamp rounding (hook records ms precision)
function getSessionStatus(effectiveMtimeMs: number, jsonlMtimeMs: number, isActiveTurn: boolean, mtimeChanged: boolean, sessionId: string): SessionStatus {
  const age = Date.now() - effectiveMtimeMs;

  // 1. Hook-driven: authoritative signal from Claude Code hooks
  const hookResult = readHookState(sessionId);
  if (hookResult) {
    const stateAge = Date.now() - hookResult.mtimeMs;
    // Waiting: check if JSONL was updated after permission was requested (= approved)
    // Use jsonlMtimeMs only (not effectiveMtimeMs) to avoid tasks/subagent mtime triggering false resume
    if (hookResult.state === 'waiting') {
      // Resume detection: JSONL updated OR tasks/subagent activity after permission request
      const jsonlResumed = hookResult.jsonlMtimeMs > 0 && jsonlMtimeMs > hookResult.jsonlMtimeMs + HOOK_MTIME_TOLERANCE_MS;
      const activityResumed = effectiveMtimeMs > hookResult.mtimeMs + HOOK_MTIME_TOLERANCE_MS;
      if (jsonlResumed || activityResumed) {
        clearHookState(sessionId);
        // fall through to heuristic
      } else {
        return 'waiting';
      }
    } else if (stateAge > HOOK_STATE_TTL_MS) {
      clearHookState(sessionId);
    } else if (age > INACTIVE_THRESHOLD_MS) {
      clearHookState(sessionId);
      return 'inactive';
    } else {
      return hookResult.state;
    }
  }

  // 2. Fallback: heuristic detection (hooks disabled or no .state file)
  if (age > INACTIVE_THRESHOLD_MS) { return 'inactive'; }
  if (isActiveTurn && age < ACTIVE_TURN_TIMEOUT_MS) { return 'thinking'; }
  if (mtimeChanged && age < ACTIVE_THRESHOLD_MS) { return 'thinking'; }
  if (age > ACTIVE_THRESHOLD_MS) { return 'idle'; }
  return 'idle';
}

// ─── Subagent parsing ───

interface SubagentSummary {
  maxMtimeMs: number;
  count: number;
  timestamps: number[];
  activities: SubagentActivity[];
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteNoBreakdown: number;
  fileCache: Map<string, SubagentFileCache>;
}

/** Per-subagent-file aggregates cached by mtime+size so unchanged files are not
 *  re-read on every refresh. messageIds records the IDs this file contributed,
 *  enabling cross-file/main-JSONL dedup checks without re-parsing. */
interface SubagentFileCache {
  mtimeMs: number;
  size: number;

  toolUseId: string | null;
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteNoBreakdown: number;
  messageIds: string[];
}

export function agentIdFromFilename(fileName: string): string {
  return fileName.startsWith('agent-') ? fileName.substring('agent-'.length, fileName.length - '.jsonl'.length) : '';
}

function getSubagentMaxMtime(sessionFilePath: string): number {
  try {
    const sessionId = path.basename(sessionFilePath, '.jsonl');
    const subagentDir = path.join(path.dirname(sessionFilePath), sessionId, 'subagents');
    let maxMtime = 0;
    for (const file of fs.readdirSync(subagentDir)) {
      if (!file.endsWith('.jsonl')) { continue; }
      const fp = path.join(subagentDir, file);
      // Only the .jsonl mtime is folded in. The sidecar .meta.json is written once when
      // the agent spawns and the .jsonl keeps growing afterwards, so meta_i <= jsonl_i
      // always holds and stat-ing the sidecar can never raise this maximum (verified
      // 2026-07-29 across 50 file pairs / 5 sessions: zero cases of a newer sidecar).
      // Stat-ing it anyway doubled the syscalls on every reconcile for no effect.
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs > maxMtime) { maxMtime = stat.mtimeMs; }
      } catch { /* skip */ }
    }
    return maxMtime;
  } catch { return 0; }
}

/** Parse subagent JSONL files for usage accumulation and agent tracking.
 *  Since Claude Code ~2.1.89, agent_progress entries are no longer written to the main JSONL.
 *  Agent data is now in separate subagent JSONL files under {sessionDir}/{sessionId}/subagents/. */
function shouldCountMessageUsage(messageId: unknown, countedMessageIds: Set<string>): boolean {
  if (typeof messageId !== 'string' || !messageId) { return true; }
  if (countedMessageIds.has(messageId)) { return false; }
  countedMessageIds.add(messageId);
  return true;
}

interface CacheWriteBreakdown {
  write5m: number;
  write1h: number;
  writeNoBreakdown: number;
}

function getCacheWriteBreakdown(usage: Usage): CacheWriteBreakdown {
  const e5m = usage.cache_creation?.ephemeral_5m_input_tokens || 0;
  const e1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
  if (e5m > 0 || e1h > 0) {
    return { write5m: e5m, write1h: e1h, writeNoBreakdown: 0 };
  }
  return { write5m: 0, write1h: 0, writeNoBreakdown: usage.cache_creation_input_tokens || 0 };
}

function parseSubagentUsage(
  sessionFilePath: string,
  countedMessageIds: Set<string>,
  prevFileCache?: Map<string, SubagentFileCache>,
): SubagentSummary {
  const result: SubagentSummary = {
    maxMtimeMs: 0, count: 0, timestamps: [], activities: [],
    input: 0, cacheRead: 0, cacheCreation: 0, output: 0,
    cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteNoBreakdown: 0,
    fileCache: new Map(),
  };
  try {
    const sessionId = path.basename(sessionFilePath, '.jsonl');
    const subagentDir = path.join(path.dirname(sessionFilePath), sessionId, 'subagents');
    const files = fs.readdirSync(subagentDir).filter(file => file.endsWith('.jsonl')).sort();
    for (const file of files) {
      const fp = path.join(subagentDir, file);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs > result.maxMtimeMs) { result.maxMtimeMs = stat.mtimeMs; }
        result.count++;
        result.timestamps.push(stat.mtimeMs);
        const metaPath = fp.replace(/\.jsonl$/, '.meta.json');

        // Unchanged file: reuse cached aggregates instead of re-reading. The sidecar
        // .meta.json is not part of this key — it is written once at spawn, before the
        // .jsonl grows, so a cached toolUseId cannot go stale while the .jsonl is
        // unchanged. Falls back to a full read if any cached ID is already counted
        // elsewhere (main JSONL legacy progress entries) — dedup then needs line
        // granularity.
        const cached = prevFileCache?.get(fp);
        if (
          cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size &&
          !cached.messageIds.some(id => countedMessageIds.has(id))
        ) {
          result.activities.push({
            agentId: agentIdFromFilename(file),
            toolUseId: cached.toolUseId,
            lastActivityMs: stat.mtimeMs,
          });
          for (const id of cached.messageIds) { countedMessageIds.add(id); }
          result.input += cached.input;
          result.cacheRead += cached.cacheRead;
          result.cacheCreation += cached.cacheCreation;
          result.output += cached.output;
          result.cacheWrite5m += cached.cacheWrite5m;
          result.cacheWrite1h += cached.cacheWrite1h;
          result.cacheWriteNoBreakdown += cached.cacheWriteNoBreakdown;
          result.fileCache.set(fp, cached);
          continue;
        }

        // Cache miss: read meta.json now (kept out of the hit path above so an
        // unchanged file doesn't pay this I/O every refresh).
        let toolUseId: string | null = null;
        try {
          const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          toolUseId = typeof raw.toolUseId === 'string' ? raw.toolUseId : null;
        } catch { /* meta.json is optional or may be mid-write */ }
        result.activities.push({
          agentId: agentIdFromFilename(file),
          toolUseId,
          lastActivityMs: stat.mtimeMs,
        });

        const fileAgg: SubagentFileCache = {
          mtimeMs: stat.mtimeMs, size: stat.size, toolUseId,
          input: 0, cacheRead: 0, cacheCreation: 0, output: 0,
          cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteNoBreakdown: 0,
          messageIds: [],
        };
        for (const line of fs.readFileSync(fp, 'utf8').trim().split('\n')) {
          if (!line.trim()) { continue; }
          try {
            const data = JSON.parse(line);
            if (data.type === 'assistant' && data.message?.usage) {
              if (!shouldCountMessageUsage(data.message.id, countedMessageIds)) { continue; }
              if (typeof data.message.id === 'string' && data.message.id) { fileAgg.messageIds.push(data.message.id); }
              const u = data.message.usage;
              fileAgg.input += u.input_tokens || 0;
              fileAgg.cacheRead += u.cache_read_input_tokens || 0;
              fileAgg.cacheCreation += u.cache_creation_input_tokens || 0;
              fileAgg.output += u.output_tokens || 0;
              const bd = getCacheWriteBreakdown(u);
              fileAgg.cacheWrite5m += bd.write5m;
              fileAgg.cacheWrite1h += bd.write1h;
              fileAgg.cacheWriteNoBreakdown += bd.writeNoBreakdown;
            }
          } catch { /* skip line */ }
        }
        result.input += fileAgg.input;
        result.cacheRead += fileAgg.cacheRead;
        result.cacheCreation += fileAgg.cacheCreation;
        result.output += fileAgg.output;
        result.cacheWrite5m += fileAgg.cacheWrite5m;
        result.cacheWrite1h += fileAgg.cacheWrite1h;
        result.cacheWriteNoBreakdown += fileAgg.cacheWriteNoBreakdown;
        result.fileCache.set(fp, fileAgg);
      } catch { /* skip file */ }
    }
  } catch { /* no subagent dir */ }
  return result;
}

// ─── Tasks dir mtime ───

function getTasksMaxMtime(projectDir: string, sessionId: string): number {
  if (!sessionId) { return 0; }
  try {
    const tasksDir = path.join(TASKS_DIR_BASE, projectDir, sessionId, 'tasks');
    let maxMtime = 0;
    for (const file of fs.readdirSync(tasksDir)) {
      if (!file.endsWith('.output')) { continue; }
      try {
        const fstat = fs.statSync(path.join(tasksDir, file));
        if (fstat.mtimeMs > maxMtime) { maxMtime = fstat.mtimeMs; }
      } catch { /* skip */ }
    }
    return maxMtime;
  } catch { return 0; }
}

// ─── Session parsing ───

function stripXmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, '').trim();
}

function extractUserText(content: any): string {
  if (typeof content === 'string') {
    const cleaned = stripXmlTags(content);
    if (cleaned) { return cleaned; }
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const cleaned = stripXmlTags(block.text);
        if (cleaned) { return cleaned; }
      }
    }
  }
  return '';
}

function isSkippableText(text: string): boolean {
  return SKIP_PREFIXES.some(prefix => text.startsWith(prefix));
}

function extractToolResultText(content: unknown): string | null {
  // Empty string normalizes to null: an unextractable/empty result must not read as
  // "completed" text — misjudging stale-vs-completed the wrong way here would mark a
  // still-running agent as done, so we prefer staying stale over a false completion.
  if (typeof content === 'string') { return content !== '' ? content : null; }
  if (!Array.isArray(content)) { return null; }
  const textBlock = content.find(block => block?.type === 'text' && typeof block.text === 'string' && block.text !== '');
  return textBlock ? textBlock.text : null;
}

function createEmptyParseState(): SessionParseState {
  return {
    _byteOffset: 0,
    lastUsage: null,
    lastModel: '',
    totalInput: 0,
    totalCacheRead: 0,
    totalCacheCreation: 0,
    totalOutput: 0,
    totalCacheWrite5m: 0,
    totalCacheWrite1h: 0,
    totalCacheWriteNoBreakdown: 0,
    compactCount: 0,
    compactAutoCount: 0,
    compactManualCount: 0,
    lastCompactFreed: 0,
    prevContext: 0,
    maxContextSeen: 0,
    hasCompactAbove200K: false,
    latestAutoCompactPreTokens: null,
    compactBoundaryPending: false,
    agentIds: new Set<string>(),
    agentLastSeen: new Map<string, number>(),
    completedAgentIds: new Set<string>(),
    agentToolUseIds: new Set<string>(),
    finishedAgentToolUseIds: new Set<string>(),
    assistantCount: 0,
    sessionId: '',
    firstUserText: '',
    aiTitle: '',
    customTitle: '',
    lastUserIdx: -1,
    lastAssistantIdx: -1,
    lastStopReason: '',
    lineIdx: 0,
    countedMessageIds: new Set<string>(),
  };
}

function cloneParseState(state: SessionParseState): SessionParseState {
  return {
    ...state,
    agentIds: new Set(state.agentIds),
    agentLastSeen: new Map(state.agentLastSeen),
    completedAgentIds: new Set(state.completedAgentIds),
    agentToolUseIds: new Set(state.agentToolUseIds),
    finishedAgentToolUseIds: new Set(state.finishedAgentToolUseIds),
    countedMessageIds: new Set(state.countedMessageIds),
  };
}

// Verified against Claude Code v2.1.219 JSONL on 2026-07-25. Known top-level
// types: assistant, user, attachment, queue-operation, ai-title, last-prompt,
// file-history-snapshot, custom-title, system, mode, file-history-delta, and
// frame-link. Only the records handled below affect session state; others are
// intentionally ignored. Progress/agent_progress is handled for subagents.
// Exception: the task-notification scan immediately below runs before JSON parsing
// and independent of record type, so it affects state even for record types not
// otherwise handled in this function.
function processSessionLine(line: string, state: SessionParseState): void {
  if (!line.trim()) { state.lineIdx++; return; }
  // Raw string match rather than a parsed-type check: the same <task-notification>
  // can be duplicated across multiple record types (queue-operation / attachment /
  // user, etc.), so matching on the line text avoids having to enumerate every type
  // it might appear under.
  if (line.includes('<task-notification>')) {
    const taskIdPattern = /<task-id>([^<]+)<\/task-id>/g;
    let match: RegExpExecArray | null;
    while ((match = taskIdPattern.exec(line)) !== null) {
      if (match[1]) { state.completedAgentIds.add(match[1]); }
    }
  }
  try {
    const data = JSON.parse(line);
    if (data.type === 'user') { state.lastUserIdx = state.lineIdx; }
    if (data.type === 'assistant') {
      state.lastAssistantIdx = state.lineIdx;
      if (data.message?.stop_reason) { state.lastStopReason = data.message.stop_reason; }
      const content = data.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use' && block.name === 'Agent' && typeof block.id === 'string') {
            state.agentToolUseIds.add(block.id);
          }
        }
      }
    }
    if (data.type === 'user') {
      const content = data.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || !state.agentToolUseIds.has(block.tool_use_id)) { continue; }
          const text = extractToolResultText(block.content);
          if (text !== null && !text.startsWith('Async agent launched successfully')) {
            state.finishedAgentToolUseIds.add(block.tool_use_id);
          }
        }
      }
    }
    if (data.sessionId && !state.sessionId) { state.sessionId = data.sessionId; }
    if (data.type === 'custom-title' && typeof data.customTitle === 'string' && data.customTitle) {
      state.customTitle = data.customTitle;
    } else if (data.type === 'ai-title' && typeof data.aiTitle === 'string' && data.aiTitle) {
      state.aiTitle = data.aiTitle;
    }
    if (data.type === 'assistant' && data.message?.usage) {
      state.lastUsage = data.message.usage;
      state.lastModel = data.message.model || state.lastModel;
      const countUsage = shouldCountMessageUsage(data.message.id, state.countedMessageIds);
      if (countUsage) {
        state.totalInput += data.message.usage.input_tokens || 0;
        state.totalCacheRead += data.message.usage.cache_read_input_tokens || 0;
        state.totalCacheCreation += data.message.usage.cache_creation_input_tokens || 0;
        state.totalOutput += data.message.usage.output_tokens || 0;
        const bd = getCacheWriteBreakdown(data.message.usage);
        state.totalCacheWrite5m += bd.write5m;
        state.totalCacheWrite1h += bd.write1h;
        state.totalCacheWriteNoBreakdown += bd.writeNoBreakdown;
      }
      const ctx = (data.message.usage.input_tokens || 0) +
                  (data.message.usage.cache_creation_input_tokens || 0) +
                  (data.message.usage.cache_read_input_tokens || 0);
      if (ctx > 0) {
        if (ctx > state.maxContextSeen) { state.maxContextSeen = ctx; }
        if (state.prevContext > 20000 && ctx < state.prevContext * 0.7 && !state.compactBoundaryPending) {
          state.compactCount++;
          state.compactAutoCount++;
          state.lastCompactFreed = state.prevContext - ctx;
        }
        state.prevContext = ctx;
        state.compactBoundaryPending = false;
      }
      if (countUsage) { state.assistantCount++; }
    }
    if (data.type === 'system' && data.subtype === 'compact_boundary') {
      state.compactCount++;
      if (data.compactMetadata?.trigger === 'manual') { state.compactManualCount++; } else { state.compactAutoCount++; }
      const preTokens = data.compactMetadata?.preTokens || 0;
      if (data.compactMetadata?.trigger === 'auto' && typeof preTokens === 'number' && Number.isFinite(preTokens) && preTokens > 0) {
        state.latestAutoCompactPreTokens = preTokens;
      }
      state.lastCompactFreed = preTokens;
      if (preTokens > DEFAULT_CONTEXT_SIZE) { state.hasCompactAbove200K = true; }
      state.compactBoundaryPending = true;
    }
    if (data.type === 'progress' && data.data?.type === 'agent_progress' && data.data?.agentId) {
      state.agentIds.add(data.data.agentId);
      const parsedTs = new Date(data.timestamp || 0).getTime();
      const ts = Number.isNaN(parsedTs) ? 0 : parsedTs;
      state.agentLastSeen.set(data.data.agentId, ts);
      const agentUsage = data.data?.message?.message?.usage;
      if (agentUsage) {
        const agentMessageId = data.data?.message?.message?.id;
        if (shouldCountMessageUsage(agentMessageId, state.countedMessageIds)) {
          state.totalInput += agentUsage.input_tokens || 0;
          state.totalCacheRead += agentUsage.cache_read_input_tokens || 0;
          state.totalCacheCreation += agentUsage.cache_creation_input_tokens || 0;
          state.totalOutput += agentUsage.output_tokens || 0;
          const bd = getCacheWriteBreakdown(agentUsage);
          state.totalCacheWrite5m += bd.write5m;
          state.totalCacheWrite1h += bd.write1h;
          state.totalCacheWriteNoBreakdown += bd.writeNoBreakdown;
        }
      }
    }
    if (!state.firstUserText && data.type === 'user' && data.message?.content) {
      const text = extractUserText(data.message.content);
      if (text && !isSkippableText(text)) {
        state.firstUserText = text;
      }
    }
  } catch { /* skip */ }
  state.lineIdx++;
}

function readSessionLines(filePath: string, fileSize: number, state: SessionParseState): boolean {
  if (fileSize < state._byteOffset) { return false; }
  if (fileSize === state._byteOffset) { return true; }

  let fd: number | null = null;
  try {
    const bytesToRead = fileSize - state._byteOffset;
    const buffer = Buffer.allocUnsafe(bytesToRead);
    fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, state._byteOffset);
    const chunk = buffer.subarray(0, bytesRead);

    // Find the last newline byte (0x0a) in the raw buffer so that we only decode
    // complete lines. This avoids corrupt decoding when a UTF-8 multibyte character
    // is split across two reads.
    const lastLF = chunk.lastIndexOf(0x0a);
    const completeBytes = lastLF >= 0 ? lastLF + 1 : 0;

    if (completeBytes > 0) {
      const completeChunk = chunk.subarray(0, completeBytes).toString('utf8');
      const lines = completeChunk.split(/\r?\n/);
      // The split always produces an empty string after the trailing newline; skip it.
      const limit = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      for (let i = 0; i < limit; i++) {
        processSessionLine(lines[i], state);
      }
    }

    // Handle trailing bytes after the last LF (file ends without a newline).
    // Attempt to decode and parse as a complete JSON line. If JSON.parse succeeds,
    // treat it as a fully written terminal line and advance _byteOffset to fileSize.
    // If JSON.parse fails (mid-write / split UTF-8), leave it as a pending incomplete
    // line — _byteOffset advances only to completeBytes, preserving the guard against
    // split multibyte characters and partial writes.
    const tail = chunk.subarray(completeBytes);
    if (tail.length > 0) {
      const tailStr = tail.toString('utf8');
      try {
        JSON.parse(tailStr);
        // Parse succeeded: complete terminal line — process and consume it fully.
        processSessionLine(tailStr, state);
        state._byteOffset = state._byteOffset + completeBytes + tail.length;
      } catch {
        // Parse failed: incomplete / mid-write line — do not consume.
        state._byteOffset += completeBytes;
      }
    } else {
      state._byteOffset += completeBytes;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function parseSessionJsonl(
  filePath: string,
  settings: ClaudeSettings,
  settingsCacheKey: string,
  mtimeMs: number,
  fileSize: number,
  projectDir: string,
  projectLabel: string,
  tasksMtimeMs?: number,
  subagentMtimeMs?: number,
  prevInfo?: SessionInfo,
): SessionInfo | null {
  try {
    const previous = prevInfo as CachedSessionInfo | undefined;
    let state = previous?._parseState && previous._parseState._byteOffset > 0 && previous._parseState._byteOffset <= (prevInfo?.fileSize ?? -1) && fileSize >= (prevInfo?.fileSize ?? -1)
      ? cloneParseState(previous._parseState)
      : createEmptyParseState();
    if (!readSessionLines(filePath, fileSize, state)) {
      state = createEmptyParseState();
      if (!readSessionLines(filePath, fileSize, state)) { return null; }
    }

    const isActiveTurn = state.lastUserIdx > state.lastAssistantIdx || state.lastStopReason === 'tool_use';

    if (!state.lastUsage) { return null; }

    // Subagent usage: parse subagent JSONL files directly (new format, ~2.1.89+)
    // Falls back gracefully if no subagent dir exists or if legacy progress entries were found
    const subagentCountedMessageIds = new Set(state.countedMessageIds);
    const subagent = parseSubagentUsage(filePath, subagentCountedMessageIds, previous?._subagentFileCache);
    if (subagentMtimeMs !== undefined) { subagent.maxMtimeMs = subagentMtimeMs; }
    let totalInput = state.totalInput;
    let totalCacheRead = state.totalCacheRead;
    let totalCacheCreation = state.totalCacheCreation;
    let totalOutput = state.totalOutput;
    let totalCacheWrite5m = state.totalCacheWrite5m;
    let totalCacheWrite1h = state.totalCacheWrite1h;
    let totalCacheWriteNoBreakdown = state.totalCacheWriteNoBreakdown;
    if (subagent.count > 0) {
      // Add subagent usage even when legacy progress entries also exist in the main
      // JSONL (e.g. a session spanning a Claude Code update): subagentCountedMessageIds
      // is seeded from state.countedMessageIds, so parseSubagentUsage's message-ID
      // dedup already prevents double-counting anything already tallied above.
      totalInput += subagent.input;
      totalCacheRead += subagent.cacheRead;
      totalCacheCreation += subagent.cacheCreation;
      totalOutput += subagent.output;
      totalCacheWrite5m += subagent.cacheWrite5m;
      totalCacheWrite1h += subagent.cacheWrite1h;
      totalCacheWriteNoBreakdown += subagent.cacheWriteNoBreakdown;
    }
    // I-10 merged usage totals across the legacy progress-entry format and the newer
    // subagent-file format (see the subagent.count block above), but left
    // totalAgentCount/agentTimestamps/subagentActivities on an exclusive either/or
    // branch. A session spanning both formats (e.g. mid Claude Code update) needs the
    // same merge here, or the newer-format agents silently drop out of agent
    // count/active-status/Graph display. Dedup by agentId where both formats supply
    // one so the same agent isn't double-counted; subagent-file entries are kept over
    // legacy entries on a collision since they additionally carry toolUseId (used by
    // getSubagentState's completion check).
    const legacyActivities: SubagentActivity[] = [...state.agentLastSeen.entries()]
      .map(([agentId, lastActivityMs]) => ({ agentId, toolUseId: null, lastActivityMs }));
    const mergedActivities: SubagentActivity[] = [];
    const seenAgentIds = new Set<string>();
    for (const activity of [...subagent.activities, ...legacyActivities]) {
      if (activity.agentId) {
        if (seenAgentIds.has(activity.agentId)) { continue; }
        seenAgentIds.add(activity.agentId);
      }
      mergedActivities.push(activity);
    }
    const totalAgentCount = mergedActivities.length;
    const agentTimestamps = mergedActivities.map(a => a.lastActivityMs);
    const subagentActivities = mergedActivities;

    const inputTokens = state.lastUsage.input_tokens || 0;
    const cacheReadTokens = state.lastUsage.cache_read_input_tokens || 0;
    const cacheCreationTokens = state.lastUsage.cache_creation_input_tokens || 0;
    const contextUsed = inputTokens + cacheCreationTokens + cacheReadTokens;
    const explicit1m = /[\[(]1[mM][\])]$/.test(state.lastModel) ? 1_000_000 : null;
    // Evidence-based 1M: session held >200K tokens at some point (current peak or pre-compact).
    // Role: the 1M promotion used when the Models API can't be read (apiContextMax is null)
    // and no explicit [1m]/settings override applies — it only promotes upward, so it never
    // hides compact pressure. This is distinct from the `Math.max(contextMax,
    // state.maxContextSeen)` floor applied after the full chain resolves below: that floor
    // is a lower bound enforced on every resolution path (including apiContextMax), not
    // itself a promotion mechanism.
    const evidenced1m = (state.maxContextSeen > DEFAULT_CONTEXT_SIZE || state.hasCompactAbove200K) ? 1_000_000 : null;
    // Settings-based 1M: weaker than evidenced (reflects the CURRENT settings model, not the
    // model in effect when this session was created). Applied only when the session's model
    // matches the settings model carrying [1m].
    // Promotion only: the override must exceed the model's own documented window to avoid
    // demoting a model whose default is already 1M.
    const modelBaseWindow = getContextMaxForModel(state.lastModel);
    const settingsMatch1m = (settings.contextWindowOverride !== null
      && settings.contextWindowOverride > modelBaseWindow
      && isExtendedContextModel(state.lastModel)
      && settings.settingsModelNormalized !== null
      && settingsModelsMatch(state.lastModel, settings.settingsModelNormalized))
      ? settings.contextWindowOverride : null;
    const apiContextMax = getMaxInputTokens(state.lastModel);
    const hasExplicitOverride = settings.maxTokensOverride !== null;
    let contextMax = settings.maxTokensOverride
      ?? explicit1m
      ?? apiContextMax
      ?? evidenced1m
      ?? settingsMatch1m
      ?? modelBaseWindow;
    // An explicitly configured compact window changes the meaning of preTokens:
    // it represents that user-selected window rather than the model context window.
    const hasConfiguredAutoCompactWindow = (
      settings.autoCompactWindowEnv !== null && settings.autoCompactWindowEnv !== undefined
    ) || (
      settings.autoCompactWindow !== null && settings.autoCompactWindow !== undefined
    );
    if (!hasExplicitOverride && !hasConfiguredAutoCompactWindow && state.latestAutoCompactPreTokens !== null) {
      // Inverse of computeAutoCompact's forward calculation (effectiveWindow = window -
      // outputReserve; compactThreshold = effectiveWindow - COMPACT_BUFFER), so preTokens
      // + OUTPUT_RESERVE_CAP + COMPACT_BUFFER approximates the window that produced it.
      // Exact only when outputReserve == OUTPUT_RESERVE_CAP; models whose max output is
      // below the 20K cap (outputReserve = Math.min(maxOutputTokens, OUTPUT_RESERVE_CAP))
      // will read as a slightly larger inferredWindow than their true effective window.
      const inferredWindow = state.latestAutoCompactPreTokens + OUTPUT_RESERVE_CAP + COMPACT_BUFFER;
      // A large gap is a reliable sign that Claude Code is running a smaller
      // effective window. Keep this conservative so ordinary threshold variance
      // (including a later 300K boundary) cannot demote a 1M session.
      if (contextMax >= inferredWindow * 2) { contextMax = inferredWindow; }
    }
    // A physically observed context is a lower bound for the window itself.
    contextMax = Math.max(contextMax, state.maxContextSeen);
    const autoCompactWindowSettings = settings.autoCompactWindow ?? null;
    const autoCompact = computeAutoCompact(state.lastModel, contextMax, {
      autoCompactWindowEnv: settings.autoCompactWindowEnv ?? undefined,
      autoCompactWindowSettings: autoCompactWindowSettings ?? undefined,
      autoCompactEnabled: settings.autoCompactEnabled,
      maxOutputTokensEnv: settings.maxOutputTokensEnv ?? undefined,
      disableCompact: settings.disableCompact,
      disableAutoCompact: settings.disableAutoCompact,
    });
    const compactThreshold = autoCompact.compactThreshold;
    const usageBase = autoCompact.active ? compactThreshold : autoCompact.effectiveWindow;
    const usagePercent = (contextUsed / usageBase) * 100;
    const tokensUntilCompact = Math.max(0, compactThreshold - contextUsed);

    const sessionName = state.customTitle
      || state.aiTitle
      || cleanSessionName(
        state.firstUserText
          ? state.firstUserText.replace(/\n/g, ' ').trim()
          : (state.sessionId ? state.sessionId.substring(0, 8) : path.basename(filePath, '.jsonl').substring(0, 8))
      );

    let activeAgentCount = 0;
    const now = Date.now();
    for (const activity of subagentActivities) {
      if (getSubagentState(activity.agentId, activity.toolUseId, activity.lastActivityMs, state.completedAgentIds, state.finishedAgentToolUseIds, now) === 'running') {
        activeAgentCount++;
      }
    }

    const tasksMtime = tasksMtimeMs ?? getTasksMaxMtime(projectDir, state.sessionId);
    const effectiveMtime = Math.max(mtimeMs, subagent.maxMtimeMs, tasksMtime);
    const info: CachedSessionInfo = {
      sessionId: state.sessionId, sessionName, model: state.lastModel,
      contextUsed, contextMax, usagePercent,
      messageCount: state.assistantCount,
      autocompactPct: settings.autocompactPct, tokensUntilCompact,
      autoCompactActive: autoCompact.active,
      autoCompactSource: autoCompact.source,
      autoCompactWindow: autoCompact.window,
      effectiveWindow: autoCompact.effectiveWindow,
      compactThreshold,
      outputReserve: autoCompact.outputReserve,
      mtimeMs, displayMtimeMs: effectiveMtime, fileSize, filePath,
      projectDir, projectLabel,
      isActiveTurn, lastStopReason: state.lastStopReason,
      status: getSessionStatus(effectiveMtime, mtimeMs, isActiveTurn, true, state.sessionId),
      inputTokens: totalInput, cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation, outputTokens: totalOutput,
      totalCacheWrite5m, totalCacheWrite1h, totalCacheWriteNoBreakdown,
      compactCount: state.compactCount,
      compactAutoCount: state.compactAutoCount,
      compactManualCount: state.compactManualCount,
      lastCompactFreed: state.lastCompactFreed,
      activeAgentCount, totalAgentCount, _agentTimestamps: agentTimestamps,
      _subagentActivities: subagentActivities,
      // cloneParseState creates new sets, so sharing these references is safe.
      _completedAgentIds: state.completedAgentIds,
      _finishedAgentToolUseIds: state.finishedAgentToolUseIds,
      tasksMtimeMs: tasksMtime,
      subagentMtimeMs: subagent.maxMtimeMs,
      settingsCacheKey,
      _parseState: state,
      _subagentFileCache: subagent.fileCache,
    };
    return info;
  } catch { return null; }
}

// ─── Session cache ───

const sessionCache = new Map<string, CachedSessionInfo>();

export function clearSessionCache(): void {
  sessionCache.clear();
}

export function findAllSessionsCached(
  projectsDir: string,
  settings: ClaudeSettings,
  inactiveMs: number,
  keepSessionIds: ReadonlySet<string> = new Set(),
): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  const now = Date.now();
  const seenPaths = new Set<string>();
  const settingsCacheKey = getSettingsCacheKey(settings);

  try {
    for (const dirent of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) { continue; }
      const projectPath = path.join(projectsDir, dirent.name);
      const projectDir = dirent.name;
      const projectLabel = decodeProjectDir(projectDir);

      for (const file of fs.readdirSync(projectPath)) {
        if (!file.endsWith('.jsonl')) { continue; }
        const filePath = path.join(projectPath, file);
        try {
          const stat = fs.statSync(filePath);
          const mtime = stat.mtimeMs;
          const size = stat.size;

          // Effective mtime includes subagent and tasks dir activity
          const sessionId = path.basename(file, '.jsonl');
          const tasksMtime = getTasksMaxMtime(projectDir, sessionId);
          const subagentMtime = getSubagentMaxMtime(filePath);
          const effectiveMtime = Math.max(mtime, subagentMtime, tasksMtime);

          if (now - effectiveMtime > inactiveMs && !keepSessionIds.has(sessionId)) {
            sessionCache.delete(filePath);
            continue;
          }
          seenPaths.add(filePath);

          const cached = sessionCache.get(filePath);
          const subagentChanged = cached ? subagentMtime !== cached.subagentMtimeMs : false;
          if (
            cached &&
            cached.mtimeMs === mtime &&
            cached.fileSize === size &&
            cached.settingsCacheKey === settingsCacheKey &&
            !subagentChanged
          ) {
            const activityChanged = tasksMtime !== cached.tasksMtimeMs;
            cached.tasksMtimeMs = tasksMtime;
            cached.status = getSessionStatus(effectiveMtime, mtime, cached.isActiveTurn, activityChanged, cached.sessionId);
            cached.displayMtimeMs = effectiveMtime;
            // Recalculate activeAgentCount on cache hit (time-dependent)
            cached.activeAgentCount = countRunningSubagents(cached, now);
            sessions.push(cached);
            continue;
          }

          const info = parseSessionJsonl(filePath, settings, settingsCacheKey, mtime, size, projectDir, projectLabel, tasksMtime, subagentMtime, cached);
          if (info) {
            sessionCache.set(filePath, info as CachedSessionInfo);
            sessions.push(info);
          } else {
            sessionCache.delete(filePath);
          }
        } catch { continue; }
      }
    }
  } catch { /* ignore */ }

  for (const key of sessionCache.keys()) {
    if (!seenPaths.has(key)) { sessionCache.delete(key); }
  }

  sessions.sort((a, b) => b.displayMtimeMs - a.displayMtimeMs);
  return sessions;
}

export function findDirtySessionsCached(
  projectsDir: string,
  settings: ClaudeSettings,
  inactiveMs: number,
  keepSessionIds: ReadonlySet<string>,
  previousSessions: SessionInfo[],
  dirtyPaths: ReadonlySet<string>,
): SessionInfo[] {
  if (previousSessions.length === 0 || dirtyPaths.size === 0) {
    return findAllSessionsCached(projectsDir, settings, inactiveMs, keepSessionIds);
  }

  const normalizedProjectsDir = path.resolve(projectsDir);
  const jsonlPaths = [...dirtyPaths]
    .map(p => path.resolve(p))
    .filter(p => p.endsWith('.jsonl') && path.dirname(path.dirname(p)) === normalizedProjectsDir);
  if (jsonlPaths.length !== dirtyPaths.size) {
    return findAllSessionsCached(projectsDir, settings, inactiveMs, keepSessionIds);
  }

  const now = Date.now();
  const settingsCacheKey = getSettingsCacheKey(settings);
  const byPath = new Map(previousSessions.map(s => [path.resolve(s.filePath), s as SessionInfo]));

  for (const filePath of jsonlPaths) {
    const projectDir = path.basename(path.dirname(filePath));
    const projectLabel = decodeProjectDir(projectDir);
    const sessionId = path.basename(filePath, '.jsonl');
    try {
      const stat = fs.statSync(filePath);
      const tasksMtime = getTasksMaxMtime(projectDir, sessionId);
      const subagentMtime = getSubagentMaxMtime(filePath);
      const effectiveMtime = Math.max(stat.mtimeMs, subagentMtime, tasksMtime);
      if (now - effectiveMtime > inactiveMs && !keepSessionIds.has(sessionId)) {
        sessionCache.delete(filePath);
        byPath.delete(filePath);
        continue;
      }

      const cached = sessionCache.get(filePath);
      const subagentChanged = cached ? subagentMtime !== cached.subagentMtimeMs : false;
      if (
        cached &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.fileSize === stat.size &&
        cached.settingsCacheKey === settingsCacheKey &&
        !subagentChanged
      ) {
        const activityChanged = tasksMtime !== cached.tasksMtimeMs;
        cached.tasksMtimeMs = tasksMtime;
        cached.status = getSessionStatus(effectiveMtime, stat.mtimeMs, cached.isActiveTurn, activityChanged, cached.sessionId);
        cached.displayMtimeMs = effectiveMtime;
        cached.activeAgentCount = countRunningSubagents(cached, now);
        byPath.set(filePath, cached);
        continue;
      }

      const info = parseSessionJsonl(
        filePath, settings, settingsCacheKey, stat.mtimeMs, stat.size,
        projectDir, projectLabel, tasksMtime, subagentMtime, cached,
      );
      if (info) {
        sessionCache.set(filePath, info as CachedSessionInfo);
        byPath.set(filePath, info);
      } else {
        sessionCache.delete(filePath);
        byPath.delete(filePath);
      }
    } catch {
      sessionCache.delete(filePath);
      byPath.delete(filePath);
    }
  }

  const sessions = [...byPath.values()];
  sessions.sort((a, b) => b.displayMtimeMs - a.displayMtimeMs);
  return sessions;
}
