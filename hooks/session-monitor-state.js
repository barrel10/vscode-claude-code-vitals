#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const EVENT_STATE = {
  UserPromptSubmit: "thinking",
  PermissionRequest: "waiting",
  Stop: "idle",
  StopFailure: "idle",
  SessionEnd: "idle",
};

try {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(data);
      const rawSid = input.session_id || input.sessionId;
      const event = input.hook_event_name;
      if (!rawSid || !event) process.exit(0);
      const sid = path.basename(String(rawSid));
      if (!sid) process.exit(0);

      const state = EVENT_STATE[event];
      if (!state) process.exit(0);

      const monitorDir = path.join(os.homedir(), ".claude", "ide", "monitor");
      fs.mkdirSync(monitorDir, { recursive: true });

      // For PermissionRequest, record JSONL mtime so monitor can detect post-approval writes
      let content = state;
      if (event === "PermissionRequest") {
        const tp = input.transcript_path || input.transcriptPath || "";
        if (tp) {
          try {
            const mtimeMs = fs.statSync(tp).mtimeMs;
            content = state + ":" + Math.floor(mtimeMs);
          } catch (_) { /* transcript not found, write state only */ }
        }
      }
      fs.writeFileSync(path.join(monitorDir, sid + ".state"), content + "\n");
    } catch (_) {
      /* ignore parse errors */
    }
    process.exit(0);
  });
} catch (_) {
  process.exit(0);
}
