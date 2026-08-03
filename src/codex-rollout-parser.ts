import * as path from 'path';
import {
  MAX_ENTRIES, MAX_RAW_LINES, MAX_READ_BYTES,
  truncateText, bump, extractResultText,
  ViewerDocument, ViewerEntry, ToolViewerEntry, RawLine,
} from './viewer-common';
import { isWrapperText } from './codex';

// ─── Codex rollout JSONL → ViewerDocument ───
//
// レコード形式: 全行 {timestamp, type, payload}。type は session_meta / turn_context /
// event_msg / response_item / world_state / inter_agent_communication_metadata 等。
//
// 本文・思考・ツールは主に response_item をソースとする。event_msg/agent_message と
// event_msg/task_complete.last_agent_message は response_item 側の assistant message と
// 重複することが多いが、常に完全重複するとは限らない（response_item側に現れないケースが
// 実データ・報告事例で確認されている）ため、以下の2機構で重複判定する。
//   - pendingAgentEvents: event_msg/agent_message で表示した本文（trim後）→ pushしたentryの
//     FIFOリスト。response_item側の対応する message(assistant) / agent_message が到着したら
//     1件consumeし、ミラーであれば表示せず（pushしない）phaseのみ転記する。
//   - lastAssistantText: 直近に表示したassistant本文（trim後）。event/response の到着順が
//     逆転した場合（response先行→event後続）や task_complete.last_agent_message の重複防止に使う。
// 両機構とも「同ターン内の直前ミラー」検出専用であり、task_started / task_complete /
// turn_aborted のターン境界でリセットする（別ターンで同一文面が再送されても誤って
// スキップしないようにするため）。いずれにも一致しない場合はフォールバックとして表示する（欠落防止）。
// event_msg/agent_reasoning は現状 response_item/reasoning と重複するため skippedTypes に計上する。
// event_msg はマーカー（task_started / task_complete / turn_aborted / error）と
// メタ（token_count）も扱う。

/** ツール呼び出しの summary に添える入力の要約（先頭60字、空白正規化） */
function summaryHintFromText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().substring(0, 60);
}

/** function_call の arguments(JSON文字列) から代表的なキーを優先して要約する。キーが無ければ生文字列を使う */
function summaryHintFromArguments(argumentsText: string): string {
  try {
    const obj = JSON.parse(argumentsText);
    if (obj && typeof obj === 'object') {
      for (const key of ['cmd', 'command', 'query']) {
        const v = (obj as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.trim()) { return summaryHintFromText(v); }
      }
    }
  } catch { /* JSONでなければ生文字列にフォールバック */ }
  return summaryHintFromText(argumentsText);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sandboxPolicyType(value: unknown): string {
  if (typeof value === 'string') { return value; }
  if (value && typeof value === 'object' && typeof (value as any).type === 'string') {
    return (value as any).type;
  }
  return '';
}

/**
 * rawLines のリングバッファに積む軽量ドラフト。pretty JSON（JSON.stringify(data, null, 2)）の
 * 生成はコストが大きいため、パース中は行わず {lineNo, type, raw} のみ保持する。パース完了後、
 * リングに生き残った行にのみ pretty を生成する（F3）。
 */
type RawDraft =
  | { kind: 'parse-error'; lineNo: number; rawTruncated: string }
  | { kind: 'non-object'; lineNo: number; raw: string }
  | { kind: 'object'; lineNo: number; type: string; raw: string };

/** 生き残った RawDraft から最終的な RawLine（pretty JSON付き）を組み立てる。現行の出力形式と同一にする */
function buildRawLine(d: RawDraft): RawLine {
  if (d.kind === 'parse-error') {
    return { lineNo: d.lineNo, type: 'parse-error', pretty: null, raw: d.rawTruncated };
  }
  if (d.kind === 'non-object') {
    let pretty: string | null = null;
    try {
      const data = JSON.parse(d.raw);
      pretty = truncateText(JSON.stringify(data));
    } catch { pretty = null; }
    return { lineNo: d.lineNo, type: 'non-object', pretty, raw: truncateText(d.raw) };
  }
  let pretty: string;
  try {
    const data = JSON.parse(d.raw);
    pretty = truncateText(JSON.stringify(data, null, 2));
  } catch {
    pretty = truncateText(d.raw);
  }
  return { lineNo: d.lineNo, type: d.type, pretty, raw: d.raw };
}

/**
 * 固定長リングバッファ（buf[total % capacity] 方式）を時系列順の配列へ再構成する。
 * 「先頭N件」ではなく「最新側（末尾）を残す」方針のため、total > capacity の場合は
 * カーソル位置（次に上書きされる = 最古の生き残り位置）から回転させる。
 * Array.prototype.shift() は O(n·m) になるため使わない（F3）。
 */
function reconstructRing<T>(buf: (T | undefined)[], total: number, capacity: number): T[] {
  if (total <= capacity) { return buf.slice(0, total) as T[]; }
  const cursor = total % capacity;
  return [...buf.slice(cursor), ...buf.slice(0, cursor)] as T[];
}

/** callById に登録するcallの通し番号（entriesリングへのpush順）付きレコード */
interface RegisteredCall {
  entry: ToolViewerEntry;
  seq: number;
}

/** callById の無制限成長を防ぐ上限（未マッチのまま残るcallの想定最大数） */
const CALL_MAP_LIMIT = MAX_ENTRIES * 4;

export function parseCodexRollout(text: string, filePath: string, truncatedHead: boolean, fileSize: number): ViewerDocument {
  const skippedTypes = new Map<string, number>();

  // assistant本文の重複排除（F1）。詳細はファイル冒頭コメント参照。
  // 値は {entry, seq}（seq=push時の entriesTotal-1）。consume時にリング在籍を検査するため保持する（A1）。
  const pendingAgentEvents = new Map<string, { entry: ViewerEntry; seq: number }[]>();
  let lastAssistantText = '';
  // ターン内で表示済みのassistant本文（trim後）→ 最新push時のseq。task_complete の重複判定で
  // リング在籍も確認する（A2。Setだとリング退去済みの本文まで重複扱いしてしまうため）。
  const turnAssistantTexts = new Map<string, number>();

  let sessionId = '';
  let cwd = '';
  let source = '';
  let cliVersion = '';
  let model = '';
  let approvalPolicy = '';
  let sandboxPolicy = '';
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let lastTokenTotal: number | null = null;

  // callId → 登録済みツール呼び出し（entry参照 + push通し番号）。output到着時に参照し、
  // マッチ後は削除する（target.outputText === null による再マッチガードの代替。F2/F3）。
  const callById = new Map<string, RegisteredCall>();
  const registerCall = (callId: string, entry: ToolViewerEntry, seq: number): void => {
    callById.set(callId, { entry, seq });
    if (callById.size > CALL_MAP_LIMIT) {
      const oldestKey = callById.keys().next().value;
      if (oldestKey !== undefined) { callById.delete(oldestKey); }
    }
  };

  // entries / rawLines は固定長リングバッファで保持する（F3）。パース中のピークメモリを
  // MAX_ENTRIES / MAX_RAW_LINES 相当に抑え、パース完了後に「最新側を残す」形で時系列順に
  // 再構成する（buf[total % MAX] 方式。Array.shift() は使わない）。
  const entriesBuf: (ViewerEntry | undefined)[] = new Array(MAX_ENTRIES);
  let entriesTotal = 0;
  const pushEntry = (entry: ViewerEntry): void => {
    entriesBuf[entriesTotal % MAX_ENTRIES] = entry;
    entriesTotal++;
  };

  const rawBuf: (RawDraft | undefined)[] = new Array(MAX_RAW_LINES);
  let rawTotal = 0;
  const pushRawDraft = (draft: RawDraft): void => {
    rawBuf[rawTotal % MAX_RAW_LINES] = draft;
    rawTotal++;
  };

  const pushAgentEventPending = (msgText: string, entry: ViewerEntry, seq: number): void => {
    const list = pendingAgentEvents.get(msgText);
    if (list) { list.push({ entry, seq }); } else { pendingAgentEvents.set(msgText, [{ entry, seq }]); }
  };
  const consumePendingAgentEvent = (msgText: string): ViewerEntry | undefined => {
    const list = pendingAgentEvents.get(msgText);
    if (!list || list.length === 0) { return undefined; }
    const record = list.shift();
    if (list.length === 0) { pendingAgentEvents.delete(msgText); }
    if (!record) { return undefined; }
    // リングから既に追い出し済み（seqがリング容量の外）なら、そのentryは表示されない。
    // consumeしたことにせず undefined を返し、呼び出し側に新規pushさせる（A1）。
    const stillInRing = record.seq >= entriesTotal - MAX_ENTRIES;
    if (!stillInRing) { return undefined; }
    return record.entry;
  };
  // ターン境界（task_started / task_complete / turn_aborted）で呼ぶ。lastAssistantText /
  // pendingAgentEvents / turnAssistantTexts は「同ターン内の直前ミラー」検出専用のため、次ターンへ持ち越さない。
  const resetTurnDedupState = (): void => {
    lastAssistantText = '';
    pendingAgentEvents.clear();
    turnAssistantTexts.clear();
  };

  let lineNo = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNo++;
    if (!line.trim()) { continue; }

    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      pushRawDraft({ kind: 'parse-error', lineNo, rawTruncated: truncateText(line) });
      bump(skippedTypes, 'parse-error');
      continue;
    }

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      pushRawDraft({ kind: 'non-object', lineNo, raw: line });
      bump(skippedTypes, 'non-object');
      continue;
    }

    const recordType = typeof data.type === 'string' ? data.type : 'unknown';
    const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
    const payloadType = typeof payload.type === 'string' ? payload.type : '';

    {
      const rawType = payloadType ? `${recordType}/${payloadType}` : recordType;
      pushRawDraft({ kind: 'object', lineNo, type: rawType, raw: line });
    }

    if (typeof data.timestamp === 'string') {
      if (!firstTimestamp) { firstTimestamp = data.timestamp; }
      lastTimestamp = data.timestamp;
    }

    if (recordType === 'session_meta') {
      if (!sessionId) { sessionId = stringValue(payload.session_id) || stringValue(payload.id); }
      if (!cwd) { cwd = stringValue(payload.cwd); }
      if (!source) { source = stringValue(payload.source); }
      if (!cliVersion) { cliVersion = stringValue(payload.cli_version); }
      continue;
    }

    if (recordType === 'turn_context') {
      model = stringValue(payload.model) || model;
      approvalPolicy = stringValue(payload.approval_policy) || approvalPolicy;
      sandboxPolicy = sandboxPolicyType(payload.sandbox_policy) || sandboxPolicy;
      continue;
    }

    if (recordType === 'event_msg') {
      if (payloadType === 'task_started') {
        pushEntry({ kind: 'marker', level: 'info', label: 'task started' });
        // 新しいターンの開始。lastAssistantText / pendingAgentEvents は「同ターン内の直前ミラー」
        // 検出専用のため、ターン境界を越えて持ち越さない（別ターン同一文面「Done」欠落バグの再発防止）。
        resetTurnDedupState();
      } else if (payloadType === 'task_complete') {
        pushEntry({ kind: 'marker', level: 'info', label: 'task complete' });
        // last_agent_message は通常 response_item 側の assistant message と重複するため、
        // 直前に表示したassistant本文（lastAssistantText、同ターン内）と一致しなければ
        // フォールバックとして表示する。
        const lastMessage = stringValue(payload.last_agent_message).trim();
        const lastSeq = turnAssistantTexts.get(lastMessage);
        const lastStillInRing = lastSeq !== undefined && lastSeq >= entriesTotal - MAX_ENTRIES;
        if (lastMessage && !lastStillInRing) {
          pushEntry({ kind: 'text', role: 'assistant', markdown: truncateText(lastMessage) });
          lastAssistantText = lastMessage;
        }
        // ターン終了。次ターンへ持ち越さない。
        resetTurnDedupState();
      } else if (payloadType === 'turn_aborted') {
        const reason = stringValue(payload.reason);
        pushEntry({ kind: 'marker', level: 'warning', label: reason ? `turn aborted (${truncateText(reason)})` : 'turn aborted' });
        resetTurnDedupState();
      } else if (payloadType === 'error') {
        const errorMessage = stringValue(payload.message);
        pushEntry({ kind: 'marker', level: 'error', label: 'error', detail: errorMessage ? truncateText(errorMessage) : undefined });
      } else if (payloadType === 'token_count') {
        const total = payload.info?.total_token_usage?.total_tokens;
        if (typeof total === 'number') { lastTokenTotal = total; }
      } else if (payloadType === 'agent_message') {
        // response_item/message(assistant) や response_item/agent_message と重複する場合が多いため、
        // 表示したentryを pendingAgentEvents に登録し、対応するresponse側到着時にconsumeさせる（F1）。
        // 直前に表示した本文（lastAssistantText）と一致する場合はここでskipする
        // （response先行→event後続ミラーの防御）。
        const messageText = stringValue(payload.message).trim();
        if (messageText && messageText !== lastAssistantText) {
          const entry: ViewerEntry = { kind: 'text', role: 'assistant', markdown: truncateText(messageText) };
          pushEntry(entry);
          lastAssistantText = messageText;
          turnAssistantTexts.set(messageText, entriesTotal - 1);
          pushAgentEventPending(messageText, entry, entriesTotal - 1);
        } else {
          bump(skippedTypes, 'event_msg/agent_message (duplicate)');
        }
      } else {
        // user_message / agent_reasoning は response_item と完全重複（noise）。
        // sub_agent_activity 等の未知イベントも含め、件数のみ集計してスキップする。
        bump(skippedTypes, `event_msg/${payloadType || 'unknown'}`);
      }
      continue;
    }

    if (recordType === 'response_item') {
      // 現行の rollout は payload 直下にitemを持つが、旧形式は payload.item にネストされる場合がある
      // （codex.ts の既存パーサーと同じ扱い）。
      const item = payload.item && typeof payload.item === 'object' ? payload.item : payload;
      const itemType = typeof item.type === 'string' ? item.type : '';

      if (itemType === 'message') {
        const role = item.role;
        if (role === 'developer') {
          bump(skippedTypes, 'response_item/message (developer)');
        } else if (role === 'user') {
          // ブロック単位でwrapper判定し、非wrapperブロックのみ残す（A3）。連結後の文字列に対して
          // isWrapperText を適用すると、wrapperブロックと実文面ブロックが混在する場合に
          // 全体がwrapper扱いされて実文面が失われる／逆にwrapper文が漏れて混入するため、
          // extractResultText で連結する前にブロックごとに判定する。
          const content = Array.isArray(item.content) ? item.content : [];
          const nonWrapperParts: string[] = [];
          for (const block of content) {
            if (!block || typeof block !== 'object') { continue; }
            const blockText = typeof block.text === 'string' ? block.text : '';
            if (!blockText.trim()) { continue; }
            if (isWrapperText(blockText)) { continue; }
            nonWrapperParts.push(blockText);
          }
          // string content のフォールバック（配列でない場合）
          if (content.length === 0 && typeof item.content === 'string' && item.content.trim()) {
            if (!isWrapperText(item.content)) {
              nonWrapperParts.push(item.content);
            }
          }
          if (nonWrapperParts.length > 0) {
            pushEntry({ kind: 'text', role: 'user', markdown: truncateText(nonWrapperParts.join('\n\n')) });
          } else if (content.length > 0 || (typeof item.content === 'string' && item.content.trim())) {
            bump(skippedTypes, 'response_item/message (wrapper)');
          }
        } else if (role === 'assistant') {
          const messageText = extractResultText(item.content);
          const trimmed = messageText.trim();
          if (trimmed) {
            const phase = typeof item.phase === 'string' ? item.phase : undefined;
            const pending = consumePendingAgentEvent(trimmed);
            if (pending) {
              // event_msg/agent_message 側で既に表示済み。ミラーとしてconsumeし、pushしない。
              if (phase && pending.kind === 'text') { pending.phase = phase; }
              bump(skippedTypes, 'response_item/message (mirror of agent_message)');
            } else {
              pushEntry({ kind: 'text', role: 'assistant', markdown: truncateText(messageText), phase });
              lastAssistantText = trimmed;
              turnAssistantTexts.set(trimmed, entriesTotal - 1);
            }
          }
        } else {
          bump(skippedTypes, 'response_item/message (unknown role)');
        }
      } else if (itemType === 'agent_message') {
        // マルチエージェントセッションのエージェント間通信。author/recipientをphaseに埋め込んで表示する。
        // event_msg/agent_message 側で既に表示済み（pendingAgentEvents）ならconsumeし、pushしない。
        const messageText = extractResultText(item.content);
        const trimmed = messageText.trim();
        if (trimmed) {
          const author = typeof item.author === 'string' ? item.author : '';
          const recipient = typeof item.recipient === 'string' ? item.recipient : '';
          const phase = author && recipient ? `${author} → ${recipient}` : undefined;
          const pending = consumePendingAgentEvent(trimmed);
          if (pending) {
            if (phase && pending.kind === 'text') { pending.phase = phase; }
            bump(skippedTypes, 'response_item/agent_message (mirror of event_msg/agent_message)');
          } else {
            pushEntry({ kind: 'text', role: 'assistant', markdown: truncateText(messageText), phase });
            lastAssistantText = trimmed;
            turnAssistantTexts.set(trimmed, entriesTotal - 1);
          }
        } else {
          bump(skippedTypes, 'response_item/agent_message (empty)');
        }
      } else if (itemType === 'reasoning') {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        const parts = summary
          .map((s: any) => {
            if (!s || typeof s !== 'object') { return ''; }
            if (typeof s.text === 'string') { return s.text; }
            if (typeof s.summary_text === 'string') { return s.summary_text; }
            return '';
          })
          .filter((t: string) => t.trim());
        if (parts.length > 0) {
          pushEntry({ kind: 'text', role: 'thinking', markdown: truncateText(parts.join('\n\n')) });
        } else {
          bump(skippedTypes, 'response_item/reasoning (empty summary)');
        }
      } else if (itemType === 'function_call') {
        const argsRaw = typeof item.arguments === 'string' ? item.arguments : '{}';
        let inputText: string;
        try { inputText = JSON.stringify(JSON.parse(argsRaw), null, 2); } catch { inputText = argsRaw; }
        const entry: ToolViewerEntry = {
          kind: 'tool',
          name: typeof item.name === 'string' ? item.name : 'tool',
          summaryHint: summaryHintFromArguments(argsRaw),
          inputText: truncateText(inputText),
          outputText: null,
          status: 'pending',
          callId: typeof item.call_id === 'string' ? item.call_id : undefined,
        };
        pushEntry(entry);
        if (entry.callId) { registerCall(entry.callId, entry, entriesTotal - 1); }
      } else if (itemType === 'custom_tool_call') {
        const inputRaw = typeof item.input === 'string' ? item.input : '';
        const entry: ToolViewerEntry = {
          kind: 'tool',
          name: typeof item.name === 'string' ? item.name : 'tool',
          summaryHint: summaryHintFromText(inputRaw),
          inputText: truncateText(inputRaw),
          outputText: null,
          status: item.status === 'failed' ? 'failed' : 'pending',
          callId: typeof item.call_id === 'string' ? item.call_id : undefined,
        };
        pushEntry(entry);
        if (entry.callId) { registerCall(entry.callId, entry, entriesTotal - 1); }
      } else if (itemType === 'mcp_tool_call') {
        // ローカルデータには未出現（実データ検証で response_item/function_call に統合されているのを確認）。
        // 将来的にこの type が出現しても落ちないよう防御的に対応する。
        const name = typeof item.name === 'string' ? item.name
          : (typeof item.server === 'string' && typeof item.tool === 'string') ? `${item.server}.${item.tool}` : 'mcp_tool';
        const inputObj = item.arguments ?? item.input ?? {};
        let inputText: string;
        try { inputText = JSON.stringify(inputObj, null, 2); } catch { inputText = String(inputObj); }
        const entry: ToolViewerEntry = {
          kind: 'tool',
          name,
          summaryHint: '',
          inputText: truncateText(inputText),
          outputText: null,
          status: 'pending',
          callId: typeof item.call_id === 'string' ? item.call_id : undefined,
        };
        pushEntry(entry);
        if (entry.callId) { registerCall(entry.callId, entry, entriesTotal - 1); }
      } else if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
        const callId = typeof item.call_id === 'string' ? item.call_id : '';
        const outputText = truncateText(extractResultText(item.output));
        const registered = callId ? callById.get(callId) : undefined;
        if (registered) {
          const target = registered.entry;
          target.outputText = outputText;
          if (target.status !== 'failed') { target.status = 'completed'; }
          // callがリングから既に追い出されている場合、そのentryを末尾に再pushして「最新側を残す」
          // 方針の下でも表示され続けるようにする（F2）。リング内であれば参照が同一なので
          // in-placeの書き換えだけで表示に反映される。
          const stillInRing = registered.seq >= entriesTotal - MAX_ENTRIES;
          if (!stillInRing) { pushEntry(target); }
          callById.delete(callId);
        } else {
          pushEntry({
            kind: 'marker',
            level: 'warning',
            label: `unmatched tool output (${callId || '(no call_id)'})`,
            detail: outputText,
          });
        }
      } else if (itemType === 'web_search_call') {
        let inputText: string;
        try { inputText = JSON.stringify(item.action ?? {}, null, 2); } catch { inputText = String(item.action); }
        const status: 'pending' | 'completed' | 'failed' =
          item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'pending';
        pushEntry({
          kind: 'tool',
          name: 'web_search',
          summaryHint: '',
          inputText: truncateText(inputText),
          outputText: null,
          status,
        });
      } else {
        bump(skippedTypes, `response_item/${itemType || 'unknown'}`);
      }
      continue;
    }

    // world_state / inter_agent_communication_metadata / thread_settings_applied / その他未知の
    // トップレベル type: 表示せず件数のみ集計する
    bump(skippedTypes, recordType);
  }

  // パース完了後にリングバッファを時系列順の配列へ再構成する。「先頭N件」ではなく
  // 「最新側（末尾）を残す」ことで、巨大ログでも task complete・最終回答・直近ツール結果が
  // 失われないようにする（F3）。rawLines の pretty JSON生成もここで生き残った行にのみ行う。
  const entriesOmitted = Math.max(0, entriesTotal - MAX_ENTRIES);
  const entries = reconstructRing(entriesBuf, entriesTotal, MAX_ENTRIES);
  const rawOmitted = Math.max(0, rawTotal - MAX_RAW_LINES);
  const rawLines = reconstructRing(rawBuf, rawTotal, MAX_RAW_LINES).map(buildRawLine);

  const title = sessionId ? sessionId.slice(0, 8) : path.basename(filePath, '.jsonl');
  const metaParts: string[] = [];
  if (sessionId) { metaParts.push(`session: ${sessionId.slice(0, 8)}`); }
  if (model) { metaParts.push(truncateText(model)); }
  if (cwd) { metaParts.push(truncateText(cwd)); }
  if (source) { metaParts.push(truncateText(source)); }
  if (approvalPolicy) { metaParts.push(`approval: ${truncateText(approvalPolicy)}`); }
  if (sandboxPolicy) { metaParts.push(`sandbox: ${truncateText(sandboxPolicy)}`); }
  if (cliVersion) { metaParts.push(`cli ${truncateText(cliVersion)}`); }
  metaParts.push(`${entries.length}${entriesOmitted > 0 ? `(+${entriesOmitted} omitted)` : ''} entries`);
  if (firstTimestamp && lastTimestamp) { metaParts.push(`${firstTimestamp} → ${lastTimestamp}`); }
  if (lastTokenTotal !== null) { metaParts.push(`${lastTokenTotal} tokens`); }
  metaParts.push(`${(fileSize / 1024).toFixed(0)} KB`);

  const notices: string[] = [];
  if (truncatedHead) {
    notices.push(`File exceeds ${(MAX_READ_BYTES / 1_000_000).toFixed(0)} MB — showing tail portion only.`);
  }
  if (entriesOmitted > 0) {
    notices.push(`${entriesOmitted} oldest entries omitted (limit ${MAX_ENTRIES}) — showing the most recent entries.`);
  }

  return {
    source: 'codex',
    title,
    metaParts,
    entries,
    entriesOmitted,
    rawLines,
    rawOmitted,
    skippedTypes,
    notices,
  };
}
