# Claude Code Vitals

Real-time session status detection, multi-session management, and compact tracking for Claude Code.

**English** | [日本語](README-ja.md)

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/barrel1054.claude-code-vitals?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=barrel1054.claude-code-vitals)

![Screenshot](https://raw.githubusercontent.com/barrel10/vscode-claude-code-vitals/main/media/screenshot.png)

## Install

Search `Claude Code Vitals` in VS Code Extensions, or:

```
ext install barrel1054.claude-code-vitals
```

## Requirements

- [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
- Node.js in PATH (required for hook detection)

## Features

### Session Cards

Each session is displayed as a card with real-time status, progress bar, and metadata.

| Element | Description |
|---------|-------------|
| Session name | AI-generated title, first user input, or session ID |
| Elapsed time | Relative time since last update (`<1m` / `Xm` / `Xh`) |
| Status icon | thinking=animation / waiting=blinking hourglass / idle/inactive=dot. Color changes green→yellow→red with progress |
| Usage (%) | Progress toward compact threshold or overall context usage (configurable) |
| Progress bar | Color-coded by usage level |

### Metadata (toggleable per element)

| Element | Example |
|---------|---------|
| Model | `opus` |
| Messages | `57 msgs` |
| Compact remaining | `compact 429.9k` |
| Agents | `9 agents` |
| Cost estimate | `$18.27` |
| Sparkline | Context usage over time (off by default) |

### Hover Actions

| Button | Action |
|--------|--------|
| Pin / Unpin | Pin session to top of list |
| Copy ID | Copy session ID to clipboard |
| JSONL | Open transcript file |

Click a card to focus the Claude Code session.

### Tooltip (toggleable per element)

| Element | Example |
|---------|---------|
| Context usage | `Context: 455.8k / 1.0M (46%)` |
| Compact progress | `Compact at 49%: 429.9k left (52%)` |
| Messages | `Messages: 121` |
| Token breakdown | `Input: 12.3M · Output: 890.5k · Cache hit: 78%` |
| Cost | `Cost: $18.2742` |
| Compact count | `Compacts: 5 (auto: 4 / manual: 1)` |
| Agents | `Agents: 9 spawned (2 active)` |

## Overview Panel

Aggregated stats across all sessions.

| Item | Description |
|------|-------------|
| Active | Total sessions (with thinking/waiting breakdown) |
| Max | Highest context usage across all sessions |
| Rate | API rate limit usage (5h window) and reset time |
| Cost | Total cost across all sessions |
| Compacts | Total compact events |
| Updated | Most recent session update |

## Sort & Filter

Available from the Sessions view title bar menu (`...`).

### Sort Order

Sort is applied in 3 stages: pinned → status (thinking→waiting→idle→inactive) → selected sort key.

| Sort | Description |
|------|-------------|
| Sort by Time | Most recently updated first (default) |
| Sort by Usage | Highest context usage first |
| Sort by Compact Proximity | Fewest tokens until compact first |

### Filter

| Filter | Description |
|--------|-------------|
| Show All | All sessions (default) |
| Warning Only | Sessions above warning threshold |
| Critical Only | Sessions above critical threshold |

## Session Status

| Status | Condition | Display |
|--------|-----------|---------|
| thinking | Active response generation or tool execution | Animated icon |
| waiting | Waiting for permission approval (hook detection only) | Blinking hourglass |
| idle | Recently active but not currently processing | Static dot |
| inactive | No updates for 15+ seconds | Static dot |

## Cost Estimate

Calculates estimated cost based on token usage in session transcripts.

### Pricing (per 1M tokens, as of 2026-04-17)

| Model | Input | Cache Write 5m | Cache Write 1h | Cache Read | Output |
|-------|-------|---------------|---------------|------------|--------|
| Opus (4.6+) | $5.00 | $6.25 | $10.00 | $0.50 | $25.00 |
| Opus (4.1/4) | $15.00 | $18.75 | $30.00 | $1.50 | $75.00 |
| Sonnet| $3.00 | $3.75 | $6.00  | $0.30 | $15.00 |
| Haiku | $1.00 | $1.25 | $2.00  | $0.10 | $5.00  |

### Limitations

- Estimates based on public pricing, not actual billing
- Does not reflect Max/Pro plan discounts

## Hook Detection

Uses Claude Code's hook system for precise session lifecycle detection.

- Enable via `enableHookDetection` setting (off by default)
- Automatically configures Claude Code hooks when enabled and removes them when disabled
- Without hooks, thinking/idle detection still works via transcript monitoring (waiting requires hooks)

## Settings

Search `claude code vitals` in VS Code settings (`Ctrl+,`).

| Setting | Default | Description |
|---------|---------|-------------|
| `enableHookDetection` | false | Enable hook-based status detection. Automatically configures hooks when enabled, removes when disabled. Requires Node.js |
| `warningThreshold` | 75 | Warning threshold (%) |
| `criticalThreshold` | 95 | Critical threshold (%) |
| `notificationLevel` | `none` | Notification trigger level (none/warning/critical) |
| `pollInterval` | 5 | Polling interval in seconds (1-60) |
| `inactiveHours` | 24 | Hide sessions inactive for this many hours |
| `defaultSort` | `time` | Default sort order (time/usage/compact) |
| `defaultFilter` | `all` | Default filter (all/warning/critical) |
| `progressMode` | `compact` | Progress bar basis: `compact` or `context` |
| `cardDisplay` | model, messages, compact, agents, cost ON | Card metadata elements |
| `tooltipDisplay` | all ON | Tooltip elements |

## License

MIT
