import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_ENTRIES, MAX_RAW_LINES, MAX_READ_BYTES,
  truncateText, bump, extractResultText, readLogText,
  buildViewerHtml, buildErrorHtml,
  ViewerDocument, ViewerEntry, RawLine,
} from './viewer-common';
import { parseCodexRollout } from './codex-rollout-parser';

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

/** tool_use_id で紐付け先が見つからなかった tool_result のフォールバック表示 */
interface OrphanResultEntry {
  kind: 'orphan-result';
  toolUseId: string;
  resultText: string;
}

type Entry = ToolCallEntry | TextEntry | OrphanResultEntry;

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

/** ツール呼び出しの summary に添える入力の要約（代表的なキーの先頭60字） */
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
      // parse失敗行: 整形ビューはスキップ、生JSONセクションには元テキストで残す（裁定どおり）
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
            // エントリ上限で弾かれた tool_use は紐付け対象にしない（結果が孤児として上限外に増えるのを防ぐ）
            // → 以降の tool_result が unmatched になりうるため、UI上部 notice で明示する（review #3採用）
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
              // 紐付け不可: フォールバック表示（裁定どおり）
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
      // progress 等の未知/非表示 type: 件数集計してスキップ（裁定どおり）
      bump(log.skippedTypes, type);
    }
  }
  return log;
}

// ─── ParsedLog → ViewerDocument ───

function toViewerDocument(log: ParsedLog, filePath: string, truncatedHead: boolean, fileSize: number): ViewerDocument {
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
    notices.push(`File exceeds ${(MAX_READ_BYTES / 1_000_000).toFixed(0)} MB — showing tail portion only.`);
  }
  // エントリ上限到達の明示（review #3採用）: 上限で弾かれた tool_use は紐付け対象外のため、
  // 以降の tool_result が unmatched 表示になりうることを利用者に知らせる
  if (log.entriesOmitted > 0) {
    notices.push(`${log.entriesOmitted} entries omitted (limit ${MAX_ENTRIES}) — tool results below may appear unmatched.`);
  }

  const entries: ViewerEntry[] = log.entries.map((entry): ViewerEntry => {
    if (entry.kind === 'tool') {
      return {
        kind: 'tool',
        name: entry.name,
        summaryHint: entry.summaryHint,
        inputText: entry.inputJson,
        outputText: entry.resultText,
        status: entry.resultText === null ? 'pending' : (entry.resultIsError ? 'failed' : 'completed'),
      };
    }
    if (entry.kind === 'orphan-result') {
      return {
        kind: 'marker',
        level: 'warning',
        label: `tool result (unmatched: ${entry.toolUseId})`,
        detail: entry.resultText,
      };
    }
    return { kind: 'text', role: entry.kind, markdown: entry.markdown };
  });

  return {
    source: 'claude',
    title,
    metaParts,
    entries,
    entriesOmitted: log.entriesOmitted,
    rawLines: log.rawLines,
    rawOmitted: log.rawOmitted,
    skippedTypes: log.skippedTypes,
    notices,
  };
}

// ─── Manager ───

export class SubagentViewerManager {
  // filePath → panel。同一ファイルは reveal + 再レンダリング、別ファイルは新パネル（synthesis裁定: Map方式）
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  open(filePath: string): void {
    this.openWith(
      filePath,
      (text, fp, truncatedHead, fileSize) => {
        const log = parseLog(text);
        return { doc: toViewerDocument(log, fp, truncatedHead, fileSize), panelTitle: log.slug ? `${log.slug} — subagent` : null };
      },
    );
  }

  openCodex(filePath: string): void {
    this.openWith(
      filePath,
      (text, fp, truncatedHead, fileSize) => {
        const doc = parseCodexRollout(text, fp, truncatedHead, fileSize);
        return { doc, panelTitle: `${doc.title} — codex` };
      },
    );
  }

  dispose(): void {
    // panel.dispose() が onDidDispose 経由で Map を触るため、コピーしてから回す
    for (const panel of [...this.panels.values()]) { panel.dispose(); }
    this.panels.clear();
  }

  private openWith(
    filePath: string,
    parse: (text: string, filePath: string, truncatedHead: boolean, fileSize: number) => { doc: ViewerDocument; panelTitle: string | null },
  ): void {
    // ファイルパス検証（review #1採用）: Webviewメッセージ経由のパスは信頼境界の外側。
    // .jsonl 拡張子チェック + 通常ファイル確認を通過したパスのみ扱う。
    // openRaw も同じ検証済み filePath 変数を使用する。
    if (path.extname(filePath).toLowerCase() !== '.jsonl') {
      vscode.window.showErrorMessage(`Not a log file (.jsonl): ${filePath}`);
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
      this.render(existing, filePath, parse);
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
      if (msg?.command === 'reload') { this.render(panel, filePath, parse); }
      if (msg?.command === 'openRaw') {
        // Promise reject を明示処理（review #4採用）
        vscode.workspace.openTextDocument(filePath)
          .then(doc => vscode.window.showTextDocument(doc))
          .then(undefined, (err) => {
            vscode.window.showErrorMessage(`Failed to open raw JSONL: ${filePath} (${String(err)})`);
          });
      }
    });
    this.render(panel, filePath, parse);
  }

  private render(
    panel: vscode.WebviewPanel,
    filePath: string,
    parse: (text: string, filePath: string, truncatedHead: boolean, fileSize: number) => { doc: ViewerDocument; panelTitle: string | null },
  ): void {
    let html: string;
    try {
      const { text, truncatedHead, fileSize } = readLogText(filePath);
      const { doc, panelTitle } = parse(text, filePath, truncatedHead, fileSize);
      if (panelTitle) { panel.title = panelTitle; }
      html = buildViewerHtml(filePath, doc);
    } catch (e) {
      html = buildErrorHtml(filePath, String(e));
    }
    panel.webview.html = html;
  }
}
