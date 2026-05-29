import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
  cleanupPeriodDays: number;
  autoCompactWindow?: number | null;
  autoCompactEnabled?: boolean;
  autoCompactWindowEnv?: number | null;
  maxOutputTokensEnv?: number | null;
  disableCompact?: boolean;
  disableAutoCompact?: boolean;
  claudeCodeRemote?: boolean;
  redwood2AutoCompactWindow?: number | null;
  redwood3?: boolean;
}

export type SessionStatus = 'thinking' | 'waiting' | 'idle' | 'inactive';

// ─── Hook-driven state markers ───

const MONITOR_DIR = path.join(os.homedir(), '.claude', 'ide', 'monitor');

function hookStatePath(sessionId: string): string {
  return path.join(MONITOR_DIR, sessionId + '.state');
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
  /** @internal tasks dir max mtime for activity detection */
  tasksMtimeMs: number;
  /** @internal subagent dir max mtime for cache invalidation */
  subagentMtimeMs: number;
  /** @internal settings fingerprint for cache invalidation */
  settingsCacheKey: string;
}

export type SortMode = 'time' | 'usage' | 'compact';
export type FilterMode = 'all' | 'warning' | 'critical';
export type ModelFilter = 'all' | 'opus' | 'sonnet' | 'haiku';
export type GroupMode = 'none' | 'project' | 'status' | 'custom';
export type AutoCompactSource = 'env' | 'settings' | 'default';

export interface AutoCompactSettings {
  autoCompactWindowEnv?: number;
  autoCompactWindowSettings?: number;
  autoCompactEnabled?: boolean;
  maxOutputTokensEnv?: number;
  disableCompact?: boolean;
  disableAutoCompact?: boolean;
  claudeCodeRemote?: boolean;
  redwood3?: boolean;
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

function getSettingsCacheKey(settings: ClaudeSettings): string {
  return JSON.stringify({
    maxTokensOverride: settings.maxTokensOverride,
    autocompactPct: settings.autocompactPct,
    contextWindowOverride: settings.contextWindowOverride,
    autoCompactWindow: settings.autoCompactWindow ?? null,
    autoCompactEnabled: settings.autoCompactEnabled !== false,
    autoCompactWindowEnv: settings.autoCompactWindowEnv ?? null,
    maxOutputTokensEnv: settings.maxOutputTokensEnv ?? null,
    disableCompact: !!settings.disableCompact,
    disableAutoCompact: !!settings.disableAutoCompact,
    claudeCodeRemote: !!settings.claudeCodeRemote,
    redwood2AutoCompactWindow: settings.redwood2AutoCompactWindow ?? null,
    redwood3: !!settings.redwood3,
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
  let claudeCodeRemote = false;
  let redwood2AutoCompactWindow: number | null = null;
  let redwood3 = false;
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
  claudeCodeRemote = envTruthy(envValue('CLAUDE_CODE_REMOTE', settingsEnv));

  // Detect context window override from model settings and GrowthBook feature flag.
  // Priority: settings.local.json model [1m] > settings.json model [1m] > GrowthBook flag
  if (contextWindowOverride === null) {
    const re1m = /[\[(]1[mM][\])]/;
    const localSettingsPath = path.join(os.homedir(), '.claude', 'settings.local.json');
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      const local = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
      if (typeof local?.model === 'string' && re1m.test(local.model)) {
        contextWindowOverride = 1_000_000;
      }
    } catch { /* ignore */ }
    if (contextWindowOverride === null) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (typeof settings?.model === 'string' && re1m.test(settings.model)) {
          contextWindowOverride = 1_000_000;
        }
      } catch { /* ignore */ }
    }
    if (contextWindowOverride === null) {
      try {
        const claudeJson = JSON.parse(
          fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')
        );
        const features = claudeJson?.cachedGrowthBookFeatures;
        const hw = features?.tengu_hawthorn_window;
        if (typeof hw === 'number' && hw > 0) {
          contextWindowOverride = hw;
        }
      } catch { /* ignore */ }
    }
  }

  try {
    const claudeJson = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')
    );
    const features = claudeJson?.cachedGrowthBookFeatures;
    redwood2AutoCompactWindow = parsePositiveNumber(features?.tengu_amber_redwood2);
    redwood3 = envTruthy(features?.tengu_amber_redwood3);
  } catch { /* ignore */ }

  return {
    maxTokensOverride, autocompactPct, contextWindowOverride,
    cleanupPeriodDays,
    autoCompactWindow, autoCompactEnabled,
    autoCompactWindowEnv, maxOutputTokensEnv,
    disableCompact, disableAutoCompact, claudeCodeRemote,
    redwood2AutoCompactWindow, redwood3,
  };
}

// Model info: base context size and whether the model supports extended (1M) context.
// The base context is the default without [1m] suffix; extended context requires
// the [1m] suffix which triggers the API beta header context-1m-2025-08-07.
// Aliases (opus/sonnet/haiku) map to the current default version.
// (2026-04-17 verified against docs.anthropic.com)
interface ModelInfo {
  contextSize: number;
  supportsExtended: boolean;
}

const MODEL_INFO: Record<string, ModelInfo> = {
  'claude-opus-4-8':   { contextSize: 200_000, supportsExtended: true },
  'claude-opus-4-7':   { contextSize: 200_000, supportsExtended: true },
  'claude-opus-4-6':   { contextSize: 200_000, supportsExtended: true },
  'claude-sonnet-4-6': { contextSize: 200_000, supportsExtended: true },
  'claude-opus-4-5':   { contextSize: 200_000, supportsExtended: false },
  'claude-opus-4-1':   { contextSize: 200_000, supportsExtended: false },
  'claude-opus-4':     { contextSize: 200_000, supportsExtended: false },
  'claude-sonnet-4-5': { contextSize: 200_000, supportsExtended: false },
  'claude-sonnet-4':   { contextSize: 200_000, supportsExtended: false },
  'claude-haiku-4-5':  { contextSize: 200_000, supportsExtended: false },
  // Short aliases → current default version
  'opus':   { contextSize: 200_000, supportsExtended: true },
  'sonnet': { contextSize: 200_000, supportsExtended: true },
  'haiku':  { contextSize: 200_000, supportsExtended: false },
};

// API pricing per million tokens (2026-04-17 verified against docs.anthropic.com)
// Aliases (opus/sonnet/haiku) apply to the current default version and any newer
// model that shares the alias's pricing. Per-ID entries override the alias for
// legacy versions whose pricing differs (e.g. Opus 4.1 is 3x the Opus 4.6 rate).
interface ModelPricing {
  inputPerMToken: number;
  cacheWrite5mPerMToken: number;
  cacheWrite1hPerMToken: number;
  cacheReadPerMToken: number;
  outputPerMToken: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'opus': { inputPerMToken: 5, cacheWrite5mPerMToken: 6.25, cacheWrite1hPerMToken: 10, cacheReadPerMToken: 0.5, outputPerMToken: 25 },
  'sonnet': { inputPerMToken: 3, cacheWrite5mPerMToken: 3.75, cacheWrite1hPerMToken: 6, cacheReadPerMToken: 0.3, outputPerMToken: 15 },
  'haiku': { inputPerMToken: 1, cacheWrite5mPerMToken: 1.25, cacheWrite1hPerMToken: 2, cacheReadPerMToken: 0.1, outputPerMToken: 5 },
  // Legacy Opus versions priced 3x higher than Opus 4.6+. Listed explicitly so
  // the alias fallback does not underprice them.
  'claude-opus-4-1': { inputPerMToken: 15, cacheWrite5mPerMToken: 18.75, cacheWrite1hPerMToken: 30, cacheReadPerMToken: 1.5, outputPerMToken: 75 },
  'claude-opus-4': { inputPerMToken: 15, cacheWrite5mPerMToken: 18.75, cacheWrite1hPerMToken: 30, cacheReadPerMToken: 1.5, outputPerMToken: 75 },
};

function normalizeModelId(model: string): string {
  return model.replace(/[\[(]1[mM][\])]$/, '').replace(/-\d{8}$/, '');
}

function lookupPricing(model: string): ModelPricing | undefined {
  return MODEL_PRICING[normalizeModelId(model)] ?? MODEL_PRICING[shortenModel(model)];
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getDefaultMaxOutputTokens(model: string): number {
  const normalized = normalizeModelId(model);
  if (
    normalized === 'claude-opus-4-8' ||
    normalized === 'claude-opus-4-7' ||
    normalized === 'claude-opus-4-6'
  ) {
    return 64_000;
  }
  return 32_000;
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
  const local = !settings.claudeCodeRemote;
  const hasConfiguredWindow = source === 'env' || source === 'settings';
  const active = !!autoCompactEnabled && (!local || !!settings.redwood3 || hasConfiguredWindow);

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

export function formatTokens(n: number): string {
  if (n >= 1000000) { return (n / 1000000).toFixed(1) + 'M'; }
  if (n >= 1000) { return (n / 1000).toFixed(1) + 'k'; }
  return String(n);
}

export function calculateCost(s: SessionInfo): number | null {
  // Prefer exact normalized model ID (covers legacy versions with distinct pricing),
  // then fall back to the family alias (opus/sonnet/haiku) for current-gen models.
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

// ��── Subagent parsing ───

interface SubagentSummary {
  maxMtimeMs: number;
  count: number;
  timestamps: number[];
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteNoBreakdown: number;
}

function getSubagentMaxMtime(sessionFilePath: string): number {
  try {
    const sessionId = path.basename(sessionFilePath, '.jsonl');
    const subagentDir = path.join(path.dirname(sessionFilePath), sessionId, 'subagents');
    let maxMtime = 0;
    for (const file of fs.readdirSync(subagentDir)) {
      if (!file.endsWith('.jsonl')) { continue; }
      try {
        const stat = fs.statSync(path.join(subagentDir, file));
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

function parseSubagentUsage(sessionFilePath: string, countedMessageIds: Set<string>): SubagentSummary {
  const result: SubagentSummary = {
    maxMtimeMs: 0, count: 0, timestamps: [],
    input: 0, cacheRead: 0, cacheCreation: 0, output: 0,
    cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteNoBreakdown: 0,
  };
  try {
    const sessionId = path.basename(sessionFilePath, '.jsonl');
    const subagentDir = path.join(path.dirname(sessionFilePath), sessionId, 'subagents');
    for (const file of fs.readdirSync(subagentDir)) {
      if (!file.endsWith('.jsonl')) { continue; }
      const fp = path.join(subagentDir, file);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs > result.maxMtimeMs) { result.maxMtimeMs = stat.mtimeMs; }
        result.count++;
        result.timestamps.push(stat.mtimeMs);
        for (const line of fs.readFileSync(fp, 'utf8').trim().split('\n')) {
          if (!line.trim()) { continue; }
          try {
            const data = JSON.parse(line);
            if (data.type === 'assistant' && data.message?.usage) {
              if (!shouldCountMessageUsage(data.message.id, countedMessageIds)) { continue; }
              const u = data.message.usage;
              result.input += u.input_tokens || 0;
              result.cacheRead += u.cache_read_input_tokens || 0;
              result.cacheCreation += u.cache_creation_input_tokens || 0;
              result.output += u.output_tokens || 0;
              const e5m = u.cache_creation?.ephemeral_5m_input_tokens || 0;
              const e1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
              if (e5m > 0 || e1h > 0) {
                result.cacheWrite5m += e5m;
                result.cacheWrite1h += e1h;
              } else {
                result.cacheWriteNoBreakdown += u.cache_creation_input_tokens || 0;
              }
            }
          } catch { /* skip line */ }
        }
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

function parseSessionJsonl(
  filePath: string,
  settings: ClaudeSettings,
  settingsCacheKey: string,
  mtimeMs: number,
  fileSize: number,
  projectDir: string,
  projectLabel: string,
): SessionInfo | null {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    let lastUsage: Usage | null = null;
    let lastModel = '';
    let totalInput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;
    let totalOutput = 0;
    let totalCacheWrite5m = 0;
    let totalCacheWrite1h = 0;
    let totalCacheWriteNoBreakdown = 0;
    let compactCount = 0;
    let compactAutoCount = 0;
    let compactManualCount = 0;
    let lastCompactFreed = 0;
    let prevContext = 0;
    let compactBoundaryPending = false;
    const agentIds = new Set<string>();
    const agentLastSeen = new Map<string, number>();
    let assistantCount = 0;
    let sessionId = '';
    let firstUserText = '';
    let aiTitle = '';
    let customTitle = '';
    let lastUserIdx = -1;
    let lastAssistantIdx = -1;
    let lastStopReason = '';
    let lineIdx = 0;
    const countedMessageIds = new Set<string>();
    for (const line of lines) {
      if (!line.trim()) { lineIdx++; continue; }
      try {
        const data = JSON.parse(line);
        if (data.type === 'user') { lastUserIdx = lineIdx; }
        if (data.type === 'assistant') {
          lastAssistantIdx = lineIdx;
          if (data.message?.stop_reason) { lastStopReason = data.message.stop_reason; }
        }
        if (data.sessionId && !sessionId) { sessionId = data.sessionId; }
        if (data.type === 'custom-title' && data.customTitle) {
          customTitle = data.customTitle;
        } else if (data.type === 'ai-title' && data.aiTitle) {
          aiTitle = data.aiTitle;
        }
        if (data.type === 'assistant' && data.message?.usage) {
          lastUsage = data.message.usage;
          lastModel = data.message.model || lastModel;
          const countUsage = shouldCountMessageUsage(data.message.id, countedMessageIds);
          if (countUsage) {
            totalInput += data.message.usage.input_tokens || 0;
            totalCacheRead += data.message.usage.cache_read_input_tokens || 0;
            totalCacheCreation += data.message.usage.cache_creation_input_tokens || 0;
            totalOutput += data.message.usage.output_tokens || 0;
            // Cache write breakdown: track separately for accurate cost calculation
            const e5m = data.message.usage.cache_creation?.ephemeral_5m_input_tokens || 0;
            const e1h = data.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
            if (e5m > 0 || e1h > 0) {
              totalCacheWrite5m += e5m;
              totalCacheWrite1h += e1h;
            } else {
              totalCacheWriteNoBreakdown += data.message.usage.cache_creation_input_tokens || 0;
            }
          }
          // Compact detection: heuristic fallback for older Claude Code versions without compact_boundary
          const ctx = (data.message.usage.input_tokens || 0) +
                      (data.message.usage.cache_creation_input_tokens || 0) +
                      (data.message.usage.cache_read_input_tokens || 0);
          if (ctx > 0) {
            if (prevContext > 20000 && ctx < prevContext * 0.7 && !compactBoundaryPending) {
              compactCount++;
              compactAutoCount++; // heuristic-detected compacts are assumed auto
              lastCompactFreed = prevContext - ctx;
            }
            prevContext = ctx;
            compactBoundaryPending = false;
          }
          if (countUsage) { assistantCount++; }
        }
        // Compact detection: explicit compact_boundary system entry (authoritative)
        if (data.type === 'system' && data.subtype === 'compact_boundary') {
          compactCount++;
          if (data.compactMetadata?.trigger === 'manual') { compactManualCount++; } else { compactAutoCount++; }
          lastCompactFreed = data.compactMetadata?.preTokens || 0;
          compactBoundaryPending = true; // suppress next heuristic drop
        }
        // Agent activity detection (legacy: progress entries in main JSONL, pre ~2.1.89)
        if (data.type === 'progress' && data.data?.type === 'agent_progress' && data.data?.agentId) {
          agentIds.add(data.data.agentId);
          const ts = new Date(data.timestamp || 0).getTime();
          agentLastSeen.set(data.data.agentId, ts);
          const agentUsage = data.data?.message?.message?.usage;
          if (agentUsage) {
            const agentMessageId = data.data?.message?.message?.id;
            if (shouldCountMessageUsage(agentMessageId, countedMessageIds)) {
              totalInput += agentUsage.input_tokens || 0;
              totalCacheRead += agentUsage.cache_read_input_tokens || 0;
              totalCacheCreation += agentUsage.cache_creation_input_tokens || 0;
              totalOutput += agentUsage.output_tokens || 0;
              const ae5m = agentUsage.cache_creation?.ephemeral_5m_input_tokens || 0;
              const ae1h = agentUsage.cache_creation?.ephemeral_1h_input_tokens || 0;
              if (ae5m > 0 || ae1h > 0) {
                totalCacheWrite5m += ae5m;
                totalCacheWrite1h += ae1h;
              } else {
                totalCacheWriteNoBreakdown += agentUsage.cache_creation_input_tokens || 0;
              }
            }
          }
        }
        if (!firstUserText && data.type === 'user' && data.message?.content) {
          const text = extractUserText(data.message.content);
          if (text && !isSkippableText(text)) {
            firstUserText = text;
          }
        }
      } catch { /* skip */ }
      lineIdx++;
    }

    const isActiveTurn = lastUserIdx > lastAssistantIdx || lastStopReason === 'tool_use';

    if (!lastUsage) { return null; }

    // Subagent usage: parse subagent JSONL files directly (new format, ~2.1.89+)
    // Falls back gracefully if no subagent dir exists or if legacy progress entries were found
    const subagent = parseSubagentUsage(filePath, countedMessageIds);
    if (agentIds.size === 0 && subagent.count > 0) {
      // New format: no progress entries in main JSONL, agent data in subagent files
      totalInput += subagent.input;
      totalCacheRead += subagent.cacheRead;
      totalCacheCreation += subagent.cacheCreation;
      totalOutput += subagent.output;
      totalCacheWrite5m += subagent.cacheWrite5m;
      totalCacheWrite1h += subagent.cacheWrite1h;
      totalCacheWriteNoBreakdown += subagent.cacheWriteNoBreakdown;
    }
    const totalAgentCount = agentIds.size > 0 ? agentIds.size : subagent.count;
    const agentTimestamps = agentIds.size > 0 ? [...agentLastSeen.values()] : subagent.timestamps;

    const inputTokens = lastUsage.input_tokens || 0;
    const cacheReadTokens = lastUsage.cache_read_input_tokens || 0;
    const cacheCreationTokens = lastUsage.cache_creation_input_tokens || 0;
    const contextUsed = inputTokens + cacheCreationTokens + cacheReadTokens;
    const explicit1m = /[\[(]1[mM][\])]$/.test(lastModel) ? 1_000_000 : null;
    const contextMax = settings.maxTokensOverride
      ?? explicit1m
      ?? (isExtendedContextModel(lastModel) ? settings.contextWindowOverride : null)
      ?? getContextMaxForModel(lastModel);
    const autoCompactWindowSettings = settings.autoCompactWindow ?? (normalizeModelId(lastModel) === 'claude-opus-4-8'
      ? settings.redwood2AutoCompactWindow
      : null);
    const autoCompact = computeAutoCompact(lastModel, contextMax, {
      autoCompactWindowEnv: settings.autoCompactWindowEnv ?? undefined,
      autoCompactWindowSettings: autoCompactWindowSettings ?? undefined,
      autoCompactEnabled: settings.autoCompactEnabled,
      maxOutputTokensEnv: settings.maxOutputTokensEnv ?? undefined,
      disableCompact: settings.disableCompact,
      disableAutoCompact: settings.disableAutoCompact,
      claudeCodeRemote: settings.claudeCodeRemote,
      redwood3: settings.redwood3,
    });
    const compactThreshold = autoCompact.compactThreshold;
    const usageBase = autoCompact.active ? compactThreshold : autoCompact.effectiveWindow;
    const usagePercent = (contextUsed / usageBase) * 100;
    const tokensUntilCompact = Math.max(0, compactThreshold - contextUsed);

    const sessionName = customTitle
      || aiTitle
      || cleanSessionName(
        firstUserText
          ? firstUserText.replace(/\n/g, ' ').trim()
          : (sessionId ? sessionId.substring(0, 8) : path.basename(filePath, '.jsonl').substring(0, 8))
      );

    let activeAgentCount = 0;
    const now = Date.now();
    for (const ts of agentTimestamps) {
      if (now - ts < 15000) { activeAgentCount++; }
    }

    const tasksMtime = getTasksMaxMtime(projectDir, sessionId);
    const effectiveMtime = Math.max(mtimeMs, subagent.maxMtimeMs, tasksMtime);
    return {
      sessionId, sessionName, model: lastModel,
      contextUsed, contextMax, usagePercent,
      messageCount: assistantCount,
      autocompactPct: settings.autocompactPct, tokensUntilCompact,
      autoCompactActive: autoCompact.active,
      autoCompactSource: autoCompact.source,
      autoCompactWindow: autoCompact.window,
      effectiveWindow: autoCompact.effectiveWindow,
      compactThreshold,
      outputReserve: autoCompact.outputReserve,
      mtimeMs, displayMtimeMs: effectiveMtime, fileSize, filePath,
      projectDir, projectLabel,
      isActiveTurn, lastStopReason,
      status: getSessionStatus(effectiveMtime, mtimeMs, isActiveTurn, true, sessionId),
      inputTokens: totalInput, cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation, outputTokens: totalOutput,
      totalCacheWrite5m, totalCacheWrite1h, totalCacheWriteNoBreakdown,
      compactCount, compactAutoCount, compactManualCount, lastCompactFreed,
      activeAgentCount, totalAgentCount, _agentTimestamps: agentTimestamps,
      tasksMtimeMs: tasksMtime,
      subagentMtimeMs: subagent.maxMtimeMs,
      settingsCacheKey,
    };
  } catch { return null; }
}

// ─── Session cache ───

const sessionCache = new Map<string, SessionInfo>();

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
            let activeCount = 0;
            for (const ts of cached._agentTimestamps) {
              if (now - ts < 15000) { activeCount++; }
            }
            cached.activeAgentCount = activeCount;
            sessions.push(cached);
            continue;
          }

          const info = parseSessionJsonl(filePath, settings, settingsCacheKey, mtime, size, projectDir, projectLabel);
          if (info) {
            sessionCache.set(filePath, info);
            sessions.push(info);
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
