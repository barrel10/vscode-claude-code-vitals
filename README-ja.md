# Claude Code Vitals

[English](README.md) | **日本語**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/barrel1054.claude-code-vitals?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=barrel1054.claude-code-vitals)

Claude Codeセッションのステータス・compact残量・トークン使用量をリアルタイム監視するVS Code拡張。

![スクリーンショット](media/screenshot.png)

## インストール

VS Code拡張機能で `Claude Code Vitals` を検索、または:

```
ext install barrel1054.claude-code-vitals
```

## 必要条件

- [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
- Node.jsがPATHに必要（フック検出使用時）

## 機能

### セッションカード

各セッションをカード形式で表示。ステータス、プログレスバー、メタデータをリアルタイム更新。

| 要素 | 説明 |
|------|------|
| セッション名 | AI生成タイトル / ユーザーの最初の入力 / セッションID |
| 経過時間 | 最終更新からの相対時間（`<1m` / `Xm` / `Xh`） |
| ステータスアイコン | thinking=アニメーション / waiting=砂時計点滅 / idle・inactive=固定ドット |
| 使用率（%） | compact閾値への進捗またはコンテキスト全体の使用率 |
| プログレスバー | 使用率に応じて緑→黄→赤に変化 |

### メタデータ（要素ごとに表示切替可能）

| 要素 | 表示例 |
|------|--------|
| モデル名 | `opus` |
| 応答数 | `57 msgs` |
| compact残量 | `compact 429.9k` |
| エージェント数 | `9 agents` |
| コスト概算 | `$18.27` |
| スパークライン | コンテキスト使用量の時系列グラフ（デフォルトOFF） |

### ホバーアクション

| ボタン | 動作 |
|--------|------|
| Pin / Unpin | セッションをリスト先頭に固定/解除 |
| Copy ID | セッションIDをクリップボードにコピー |
| JSONL | トランスクリプトファイルを開く |

カードクリックでClaude Codeセッションにフォーカス。

### ツールチップ（要素ごとに表示切替可能）

| 要素 | 表示例 |
|------|--------|
| コンテキスト使用量 | `Context: 455.8k / 1.0M (46%)` |
| compact進捗 | `Compact at 49%: 429.9k left (52%)` |
| 応答数 | `Messages: 121` |
| トークン内訳 | `Input: 12.3M · Output: 890.5k · Cache hit: 78%` |
| コスト | `Cost: $18.2742` |
| compact回数 | `Compacts: 5 (auto: 4 / manual: 1)` |
| エージェント数 | `Agents: 9 spawned (2 active)` |

## Overviewパネル

全セッションの集計情報をツリービューで表示。

| 項目 | 説明 |
|------|------|
| Active | セッション総数（thinking/waiting内訳付き） |
| Max | 最大コンテキスト使用率 |
| Rate | APIレート制限使用率とリセット時刻 |
| Cost | コスト合計 |
| Compacts | compact発火回数合計 |
| Updated | 最新更新時刻 |

## ソートとフィルタ

Sessionsビューのタイトルバーメニュー（`...`）から切替。

### ソート順

ピン留め → ステータス（thinking→waiting→idle→inactive） → 選択したソートキーの3段階。

| ソート | 説明 |
|--------|------|
| Sort by Time | 最終更新時刻の新しい順（デフォルト） |
| Sort by Usage | コンテキスト使用率の高い順 |
| Sort by Compact Proximity | compact残トークンの少ない順 |

### フィルタ

| フィルタ | 説明 |
|----------|------|
| Show All | 全セッション表示（デフォルト） |
| Warning Only | warning閾値以上のみ |
| Critical Only | critical閾値以上のみ |

## セッションステータス

| ステータス | 条件 | 表示 |
|-----------|------|------|
| thinking | 応答生成中またはツール実行中 | アニメーションアイコン |
| waiting | 権限承認待ち（フック検出時のみ） | 砂時計点滅 |
| idle | 最近アクティブだが現在処理なし | 固定ドット |
| inactive | 15秒以上更新なし | 固定ドット |

## コスト概算

セッショントランスクリプトのトークン使用量に基づく概算。

### 単価テーブル（100万トークンあたり、2026-04-17時点）

| モデル | Input | Cache Write 5m | Cache Write 1h | Cache Read | Output |
|--------|-------|---------------|---------------|------------|--------|
| Opus (4.6+) | $5.00 | $6.25 | $10.00 | $0.50 | $25.00 |
| Opus (4.1/4) | $15.00 | $18.75 | $30.00 | $1.50 | $75.00 |
| Sonnet | $3.00 | $3.75 | $6.00  | $0.30 | $15.00 |
| Haiku  | $1.00 | $1.25 | $2.00  | $0.10 | $5.00  |

### 制限事項

- 公開単価に基づく概算値（実際の請求額ではない）
- Max/Proプランの割引は未反映

## フック検出

Claude Codeのフックシステムによる高精度なステータス検出。

- `enableHookDetection` 設定で有効化（デフォルトOFF）
- 有効化時にClaude Codeフックを自動設定、無効化時に自動削除
- フック無効時もthinking/idle検出は動作（waitingのみフック必須）

## 設定

VS Code設定（`Ctrl+,`）で `claude code vitals` を検索。

| 設定 | デフォルト | 説明 |
|------|----------|------|
| `enableHookDetection` | false | フック検出の有効化。有効化時に自動設定、無効化時に自動削除。Node.js必要 |
| `warningThreshold` | 75 | 警告閾値（%） |
| `criticalThreshold` | 95 | 危険閾値（%） |
| `notificationLevel` | `none` | 通知レベル（none/warning/critical） |
| `pollInterval` | 5 | ポーリング間隔（秒、1-60） |
| `inactiveHours` | 24 | 非アクティブセッションの非表示時間 |
| `defaultSort` | `time` | デフォルトソート順（time/usage/compact） |
| `defaultFilter` | `all` | デフォルトフィルタ（all/warning/critical） |
| `progressMode` | `compact` | プログレスバー基準: `compact` or `context` |
| `cardDisplay` | model, messages, compact, agents, cost ON | カード表示要素 |
| `tooltipDisplay` | 全項目ON | ツールチップ表示要素 |

## ライセンス

MIT
