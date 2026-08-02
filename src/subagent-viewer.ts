import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { escapeHtml } from './graph-view';

// ─── Size guards ───
const MAX_READ_BYTES = 10_000_000;
const MAX_BLOCK_CHARS = 50_000;
const MAX_ENTRIES = 1_000;
const MAX_RAW_LINES = 1_000;

// ─── Parsed structures ───

interface ToolCallEntry {
  kind: 'tool';
  name: string;
  summaryHint: string;
  inputJson: string;
  resultText: string | null;
  resultIsError: boolean;
}

interface TextEntry {
  kind: 'user' | 'assistant';
  markdown: string;
}

/** Fallback display for tool_result with no matching tool_use_id */
interface OrphanResultEntry {
  kind: 'orphan-result';
  toolUseId: string;
  resultText: string;
}

type Entry = ToolCallEntry | TextEntry | OrphanResultEntry;

interface RawLine {
  lineNo: number;
  type: string;
  /** pretty-printed JSON; null for lines that failed JSON.parse (raw is shown instead) */
  pretty: string | null;
  raw: string;
}

interface ParsedLog {
  entries: Entry[];
  entriesOmitted: number;
  rawLines: RawLine[];
  rawOmitted: number;
  skippedTypes: Map<string, number>;
  model: string | null;
  agentId: string | null;
  slug: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

// ─── Helpers ───

function nonce(): string {
  return Array.from({ length: 32 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
      .charAt(Math.floor(Math.random() * 62))
  ).join('');
}

function truncateText(text: string): string {
  return text.length > MAX_BLOCK_CHARS
    ? text.slice(0, MAX_BLOCK_CHARS) + `\n… (${text.length - MAX_BLOCK_CHARS} chars truncated)`
    : text;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

/** Extract text from tool_result.content: tries string, text block array, then JSON fallback */
function extractResultText(content: unknown): string {
  if (typeof content === 'string') { return content; }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string') {
        parts.push((block as any).text);
      }
    }
    if (parts.length > 0) { return parts.join('\n'); }
  }
  try { return JSON.stringify(content, null, 2) ?? ''; } catch { return String(content); }
}

/** Summary hint for a tool call (first 60 chars of a representative input key) */
function toolSummaryHint(input: unknown): string {
  if (!input || typeof input !== 'object') { return ''; }
  const obj = input as Record<string, unknown>;
  for (const key of ['description', 'query', 'command', 'file_path', 'url', 'pattern', 'prompt', 'skill']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) {
      return v.replace(/\s+/g, ' ').trim().substring(0, 60);
    }
  }
  return '';
}

// ─── Markdown (lightweight, self-contained) ───
// XSS-safe ordering: (1) extract fenced code blocks into placeholders →
// (2) escapeHtml the rest → (3) apply inline tag replacements →
// (4) restore code blocks (already escaped).
// Placeholders use 0000 delimiters (not affected by escapeHtml).
function renderMarkdown(text: string): string {
  const codeBlocks: string[] = [];
  const withPlaceholders = text.replace(/```[a-zA-Z0-9_-]*\r?\n?([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(`<pre class="code-block"><code>${escapeHtml(code)}</code></pre>`);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });
  let html = escapeHtml(withPlaceholders);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/\r?\n/g, '<br>');
  html = html.replace(/<\/(h1|h2|h3|h4|li)><br>/g, '</$1>');
  html = html.replace(/\u0000CODE(\d+)\u0000(<br>)?/g, (_m, i: string) => codeBlocks[Number(i)] ?? '');
  return html;
}

// ─── File reading (size guard) ───

interface ReadResult {
  text: string;
  truncatedHead: boolean;
  fileSize: number;
}

function readLogText(filePath: string): ReadResult {
  const stat = fs.statSync(filePath);
  if (stat.size <= MAX_READ_BYTES) {
    return { text: fs.readFileSync(filePath, 'utf8'), truncatedHead: false, fileSize: stat.size };
  }
  // Large file: read only the tail, drop the first incomplete line
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
    let text = buf.toString('utf8', 0, bytesRead);
    const firstLF = text.indexOf('\n');
    if (firstLF >= 0) { text = text.slice(firstLF + 1); }
    return { text, truncatedHead: true, fileSize: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

// ─── JSONL parsing ───

function parseLog(text: string): ParsedLog {
  const log: ParsedLog = {
    entries: [], entriesOmitted: 0,
    rawLines: [], rawOmitted: 0,
    skippedTypes: new Map(),
    model: null, agentId: null, slug: null,
    firstTimestamp: null, lastTimestamp: null,
  };
  const toolById = new Map<string, ToolCallEntry>();
  const pushEntry = (entry: Entry): boolean => {
    if (log.entries.length >= MAX_ENTRIES) { log.entriesOmitted++; return false; }
    log.entries.push(entry);
    return true;
  };
  let lineNo = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNo++;
    if (!line.trim()) { continue; }

    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      // Parse-failed line: skip formatted view, keep raw text in raw section
      if (log.rawLines.length < MAX_RAW_LINES) {
        log.rawLines.push({ lineNo, type: 'parse-error', pretty: null, raw: truncateText(line) });
      } else { log.rawOmitted++; }
      bump(log.skippedTypes, 'parse-error');
      continue;
    }

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      if (log.rawLines.length < MAX_RAW_LINES) {
        log.rawLines.push({ lineNo, type: 'non-object', pretty: truncateText(JSON.stringify(data)), raw: truncateText(line) });
      } else { log.rawOmitted++; }
      bump(log.skippedTypes, 'non-object');
      continue;
    }

    const type = typeof data.type === 'string' ? data.type : 'unknown';
    if (log.rawLines.length < MAX_RAW_LINES) {
      let pretty: string;
      try { pretty = JSON.stringify(data, null, 2); } catch { pretty = line; }
      log.rawLines.push({ lineNo, type, pretty: truncateText(pretty), raw: line });
    } else { log.rawOmitted++; }

    if (!log.agentId && typeof data.agentId === 'string') { log.agentId = data.agentId; }
    if (!log.slug && typeof data.slug === 'string') { log.slug = data.slug; }
    if (typeof data.timestamp === 'string') {
      if (!log.firstTimestamp) { log.firstTimestamp = data.timestamp; }
      log.lastTimestamp = data.timestamp;
    }

    if (type === 'assistant') {
      if (!log.model && typeof data.message?.model === 'string') { log.model = data.message.model; }
      const content = data.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            pushEntry({ kind: 'assistant', markdown: truncateText(block.text) });
          } else if (block?.type === 'tool_use') {
            let inputJson: string;
            try { inputJson = JSON.stringify(block.input ?? {}, null, 2); } catch { inputJson = String(block.input); }
            const entry: ToolCallEntry = {
              kind: 'tool',
              name: typeof block.name === 'string' ? block.name : 'tool',
              summaryHint: toolSummaryHint(block.input),
              inputJson: truncateText(inputJson),
              resultText: null,
              resultIsError: false,
            };
            if (pushEntry(entry) && typeof block.id === 'string' && block.id) {
              toolById.set(block.id, entry);
            }
          }
        }
      }
    } else if (type === 'user') {
      const content = data.message?.content;
      if (typeof content === 'string') {
        if (content.trim()) { pushEntry({ kind: 'user', markdown: truncateText(content) }); }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            pushEntry({ kind: 'user', markdown: truncateText(block.text) });
          } else if (block?.type === 'tool_result') {
            const resultText = truncateText(extractResultText(block.content));
            const target = typeof block.tool_use_id === 'string' ? toolById.get(block.tool_use_id) : undefined;
            if (target && target.resultText === null) {
              target.resultText = resultText;
              target.resultIsError = block.is_error === true;
            } else {
              // Unmatched tool_result: fallback display
              pushEntry({
                kind: 'orphan-result',
                toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '(no id)',
                resultText,
              });
            }
          }
        }
      }
    } else {
      // Unknown/non-display record types: count and skip
      bump(log.skippedTypes, type);
    }
  }
  return log;
}

// ─── HTML rendering ───

const VIEWER_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 16px 20px 40px;
  line-height: 1.5;
}
.header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
.header h1 { font-size: 1.2em; font-weight: 600; }
.meta { font-size: .85em; opacity: .7; margin-bottom: 12px; }
.toolbar { display: flex; gap: 8px; margin-bottom: 16px; }
.toolbar button {
  font-family: inherit; font-size: .85em; padding: 3px 10px;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border: none; border-radius: 3px; cursor: pointer;
}
.toolbar button:hover { background: var(--vscode-button-hoverBackground); }
.toolbar button.secondary {
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  background: var(--vscode-button-secondaryBackground, transparent);
  border: 1px solid var(--vscode-widget-border);
}
.notice {
  font-size: .85em; padding: 6px 10px; margin-bottom: 12px; border-radius: 4px;
  background: var(--vscode-inputValidation-warningBackground, rgba(200,160,0,.15));
  border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-widget-border));
}
.entry { margin-bottom: 14px; max-width: 900px; }
.entry-label {
  font-size: .75em; font-weight: 600; opacity: .6;
  text-transform: uppercase; letter-spacing: .05em; margin-bottom: 3px;
}
.entry.user .bubble {
  padding: 8px 12px; border-radius: 6px;
  background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.1));
  border-left: 3px solid var(--vscode-charts-blue);
}
.entry.assistant .bubble { padding: 2px 0; }
.bubble h1, .bubble h2, .bubble h3, .bubble h4 { margin: 10px 0 4px; line-height: 1.3; }
.bubble h1 { font-size: 1.25em; }
.bubble h2 { font-size: 1.15em; }
.bubble h3 { font-size: 1.05em; }
.bubble h4 { font-size: 1em; }
.bubble li { margin-left: 18px; }
code {
  font-family: var(--vscode-editor-font-family, monospace); font-size: .9em;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15));
  padding: 0 3px; border-radius: 3px;
}
pre.code-block, pre.json {
  font-family: var(--vscode-editor-font-family, monospace); font-size: .85em;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
  border: 1px solid var(--vscode-widget-border);
  border-radius: 4px; padding: 8px 10px; margin: 6px 0;
  overflow-x: auto; white-space: pre;
}
pre.code-block code, pre.json code { background: none; padding: 0; }
details.tool {
  margin: 6px 0; border: 1px solid var(--vscode-widget-border); border-radius: 4px;
  max-width: 900px;
}
details.tool > summary {
  cursor: pointer; padding: 5px 10px; font-size: .9em; user-select: none;
  color: var(--vscode-charts-green);
}
details.tool.error > summary { color: var(--vscode-charts-red); }
details.tool > summary .hint { opacity: .6; color: var(--vscode-foreground); }
details.tool > .tool-body { padding: 4px 10px 8px; border-top: 1px solid var(--vscode-widget-border); }
.tool-section-label { font-size: .75em; opacity: .6; margin-top: 6px; }
pre.result {
  font-family: var(--vscode-editor-font-family, monospace); font-size: .85em;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
  border-radius: 4px; padding: 8px 10px; margin: 4px 0;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  max-height: 400px; overflow-y: auto;
}
.pending { font-size: .85em; opacity: .6; font-style: italic; }
.skipped { font-size: .8em; opacity: .55; margin: 12px 0; }
details.raw-section {
  margin-top: 24px; border-top: 1px solid var(--vscode-widget-border); padding-top: 10px;
}
details.raw-section > summary { cursor: pointer; font-weight: 600; opacity: .8; }
details.raw-line { margin: 4px 0 4px 12px; }
details.raw-line > summary {
  cursor: pointer; font-size: .85em; opacity: .75;
  font-family: var(--vscode-editor-font-family, monospace);
}
.error-page { padding: 40px 12px; text-align: center; opacity: .7; }
`;

function renderEntry(entry: Entry): string {
  // Branch order (tool → orphan-result → user/assistant fallback) is chosen so TS can
  // narrow the discriminated union: TextEntry.kind is itself a union ('user' | 'assistant'),
  // and `a.kind === 'x' || a.kind === 'y'` does not exclude such a member from the else
  // branch. Checking the single-literal-kind variants first and falling through avoids it.
  if (entry.kind === 'tool') {
    const hint = entry.summaryHint ? ` <span class="hint">— ${escapeHtml(entry.summaryHint)}</span>` : '';
    const result = entry.resultText !== null
      ? `<div class="tool-section-label">result${entry.resultIsError ? ' (error)' : ''}</div><pre class="result">${escapeHtml(entry.resultText)}</pre>`
      : '<div class="pending">no result recorded</div>';
    return `<details class="tool${entry.resultIsError ? ' error' : ''}">
<summary>${escapeHtml(entry.name)}${hint}</summary>
<div class="tool-body">
<div class="tool-section-label">input</div>
<pre class="json">${escapeHtml(entry.inputJson)}</pre>
${result}
</div>
</details>`;
  }
  if (entry.kind === 'orphan-result') {
    return `<details class="tool">
<summary>tool result (unmatched: ${escapeHtml(entry.toolUseId)})</summary>
<div class="tool-body"><pre class="result">${escapeHtml(entry.resultText)}</pre></div>
</details>`;
  }
  return `<div class="entry ${entry.kind}">
<div class="entry-label">${entry.kind}</div>
<div class="bubble">${renderMarkdown(entry.markdown)}</div>
</div>`;
}

function buildViewerHtml(filePath: string, log: ParsedLog, truncatedHead: boolean, fileSize: number): string {
  const nonceValue = nonce();
  const title = log.slug || path.basename(filePath, '.jsonl');
  const metaParts: string[] = [];
  if (log.agentId) { metaParts.push(`agent: ${log.agentId}`); }
  if (log.model) { metaParts.push(log.model); }
  metaParts.push(`${log.entries.length}${log.entriesOmitted > 0 ? `(+${log.entriesOmitted} omitted)` : ''} entries`);
  if (log.firstTimestamp && log.lastTimestamp) {
    metaParts.push(`${log.firstTimestamp} → ${log.lastTimestamp}`);
  }
  metaParts.push(`${(fileSize / 1024).toFixed(0)} KB`);

  const notices: string[] = [];
  if (truncatedHead) {
    notices.push(`<div class="notice">File exceeds ${(MAX_READ_BYTES / 1_000_000).toFixed(0)} MB — showing tail portion only.</div>`);
  }
  if (log.entriesOmitted > 0) {
    notices.push(`<div class="notice">${log.entriesOmitted} entries omitted (limit ${MAX_ENTRIES}) — tool results below may appear unmatched.</div>`);
  }

  const skipped = [...log.skippedTypes.entries()]
    .map(([t, n]) => `${escapeHtml(t)} ×${n}`)
    .join(', ');
  const skippedHtml = skipped ? `<div class="skipped">Skipped records: ${skipped}</div>` : '';

  const entriesHtml = log.entries.map(renderEntry).join('\n');
  const omittedHtml = log.entriesOmitted > 0
    ? `<div class="skipped">+${log.entriesOmitted} entries omitted (limit ${MAX_ENTRIES})</div>` : '';

  const rawItems = log.rawLines.map(l =>
    `<details class="raw-line"><summary>#${l.lineNo} ${escapeHtml(l.type)}</summary>${
      l.pretty !== null
        ? `<pre class="json">${escapeHtml(l.pretty)}</pre>`
        : `<pre class="result">${escapeHtml(l.raw)}</pre>`
    }</details>`
  ).join('\n');
  const rawOmittedHtml = log.rawOmitted > 0
    ? `<div class="skipped">+${log.rawOmitted} lines omitted (limit ${MAX_RAW_LINES})</div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonceValue}';">
<style>${VIEWER_CSS}</style>
</head>
<body>
<div class="header"><h1>${escapeHtml(title)}</h1></div>
<div class="meta">${escapeHtml(metaParts.join(' · '))}</div>
<div class="toolbar">
<button data-cmd="reload">Reload</button>
<button class="secondary" data-cmd="openRaw">Open raw JSONL</button>
</div>
${notices.join('\n')}
${entriesHtml}
${omittedHtml}
${skippedHtml}
<details class="raw-section">
<summary>Raw JSONL (${log.rawLines.length}${log.rawOmitted > 0 ? `+${log.rawOmitted}` : ''} lines)</summary>
${rawItems}
${rawOmittedHtml}
</details>
<script nonce="${nonceValue}">
(function() {
  var vscode = acquireVsCodeApi();
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.cmd) {
        vscode.postMessage({ command: el.dataset.cmd });
        return;
      }
      el = el.parentElement;
    }
  });
})();
</script>
</body>
</html>`;
}

function buildErrorHtml(filePath: string, message: string): string {
  const nonceValue = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonceValue}';">
<style>${VIEWER_CSS}</style>
</head>
<body>
<div class="error-page">
<p>Failed to read subagent log:</p>
<p><code>${escapeHtml(filePath)}</code></p>
<p>${escapeHtml(message)}</p>
</div>
<div class="toolbar" style="justify-content: center;">
<button data-cmd="reload">Retry</button>
</div>
<script nonce="${nonceValue}">
(function() {
  var vscode = acquireVsCodeApi();
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.cmd) {
        vscode.postMessage({ command: el.dataset.cmd });
        return;
      }
      el = el.parentElement;
    }
  });
})();
</script>
</body>
</html>`;
}

// ─── Manager ───

export class SubagentViewerManager {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  open(filePath: string): void {
    if (path.extname(filePath).toLowerCase() !== '.jsonl') {
      vscode.window.showErrorMessage(`Not a subagent log (.jsonl): ${filePath}`);
      return;
    }
    try {
      if (!fs.statSync(filePath).isFile()) {
        vscode.window.showErrorMessage(`Not a regular file: ${filePath}`);
        return;
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot access subagent log: ${filePath} (${String(e)})`);
      return;
    }

    const existing = this.panels.get(filePath);
    if (existing) {
      existing.reveal(undefined, false);
      this.render(existing, filePath);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'claudeCodeVitalsSubagentViewer',
      path.basename(filePath),
      vscode.ViewColumn.Beside,
      { enableScripts: true },
    );
    this.panels.set(filePath, panel);
    panel.onDidDispose(() => { this.panels.delete(filePath); });
    panel.webview.onDidReceiveMessage(msg => {
      if (msg?.command === 'reload') { this.render(panel, filePath); }
      if (msg?.command === 'openRaw') {
        vscode.workspace.openTextDocument(filePath)
          .then(doc => vscode.window.showTextDocument(doc))
          .then(undefined, (err) => {
            vscode.window.showErrorMessage(`Failed to open raw JSONL: ${filePath} (${String(err)})`);
          });
      }
    });
    this.render(panel, filePath);
  }

  dispose(): void {
    // Copy before iterating since panel.dispose() modifies the Map via onDidDispose
    for (const panel of [...this.panels.values()]) { panel.dispose(); }
    this.panels.clear();
  }

  private render(panel: vscode.WebviewPanel, filePath: string): void {
    let html: string;
    try {
      const { text, truncatedHead, fileSize } = readLogText(filePath);
      const log = parseLog(text);
      if (log.slug) { panel.title = `${log.slug} — subagent`; }
      html = buildViewerHtml(filePath, log, truncatedHead, fileSize);
    } catch (e) {
      html = buildErrorHtml(filePath, String(e));
    }
    panel.webview.html = html;
  }
}
