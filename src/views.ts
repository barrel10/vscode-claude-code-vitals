import * as vscode from 'vscode';
import {
  SessionInfo, SortMode, FilterMode,
  formatTokens, formatRelativeTime, shortenModel, calculateCost,
} from './sessions';
import { RateLimitInfo, formatResetTime } from './ratelimit';

// ─── Helpers ───

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── SessionWebviewProvider ───

export class SessionWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'claudeCodeVitalsSessionView';

  private _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];
  private allSessions: SessionInfo[] = [];
  private sortMode: SortMode = 'time';
  private filterMode: FilterMode = 'all';
  private warningThreshold = 75;
  private criticalThreshold = 95;
  private rateLimit: RateLimitInfo | null = null;
  private usageHistory: Record<string, { t: number; u: number }[]> = {};
  private cardDisplay = new Set(['model', 'messages', 'compact', 'agents', 'cost']);
  private tooltipDisplay = new Set(['context', 'compact', 'messages', 'tokens', 'cost', 'compacts', 'agents']);
  private progressMode: 'compact' | 'context' = 'compact';
  private pinnedSessions = new Set<string>();

  get pinnedSessionIds(): ReadonlySet<string> { return this.pinnedSessions; }

  constructor(
    private readonly _onFocusSession: (sessionId: string) => void,
    private readonly _globalState: vscode.Memento,
  ) {
    this.pinnedSessions = new Set(_globalState.get<string[]>('pinnedSessions', []));
  }

  updateRateLimit(info: RateLimitInfo | null): void {
    this.rateLimit = info;
    this.render();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(
      msg => {
        if (msg.command === 'focusSession') {
          const sessions = this.getDisplaySessions();
          const session = sessions[msg.index];
          if (session) {
            this._onFocusSession(session.sessionId);
          }
        }
        if (msg.command === 'togglePin') {
          if (this.pinnedSessions.has(msg.sessionId)) {
            this.pinnedSessions.delete(msg.sessionId);
          } else {
            this.pinnedSessions.add(msg.sessionId);
          }
          this._globalState.update('pinnedSessions', [...this.pinnedSessions]);
          this.render();
        }
        if (msg.command === 'copyId') {
          vscode.env.clipboard.writeText(msg.sessionId);
        }
        if (msg.command === 'openFile') {
          vscode.workspace.openTextDocument(msg.path).then(doc => vscode.window.showTextDocument(doc));
        }
      },
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

  update(sessions: SessionInfo[], warningThreshold: number, criticalThreshold: number, history?: Record<string, { t: number; u: number }[]>): void {
    this.allSessions = sessions;
    this.warningThreshold = warningThreshold;
    this.criticalThreshold = criticalThreshold;
    if (history) { this.usageHistory = history; }
    this.render();
    this.updateBadge();
  }

  updateDisplaySettings(card: string[], tooltip: string[], progressMode: 'compact' | 'context' = 'compact'): void {
    this.cardDisplay = new Set(card);
    this.tooltipDisplay = new Set(tooltip);
    this.progressMode = progressMode;
  }

  setSortMode(mode: SortMode): void {
    this.sortMode = mode;
    this.render();
  }

  setFilterMode(mode: FilterMode): void {
    this.filterMode = mode;
    this.render();
  }

  dispose(): void {
    for (const d of this._disposables) { d.dispose(); }
  }

  private updateBadge(): void {
    if (!this._view) { return; }
    const count = this.allSessions.filter(s => s.usagePercent >= this.warningThreshold).length;
    this._view.badge = count > 0
      ? { value: count, tooltip: `${count} session(s) above ${this.warningThreshold}%` }
      : undefined;
  }

  private getDisplaySessions(): SessionInfo[] {
    return this.applySort(this.applyFilter(this.allSessions));
  }

  private render(): void {
    if (!this._view) { return; }
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        .charAt(Math.floor(Math.random() * 62))
    ).join('');
    this._view.webview.html = this.buildHtml(this.getDisplaySessions(), nonce);
  }

  private buildHtml(sessions: SessionInfo[], nonce: string): string {
    const groups = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      const g = groups.get(s.projectDir);
      if (g) { g.push(s); } else { groups.set(s.projectDir, [s]); }
    }
    const multiProject = groups.size > 1;

    let cards = '';
    let globalIndex = 0;
    if (multiProject) {
      for (const [, projectSessions] of groups) {
        const label = projectSessions[0].projectLabel;
        cards += `<div class="group-header">${escapeHtml(label)}</div>`;
        for (const s of projectSessions) {
          cards += this.buildCard(s, globalIndex++);
        }
      }
    } else {
      for (const s of sessions) {
        cards += this.buildCard(s, globalIndex++);
      }
    }

    return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  user-select: none;
}
.list { padding: 4px 0; }
.session {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  margin: 0 4px;
  cursor: pointer;
  border-radius: 6px;
  border: none;
  background: transparent;
}
.session:hover { background: var(--vscode-list-hoverBackground); }
.row1 {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 22px;
}
.name {
  color: var(--vscode-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  font-size: 1em;
}
.pin { font-size: 10px; flex-shrink: 0; opacity: .7; }
.time {
  opacity: .7;
  font-size: .9em;
  flex-shrink: 0;
  margin-left: auto;
}
.row2 {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 16px;
  padding-left: 1px;
}
.dot { font-size: 8px; line-height: 1; flex-shrink: 0; }
.thinking {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 10px;
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1;
}
.waiting {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 10px;
  flex-shrink: 0;
  font-size: 9px;
  line-height: 1;
  animation: blink 1s linear infinite;
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.pct { font-size: .8em; opacity: .85; min-width: 26px; }
.bar-track {
  flex: 1;
  height: 2px;
  background: rgba(128,128,128,0.2);
  border-radius: 1px;
  overflow: hidden;
}
.bar-fill { height: 100%; border-radius: 1px; }
.row3 {
  opacity: .6;
  font-size: .8em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 1px;
  height: 16px;
}
.group-header {
  padding: 10px 12px 4px;
  font-size: .75em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .5px;
  opacity: .6;
}
.row3-wrap { height: 16px; overflow: hidden; position: relative; }
.actions { display: none; gap: 4px; padding: 0; position: absolute; top: 0; left: 1px; }
.session:hover .row3 { visibility: hidden; }
.session:hover .actions { display: flex; }
.action {
  font-size: .7em;
  padding: 1px 6px;
  border: 1px solid var(--vscode-button-border, var(--vscode-widget-border));
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  border-radius: 3px;
  font-family: inherit;
}
.action:hover { background: var(--vscode-button-hoverBackground, rgba(255,255,255,0.1)); }
.sparkline { padding: 2px 0 0 20px; opacity: 0.7; }
.sparkline svg { display: block; }
.empty {
  padding: 24px 12px;
  opacity: .5;
  text-align: center;
}</style>
</head><body>
<div class="list">${sessions.length > 0 ? cards : '<div class="empty">No active sessions</div>'}</div>
<script nonce="${nonce}">
(function() {
  var vscode = acquireVsCodeApi();
  document.addEventListener('click', function(e) {
    if (e.target.classList && e.target.classList.contains('action')) {
      e.stopPropagation();
      vscode.postMessage({
        command: e.target.dataset.cmd,
        sessionId: e.target.dataset.sid,
        path: e.target.dataset.path
      });
    }
  }, true);
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && !el.classList.contains('session')) { el = el.parentElement; }
    if (el && el.dataset.index !== undefined) {
      vscode.postMessage({ command: 'focusSession', index: parseInt(el.dataset.index, 10) });
    }
  });
  var frames = ['\\u00B7','\\u2722','\\u2733','\\u2736','\\u273B','\\u273D','\\u273B','\\u2736','\\u2733','\\u2722'];
  var idx = 0;
  setInterval(function() {
    idx = (idx + 1) % frames.length;
    var els = document.querySelectorAll('.thinking');
    for (var i = 0; i < els.length; i++) { els[i].textContent = frames[idx]; }
  }, 150);
})();
</script>
</body></html>`;
  }

  private buildCard(s: SessionInfo, index: number): string {
    const name = escapeHtml(s.sessionName.length > 42
      ? s.sessionName.substring(0, 42) + '...' : s.sessionName);
    const time = formatRelativeTime(s.displayMtimeMs);
    const compact = formatTokens(s.tokensUntilCompact);
    const model = shortenModel(s.model);
    const progress = Math.min(100, this.getProgress(s));
    const pct = progress.toFixed(0);
    const colorVar = this.getColorVar(progress);

    const tt = this.tooltipDisplay;
    const tooltipLines = [s.sessionName, s.model];
    if (tt.has('context')) {
      tooltipLines.push(`Context: ${formatTokens(s.contextUsed)} / ${formatTokens(s.contextMax)} (${(s.contextUsed / s.contextMax * 100).toFixed(0)}%)`);
    }
    if (tt.has('compact')) {
      const compactProgress = Math.min(100, (() => { const t = s.contextMax * s.autocompactPct / 100; return t > 0 ? (s.contextUsed / t) * 100 : 0; })());
      tooltipLines.push(`Compact at ${s.autocompactPct}%: ${compact} left (${compactProgress.toFixed(0)}%)`);
    }
    if (tt.has('messages')) {
      tooltipLines.push(`Messages: ${s.messageCount}`);
    }
    if (tt.has('tokens')) {
      tooltipLines.push(`Input: ${formatTokens(s.inputTokens)} \u00B7 Output: ${formatTokens(s.outputTokens)} \u00B7 Cache hit: ${s.inputTokens + s.cacheReadTokens + s.cacheCreationTokens > 0 ? ((s.cacheReadTokens / (s.inputTokens + s.cacheReadTokens + s.cacheCreationTokens)) * 100).toFixed(0) : 0}%`);
    }
    const cost = calculateCost(s);
    if (tt.has('cost') && cost !== null) {
      tooltipLines.push(`Cost: $${cost.toFixed(4)}`);
    }
    if (tt.has('compacts') && s.compactCount > 0) {
      tooltipLines.push(`Compacts: ${s.compactCount} (auto: ${s.compactAutoCount} / manual: ${s.compactManualCount})`);
    }
    if (tt.has('agents') && s.totalAgentCount > 0) {
      tooltipLines.push(`Agents: ${s.totalAgentCount} spawned${s.activeAgentCount > 0 ? ` (${s.activeAgentCount} active)` : ''}`);
    }
    const tooltip = escapeHtml(tooltipLines.join('\n'));

    const cd = this.cardDisplay;
    const meta: string[] = [];
    if (cd.has('model') && model) { meta.push(model); }
    if (cd.has('messages')) { meta.push(`${s.messageCount} msgs`); }
    if (cd.has('compact')) { meta.push(`compact ${compact}`); }
    if (cd.has('agents') && s.totalAgentCount > 0) { meta.push(`${s.totalAgentCount} agents`); }
    if (cd.has('cost') && cost !== null) { meta.push('$' + cost.toFixed(2)); }

    let statusIcon: string;
    if (s.status === 'thinking') {
      statusIcon = `<span class="thinking" style="color:var(${colorVar})">&#x00B7;</span>`;
    } else if (s.status === 'waiting') {
      statusIcon = `<span class="waiting" style="color:var(--vscode-charts-yellow)">&#x23F3;</span>`;
    } else {
      statusIcon = `<span class="dot" style="color:var(${colorVar})">&#x25CF;</span>`;
    }

    const sparkline = cd.has('sparkline') ? this.buildSparkline(s.sessionId, s.contextMax) : '';

    const pinIcon = this.pinnedSessions.has(s.sessionId) ? '<span class="pin">&#x1F4CC;</span>' : '';

    return `<div class="session" data-index="${index}" title="${tooltip}">
  <div class="row1">
    ${pinIcon}<span class="name">${name}</span>
    <span class="time">${time}</span>
  </div>
  <div class="row2">
    ${statusIcon}
    <span class="pct">${pct}%</span>
    <div class="bar-track"><div class="bar-fill" style="width:${progress.toFixed(1)}%;background:var(${colorVar})"></div></div>
  </div>
  ${sparkline}
  <div class="row3-wrap">
    <div class="row3">${escapeHtml(meta.join(' · '))}</div>
    <div class="actions">
    <button class="action" data-cmd="togglePin" data-sid="${escapeHtml(s.sessionId)}">${this.pinnedSessions.has(s.sessionId) ? 'Unpin' : 'Pin'}</button>
    <button class="action" data-cmd="copyId" data-sid="${escapeHtml(s.sessionId)}">Copy ID</button>
    <button class="action" data-cmd="openFile" data-path="${escapeHtml(s.filePath)}">JSONL</button>
    </div>
  </div>
</div>`;
  }

  private buildSparkline(sessionId: string, contextMax: number): string {
    const points = this.usageHistory[sessionId];
    if (!points || points.length < 2) { return ''; }
    const w = 120, h = 20;
    const maxU = contextMax || 1;
    const coords = points.map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - (p.u / maxU) * h;
      return `${x.toFixed(1)},${Math.max(0, Math.min(h, y)).toFixed(1)}`;
    });
    return `<div class="sparkline"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <polyline points="${coords.join(' ')}" fill="none" stroke="var(--vscode-charts-blue)" stroke-width="1.5" stroke-linejoin="round" />
  </svg></div>`;
  }

  private getColorVar(compactProgress: number): string {
    if (compactProgress >= this.criticalThreshold) { return '--vscode-charts-red'; }
    if (compactProgress >= this.warningThreshold) { return '--vscode-charts-yellow'; }
    return '--vscode-charts-green';
  }

  private getProgress(s: SessionInfo): number {
    if (this.progressMode === 'context') {
      return s.contextMax > 0 ? (s.contextUsed / s.contextMax) * 100 : 0;
    }
    const threshold = s.contextMax * s.autocompactPct / 100;
    return threshold > 0 ? (s.contextUsed / threshold) * 100 : 0;
  }

  private applyFilter(sessions: SessionInfo[]): SessionInfo[] {
    switch (this.filterMode) {
      case 'warning': return sessions.filter(s =>
        this.getProgress(s) >= this.warningThreshold);
      case 'critical': return sessions.filter(s =>
        this.getProgress(s) >= this.criticalThreshold);
      default: return sessions;
    }
  }

  private statusOrder(s: SessionInfo): number {
    switch (s.status) {
      case 'thinking': return 0;
      case 'waiting': return 1;
      case 'idle': return 2;
      case 'inactive': return 3;
      default: return 4;
    }
  }

  private applySort(sessions: SessionInfo[]): SessionInfo[] {
    const arr = [...sessions];
    const pinned = this.pinnedSessions;

    arr.sort((a, b) => {
      // 1. Pinned sessions first
      const pa = pinned.has(a.sessionId) ? 0 : 1;
      const pb = pinned.has(b.sessionId) ? 0 : 1;
      if (pa !== pb) { return pa - pb; }

      // 2. Group by status
      const sa = this.statusOrder(a);
      const sb = this.statusOrder(b);
      if (sa !== sb) { return sa - sb; }

      // 3. Sort key
      switch (this.sortMode) {
        case 'usage': return b.usagePercent - a.usagePercent;
        case 'compact': return a.tokensUntilCompact - b.tokensUntilCompact;
        default: return b.displayMtimeMs - a.displayMtimeMs;
      }
    });
    return arr;
  }
}

// ─── OverviewTreeProvider ───

export class OverviewTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private sessions: SessionInfo[] = [];
  private rateLimit: RateLimitInfo | null = null;

  update(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    this._onDidChange.fire();
  }

  updateRateLimit(info: RateLimitInfo | null): void {
    this.rateLimit = info;
    this._onDidChange.fire();
  }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem { return el; }

  getChildren(): vscode.TreeItem[] {
    const total = this.sessions.length;
    const thinkingCount = this.sessions.filter(s => s.status === 'thinking').length;
    const waitingCount = this.sessions.filter(s => s.status === 'waiting').length;
    const maxUsage = total > 0 ? Math.max(...this.sessions.map(s => s.usagePercent)) : 0;
    const latestMtime = total > 0 ? Math.max(...this.sessions.map(s => s.displayMtimeMs)) : 0;

    const items: vscode.TreeItem[] = [];
    const addItem = (label: string, value: string, icon: string, color?: string) => {
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description = value;
      item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
      items.push(item);
    };

    // Sessions count with status breakdown
    const statusParts: string[] = [];
    if (thinkingCount > 0) { statusParts.push(`${thinkingCount} thinking`); }
    if (waitingCount > 0) { statusParts.push(`${waitingCount} waiting`); }
    const activeDesc = statusParts.length > 0
      ? `${total} (${statusParts.join(', ')})`
      : String(total);
    addItem('Sessions', activeDesc, 'pulse', 'charts.blue');

    // Thinking/waiting session names
    for (const s of this.sessions) {
      if (s.status === 'thinking' || s.status === 'waiting') {
        const name = s.sessionName.length > 30 ? s.sessionName.substring(0, 30) + '...' : s.sessionName;
        const icon = s.status === 'thinking' ? 'sync~spin' : 'bell';
        const color = s.status === 'thinking' ? 'charts.green' : 'charts.yellow';
        addItem(`  ${s.status}`, name, icon, color);
      }
    }

    // Max compact progress
    const maxColor = maxUsage >= 95 ? 'charts.red' : maxUsage >= 75 ? 'charts.yellow' : 'charts.green';
    addItem('Max usage', total > 0 ? maxUsage.toFixed(0) + '%' : '-', 'graph', maxColor);

    // Rate limit
    if (this.rateLimit) {
      const pct = Math.round(this.rateLimit.util5h);
      const reset = formatResetTime(this.rateLimit.reset5h);
      const color = pct >= 90 ? 'charts.red' : pct >= 50 ? 'charts.yellow' : 'charts.green';
      addItem('Rate', `${pct}%/5h (${reset})`, 'dashboard', color);
    }

    // Total cost
    const totalCost = this.sessions.reduce((sum, s) => sum + (calculateCost(s) ?? 0), 0);
    if (totalCost > 0) {
      addItem('Cost', '$' + totalCost.toFixed(2), 'credit-card', 'charts.blue');
    }

    // Total compacts with auto/manual breakdown
    const totalCompacts = this.sessions.reduce((sum, s) => sum + s.compactCount, 0);
    if (totalCompacts > 0) {
      const totalAuto = this.sessions.reduce((sum, s) => sum + s.compactAutoCount, 0);
      const totalManual = this.sessions.reduce((sum, s) => sum + s.compactManualCount, 0);
      addItem('Compacts', `${totalCompacts} (auto: ${totalAuto} / manual: ${totalManual})`, 'fold', 'charts.yellow');
    }

    // Active agents
    const totalActiveAgents = this.sessions.reduce((sum, s) => sum + s.activeAgentCount, 0);
    const totalAgents = this.sessions.reduce((sum, s) => sum + s.totalAgentCount, 0);
    if (totalAgents > 0) {
      addItem('Agents', `${totalAgents} spawned${totalActiveAgents > 0 ? ` (${totalActiveAgents} active)` : ''}`, 'server-process', 'charts.blue');
    }

    addItem('Updated', latestMtime > 0 ? formatRelativeTime(latestMtime) : '-', 'clock');

    return items;
  }
}
