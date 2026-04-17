# Changelog

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
