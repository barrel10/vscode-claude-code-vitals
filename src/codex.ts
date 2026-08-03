import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CodexSessionInfo {
  sessionId: string;
  startTime: number;
  cwd: string;
  model: string;
  status: 'running' | 'completed';
  prompt: string;
  subcommand: 'exec' | 'review' | 'interactive';
  filePath: string;
  mtimeMs: number;
}

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const MAX_HEADER_LINES = 10;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 8 * 1024;
const MAX_TAIL_CHUNKS = 4;
const MAX_HEADER_CACHE_ENTRIES = 1000;
const UNTERMINATED_RUNNING_LIMIT_MS = 30 * 60_000;

let _log: (msg: string) => void = () => {};
export function setCodexLogger(logger: (msg: string) => void): void { _log = logger; }

type CachedCodexHeader = Omit<CodexSessionInfo, 'status'>;

const headerCache = new Map<string, { mtimeMs: number; size: number; header: CachedCodexHeader; terminated: boolean; lastGrowthMs: number }>();

export function getCodexSessionsDir(): string {
  return path.join(CODEX_HOME, 'sessions');
}

export function findRecentCodexSessions(hoursBack: number): CodexSessionInfo[] {
  const sessionsDir = getCodexSessionsDir();
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const files: string[] = [];

  _log(`[codex] sessionsDir=${sessionsDir} hoursBack=${hoursBack}`);
  try {
    collectRolloutFiles(sessionsDir, cutoff, files);
    _log(`[codex] rollout files found: ${files.length}`);
  } catch (e) {
    _log(`[codex] collectRolloutFiles error: ${e}`);
    return [];
  }

  const sessions: CodexSessionInfo[] = [];
  for (const filePath of files) {
    const parsed = parseCodexRolloutHeader(filePath);
    if (parsed) { sessions.push(parsed); }
    else { _log(`[codex] parse failed: ${filePath}`); }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

export function parseCodexRolloutHeader(filePath: string): CodexSessionInfo | null {
  try {
    const stat = fs.statSync(filePath);
    const cached = headerCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return withCurrentStatus(cached.header, cached.terminated, cached.lastGrowthMs);
    }
    // On Windows, mtime can lag behind an actual write for a long-lived session; a
    // changed file size vs. the cached entry is independent evidence of recent
    // activity. A one-shot "sizeChanged" flag only covered the single call that
    // observed the growth — the very next poll's cache-hit path above had no way to
    // recall it, so running/completed flapped every other cycle while mtime stayed
    // stale. lastGrowthMs persists the timestamp of the last observed size change in
    // the cache entry itself so every read path (including the cache hit above) can
    // use it.
    const sizeChanged = cached !== undefined && cached.size !== stat.size;
    const lastGrowthMs = sizeChanged ? Date.now() : (cached?.lastGrowthMs ?? 0);
    const lines = readHeaderLines(filePath, MAX_HEADER_LINES);
    const header = parseHeaderLines(lines, filePath, stat.mtimeMs);
    if (!header) { return null; }
    const terminated = isRolloutTerminated(filePath, stat.size);
    if (headerCache.size > MAX_HEADER_CACHE_ENTRIES) {
      headerCache.clear();
    }
    headerCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, header, terminated, lastGrowthMs });
    return withCurrentStatus(header, terminated, lastGrowthMs);
  } catch {
    return null;
  }
}

function withCurrentStatus(header: CachedCodexHeader, terminated: boolean, lastGrowthMs = 0): CodexSessionInfo {
  return {
    sessionId: header.sessionId,
    startTime: header.startTime,
    cwd: header.cwd,
    model: header.model,
    status: terminated
      ? 'completed'
      : (Date.now() - Math.max(header.mtimeMs, lastGrowthMs) < UNTERMINATED_RUNNING_LIMIT_MS) ? 'running' : 'completed',
    prompt: header.prompt,
    subcommand: header.subcommand,
    filePath: header.filePath,
    mtimeMs: header.mtimeMs,
  };
}
// The tail window may cut the leading line in half at its start boundary.
// When that truncated line can't be parsed and more of the file remains,
// re-read with a larger window (up to MAX_TAIL_CHUNKS chunks) so the
// decisive event isn't missed just because it straddled a chunk boundary.
function isRolloutTerminated(filePath: string, size: number): boolean {
  if (size <= 0) { return false; }

  const fd = fs.openSync(filePath, 'r');
  try {
    for (let chunkCount = 1; chunkCount <= MAX_TAIL_CHUNKS; chunkCount++) {
      const bytesToRead = Math.min(size, MAX_TAIL_BYTES * chunkCount);
      const start = size - bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
      const content = buffer.toString('utf8', 0, bytesRead);
      const lines = content.split(/\r?\n/);

      let needsLargerWindow = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) { continue; }

        let data: any;
        try {
          data = JSON.parse(line);
        } catch {
          if (i === 0 && start > 0 && chunkCount < MAX_TAIL_CHUNKS) {
            needsLargerWindow = true;
            break;
          }
          continue;
        }

        if (data.type === 'event_msg') {
          const payloadType = data.payload?.type;
          if (payloadType === 'token_count') { continue; }
          return payloadType === 'task_complete' || payloadType === 'turn_aborted' || payloadType === 'error';
        }

        return false;
      }

      if (!needsLargerWindow) { return false; }
    }
  } finally {
    fs.closeSync(fd);
  }

  return false;
}

// Rollout files can grow to tens of MB; read only the leading bytes needed
// for the header instead of the whole file. A line truncated at the byte
// cap fails JSON.parse and is skipped, which is acceptable for header use.
function readHeaderLines(filePath: string, maxLines: number): string[] {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const content = buffer.toString('utf8', 0, bytesRead);
    const lines: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) { continue; }
      lines.push(line);
      if (lines.length >= maxLines) { break; }
    }
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

function collectRolloutFiles(dirPath: string, cutoff: number, out: string[]): void {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  dirents.sort((a, b) => b.name.localeCompare(a.name));

  for (const dirent of dirents) {
    const fullPath = path.join(dirPath, dirent.name);
    if (dirent.isDirectory()) {
      collectRolloutFiles(fullPath, cutoff, out);
      continue;
    }
    if (!dirent.isFile() || !/^rollout-.*\.jsonl$/.test(dirent.name)) { continue; }
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs >= cutoff) { out.push(fullPath); }
    } catch { /* skip */ }
  }
}

function parseHeaderLines(lines: string[], filePath: string, mtimeMs: number): CachedCodexHeader | null {
  let sessionId = '';
  let startTime = 0;
  let cwd = '';
  let model = '';
  let prompt = '';
  let subcommand: CodexSessionInfo['subcommand'] = 'interactive';
  let approvalPolicy = '';
  let sandboxPolicy = '';

  for (const line of lines) {
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }

    if (data.type === 'session_meta') {
      const payload = data.payload || {};
      sessionId = stringValue(payload.session_id) || stringValue(payload.id) || sessionId;
      cwd = stringValue(payload.cwd) || cwd;
      startTime = parseTimestamp(payload.timestamp) || parseTimestamp(data.timestamp) || startTime;
      subcommand = payload.source === 'exec' ? 'exec' : 'interactive';
    } else if (data.type === 'turn_context') {
      const payload = data.payload || {};
      model = stringValue(payload.model) || model;
      approvalPolicy = stringValue(payload.approval_policy) || approvalPolicy;
      sandboxPolicy = policyText(payload.sandbox_policy) || sandboxPolicy;
    } else if (data.type === 'event_msg' && !prompt) {
      const payload = data.payload || {};
      if (payload.type === 'user_message' && typeof payload.message === 'string' && !isWrapperText(payload.message)) {
        prompt = truncatePrompt(payload.message);
      }
    } else if (data.type === 'response_item' && !prompt) {
      // Current rollouts put the message directly in payload; older ones nest it under payload.item.
      const payload = data.payload || {};
      const item = payload.item && typeof payload.item === 'object' ? payload.item : payload;
      if (item?.type === 'message' && item.role === 'user') {
        const text = extractInputText(item.content);
        if (text && !isWrapperText(text)) {
          prompt = truncatePrompt(text);
        }
      }
    }
  }

  if (subcommand !== 'exec' && approvalPolicy === 'never' && sandboxPolicy.includes('read')) {
    subcommand = 'review';
  }

  if (!sessionId || !startTime || !cwd) { return null; }

  return {
    sessionId,
    startTime,
    cwd,
    model,
    prompt,
    subcommand,
    filePath,
    mtimeMs,
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function policyText(value: unknown): string {
  if (typeof value === 'string') { return value; }
  if (value === undefined || value === null) { return ''; }
  try { return JSON.stringify(value); } catch { return ''; }
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') { return 0; }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractInputText(content: unknown): string {
  if (typeof content === 'string') { return content; }
  if (!Array.isArray(content)) { return ''; }
  for (const block of content) {
    if (block?.type === 'input_text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return '';
}

// Harness-injected wrappers (AGENTS.md, environment info) are recorded as
// user messages but are not the actual prompt.
export function isWrapperText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<user_instructions')
    || t.startsWith('<environment_context')
    || t.startsWith('<permissions instructions')
    || t.startsWith('# AGENTS.md instructions');
}

function truncatePrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? normalized.substring(0, 80) + '...' : normalized;
}
