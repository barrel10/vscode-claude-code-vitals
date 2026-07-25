# Changelog

## 1.8.0 (2026-07-25)

### Added
- Claude Opus 5 support: recognized as a 1M-context model (1M is its documented default and maximum, not something the `[1m]` suffix has to unlock), priced at $5/$25 per MTok, with a 128K default max output

### Changed
- Agent Graph is now a hierarchical list instead of an SVG node graph. Parent and children are related by indentation and a left rule, so the panel grows downward instead of sideways and no longer needs horizontal scrolling in a narrow sidebar
- The editor view lays sessions out in columns that reflow with the window width, instead of placing them in one ever-widening row
- Completed subagents and Codex runs now stay in the list instead of disappearing after 5 minutes. Running children are listed first, then completed ones by most recent activity, capped at 8 rows in the sidebar and 30 in the editor view with a `+N more` row for the remainder
- Session rows now show how many children are running out of the total, plus context usage; Codex rows show the subcommand, model, and elapsed time

### Security
- `claudeCodeVitals.enableHookDetection` is now `machine` scope. It was previously settable per workspace, so opening a repository whose `.vscode/settings.json` enabled it would install the hook script into `~/.claude/hooks/` and rewrite `~/.claude/settings.local.json` with no further action from you. Only your user or machine settings can turn it on now
- `claudeCodeVitals.debugGraphStateFile`, added in 1.7.1 as an undeclared setting, is now declared with `machine` scope. Previously a workspace's `.vscode/settings.json` could point the debug dump at any writable file and the extension would overwrite it on every refresh

## 1.7.2 (2026-07-23)

### Fixed
- Subagent labels now show the agent name and description from `.meta.json` sidecar files (e.g. "sleep-analysis" / "Fable fixes R4 Critical 2") instead of raw prompt text
- Agent Graph nodes now remain visible for 5 minutes after completion with a faded style, instead of disappearing after 15 seconds
- Agent Graph sublabel shows the agent's own model (e.g. "fable") when specified, rather than always inheriting the parent session's model
- Subagent metadata cache now includes `.meta.json` mtime in its invalidation key, so late-created or updated sidecar files are picked up without restarting the extension

## 1.7.1 (2026-07-03)

### Fixed
- Codex nodes no longer disappear or turn gray mid-run while the CLI stays silent during long shell commands: sessions without a completion event in their rollout now count as running for up to 30 minutes, instead of requiring a file write within the last 2 minutes
- Codex nodes now turn gray within seconds of the process finishing (completion events `task_complete` / `turn_aborted` / `error` are detected from the rollout tail), instead of up to 2 minutes later
- Codex nodes no longer jump between Claude sessions of the same project: the session assignment is decided once and kept stable
- Sessions with a running Codex child stay visible in the Agent Graph (sidebar and full-screen view) even after the Claude session itself goes idle

## 1.7.0 (2026-07-02)

### Added
- Agent Graph view: a new activity bar panel that visualizes the running Claude session as a live node graph, with spawned subagents and Codex CLI runs as child nodes (status colors, prompt tooltips, click-to-focus)
- Codex CLI session detection: rollout files under `~/.codex/sessions` (or `CODEX_HOME`) are parsed and matched to Claude sessions by working directory
- Full-screen graph view in an editor tab (view title icon) showing all active sessions
- Selecting a session in the Sessions panel focuses its graph

### Performance
- Codex rollout headers and subagent labels are cached (mtime+size keyed), and rollout headers read at most the leading 256 KB of the file, so refreshes no longer re-read unchanged or large files

## 1.6.1 (2026-06-29)

### Fixed
- Auto-compact now correctly shows as active for all local users. Previously, local sessions without an explicit `CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment variable could show auto-compact as inactive, diverging from Claude Code's actual default behavior (caused by a removed internal feature gate)

## 1.6.0 (2026-06-10)

### Added
- Claude Fable 5 support: model name, cost estimation, context window detection, and a new Fable entry in the model filter. Fable sessions previously showed a generic "claude" label with no cost estimate

### Fixed
- The `pollInterval` setting now correctly defaults to 60 seconds as documented (the published default had remained at 5 seconds)
- Activity bar badge count now agrees with the card progress bars when `progressMode` is set to `context`
- Japanese localization restored for the `pollInterval` setting description

### Performance
- Sub-agent transcript files are now cached per file, removing a remaining source of redundant re-reads on sessions with many sub-agents

## 1.5.3 (2026-06-05)

### Performance
- Reduced VS Code UI freezes during long work sessions. Large session logs are now processed incrementally, lowering refresh overhead for sessions with large transcripts

## 1.5.2 (2026-06-05)

### Fixed
- The context window size is now determined per session from its own model, instead of applying a global `[1m]` setting to every session. Previously, configuring `[1m]` for one model (for example Opus) could make unrelated sessions (such as Sonnet) display a 1M context bar. A session now shows 1M only when its own model warrants it: an explicit `[1m]` suffix, evidenced usage above 200K, or a `[1m]` settings model that matches the session's model

## 1.5.1 (2026-05-30)

### Fixed
- Auto-compact progress now reflects Claude Code's actual auto-compact configuration. The extension now reads `autoCompactWindow` and `autoCompactEnabled` from `~/.claude/settings.json` (matching Claude Code's official settings) instead of an unused experimental override

## 1.5.0 (2026-05-30)

### Added
- Claude Opus 4.8 support with 1M extended context (fixes the ~50% usage gauge that previously appeared immediately after starting an Opus 4.8 session)

### Fixed
- Cost, total tokens, and message counts were over-reported (roughly 2.2x, and ~2.6x for sub-agents) due to duplicated session records. Counts are now correctly deduplicated
- Auto-compact progress no longer over-reports (occasional 100%+ readings) on recent Claude Code versions. The display now matches the actual auto-compact behavior, including when auto-compact is disabled

## 1.4.1 (2026-05-29)

### Fixed
- Manually renamed sessions no longer revert to an AI-generated title shortly after the rename

## 1.4.0 (2026-04-29)

### Added
- Model filter (opus / sonnet / haiku) as an independent axis combined with the existing warning/critical filter via AND. New commands `Claude Code Vitals: Model All / Opus / Sonnet / Haiku` and setting `claudeCodeVitals.defaultModelFilter`
- Cleanup countdown in Overview using Claude Code's `cleanupPeriodDays` setting (default 30) so the oldest session's auto-deletion ETA is visible
- Optional `CLAUDE_CODE_OAUTH_TOKEN` environment override for usage fetch (preferred over disk credentials), gated by new setting `claudeCodeVitals.useEnvOauthToken` (off by default). Helpful for CI / env-only sessions
- Output channel warning when an unknown model id is detected so cost estimation gaps are surfaced (one log per id)

### Fixed
- Race window where a stale rate-limit fetch could overwrite fresh `cached` / `backoffUntil` after a forced re-fetch (introduced by the env fallback). Now guarded by a per-fetch generation counter
- Disk credentials watcher no longer resets backoff while the env token is the active source

## 1.3.0 (2026-04-17)

### Added
- Claude Opus 4.7 (`claude-opus-4-7`) support with extended context (1M via `[1m]` suffix)
- Per-model pricing for Opus 4.1 and Opus 4 (Anthropic public rates as of 2026-04-17)

### Fixed
- Cost calculation for legacy Opus sessions (Opus 4.1 / Opus 4 were underestimated at ~1/3 of actual rate because the `opus` alias applied Opus 4.6 pricing to all versions)

## 1.0.0 (2026-03-25)

Initial release.

### Features

- Real-time session status detection (thinking/waiting/idle/inactive) via Claude Code hooks
- Compact remaining visualization with progress bar and proximity sort
- Multi-session card view with project grouping
- Pin/unpin sessions (persisted across restarts)
- Sort by time, usage, or compact proximity
- Filter by all, warning, or critical threshold
- Cost estimation based on API pricing (per-model, cache-aware)
- Compact event tracking (auto/manual, compact_boundary + heuristic)
- Agent activity tracking (total/active count)
- Context usage sparkline (opt-in)
- Overview panel (active sessions, max usage, rate limit, cost, compacts)
- API rate limit display (5h window via OAuth)
- Configurable card/tooltip display elements
- Progress mode: compact threshold or overall context usage
- i18n support (English/Japanese)
- Hook-based detection with Node.js script (no bash dependency)
- Automatic hook install/uninstall via settings toggle
