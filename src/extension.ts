import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  readClaudeSettings, findAllSessionsCached, clearSessionCache,
  ClaudeSettings, getMonitorDir, SortMode, FilterMode, ModelFilter, GroupMode,
  findUnknownPricingModels,
} from './sessions';
import { SessionWebviewProvider, OverviewTreeProvider } from './views';
import { fetchRateLimits, startCredentialsWatch, stopCredentialsWatch } from './ratelimit';

// ─── Constants ───

const DEBOUNCE_MS = 300;


function getPollIntervalMs(): number {
  const config = vscode.workspace.getConfiguration('claudeCodeVitals');
  const seconds = config.get<number>('pollInterval', 5);
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

// ─── Activate ───

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Claude Code Vitals');
  context.subscriptions.push(outputChannel);
  log = (msg: string) => outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  const sessionProvider = new SessionWebviewProvider(async (sessionId) => {
    const cmds = await vscode.commands.getCommands(true);
    if (cmds.includes('claude-vscode.editor.open')) {
      vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
    } else {
      vscode.window.showWarningMessage('Claude Code extension is not installed. Session focus requires the Claude Code VSCode extension.');
    }
  }, context.globalState);
  const overviewProvider = new OverviewTreeProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SessionWebviewProvider.viewId, sessionProvider),
  );
  const overviewView = vscode.window.createTreeView('claudeCodeVitalsOverviewView', {
    treeDataProvider: overviewProvider,
  });
  context.subscriptions.push(overviewView);

  let watchers = new Map<string, fs.FSWatcher>();
  let lastMtimes = new Map<string, number>();
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
  const notifiedSessions = new Set<string>();
  const reportedUnknownModels = new Set<string>();

  function scheduleRefresh() {
    if (debounceTimer) { clearTimeout(debounceTimer); }
    debounceTimer = setTimeout(refresh, DEBOUNCE_MS);
  }

  function refresh() {
    debounceTimer = null;

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
      settings.disableAutoCompact !== lastSettings.disableAutoCompact ||
      settings.claudeCodeRemote !== lastSettings.claudeCodeRemote ||
      settings.redwood2AutoCompactWindow !== lastSettings.redwood2AutoCompactWindow ||
      settings.redwood3 !== lastSettings.redwood3;
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

    if (settingsChanged) { clearSessionCache(); }

    const sessions = findAllSessionsCached(projectsDir, settings, inactiveMs, sessionProvider.pinnedSessionIds);

    let dataChanged = settingsChanged || configChanged || sessions.length !== lastMtimes.size;
    if (!dataChanged) {
      for (const s of sessions) {
        if (lastMtimes.get(s.filePath) !== s.displayMtimeMs) { dataChanged = true; break; }
      }
    }

    // Update file watchers
    const newPaths = new Set(sessions.map(s => s.filePath));
    for (const [p, w] of watchers) {
      if (!newPaths.has(p)) { w.close(); watchers.delete(p); }
    }
    for (const s of sessions) {
      if (!watchers.has(s.filePath)) {
        try {
          const w = fs.watch(s.filePath, () => scheduleRefresh());
          watchers.set(s.filePath, w);
        } catch (e) { log(`Failed to watch file: ${s.filePath}: ${e}`); }
      }
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
    context.globalState.update('usageHistory', history);

    // Always update views (status is time-dependent)
    sessionProvider.updateDisplaySettings(cardDisplay, tooltipDisplay, progressMode);
    sessionProvider.update(sessions, warnThreshold, critThreshold, history);
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
    vscode.commands.registerCommand('claude-code-vitals.refresh', refresh),
    vscode.commands.registerCommand('claude-code-vitals.sortByTime', () => sessionProvider.setSortMode('time')),
    vscode.commands.registerCommand('claude-code-vitals.sortByUsage', () => sessionProvider.setSortMode('usage')),
    vscode.commands.registerCommand('claude-code-vitals.sortByCompact', () => sessionProvider.setSortMode('compact')),
    vscode.commands.registerCommand('claude-code-vitals.filterAll', () => sessionProvider.setFilterMode('all')),
    vscode.commands.registerCommand('claude-code-vitals.filterWarning', () => sessionProvider.setFilterMode('warning')),
    vscode.commands.registerCommand('claude-code-vitals.filterCritical', () => sessionProvider.setFilterMode('critical')),
    vscode.commands.registerCommand('claude-code-vitals.modelFilterAll', () => sessionProvider.setModelFilter('all')),
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
  );

  // Watch config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeCodeVitals')) {
        clearSessionCache();
        refresh();

        if (e.affectsConfiguration('claudeCodeVitals.pollInterval')) {
          clearInterval(pollTimer);
          pollTimer = setInterval(scheduleRefresh, getPollIntervalMs());
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
    const dw = fs.watch(projectsDir, () => scheduleRefresh());
    dirWatchers.push(dw);
    for (const dirent of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) { continue; }
      try {
        const projPath = path.join(projectsDir, dirent.name);
        const dw2 = fs.watch(projPath, () => scheduleRefresh());
        dirWatchers.push(dw2);
        // Watch subagent directories for agent activity detection
        for (const sub of fs.readdirSync(projPath, { withFileTypes: true })) {
          if (!sub.isDirectory()) { continue; }
          const subagentDir = path.join(projPath, sub.name, 'subagents');
          try {
            if (fs.existsSync(subagentDir)) {
              const dw3 = fs.watch(subagentDir, () => scheduleRefresh());
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
      const tw = fs.watch(tasksBase, { recursive: true }, () => scheduleRefresh());
      dirWatchers.push(tw);
    }
  } catch (e) { log(`Failed to watch tasks dirs: ${e}`); }

  // Watch hook monitor directory for state changes (waiting/stopped)
  try {
    const monitorDir = getMonitorDir();
    fs.mkdirSync(monitorDir, { recursive: true });
    const monitorWatcher = fs.watch(monitorDir, () => scheduleRefresh());
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
  startCredentialsWatch(scheduleRefresh);
  refresh();
  pollTimer = setInterval(scheduleRefresh, getPollIntervalMs());

  context.subscriptions.push({
    dispose: () => {
      clearInterval(pollTimer);
      if (debounceTimer) { clearTimeout(debounceTimer); }
      for (const w of watchers.values()) { w.close(); }
      for (const dw of dirWatchers) { dw.close(); }
      stopCredentialsWatch();
      sessionProvider.dispose();
    },
  });
}

export function deactivate() {}

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
