# Changelog

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
