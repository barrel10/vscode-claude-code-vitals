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
const MAX_HEADER_CACHE_ENTRIES = 1000;
const RUNNING_THRESHOLD_MS = 120_000;

let _log: (msg: string) => void = () => {};
export function setCodexLogger(logger: (msg: string) => void): void { _log = logger; }

type CachedCodexHeader = Omit<CodexSessionInfo, 'status'>;

const headerCache = new Map<string, { mtimeMs: number; size: number; header: CachedCodexHeader }>();

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
      return withCurrentStatus(cached.header);
    }
    const lines = readHeaderLines(filePath, MAX_HEADER_LINES);
    const parsed = parseHeaderLines(lines, filePath, stat.mtimeMs);
    if (!parsed) { return null; }
    const { status: _status, ...header } = parsed;
    if (headerCache.size > MAX_HEADER_CACHE_ENTRIES) {
      headerCache.clear();
    }
    headerCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, header });
    return parsed;
  } catch {
    return null;
  }
}

function withCurrentStatus(header: CachedCodexHeader): CodexSessionInfo {
  return {
    sessionId: header.sessionId,
    startTime: header.startTime,
    cwd: header.cwd,
    model: header.model,
    status: Date.now() - header.mtimeMs < RUNNING_THRESHOLD_MS ? 'running' : 'completed',
    prompt: header.prompt,
    subcommand: header.subcommand,
    filePath: header.filePath,
    mtimeMs: header.mtimeMs,
  };
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

function parseHeaderLines(lines: string[], filePath: string, mtimeMs: number): CodexSessionInfo | null {
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

  if (approvalPolicy === 'never' && sandboxPolicy.includes('read')) {
    subcommand = 'review';
  }

  if (!sessionId || !startTime || !cwd) { return null; }

  return {
    sessionId,
    startTime,
    cwd,
    model,
    status: Date.now() - mtimeMs < RUNNING_THRESHOLD_MS ? 'running' : 'completed',
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
function isWrapperText(text: string): boolean {
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
