import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  readClaudeSettings, findAllSessionsCached, findDirtySessionsCached, clearSessionCache,
  ClaudeSettings, getMonitorDir, SortMode, FilterMode, ModelFilter, GroupMode,
  findUnknownPricingModels, SessionInfo,
} from './sessions';
import { SessionWebviewProvider, OverviewTreeProvider } from './views';
import { GraphWebviewProvider, GraphData } from './graph-view';
import { findRecentCodexSessions, getCodexSessionsDir, setCodexLogger, CodexSessionInfo } from './codex';
import { fetchRateLimits, startCredentialsWatch, stopCredentialsWatch } from './ratelimit';

// ─── Constants ───

const DEBOUNCE_MS = 300;
const EXTENDED_DEBOUNCE_MS = 1000;
const DIRTY_QUEUE_EXTEND_THRESHOLD = 100;
const DIRTY_QUEUE_FULL_RECONCILE_THRESHOLD = 10_000;
const MAX_JSONL_WATCHERS = 50;
const MAX_SUBAGENT_LABEL_CACHE_ENTRIES = 1000;
const MAX_CODEX_ASSIGNMENT_CACHE_ENTRIES = 1000;


function getPollIntervalMs(): number {
  const config = vscode.workspace.getConfiguration('claudeCodeVitals');
  const seconds = config.get<number>('pollInterval', 60);
  return Math.max(1, Math.min(60, seconds)) * 1000;
}

// ─── Logging ───

let log: (msg: string) => void = () => {};

// ─── Sparkline types ───

interface UsageDataPoint {
  t: number;  // timestamp ms
  u: number;  // contextUsed
}
type UsageHistory = Record<string, UsageDataPoint[]>;

interface SubagentLabelCacheEntry {
  mtimeMs: number;
  size: number;
  label: string;
}

const subagentLabelCache = new Map<string, SubagentLabelCacheEntry>();
const codexSessionAssignments = new Map<string, string>();

// ─── Activate ───

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Claude Code Vitals');
  context.subscriptions.push(outputChannel);
  log = (msg: string) => outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  setCodexLogger(log);
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  const graphProvider = new GraphWebviewProvider(async (sessionId) => {
    graphProvider.setFocusedSession(sessionId);
    const cmds = await vscode.commands.getCommands(true);
    if (cmds.includes('claude-vscode.editor.open')) {
      vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
    }
  });
  const sessionProvider = new SessionWebviewProvider(async (sessionId) => {
    graphProvider.setFocusedSession(sessionId);
    const cmds = await vscode.commands.getCommands(true);
    if (cmds.includes('claude-vscode.editor.open')) {
      vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
    } else {
      vscode.window.showWarningMessage('Claude Code extension is not installed. Session focus requires the Claude Code VSCode extension.');
    }
  }, context.globalState);
  const overviewProvider = new OverviewTreeProvider();
  graphProvider.setRefreshHandler(() => scheduleRefresh(undefined, true));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SessionWebviewProvider.viewId, sessionProvider),
    vscode.window.registerWebviewViewProvider(GraphWebviewProvider.viewId, graphProvider),
  );
  const overviewView = vscode.window.createTreeView('claudeCodeVitalsOverviewView', {
    treeDataProvider: overviewProvider,
  });
  context.subscriptions.push(overviewView);

  let watchers = new Map<string, fs.FSWatcher>();
  let lastMtimes = new Map<string, number>();
  let currentSessions: import('./sessions').SessionInfo[] = [];
  let lastSettings: ClaudeSettings = {
    maxTokensOverride: null,
    autocompactPct: 0,
    contextWindowOverride: null,
    settingsModelNormalized: null,
    cleanupPeriodDays: 30,
    autoCompactWindow: null,
    autoCompactEnabled: true,
  };
  let lastWarnThreshold = -1;
  let lastCritThreshold = -1;
  let lastInactiveHours = -1;
  let lastNotifyLevel = '';
  let lastCardDisplay = '';
  let lastTooltipDisplay = '';
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval>;
  let refreshRunning = false;
  let refreshPending = false;
  let forceReconcile = true;
  const dirtyPaths = new Set<string>();
  const notifiedSessions = new Set<string>();
  const reportedUnknownModels = new Set<string>();

  function markDirtyPath(p: string, reconcile = false): void {
    if (dirtyPaths.size > DIRTY_QUEUE_FULL_RECONCILE_THRESHOLD) {
      dirtyPaths.clear();
      forceReconcile = true;
      return;
    }
    dirtyPaths.add(p);
    if (reconcile) { forceReconcile = true; }
  }

  function scheduleRefresh(p?: string, reconcile = false) {
    if (p) { markDirtyPath(p, reconcile); }
    else if (reconcile) { forceReconcile = true; }
    if (debounceTimer) { clearTimeout(debounceTimer); }
    const delay = dirtyPaths.size > DIRTY_QUEUE_EXTEND_THRESHOLD ? EXTENDED_DEBOUNCE_MS : DEBOUNCE_MS;
    debounceTimer = setTimeout(() => { void refresh(); }, delay);
  }

  async function refresh() {
    if (refreshRunning) {
      refreshPending = true;
      return;
    }
    refreshRunning = true;
    debounceTimer = null;

    try {
      const refreshDirtyPaths = new Set(dirtyPaths);
      dirtyPaths.clear();
      const shouldReconcile = forceReconcile || refreshDirtyPaths.size === 0;
      forceReconcile = false;

      const config = vscode.workspace.getConfiguration('claudeCodeVitals');
      const warnThreshold = config.get<number>('warningThreshold', 75);
      const critThreshold = config.get<number>('criticalThreshold', 95);
      const inactiveHours = config.get<number>('inactiveHours', 24);
      const notificationLevel = config.get<string>('notificationLevel', 'none');
      const effectiveLevel = notificationLevel;
      const inactiveMs = inactiveHours * 60 * 60 * 1000;

      const settings = readClaudeSettings();

    // Detect changes — clear cache before loading if settings changed
    const settingsChanged =
      settings.maxTokensOverride !== lastSettings.maxTokensOverride ||
      settings.autocompactPct !== lastSettings.autocompactPct ||
      settings.contextWindowOverride !== lastSettings.contextWindowOverride ||
      settings.settingsModelNormalized !== lastSettings.settingsModelNormalized ||
      settings.cleanupPeriodDays !== lastSettings.cleanupPeriodDays ||
      settings.autoCompactWindow !== lastSettings.autoCompactWindow ||
      settings.autoCompactEnabled !== lastSettings.autoCompactEnabled ||
      settings.autoCompactWindowEnv !== lastSettings.autoCompactWindowEnv ||
      settings.maxOutputTokensEnv !== lastSettings.maxOutputTokensEnv ||
      settings.disableCompact !== lastSettings.disableCompact ||
      settings.disableAutoCompact !== lastSettings.disableAutoCompact;
    const progressMode = config.get<string>('progressMode', 'compact') as 'compact' | 'context';
    const cardDisplayObj = config.get<Record<string, boolean>>('cardDisplay', {});
    const tooltipDisplayObj = config.get<Record<string, boolean>>('tooltipDisplay', {});
    const cardDisplay = Object.entries({ sparkline: false, model: true, messages: true, compact: true, agents: true, cost: true, ...cardDisplayObj })
      .filter(([, v]) => v).map(([k]) => k);
    const tooltipDisplay = Object.entries({ context: true, compact: true, messages: true, tokens: true, cost: true, compacts: true, agents: true, ...tooltipDisplayObj })
      .filter(([, v]) => v).map(([k]) => k);
    const cardDisplayKey = cardDisplay.join(',');
    const tooltipDisplayKey = tooltipDisplay.join(',');

    const configChanged =
      warnThreshold !== lastWarnThreshold ||
      critThreshold !== lastCritThreshold ||
      inactiveHours !== lastInactiveHours ||
      effectiveLevel !== lastNotifyLevel ||
      cardDisplayKey !== lastCardDisplay ||
      tooltipDisplayKey !== lastTooltipDisplay;

      if (settingsChanged) {
        clearSessionCache();
        forceReconcile = false;
      }

      const sessions = (settingsChanged || shouldReconcile)
        ? findAllSessionsCached(projectsDir, settings, inactiveMs, sessionProvider.pinnedSessionIds)
        : findDirtySessionsCached(projectsDir, settings, inactiveMs, sessionProvider.pinnedSessionIds, currentSessions, refreshDirtyPaths);
      currentSessions = sessions;

    let dataChanged = settingsChanged || configChanged || sessions.length !== lastMtimes.size;
    if (!dataChanged) {
      for (const s of sessions) {
        if (lastMtimes.get(s.filePath) !== s.displayMtimeMs) { dataChanged = true; break; }
      }
    }

    // Update file watchers
    const newPaths = new Set(sessions.map(s => s.filePath));
      for (const [p, w] of watchers) {
        if (!newPaths.has(p) || sessions.length > MAX_JSONL_WATCHERS) { w.close(); watchers.delete(p); }
      }
      if (sessions.length <= MAX_JSONL_WATCHERS) {
        for (const s of sessions) {
          if (!watchers.has(s.filePath)) {
            try {
              const w = fs.watch(s.filePath, () => scheduleRefresh(s.filePath));
              watchers.set(s.filePath, w);
            } catch (e) { log(`Failed to watch file: ${s.filePath}: ${e}`); }
          }
        }
      }
      if (sessions.length > MAX_JSONL_WATCHERS && watchers.size > 0) {
        for (const w of watchers.values()) { w.close(); }
        watchers.clear();
      }

      if (dataChanged) {
        lastMtimes = new Map(sessions.map(s => [s.filePath, s.displayMtimeMs]));
        lastSettings = settings;
        lastWarnThreshold = warnThreshold;
        lastCritThreshold = critThreshold;
        lastInactiveHours = inactiveHours;
        lastNotifyLevel = effectiveLevel;
        lastCardDisplay = cardDisplayKey;
        lastTooltipDisplay = tooltipDisplayKey;
      }

    // Sparkline data collection
      const history: UsageHistory = context.globalState.get('usageHistory', {});
      for (const s of sessions) {
        if (!history[s.sessionId]) { history[s.sessionId] = []; }
        const points = history[s.sessionId];
        const last = points[points.length - 1];
        if (!last || last.u !== s.contextUsed) {
          points.push({ t: Date.now(), u: s.contextUsed });
        }
        if (points.length > 100) {
          history[s.sessionId] = points.slice(-100);
        }
      }
      // Clean up sessions no longer active
      const activeIds = new Set(sessions.map(s => s.sessionId));
      for (const sid of Object.keys(history)) {
        if (!activeIds.has(sid)) { delete history[sid]; }
      }
      // History only changes when session data changed — skip the storage write otherwise
      if (dataChanged) { context.globalState.update('usageHistory', history); }

    // Always update views (status is time-dependent)
      sessionProvider.updateDisplaySettings(cardDisplay, tooltipDisplay, progressMode);
      sessionProvider.update(sessions, warnThreshold, critThreshold, history);

      // Graph view: Codex session discovery + correlation
      const codexSessions = findRecentCodexSessions(inactiveHours);
      const graphDataMap = correlateCodexSessions(sessions, codexSessions, projectsDir);
      graphProvider.update(sessions, graphDataMap);

      const debugGraphStateFile = config.get<string>('debugGraphStateFile', '');
      if (debugGraphStateFile) { writeGraphDebugState(debugGraphStateFile, sessions, graphDataMap); }

      overviewProvider.update(sessions, settings);

      for (const modelId of findUnknownPricingModels(sessions)) {
        if (reportedUnknownModels.has(modelId)) { continue; }
        reportedUnknownModels.add(modelId);
        log(`[pricing] Unknown model: ${modelId} — cost reported as $0. Update MODEL_PRICING in sessions.ts.`);
      }

    // Fetch rate limits asynchronously (only when data changed, respects 60s cache)
      if (dataChanged) {
        fetchRateLimits().then(info => {
          overviewProvider.updateRateLimit(info);
        }).catch((e) => { log(`Failed to fetch rate limits: ${e}`); });
      }

    // Notifications (opt-in, only on data change)
      if (dataChanged && effectiveLevel !== 'none') {
        const threshold = effectiveLevel === 'warning' ? warnThreshold : critThreshold;
        for (const s of sessions) {
          if (s.usagePercent >= threshold) {
            if (!notifiedSessions.has(s.filePath)) {
              notifiedSessions.add(s.filePath);
              const name = s.sessionName.length > 30
                ? s.sessionName.substring(0, 30) + '...'
                : s.sessionName;
              const msg = `Claude session "${name}" at ${s.usagePercent.toFixed(0)}% context usage`;
              if (effectiveLevel === 'critical') {
                vscode.window.showWarningMessage(msg);
              } else {
                vscode.window.showInformationMessage(msg);
              }
            }
          } else {
            notifiedSessions.delete(s.filePath);
          }
        }
      }
    } catch (e) {
      log(`Refresh failed: ${e}`);
    } finally {
      refreshRunning = false;
      if (refreshPending) {
        refreshPending = false;
        scheduleRefresh();
      }
    }
  }

  // Apply default sort/filter from settings
  {
    const cfg = vscode.workspace.getConfiguration('claudeCodeVitals');
    const defaultSort = cfg.get<SortMode>('defaultSort', 'time');
    const defaultFilter = cfg.get<FilterMode>('defaultFilter', 'all');
    const defaultModelFilter = cfg.get<ModelFilter>('defaultModelFilter', 'all');
    const defaultGroup = cfg.get<GroupMode>('defaultGroup', 'none');
    if (defaultSort !== 'time') { sessionProvider.setSortMode(defaultSort); }
    if (defaultFilter !== 'all') { sessionProvider.setFilterMode(defaultFilter); }
    if (defaultModelFilter !== 'all') { sessionProvider.setModelFilter(defaultModelFilter); }
    if (defaultGroup !== 'none') { sessionProvider.setGroupMode(defaultGroup); }
  }

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-vitals.refresh', () => {
      forceReconcile = true;
      return refresh();
    }),
    vscode.commands.registerCommand('claude-code-vitals.sortByTime', () => sessionProvider.setSortMode('time')),
    vscode.commands.registerCommand('claude-code-vitals.sortByUsage', () => sessionProvider.setSortMode('usage')),
    vscode.commands.registerCommand('claude-code-vitals.sortByCompact', () => sessionProvider.setSortMode('compact')),
    vscode.commands.registerCommand('claude-code-vitals.filterAll', () => sessionProvider.setFilterMode('all')),
    vscode.commands.registerCommand('claude-code-vitals.filterWarning', () => sessionProvider.setFilterMode('warning')),
    vscode.commands.registerCommand('claude-code-vitals.filterCritical', () => sessionProvider.setFilterMode('critical')),
    vscode.commands.registerCommand('claude-code-vitals.modelFilterAll', () => sessionProvider.setModelFilter('all')),
    vscode.commands.registerCommand('claude-code-vitals.modelFilterFable', () => sessionProvider.setModelFilter('fable')),
    vscode.commands.registerCommand('claude-code-vitals.modelFilterOpus', () => sessionProvider.setModelFilter('opus')),
    vscode.commands.registerCommand('claude-code-vitals.modelFilterSonnet', () => sessionProvider.setModelFilter('sonnet')),
    vscode.commands.registerCommand('claude-code-vitals.modelFilterHaiku', () => sessionProvider.setModelFilter('haiku')),
    vscode.commands.registerCommand('claude-code-vitals.toggleShowHidden', () => sessionProvider.toggleShowHidden()),
    vscode.commands.registerCommand('claude-code-vitals.groupNone', () => sessionProvider.setGroupMode('none')),
    vscode.commands.registerCommand('claude-code-vitals.groupByProject', () => sessionProvider.setGroupMode('project')),
    vscode.commands.registerCommand('claude-code-vitals.groupByStatus', () => sessionProvider.setGroupMode('status')),
    vscode.commands.registerCommand('claude-code-vitals.groupByCustom', () => sessionProvider.setGroupMode('custom')),
    vscode.commands.registerCommand('claude-code-vitals.manageGroups', () => sessionProvider.manageCustomGroups()),
    vscode.commands.registerCommand('claude-code-vitals.setupHooks', () => setupHooks(context)),
    vscode.commands.registerCommand('claude-code-vitals.removeHooks', () => removeHooks()),
    vscode.commands.registerCommand('claude-code-vitals.refreshGraph', () => scheduleRefresh(undefined, true)),
    vscode.commands.registerCommand('claude-code-vitals.openGraphInEditor', () => graphProvider.openInEditor()),
  );

  // Watch config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeCodeVitals')) {
        clearSessionCache();
        forceReconcile = true;
        void refresh();

        if (e.affectsConfiguration('claudeCodeVitals.pollInterval')) {
          clearInterval(pollTimer);
          pollTimer = setInterval(() => scheduleRefresh(projectsDir, true), getPollIntervalMs());
        }

        // Auto setup/remove hooks based on enableHookDetection
        if (e.affectsConfiguration('claudeCodeVitals.enableHookDetection')) {
          const cfg = vscode.workspace.getConfiguration('claudeCodeVitals');
          const enabled = cfg.get<boolean>('enableHookDetection', false);
          if (enabled) {
            setupHooks(context);
          } else {
            removeHooks();
          }
        }

        // Re-fetch rate limits immediately when token source changes
        if (e.affectsConfiguration('claudeCodeVitals.useEnvOauthToken')) {
          fetchRateLimits(true).then(info => {
            overviewProvider.updateRateLimit(info);
          }).catch((e) => { log(`Failed to fetch rate limits: ${e}`); });
        }
      }
    }),
  );

  // Watch project directories for new session files
  const dirWatchers: fs.FSWatcher[] = [];
  try {
    const dw = fs.watch(projectsDir, () => scheduleRefresh(projectsDir, true));
    dirWatchers.push(dw);
    for (const dirent of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) { continue; }
      try {
        const projPath = path.join(projectsDir, dirent.name);
        const dw2 = fs.watch(projPath, (_event, filename) => {
          if (filename && filename.endsWith('.jsonl')) {
            scheduleRefresh(path.join(projPath, filename.toString()));
          } else {
            scheduleRefresh(projPath, true);
          }
        });
        dirWatchers.push(dw2);
        // Watch subagent directories for agent activity detection
        for (const sub of fs.readdirSync(projPath, { withFileTypes: true })) {
          if (!sub.isDirectory()) { continue; }
          const subagentDir = path.join(projPath, sub.name, 'subagents');
          try {
            if (fs.existsSync(subagentDir)) {
              const dw3 = fs.watch(subagentDir, () => scheduleRefresh(subagentDir, true));
              dirWatchers.push(dw3);
            }
          } catch { /* skip */ }
        }
      } catch (e) { log(`Failed to watch project dir: ${path.join(projectsDir, dirent.name)}: ${e}`); }
    }
  } catch (e) { log(`Failed to watch projects dir: ${projectsDir}: ${e}`); }

  // Watch tasks directories for tool/agent activity detection (os.tmpdir()/claude/)
  const tasksBase = path.join(os.tmpdir(), 'claude');
  try {
    if (fs.existsSync(tasksBase)) {
      const tw = fs.watch(tasksBase, { recursive: true }, () => scheduleRefresh(tasksBase, true));
      dirWatchers.push(tw);
    }
  } catch (e) { log(`Failed to watch tasks dirs: ${e}`); }

  // Watch Codex rollout files for graph updates
  const codexSessionsDir = getCodexSessionsDir();
  try {
    const codexWatcher = fs.watch(codexSessionsDir, { recursive: true }, () => {
      scheduleRefresh(undefined, false);
    });
    dirWatchers.push(codexWatcher);
  } catch (e) { log(`Codex sessions dir not found: ${e}`); }

  // Watch hook monitor directory for state changes (waiting/stopped)
  try {
    const monitorDir = getMonitorDir();
    fs.mkdirSync(monitorDir, { recursive: true });
    const monitorWatcher = fs.watch(monitorDir, () => scheduleRefresh(monitorDir, true));
    dirWatchers.push(monitorWatcher);
  } catch (e) { log(`Failed to watch monitor dir: ${e}`); }

  // Sync hook state with setting on activation
  {
    const cfg = vscode.workspace.getConfiguration('claudeCodeVitals');
    const wantHooks = cfg.get<boolean>('enableHookDetection', false);
    // Always clean stale entries from settings.json on activation
    cleanGlobalSettingsHooks();
    const settings = readClaudeSettingsJson();
    const hasHooks = isHookInstalled(settings);
    if (wantHooks && !hasHooks) {
      setupHooks(context);
    } else if (!wantHooks && hasHooks) {
      removeHooks();
    }
  }

  // Start
  startCredentialsWatch(() => scheduleRefresh(projectsDir, true));
  void refresh();
  pollTimer = setInterval(() => scheduleRefresh(projectsDir, true), getPollIntervalMs());

  context.subscriptions.push({
    dispose: () => {
      clearInterval(pollTimer);
      if (debounceTimer) { clearTimeout(debounceTimer); }
      for (const w of watchers.values()) { w.close(); }
      for (const dw of dirWatchers) { dw.close(); }
      stopCredentialsWatch();
      sessionProvider.dispose();
      graphProvider.dispose();
    },
  });
}

export function deactivate() {}

// Debug hook: mirrors the exact data handed to the graph view so external
// tooling can observe what the UI displays. Enabled only when the
// (undeclared) setting claudeCodeVitals.debugGraphStateFile is set.
function writeGraphDebugState(filePath: string, sessions: SessionInfo[], graphDataMap: Map<string, GraphData>): void {
  try {
    const now = Date.now();
    const state = {
      timestamp: new Date().toISOString(),
      sessions: sessions.map(s => ({
        sessionId: s.sessionId,
        name: s.sessionName,
        status: s.status,
        displayAgeSec: Math.round((now - s.displayMtimeMs) / 1000),
        activeAgents: s.activeAgentCount,
        totalAgents: s.totalAgentCount,
        codex: (graphDataMap.get(s.sessionId)?.codexSessions || []).map(c => ({
          sessionId: c.sessionId,
          status: c.status,
          subcommand: c.subcommand,
          silenceSec: Math.round((now - c.mtimeMs) / 1000),
          prompt: c.prompt.slice(0, 60),
        })),
      })),
    };
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch (e) { log(`graph debug dump failed: ${e}`); }
}

function correlateCodexSessions(
  claudeSessions: SessionInfo[],
  codexSessions: CodexSessionInfo[],
  projectsDir: string,
): Map<string, GraphData> {
  const map = new Map<string, GraphData>();
  for (const cs of claudeSessions) {
    map.set(cs.sessionId, {
      claudeSessionId: cs.sessionId,
      codexSessions: [],
      subagentCount: cs.totalAgentCount,
      activeSubagentCount: cs.activeAgentCount,
      subagentTimestamps: cs._agentTimestamps,
      subagentLabels: readSubagentLabels(projectsDir, cs.projectDir, cs.sessionId, cs.totalAgentCount),
    });
  }
  for (const codex of codexSessions) {
    const assignedSessionId = codexSessionAssignments.get(codex.sessionId);
    if (assignedSessionId && map.has(assignedSessionId)) {
      map.get(assignedSessionId)!.codexSessions.push(codex);
      continue;
    }
    if (assignedSessionId) {
      codexSessionAssignments.delete(codex.sessionId);
    }

    const candidates = getEncodedAncestors(codex.cwd);
    let bestMatch: string | null = null;
    let bestLen = -1;
    let bestTimeDiff = Infinity;
    for (const cs of claudeSessions) {
      const key = matchKey(cs.projectDir);
      if (!candidates.has(key)) { continue; }
      const timeDiff = Math.abs(codex.startTime - cs.displayMtimeMs);
      if (cs.projectDir.length > bestLen || (cs.projectDir.length === bestLen && timeDiff < bestTimeDiff)) {
        bestLen = cs.projectDir.length;
        bestTimeDiff = timeDiff;
        bestMatch = cs.sessionId;
      }
    }
    if (bestMatch) {
      if (codexSessionAssignments.size > MAX_CODEX_ASSIGNMENT_CACHE_ENTRIES) {
        codexSessionAssignments.clear();
      }
      codexSessionAssignments.set(codex.sessionId, bestMatch);
      map.get(bestMatch)!.codexSessions.push(codex);
    }
  }
  return map;
}

function readSubagentLabels(projectsDir: string, projectDir: string, sessionId: string, count: number): string[] {
  if (count === 0) { return []; }
  const labels: string[] = [];
  try {
    const subagentDir = path.join(projectsDir, projectDir, sessionId, 'subagents');
    const files = fs.readdirSync(subagentDir).filter(f => f.endsWith('.jsonl')).sort();
    for (const file of files) {
      const fallback = `Agent ${labels.length + 1}`;
      try {
        const fp = path.join(subagentDir, file);
        const stat = fs.statSync(fp);
        const cached = subagentLabelCache.get(fp);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          labels.push(cached.label || fallback);
          continue;
        }
        const fd = fs.openSync(fp, 'r');
        try {
          const buf = Buffer.alloc(Math.min(4096, stat.size));
          fs.readSync(fd, buf, 0, buf.length, 0);
          const text = buf.toString('utf8');
          const label = extractSubagentLabel(text);
          if (subagentLabelCache.size > MAX_SUBAGENT_LABEL_CACHE_ENTRIES) {
            subagentLabelCache.clear();
          }
          subagentLabelCache.set(fp, { mtimeMs: stat.mtimeMs, size: stat.size, label });
          labels.push(label || fallback);
        } finally { fs.closeSync(fd); }
      } catch { labels.push(fallback); }
    }
  } catch { /* subagent dir doesn't exist */ }
  return labels;
}

function extractSubagentLabel(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] || '';
  try {
    const data = JSON.parse(firstLine);
    if (data.type === 'user') {
      const content = data.message?.content;
      if (typeof content === 'string') {
        return content.replace(/\s+/g, ' ').trim().substring(0, 60);
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            return block.text.replace(/\s+/g, ' ').trim().substring(0, 60);
          }
        }
      }
    }
  } catch { /* JSON parse failed — line truncated, try pattern extraction */ }
  const marker = '"content":"';
  const idx = firstLine.indexOf(marker);
  if (idx === -1) { return ''; }
  const start = idx + marker.length;
  let result = '';
  for (let i = start; i < firstLine.length && result.length < 80; i++) {
    const ch = firstLine[i];
    if (ch === '"') { break; }
    if (ch === '\\' && i + 1 < firstLine.length) {
      const next = firstLine[i + 1];
      if (next === 'n' || next === 't' || next === 'r') { result += ' '; i++; continue; }
      if (next === '"') { result += '"'; i++; continue; }
      result += next; i++; continue;
    }
    result += ch;
  }
  return result.replace(/\s+/g, ' ').trim().substring(0, 60);
}

function encodePathLikeClaude(fsPath: string): string {
  return fsPath.replace(/[\/\\]+$/, '').replace(/[:\/\\]/g, '-');
}

function matchKey(encoded: string): string {
  const normalized = encoded.normalize('NFC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getEncodedAncestors(fsPath: string): Set<string> {
  const candidates = new Set<string>();
  let current = fsPath.replace(/[\/\\]+$/, '');
  const variants = [current];
  try { variants.push(fs.realpathSync.native(current)); } catch { /* ignore */ }
  for (const variant of variants) {
    let p = variant;
    while (true) {
      candidates.add(matchKey(encodePathLikeClaude(p)));
      const parent = path.dirname(p);
      if (parent === p) { break; }
      p = parent;
    }
  }
  return candidates;
}
// ─── Hook Setup/Remove ───

const HOOK_ID = 'claude-code-vitals';
const LEGACY_HOOK_IDS = ['claude-session-monitor'];
const HOOK_SCRIPT = 'session-monitor-state.js';
const LEGACY_SCRIPTS = ['session-monitor-state.sh', 'session-monitor-waiting.sh', 'session-monitor-stopped.sh'];
const HOOK_EVENTS = [
  'UserPromptSubmit', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd',
] as const;
// All events ever registered by this extension (for cleanup of legacy entries)
const ALL_OWNED_EVENTS = [
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd',
];

interface HookEntry { _id?: string; hooks: { type: string; command: string }[] }
interface HooksConfig { [event: string]: HookEntry[] }

function isOurEntry(entry: HookEntry): boolean {
  return entry._id === HOOK_ID || (entry._id !== undefined && LEGACY_HOOK_IDS.includes(entry._id));
}
function filterOurEntries(entries: HookEntry[]): HookEntry[] { return entries.filter(e => !isOurEntry(e)); }

function getClaudeLocalSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.local.json');
}

function getClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

function claudeDirExists(): boolean {
  return fs.existsSync(getClaudeDir());
}

function getClaudeHooksDir(): string {
  return path.join(getClaudeDir(), 'hooks');
}

function getClaudeGlobalSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readClaudeSettingsJson(): Record<string, unknown> {
  const p = getClaudeLocalSettingsPath();
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function writeClaudeSettingsJson(obj: Record<string, unknown>): void {
  if (!claudeDirExists()) { return; }
  const p = getClaudeLocalSettingsPath();
  const backup = p + '.bak';
  try { fs.copyFileSync(p, backup); } catch { /* no existing file */ }
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** Remove our hook entries and resulting empty arrays from settings.json (global).
 *  Empty arrays for managed events in settings.json can override settings.local.json hooks. */
function cleanGlobalSettingsHooks(): void {
  const globalPath = getClaudeGlobalSettingsPath();
  let globalSettings: Record<string, unknown>;
  try { globalSettings = JSON.parse(fs.readFileSync(globalPath, 'utf8')); } catch { return; }
  const hooks = globalSettings.hooks as HooksConfig | undefined;
  if (!hooks) { return; }

  let changed = false;
  for (const event of ALL_OWNED_EVENTS) {
    if (!(event in hooks)) { continue; }
    const cleaned = filterOurEntries(hooks[event] || []);
    if (cleaned.length === 0) {
      delete hooks[event];
      changed = true;
    } else if (cleaned.length !== (hooks[event]?.length ?? 0)) {
      hooks[event] = cleaned;
      changed = true;
    }
  }
  if (changed) {
    try { fs.writeFileSync(globalPath, JSON.stringify(globalSettings, null, 2) + '\n', 'utf8'); }
    catch (e) { log(`Failed to clean global settings hooks: ${e}`); }
  }
}

function isHookInstalled(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as HooksConfig | undefined;
  if (!hooks) { return false; }
  // All events must have an entry with the current HOOK_ID AND point to the current unified script
  return HOOK_EVENTS.every(event => {
    const ours = hooks[event]?.find(e => e._id === HOOK_ID);
    return ours && ours.hooks?.some(h => h.command.includes(HOOK_SCRIPT));
  });
}

async function setupHooks(context: vscode.ExtensionContext): Promise<void> {
  if (!claudeDirExists()) {
    vscode.window.showWarningMessage('Claude Code is not installed (~/.claude not found). Hooks cannot be set up.');
    return;
  }
  // 1. Copy hook script (single unified script)
  const destDir = getClaudeHooksDir();
  fs.mkdirSync(destDir, { recursive: true });
  const src = path.join(context.extensionPath, 'hooks', HOOK_SCRIPT);
  if (!fs.existsSync(src)) {
    vscode.window.showErrorMessage(`Hook script ${HOOK_SCRIPT} not found in extension.`);
    return;
  }
  fs.copyFileSync(src, path.join(destDir, HOOK_SCRIPT));
  // Clean up legacy scripts
  for (const legacy of LEGACY_SCRIPTS) {
    try { fs.unlinkSync(path.join(destDir, legacy)); } catch { /* already gone */ }
  }

  // 2. Clean stale entries from settings.json (global) to prevent override conflicts
  cleanGlobalSettingsHooks();

  // 3. Update settings.local.json
  const settings = readClaudeSettingsJson();
  if (isHookInstalled(settings)) {
    vscode.window.showInformationMessage('Hooks are already configured.');
    return;
  }
  if (!settings.hooks) { settings.hooks = {}; }
  const hooks = settings.hooks as HooksConfig;

  // Clean up ALL owned entries (including legacy PreToolUse/PostToolUse)
  for (const event of ALL_OWNED_EVENTS) {
    if (hooks[event]) {
      hooks[event] = filterOurEntries(hooks[event]);
      if (hooks[event].length === 0) { delete hooks[event]; }
    }
  }

  // Register current events
  for (const event of HOOK_EVENTS) {
    if (!hooks[event]) { hooks[event] = []; }
    hooks[event].push({
      _id: HOOK_ID,
      hooks: [{ type: 'command', command: `node ~/.claude/hooks/${HOOK_SCRIPT}` }],
    });
  }

  try {
    writeClaudeSettingsJson(settings);
  } catch (e) {
    log(`Failed to write settings for hook setup: ${e}`);
    vscode.window.showErrorMessage('Failed to write Claude settings for hooks.');
    return;
  }
  vscode.window.showInformationMessage('Claude Code Vitals hooks installed. Restart Claude Code sessions to activate.');
}

async function removeHooks(): Promise<void> {
  const settings = readClaudeSettingsJson();
  const hooks = settings.hooks as HooksConfig | undefined;
  if (!hooks || !ALL_OWNED_EVENTS.some(event => hooks[event]?.some(isOurEntry))) {
    vscode.window.showInformationMessage('Hooks are not installed.');
    return;
  }

  // Clean up ALL owned entries from both settings files
  cleanGlobalSettingsHooks();
  for (const event of ALL_OWNED_EVENTS) {
    if (hooks[event]) {
      hooks[event] = filterOurEntries(hooks[event]);
      if (hooks[event].length === 0) { delete hooks[event]; }
    }
  }
  try {
    writeClaudeSettingsJson(settings);
  } catch (e) {
    log(`Failed to write settings for hook removal: ${e}`);
    vscode.window.showErrorMessage('Failed to write Claude settings for hook removal.');
    return;
  }

  const hooksDir = getClaudeHooksDir();
  try { fs.unlinkSync(path.join(hooksDir, HOOK_SCRIPT)); } catch { /* already gone */ }
  for (const legacy of LEGACY_SCRIPTS) {
    try { fs.unlinkSync(path.join(hooksDir, legacy)); } catch { /* already gone */ }
  }
  vscode.window.showInformationMessage('Claude Code Vitals hooks removed.');
}
