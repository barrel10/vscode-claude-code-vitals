import * as vscode from 'vscode';
import { CodexSessionInfo } from './codex';
import { SessionInfo, SessionStatus } from './sessions';

export interface GraphData {
  claudeSessionId: string;
  codexSessions: CodexSessionInfo[];
  subagentCount: number;
  activeSubagentCount: number;
  subagentTimestamps: number[];
  subagentLabels: string[];
}

interface GraphNode {
  id: string;
  type: 'claude' | 'subagent' | 'codex';
  label: string;
  sublabel: string;
  status: 'active' | 'idle' | 'completed';
  x: number;
  y: number;
  w?: number;
  tooltip?: string;
  sessionId?: string;
  filePath?: string;
  visualStatus?: SessionStatus | 'running';
}

interface GraphEdge {
  from: string;
  to: string;
}

interface LayoutResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

const CLAUDE_WIDTH = 160;
const CLAUDE_HEIGHT = 50;
const CHILD_WIDTH = 100;
const CHILD_HEIGHT = 36;
const CHILD_GAP = 16;
const GROUP_GAP = 60;
const PADDING = 40;
const PARENT_Y = 50;
const CHILD_Y = 150;
const ACTIVE_MS = 15_000;

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

  private getSessionsForSidebar(): SessionInfo[] {
    if (this.focusedSessionId) {
      const focused = this.sessions.find(s => s.sessionId === this.focusedSessionId);
      if (focused) { return [focused]; }
    }
    const thinking = this.sessions
      .filter(s => s.status === 'thinking')
      .sort((a, b) => b.displayMtimeMs - a.displayMtimeMs);
    if (thinking.length > 0) { return [thinking[0]]; }
    const recent = [...this.sessions]
      .filter(s => s.status !== 'inactive')
      .sort((a, b) => b.displayMtimeMs - a.displayMtimeMs);
    return recent.length > 0 ? [recent[0]] : [];
  }

  private getSessionsForPanel(): SessionInfo[] {
    return this.sessions.filter(s => {
      const graph = this.graphDataMap.get(s.sessionId);
      const hasCodex = (graph?.codexSessions.length || 0) > 0;
      return s.status !== 'inactive' && (
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

  private buildHtml(sessions: SessionInfo[], nonceValue: string, fullscreen: boolean): string {
    if (sessions.length === 0) {
      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonceValue}';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
.empty { text-align: center; padding: 40px; opacity: 0.5; }
</style>
</head>
<body><div class="empty">No active agents</div></body>
</html>`;
    }

    const scale = 1;
    const layout = this.buildLayout(sessions, scale, fullscreen);
    const nodeMap = new Map(layout.nodes.map(node => [node.id, node]));
    const edges = layout.edges.map(edge => this.renderEdge(edge, nodeMap, scale)).join('');
    const nodes = layout.nodes.map(node => this.renderNode(node, scale)).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonceValue}';">
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: transparent;
  user-select: none;
}
.graph-wrap { width: 100%; overflow-x: auto; overflow-y: auto; padding: 8px 0; }
svg { display: block; ${fullscreen ? 'min-width: 100%; height: auto;' : 'width: 100%; height: auto;'} }
.edge {
  fill: none;
  stroke: var(--vscode-descriptionForeground);
  stroke-opacity: 0.3;
  stroke-width: 1.5;
}
.node { cursor: pointer; }
.node:hover .shape { stroke: var(--vscode-focusBorder); stroke-width: 1.5; }
.shape { stroke: transparent; stroke-width: 1; }
.node text { pointer-events: none; fill: var(--vscode-editor-background); }
.node text.center { text-anchor: middle; }
.node text.left { text-anchor: start; }
.node .primary { font-size: 11px; font-weight: 600; }
.node .secondary { font-size: 9px; opacity: 0.85; }
.claude-thinking { fill: var(--vscode-charts-blue); }
.claude-waiting { fill: var(--vscode-charts-yellow); }
.claude-idle { fill: var(--vscode-descriptionForeground); opacity: 0.3; }
.subagent-active { fill: var(--vscode-charts-blue); }
.subagent-completed { fill: var(--vscode-descriptionForeground); opacity: 0.5; }
.codex-running { fill: var(--vscode-charts-green); }
.codex-completed { fill: var(--vscode-descriptionForeground); opacity: 0.5; }
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.node-active { animation: pulse 2s ease-in-out infinite; }
</style>
</head>
<body>
<div class="graph-wrap">
<svg width="100%" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="Agent graph">
${edges}
${nodes}
</svg>
</div>
<script nonce="${nonceValue}">
(function() {
  var vscode = acquireVsCodeApi();
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && (!el.classList || !el.classList.contains('node'))) { el = el.parentElement; }
    if (!el) { return; }
    if (el.dataset.cmd === 'focusClaudeSession') {
      vscode.postMessage({ command: 'focusClaudeSession', sessionId: el.dataset.sessionId });
    } else if (el.dataset.cmd === 'openCodexFile') {
      vscode.postMessage({ command: 'openCodexFile', path: el.dataset.path });
    }
  });
})();
</script>
</body>
</html>`;
  }

  private buildLayout(sessions: SessionInfo[], scale: number, fullscreen: boolean = false): LayoutResult {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const cw = CLAUDE_WIDTH * scale;
    const ch = CLAUDE_HEIGHT * scale;
    const childW = CHILD_WIDTH * scale;
    const childG = CHILD_GAP * scale;
    const groupG = GROUP_GAP * scale;
    const pad = PADDING * scale;
    const parentY = PARENT_Y * scale;
    const childY = CHILD_Y * scale;
    let cursorX = pad;

    for (const session of sessions) {
      const graph = this.graphDataMap.get(session.sessionId) || {
        claudeSessionId: session.sessionId,
        codexSessions: [],
        subagentCount: session.totalAgentCount,
        activeSubagentCount: session.activeAgentCount,
        subagentTimestamps: session._agentTimestamps,
        subagentLabels: [],
      };

      const now = Date.now();
      const activeAgentIndices: number[] = [];
      for (let i = 0; i < graph.subagentCount; i++) {
        const ts = graph.subagentTimestamps[i] || 0;
        if (now - ts < ACTIVE_MS) { activeAgentIndices.push(i); }
      }
      const RECENT_CODEX_MS = 5 * 60 * 1000;
      const visibleCodex = graph.codexSessions.filter(c =>
        c.status === 'running' || (now - c.mtimeMs < RECENT_CODEX_MS)
      );
      const doneAgents = graph.subagentCount - activeAgentIndices.length;
      const doneCodex = graph.codexSessions.length - visibleCodex.length;

      const activeChildCount = activeAgentIndices.length + visibleCodex.length;
      const childWidth = activeChildCount > 0 ? activeChildCount * childW + (activeChildCount - 1) * childG : 0;

      const sublabelParts: string[] = [session.model];
      if (doneAgents > 0) { sublabelParts.push(`${doneAgents} done`); }
      if (doneCodex > 0) { sublabelParts.push(`${doneCodex} codex done`); }

      const label = fullscreen ? session.sessionName : this.trimLabel(session.sessionName, 22);
      const sublabel = sublabelParts.join(' · ');
      const nodeW = fullscreen
        ? Math.max(cw, Math.max(label.length, sublabel.length) * 7 * scale + 16 * scale)
        : cw;
      const groupWidth = Math.max(nodeW, childWidth);
      const parentX = cursorX + groupWidth / 2;
      const parentId = `claude:${session.sessionId}`;

      nodes.push({
        id: parentId,
        type: 'claude',
        label,
        sublabel,
        w: nodeW,
        status: session.status === 'thinking' ? 'active' : 'idle',
        x: parentX,
        y: parentY,
        sessionId: session.sessionId,
        visualStatus: session.status,
      });

      if (activeChildCount > 0) {
        let childX = parentX - childWidth / 2 + childW / 2;
        for (const i of activeAgentIndices) {
          const childId = `subagent:${session.sessionId}:${i}`;
          const agentDesc = graph.subagentLabels[i] || `Agent ${i + 1}`;
          nodes.push({
            id: childId, type: 'subagent',
            label: `Agent ${i + 1}`,
            sublabel: session.model,
            tooltip: agentDesc,
            status: 'active', x: childX, y: childY,
          });
          edges.push({ from: parentId, to: childId });
          childX += childW + childG;
        }
        for (const codex of visibleCodex) {
          const childId = `codex:${codex.sessionId}`;
          const isRunning = codex.status === 'running';
          nodes.push({
            id: childId, type: 'codex',
            label: codex.subcommand,
            sublabel: codex.model || codex.subcommand,
            tooltip: codex.prompt || codex.subcommand,
            status: isRunning ? 'active' : 'completed', x: childX, y: childY,
            filePath: codex.filePath, visualStatus: isRunning ? 'running' : undefined,
          });
          edges.push({ from: parentId, to: childId });
          childX += childW + childG;
        }
      }

      cursorX += groupWidth + groupG;
    }

    const width = Math.max(240, cursorX - groupG + pad);
    const hasChildren = nodes.some(n => n.type !== 'claude');
    const height = hasChildren ? childY + pad : parentY + ch / 2 + pad;
    return { nodes, edges, width, height };
  }

  private renderEdge(edge: GraphEdge, nodeMap: Map<string, GraphNode>, scale: number): string {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    if (!from || !to) { return ''; }
    const ch = CLAUDE_HEIGHT * scale;
    const childH = CHILD_HEIGHT * scale;
    const x1 = from.x;
    const y1 = from.y + ch / 2;
    const x2 = to.x;
    const y2 = to.y - childH / 2;
    const midY = (y1 + y2) / 2;
    return `<path class="edge" d="M ${x1.toFixed(1)},${y1.toFixed(1)} C ${x1.toFixed(1)},${midY.toFixed(1)} ${x2.toFixed(1)},${midY.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" />`;
  }

  private renderNode(node: GraphNode, scale: number): string {
    if (node.type === 'claude') { return this.renderClaudeNode(node, scale); }
    if (node.type === 'subagent') { return this.renderSubagentNode(node, scale); }
    return this.renderCodexNode(node, scale);
  }

  private renderClaudeNode(node: GraphNode, scale: number): string {
    const nw = node.w || CLAUDE_WIDTH * scale;
    const ch = CLAUDE_HEIGHT * scale;
    const x = node.x - nw / 2;
    const y = node.y - ch / 2;
    const pad = 8 * scale;
    const textX = x + pad;
    const clipId = `clip-${node.id.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const className = node.visualStatus === 'thinking'
      ? 'claude-thinking node-active'
      : node.visualStatus === 'waiting'
        ? 'claude-waiting'
        : 'claude-idle';
    return `<g class="node" data-cmd="focusClaudeSession" data-session-id="${escapeHtml(node.sessionId || '')}">
<defs><clipPath id="${clipId}"><rect x="${(x + pad).toFixed(1)}" y="${y.toFixed(1)}" width="${nw - pad * 2}" height="${ch}" /></clipPath></defs>
<rect class="shape ${className}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" rx="${8 * scale}" width="${nw}" height="${ch}" />
<text class="primary left" clip-path="url(#${clipId})" x="${textX.toFixed(1)}" y="${(node.y - 3 * scale).toFixed(1)}" style="font-size:${11 * scale}px">${escapeHtml(node.label)}</text>
<text class="secondary left" clip-path="url(#${clipId})" x="${textX.toFixed(1)}" y="${(node.y + 14 * scale).toFixed(1)}" style="font-size:${9 * scale}px">${escapeHtml(node.sublabel)}</text>
</g>`;
  }

  private renderChildNode(node: GraphNode, scale: number, cssClass: string, cmd?: string): string {
    const w = CHILD_WIDTH * scale;
    const h = CHILD_HEIGHT * scale;
    const x = node.x - w / 2;
    const y = node.y - h / 2;
    const pad = 6 * scale;
    const clipId = `clip-${node.id.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const tip = node.tooltip ? `<title>${escapeHtml(node.tooltip)}</title>` : '';
    const cmdAttr = cmd ? ` data-cmd="${cmd}" data-path="${escapeHtml(node.filePath || '')}"` : '';
    return `<g class="node"${cmdAttr}>
${tip}
<defs><clipPath id="${clipId}"><rect x="${(x + pad).toFixed(1)}" y="${y.toFixed(1)}" width="${w - pad * 2}" height="${h}" /></clipPath></defs>
<rect class="shape ${cssClass}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" rx="${4 * scale}" width="${w}" height="${h}" />
<text class="primary left" clip-path="url(#${clipId})" x="${(x + pad).toFixed(1)}" y="${(node.y - 2 * scale).toFixed(1)}" style="font-size:${9 * scale}px">${escapeHtml(node.label)}</text>
<text class="secondary left" clip-path="url(#${clipId})" x="${(x + pad).toFixed(1)}" y="${(node.y + 11 * scale).toFixed(1)}" style="font-size:${8 * scale}px">${escapeHtml(node.sublabel)}</text>
</g>`;
  }

  private renderSubagentNode(node: GraphNode, scale: number): string {
    const className = node.status === 'active' ? 'subagent-active node-active' : 'subagent-completed';
    return this.renderChildNode(node, scale, className);
  }

  private renderCodexNode(node: GraphNode, scale: number): string {
    const className = node.status === 'active' ? 'codex-running node-active' : 'codex-completed';
    return this.renderChildNode(node, scale, className, 'openCodexFile');
  }

  private trimLabel(label: string, max: number): string {
    return label.length > max ? label.substring(0, max) + '...' : label;
  }
}
