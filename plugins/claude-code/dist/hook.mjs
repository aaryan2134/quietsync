#!/usr/bin/env node

// packages/cli/src/hook.ts
import { spawnSync } from "node:child_process";
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { join as join2 } from "node:path";

// packages/core/src/paths.ts
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
function defaultHome() {
  return process.env.QUIETSYNC_HOME || join(homedir(), ".quietsync");
}
function socketPathFor(home, sessionId) {
  let sid = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
  if (process.platform === "win32")
    return `\\\\.\\pipe\\quietsync-${(() => {
      try {
        return userInfo().username.replace(/[^A-Za-z0-9_-]/g, "");
      } catch {
        return "user";
      }
    })()}-${sid}`;
  let dir = process.env.QUIETSYNC_RUN_DIR || join(home, "run");
  return join(dir, `${sid}.sock`);
}

// packages/cli/src/ipc.ts
import { request } from "node:http";
import { existsSync } from "node:fs";
function call(socket, path, body, timeoutMs = 3000) {
  if (process.platform !== "win32" && !existsSync(socket))
    return Promise.resolve(null);
  return new Promise((resolve) => {
    let data = body === void 0 ? void 0 : JSON.stringify(body), req = request({
      socketPath: socket,
      path,
      method: data === void 0 ? "GET" : "POST",
      headers: data === void 0 ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      timeout: timeoutMs
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c)), res.on("end", () => {
        if ((res.statusCode ?? 500) >= 300)
          return resolve(null);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    if (req.on("timeout", () => req.destroy()), req.on("error", () => resolve(null)), data !== void 0)
      req.write(data);
    req.end();
  });
}
async function readStdin() {
  let chunks = [];
  for await (let c of process.stdin)
    chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// packages/cli/src/hook.ts
var event = process.argv[2], raw = await readStdin(), input = {};
try {
  input = JSON.parse(raw || "{}");
} catch {}
var sid = String(input.session_id ?? ""), out = (x) => process.stdout.write(`${JSON.stringify(x)}
`);
function socketFor(id) {
  let direct = id ? socketPathFor(defaultHome(), id) : "";
  if (direct && (process.platform === "win32" || existsSync2(direct)))
    return direct;
  let alias = join2(process.env.QUIETSYNC_RUN_DIR || join2(defaultHome(), "run"), `p${process.env.QUIETSYNC_HOOK_PPID ?? process.ppid}.sock`);
  return existsSync2(alias) ? alias : "";
}
var sock = socketFor(sid);
if (sock && event === "pre-tool-use") {
  let decision = await call(sock, "/hook/pre-tool-use", { tool_name: input.tool_name, tool_input: input.tool_input, cwd: input.cwd, source: "hook" }) ?? { decision: "ask", reason: "quietsync is running in this session but did not answer, so it could not check this call. Approve only if you expect it." };
  if (decision.decision !== "none")
    out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision.decision, permissionDecisionReason: decision.reason ?? "" } });
} else if (sock && event === "user-prompt-submit") {
  let r = await call(sock, "/hook/user-prompt-submit", { prompt: input.prompt, source: input.source ?? null, hook: !0 });
  if (r?.context || r?.message)
    out({ ...r.context ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: r.context } } : {}, ...r.message ? { systemMessage: r.message } : {} });
} else if (sock && event === "session-start") {
  let r = await call(sock, "/hook/session-start", { session_id: sid, source: input.source });
  if (r?.context)
    out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: r.context }, ...r.message ? { systemMessage: r.message } : {} });
} else if (event === "session-start")
  try {
    process.stdout.write(readFileSync(join2(process.env.QUIETSYNC_RUN_DIR || join2(defaultHome(), "run"), "waiting.json"), "utf8"));
  } catch {}
else if (sock && event === "stop") {
  let r = await call(sock, "/hook/stop", { active: !!input.stop_hook_active });
  if (r?.block)
    out({ decision: "block", reason: r.block });
} else if (event === "statusline") {
  let r = sid ? await call(sock, "/statusline", void 0, 800) : null, then = process.argv.indexOf("--then"), tail = "";
  if (then > 0 && process.argv[then + 1])
    tail = (spawnSync(process.argv[then + 1], { shell: !0, input: raw, encoding: "utf8" }).stdout ?? "").trimEnd();
  process.stdout.write(`${[r?.line, tail].filter(Boolean).join("  ")}
`);
}
