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
}

export type SortMode = 'time' | 'usage' | 'compact';
export type FilterMode = 'all' | 'warning' | 'critical';

// ─── Constants ───

const TASKS_DIR_BASE = path.join(os.tmpdir(), 'claude');
const DEFAULT_CONTEXT_SIZE = 200000;

const SKIP_PREFIXES = [
  'This session is being continued',
  'The user opened the file',
  'The user selected the lines',
  'The user opened a folder',
];

// ─── Helpers ───

export function readClaudeSettings(): ClaudeSettings {
  let maxTokensOverride: number | null = null;
  let autocompactPct = 95;
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')
    );
    if (settings?.maxTokens && typeof settings.maxTokens === 'number') {
      maxTokensOverride = settings.maxTokens;
    }
    const override = settings?.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    if (override) {
      const n = parseInt(override, 10);
      if (!isNaN(n)) { autocompactPct = n; }
    }
  } catch { /* ignore */ }
  return { maxTokensOverride, autocompactPct };
}

// Built-in context limits by model ID and short alias.
// Aliases (opus/sonnet/haiku) map to the current default version.
// Update aliases when Anthropic changes the default model version.
// (2026-03-19 verified against docs.anthropic.com)
const CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4-5': 200_000,
  // Short aliases → current default version
  'opus': 1_000_000,
  'sonnet': 1_000_000,
  'haiku': 200_000,
};

// API pricing per million tokens (2026-03-24 verified against docs.anthropic.com)
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
};

function normalizeModelId(model: string): string {
  return model.replace(/[\[(]1[mM][\])]$/, '').replace(/-\d{8}$/, '');
}

export function getContextMaxForModel(model: string): number {
  const normalized = normalizeModelId(model);
  return CONTEXT_LIMITS[normalized] ?? DEFAULT_CONTEXT_SIZE;
}

export function formatTokens(n: number): string {
  if (n >= 1000000) { return (n / 1000000).toFixed(1) + 'M'; }
  if (n >= 1000) { return (n / 1000).toFixed(1) + 'k'; }
  return String(n);
}

export function calculateCost(s: SessionInfo): number | null {
  const key = shortenModel(s.model);
  const pricing = MODEL_PRICING[key];
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

// ─── Subagent mtime ───

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
    let lastUserIdx = -1;
    let lastAssistantIdx = -1;
    let lastStopReason = '';
    let lineIdx = 0;
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
          aiTitle = data.customTitle;
        } else if (data.type === 'ai-title' && data.aiTitle) {
          aiTitle = data.aiTitle;
        }
        if (data.type === 'assistant' && data.message?.usage) {
          lastUsage = data.message.usage;
          lastModel = data.message.model || lastModel;
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
          assistantCount++;
        }
        // Compact detection: explicit compact_boundary system entry (authoritative)
        if (data.type === 'system' && data.subtype === 'compact_boundary') {
          compactCount++;
          if (data.compactMetadata?.trigger === 'manual') { compactManualCount++; } else { compactAutoCount++; }
          lastCompactFreed = data.compactMetadata?.preTokens || 0;
          compactBoundaryPending = true; // suppress next heuristic drop
        }
        // Agent activity detection
        if (data.type === 'progress' && data.data?.type === 'agent_progress' && data.data?.agentId) {
          agentIds.add(data.data.agentId);
          const ts = new Date(data.timestamp || 0).getTime();
          agentLastSeen.set(data.data.agentId, ts);
          // Accumulate agent tokens for cost calculation
          const agentUsage = data.data?.message?.message?.usage;
          if (agentUsage) {
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

    const inputTokens = lastUsage.input_tokens || 0;
    const cacheReadTokens = lastUsage.cache_read_input_tokens || 0;
    const cacheCreationTokens = lastUsage.cache_creation_input_tokens || 0;
    const contextUsed = inputTokens + cacheCreationTokens + cacheReadTokens;
    const contextMax = settings.maxTokensOverride ?? getContextMaxForModel(lastModel);
    const compactThreshold = Math.max(1, Math.floor(contextMax * settings.autocompactPct / 100));
    const usagePercent = (contextUsed / compactThreshold) * 100;
    const tokensUntilCompact = Math.max(0, compactThreshold - contextUsed);

    const sessionName = aiTitle
      || cleanSessionName(
        firstUserText
          ? firstUserText.replace(/\n/g, ' ').trim()
          : (sessionId ? sessionId.substring(0, 8) : path.basename(filePath, '.jsonl').substring(0, 8))
      );

    const agentTimestamps = [...agentLastSeen.values()];
    let activeAgentCount = 0;
    const now = Date.now();
    for (const ts of agentTimestamps) {
      if (now - ts < 15000) { activeAgentCount++; }
    }

    const tasksMtime = getTasksMaxMtime(projectDir, sessionId);
    const effectiveMtime = Math.max(mtimeMs, getSubagentMaxMtime(filePath), tasksMtime);
    return {
      sessionId, sessionName, model: lastModel,
      contextUsed, contextMax, usagePercent,
      messageCount: assistantCount,
      autocompactPct: settings.autocompactPct, tokensUntilCompact,
      mtimeMs, displayMtimeMs: effectiveMtime, fileSize, filePath,
      projectDir, projectLabel,
      isActiveTurn, lastStopReason,
      status: getSessionStatus(effectiveMtime, mtimeMs, isActiveTurn, true, sessionId),
      inputTokens: totalInput, cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation, outputTokens: totalOutput,
      totalCacheWrite5m, totalCacheWrite1h, totalCacheWriteNoBreakdown,
      compactCount, compactAutoCount, compactManualCount, lastCompactFreed,
      activeAgentCount, totalAgentCount: agentIds.size, _agentTimestamps: agentTimestamps,
      tasksMtimeMs: tasksMtime,
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
          const effectiveMtime = Math.max(mtime, getSubagentMaxMtime(filePath), tasksMtime);

          if (now - effectiveMtime > inactiveMs && !keepSessionIds.has(sessionId)) {
            sessionCache.delete(filePath);
            continue;
          }
          seenPaths.add(filePath);

          const cached = sessionCache.get(filePath);
          if (cached && cached.mtimeMs === mtime && cached.fileSize === size) {
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

          const info = parseSessionJsonl(filePath, settings, mtime, size, projectDir, projectLabel);
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
