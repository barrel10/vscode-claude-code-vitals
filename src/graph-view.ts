import * as vscode from 'vscode';
import { CodexSessionInfo } from './codex';
import { SessionInfo, formatRelativeTime, getSubagentState, shortenModel, SubagentState } from './sessions';

export interface SubagentMeta {
  label: string;
  description: string;
  model: string | null;
  agentId: string;
  toolUseId: string | null;
  /** Last activity of this subagent (JSONL file mtime). 0 = unknown. */
  lastActivityMs: number;
}

export interface GraphData {
  claudeSessionId: string;
  codexSessions: CodexSessionInfo[];
  subagentCount: number;
  activeSubagentCount: number;
  /**
   * Subagent activity times (SessionInfo._agentTimestamps). Supplied either from
   * agent_progress records in the main JSONL or from subagents/ file mtimes. Even the
   * mtime case is a separate scan from subagentMeta's, not a shared one: a failed statSync
   * drops the entry here but yields a placeholder in readSubagentMeta, and this array can
   * be a cached one from an earlier scan. Index correspondence with subagentMeta is
   * therefore never guaranteed and must not be assumed.
   */
  subagentTimestamps: number[];
  subagentMeta: SubagentMeta[];
}

interface ChildRow {
  kind: 'subagent' | 'codex';
  primary: string;
  secondary: string;
  state: SubagentState;
  lastActivityMs: number;
  detail: string;
  durationText?: string;
  filePath?: string;
}

const SIDEBAR_COMPLETED_LIMIT = 8;
const PANEL_COMPLETED_LIMIT = 30;

const GRAPH_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: transparent;
  user-select: none;
}
.graph { padding: 6px 4px; }
.graph.fullscreen {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
  align-items: start;
  padding: 12px;
}
.session-block { min-width: 0; }
.graph.fullscreen .session-block {
  border: 1px solid var(--vscode-widget-border);
  border-radius: 6px;
  padding: 6px;
}
.parent-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.parent-row:hover { background: var(--vscode-list-hoverBackground); }
.status-icon { font-size: 9px; line-height: 1; flex-shrink: 0; }
.status-icon.thinking { color: var(--vscode-charts-blue); animation: pulse 2s ease-in-out infinite; }
.status-icon.waiting { color: var(--vscode-charts-yellow); }
.status-icon.idle { color: var(--vscode-descriptionForeground); opacity: .6; }
.session-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.model-badge { flex-shrink: 0; font-size: .8em; opacity: .7; }
.child-summary { flex-shrink: 0; font-size: .8em; opacity: .7; }
.context-pct { flex-shrink: 0; font-size: .8em; opacity: .85; }
.children {
  margin: 2px 0 6px 10px;
  padding-left: 8px;
  border-left: 1px solid var(--vscode-tree-indentGuidesStroke, var(--vscode-widget-border));
}
.child-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 2px 4px;
  border-radius: 3px;
}
.child-row.codex { cursor: pointer; }
.child-row.codex:hover { background: var(--vscode-list-hoverBackground); }
.status-dot {
  font-size: 7px;
  line-height: 1;
  flex-shrink: 0;
  color: var(--vscode-descriptionForeground);
  opacity: .5;
}
.child-row.subagent.running .status-dot {
  color: var(--vscode-charts-blue);
  opacity: 1;
  animation: pulse 2s ease-in-out infinite;
}
.child-row.subagent.stale .status-dot {
  color: var(--vscode-charts-yellow);
  opacity: .8;
}
.child-row.codex.running .status-dot {
  color: var(--vscode-charts-green);
  opacity: 1;
  animation: pulse 2s ease-in-out infinite;
}
.child-main { flex: 1 1 auto; min-width: 0; }
.child-line1 { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.child-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: .9em;
}
.codex-badge {
  flex-shrink: 0;
  font-size: .75em;
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid var(--vscode-widget-border);
  color: var(--vscode-charts-green);
}
.child-row.codex:not(.running) .codex-badge { color: var(--vscode-descriptionForeground); }
.child-model { flex-shrink: 0; font-size: .75em; opacity: .6; }
.child-duration { flex-shrink: 0; font-size: .75em; opacity: .8; }
.child-time { flex-shrink: 0; font-size: .75em; opacity: .6; margin-left: auto; }
.child-line2 {
  font-size: .75em;
  opacity: .55;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.more-row { padding: 2px 4px; font-size: .75em; opacity: .5; }
.empty { text-align: center; padding: 40px 12px; opacity: .5; }
.empty-note { font-size: .8em; margin-top: 6px; }
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .5; }
}
`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nonce(): string {
  return Array.from({ length: 32 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
      .charAt(Math.floor(Math.random() * 62))
  ).join('');
}

function formatDuration(ms: number): string {
  if (ms <= 0) { return '0s'; }
  const s = Math.floor(ms / 1000);
  if (s < 60) { return `${s}s`; }
  const m = Math.floor(s / 60);
  if (m < 60) { return s % 60 > 0 ? `${m}m ${s % 60}s` : `${m}m`; }
  const h = Math.floor(m / 60);
  return m % 60 > 0 ? `${h}h ${m % 60}m` : `${h}h`;
}

export class GraphWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'claudeCodeVitalsGraphView';

  private _view?: vscode.WebviewView;
  private _panel?: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private sessions: SessionInfo[] = [];
  private graphDataMap = new Map<string, GraphData>();
  private _onRefresh: (() => void) | undefined;
  private focusedSessionId: string | null = null;

  constructor(
    private readonly _onFocusSession: (sessionId: string) => void,
  ) {}

  setFocusedSession(sessionId: string): void {
    this.focusedSessionId = sessionId;
    this.render();
  }

  setRefreshHandler(handler: () => void): void {
    this._onRefresh = handler;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(
      msg => this.handleMessage(msg),
      undefined,
      this._disposables,
    );

    webviewView.onDidChangeVisibility(
      () => { if (webviewView.visible) { this.render(); } },
      undefined,
      this._disposables,
    );

    this.render();
  }

  openInEditor(): void {
    if (this._panel) {
      this._panel.reveal();
      return;
    }
    this._panel = vscode.window.createWebviewPanel(
      'claudeCodeVitalsGraph', 'Agent Graph',
      vscode.ViewColumn.One, { enableScripts: true },
    );
    this._panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
    this._panel.onDidDispose(() => { this._panel = undefined; });
    this.renderPanel();
  }

  update(sessions: SessionInfo[], graphDataMap: Map<string, GraphData>): void {
    this.sessions = sessions;
    this.graphDataMap = graphDataMap;
    this.render();
    this.renderPanel();
  }

  dispose(): void {
    for (const d of this._disposables) { d.dispose(); }
    this._panel?.dispose();
  }

  private handleMessage(msg: any): void {
    if (msg.command === 'focusClaudeSession' && msg.sessionId) {
      this._onFocusSession(msg.sessionId);
    }
    if (msg.command === 'openCodexFile' && msg.path) {
      vscode.workspace.openTextDocument(msg.path).then(doc => vscode.window.showTextDocument(doc));
    }
    if (msg.command === 'refreshGraph') {
      this._onRefresh?.();
    }
  }

  private hasRunningCodex(sessionId: string): boolean {
    const graph = this.graphDataMap.get(sessionId);
    return !!graph?.codexSessions.some(c => c.status === 'running');
  }

  private latestRunningCodexMtime(sessionId: string): number {
    const graph = this.graphDataMap.get(sessionId);
    if (!graph) { return 0; }
    return graph.codexSessions
      .filter(c => c.status === 'running')
      .reduce((max, c) => Math.max(max, c.mtimeMs), 0);
  }

  private getSessionsForSidebar(): SessionInfo[] {
    if (this.focusedSessionId) {
      const focused = this.sessions.find(s => s.sessionId === this.focusedSessionId);
      if (focused) { return [focused]; }
    }
    const thinking = this.sessions
      .filter(s => s.status === 'thinking')
      .sort((a, b) => b.displayMtimeMs - a.displayMtimeMs);
    if (thinking.length > 0) { return [thinking[0]]; }
    const recentSortKey = (s: SessionInfo): number =>
      Math.max(s.displayMtimeMs, this.latestRunningCodexMtime(s.sessionId));
    const recent = [...this.sessions]
      .filter(s => s.status !== 'inactive' || this.hasRunningCodex(s.sessionId))
      .sort((a, b) => recentSortKey(b) - recentSortKey(a));
    return recent.length > 0 ? [recent[0]] : [];
  }

  private getSessionsForPanel(): SessionInfo[] {
    return this.sessions.filter(s => {
      const graph = this.graphDataMap.get(s.sessionId);
      const hasCodex = (graph?.codexSessions.length || 0) > 0;
      const hasRunningCodex = this.hasRunningCodex(s.sessionId);
      return (s.status !== 'inactive' || hasRunningCodex) && (
        s.status === 'thinking' ||
        s.totalAgentCount > 0 ||
        s.isActiveTurn ||
        hasCodex
      );
    });
  }

  private render(): void {
    if (!this._view) { return; }
    const sessions = this.getSessionsForSidebar();
    this._view.webview.html = this.buildHtml(sessions, nonce(), false);
  }

  private renderPanel(): void {
    if (!this._panel) { return; }
    const sessions = this.getSessionsForPanel();
    this._panel.webview.html = this.buildHtml(sessions, nonce(), true);
  }

  private buildChildRows(session: SessionInfo, graph: GraphData, now: number): ChildRow[] {
    const rows: ChildRow[] = [];
    for (let i = 0; i < graph.subagentCount; i++) {
      const meta = graph.subagentMeta[i];
      const label = meta?.label || `Agent ${i + 1}`;
      // meta carries this row's own label/model/time, so prefer it — including a
      // lastActivityMs of 0, which means "unknown" and must not be filled in from a list
      // that may not be index-aligned. Only where meta is absent (subagentCount can exceed
      // subagentMeta.length) is the row an unnamed "Agent N" placeholder, and the
      // positional timestamp the best available signal.
      const last = meta ? meta.lastActivityMs : (graph.subagentTimestamps[i] || 0);
      rows.push({
        kind: 'subagent',
        primary: label,
        secondary: shortenModel(meta?.model || session.model),
        state: getSubagentState(meta?.agentId || '', meta?.toolUseId || null, last, session._completedAgentIds, session._finishedAgentToolUseIds, now),
        lastActivityMs: last,
        detail: meta?.description || label,
      });
    }
    for (const codex of graph.codexSessions) {
      rows.push({
        kind: 'codex',
        primary: codex.subcommand,
        // Codex model IDs (gpt-5-codex, gpt-5.1-codex-max, ...) are not Claude IDs, so
        // shortenModel would collapse every one of them to "gpt". Show the raw value.
        secondary: codex.model || '',
        state: codex.status === 'running' ? 'running' : 'completed',
        lastActivityMs: codex.mtimeMs,
        detail: codex.prompt || codex.subcommand,
        durationText: formatDuration(codex.mtimeMs - codex.startTime),
        filePath: codex.filePath,
      });
    }
    rows.sort((a, b) => {
      const rank = (row: ChildRow): number => row.state === 'running' ? 0 : row.state === 'stale' ? 1 : 2;
      if (rank(a) !== rank(b)) { return rank(a) - rank(b); }
      return b.lastActivityMs - a.lastActivityMs;
    });
    return rows;
  }

  private renderChildRow(row: ChildRow, fullscreen: boolean): string {
    const stateText = row.state;
    const cls = `child-row ${row.kind} ${stateText}`;
    const cmdAttr = row.kind === 'codex'
      ? ` data-cmd="openCodexFile" data-path="${escapeHtml(row.filePath || '')}"`
      : '';
    const tipLines = [row.detail, `status: ${stateText}`];
    if (row.lastActivityMs > 0) { tipLines.push(`last activity: ${formatRelativeTime(row.lastActivityMs)} ago`); }
    if (row.durationText) { tipLines.push(`duration: ${row.durationText}`); }
    const title = escapeHtml(tipLines.join('\n'));
    const primary = row.kind === 'codex'
      ? `<span class="codex-badge">${escapeHtml(row.primary)}</span>`
      : `<span class="child-label">${escapeHtml(row.primary)}</span>`;
    const model = row.secondary ? `<span class="child-model">${escapeHtml(row.secondary)}</span>` : '';
    const duration = row.durationText ? `<span class="child-duration">${escapeHtml(row.durationText)}</span>` : '';
    const time = row.lastActivityMs > 0
      ? `<span class="child-time">${escapeHtml(formatRelativeTime(row.lastActivityMs))}</span>`
      : '';
    const line2 = fullscreen && row.detail
      ? `<div class="child-line2">${escapeHtml(row.detail)}</div>`
      : '';
    return `<div class="${cls}"${cmdAttr} title="${title}" aria-label="${escapeHtml(`${row.primary} ${stateText}`)}">
<span class="status-dot" aria-hidden="true">&#x25CF;</span>
<div class="child-main"><div class="child-line1">${primary}${model}${duration}</div>${line2}</div>
${time}
</div>`;
  }

  private buildSessionBlock(session: SessionInfo, fullscreen: boolean, now: number): string {
    const graph = this.graphDataMap.get(session.sessionId) || {
      claudeSessionId: session.sessionId,
      codexSessions: [],
      subagentCount: session.totalAgentCount,
      activeSubagentCount: session.activeAgentCount,
      subagentTimestamps: session._agentTimestamps,
      subagentMeta: [],
    };
    const rows = this.buildChildRows(session, graph, now);
    const runningRows = rows.filter(r => r.state === 'running');
    const nonRunningRows = rows.filter(r => r.state !== 'running');
    const limit = fullscreen ? PANEL_COMPLETED_LIMIT : SIDEBAR_COMPLETED_LIMIT;
    const visibleRows = [...runningRows, ...nonRunningRows.slice(0, limit)];
    const omitted = nonRunningRows.length - Math.min(nonRunningRows.length, limit);

    let statusIcon: string;
    if (session.status === 'thinking') {
      statusIcon = '<span class="status-icon thinking" title="thinking" aria-label="thinking">&#x25CF;</span>';
    } else if (session.status === 'waiting') {
      statusIcon = '<span class="status-icon waiting" title="waiting" aria-label="waiting">&#x25CF;</span>';
    } else {
      statusIcon = `<span class="status-icon idle" title="${session.status}" aria-label="${session.status}">&#x25CF;</span>`;
    }

    const summary = rows.length > 0
      ? `<span class="child-summary" title="children: running / total">${runningRows.length > 0 ? `${runningRows.length} running &middot; ` : ''}${rows.length} total</span>`
      : '';
    const pct = `<span class="context-pct" title="context usage">${Math.round(session.usagePercent)}%</span>`;
    const model = `<span class="model-badge">${escapeHtml(shortenModel(session.model))}</span>`;

    const children = visibleRows.length > 0
      ? `<div class="children">${visibleRows.map(r => this.renderChildRow(r, fullscreen)).join('')}${omitted > 0 ? `<div class="more-row">+${omitted} more</div>` : ''}</div>`
      : '';

    return `<div class="session-block">
<div class="parent-row" data-cmd="focusClaudeSession" data-session-id="${escapeHtml(session.sessionId)}" title="${escapeHtml(session.sessionName)}">
${statusIcon}<span class="session-name">${escapeHtml(session.sessionName)}</span>${model}${summary}${pct}
</div>
${children}
</div>`;
  }

  private buildHtml(sessions: SessionInfo[], nonceValue: string, fullscreen: boolean): string {
    const style = `<style>${GRAPH_CSS}</style>`;
    const head = `<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonceValue}';">
${style}
</head>`;

    if (sessions.length === 0) {
      const note = fullscreen
        ? '<div class="empty-note">Sessions appear here while thinking, running subagents or Codex, or during an active turn.</div>'
        : '';
      return `<!DOCTYPE html>
<html lang="en">
${head}
<body><div class="empty">No active agents${note}</div></body>
</html>`;
    }

    const now = Date.now();
    const blocks = sessions.map(s => this.buildSessionBlock(s, fullscreen, now)).join('');
    return `<!DOCTYPE html>
<html lang="en">
${head}
<body>
<div class="graph${fullscreen ? ' fullscreen' : ''}">
${blocks}
</div>
<script nonce="${nonceValue}">
(function() {
  var vscode = acquireVsCodeApi();
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.cmd === 'openCodexFile') {
        vscode.postMessage({ command: 'openCodexFile', path: el.dataset.path });
        return;
      }
      if (el.dataset && el.dataset.cmd === 'focusClaudeSession') {
        vscode.postMessage({ command: 'focusClaudeSession', sessionId: el.dataset.sessionId });
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
}
