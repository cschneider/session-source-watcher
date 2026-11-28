// SPDX-License-Identifier: Apache-2.0
// End-to-end check of the packaged Copilot extension against a stub SDK,
// the bundled daemon and a fake GitHub API. Run with `npm run test:e2e`.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const built = "dist/copilot-plugin/com.github.copilot/extensions/session-source-watcher";
const dir = mkdtempSync(join(tmpdir(), "ssw-e2e-"));
const ext = join(dir, "ext");
const sdk = join(ext, "node_modules", "@github", "copilot-sdk");
mkdirSync(sdk, { recursive: true });
copyFileSync(join(built, "extension.mjs"), join(ext, "extension.mjs"));
copyFileSync(join(built, "ssw.mjs"), join(ext, "ssw.mjs"));
writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@github/copilot-sdk", type: "module", exports: { "./extension": "./extension.js" } }));
writeFileSync(
  join(sdk, "extension.js"),
  `let config;
const listeners = [];
const sent = [];
export function createCanvas(options) { return { declaration: { id: options.id }, options }; }
export async function joinSession(c) {
  config = c;
  const session = {
    sessionId: "e2e-session",
    send: async (message) => { sent.push(message); return "msg-" + sent.length; },
    getEvents: async () => [],
    on: (handler) => { listeners.push(handler); return () => {}; },
    log: async () => {},
  };
  process.send({ type: "joined", tools: c.tools.definitions.map((t) => t.name), canvases: (c.canvases?.definitions ?? []).length });
  return session;
}
process.on("message", async (command) => {
  try {
    let result;
    if (command.type === "tool") {
      const tool = config.tools.definitions.find((t) => t.name === command.name);
      result = await tool.handler(command.args, { sessionId: "e2e-session", toolCallId: "c1", toolName: command.name });
    } else if (command.type === "sessionStart") {
      result = await config.hooks.onSessionStart({ source: "startup", sessionId: "e2e-session", timestamp: new Date(), workingDirectory: "/" });
    } else if (command.type === "canvas") {
      result = await config.canvases.definitions[0].options.open({ instanceId: "c1" });
    }
    process.send({ type: "result", id: command.id, result });
  } catch (error) {
    process.send({ type: "result", id: command.id, error: String(error) });
  }
});
`,
);

const sha = "b".repeat(40);
const github = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const send = (body) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (path === "/user") return send({ login: "e2e-user" });
  if (path === "/repos/octo/app/pulls/7") {
    return send({ state: "open", merged: false, draft: false, title: "Fix", updated_at: "2027-01-04T09:00:00Z", html_url: "https://github.com/octo/app/pull/7", head: { sha, ref: "fix" }, base: { ref: "main" } });
  }
  if (path.endsWith("/check-runs")) return send({ check_runs: [] });
  if (path.endsWith("/status")) return send({ statuses: [] });
  return send([]);
});
await new Promise((resolve) => github.listen(0, "127.0.0.1", resolve));
const apiBase = `http://127.0.0.1:${github.address().port}`;

const state = join(dir, "state");
const child = fork(join(ext, "extension.mjs"), [], {
  env: {
    ...process.env,
    SSW_STATE_DIR: state,
    SSW_GITHUB_TOKEN: "test-token",
    SSW_GITHUB_API_BASE: apiBase,
    SSW_DAEMON_COMMAND: JSON.stringify([process.execPath, "--disable-warning=ExperimentalWarning", join(ext, "ssw.mjs"), "daemon"]),
  },
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});

let nextId = 1;
const waiting = new Map();
let joined;
const joinedPromise = new Promise((resolve) => (joined = resolve));
child.on("message", (message) => {
  if (message.type === "joined") joined(message);
  if (message.type === "result") waiting.get(message.id)?.(message);
});
const call = (command) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, (message) => (message.error ? reject(new Error(message.error)) : resolve(message.result)));
    child.send({ ...command, id });
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const info = await joinedPromise;
  assert.ok(info.tools.includes("watch_add") && info.tools.includes("watch_ack"), "tools registered");
  assert.equal(info.canvases, 1, "canvas registered");

  const start = await call({ type: "sessionStart" });
  assert.match(start.additionalContext, /watch_add/, "watching guide in context");

  const added = await call({ type: "tool", name: "watch_add", args: { source: "https://github.com/octo/app/pull/7", reason: "e2e check" } });
  assert.equal(added.resultType, "success", added.textResultForLlm);
  assert.match(added.textResultForLlm, /^Watching w-[0-9a-z]{6}: github.com\/octo\/app#7/);

  let listed;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    listed = await call({ type: "tool", name: "watch_list", args: {} });
    if (/coverage complete/.test(listed.textResultForLlm)) break;
  }
  assert.match(listed.textResultForLlm, /coverage complete/, "daemon read the pull request");

  const bad = await call({ type: "tool", name: "watch_add", args: { source: "https://example.com/nope", reason: "x" } });
  assert.equal(bad.resultType, "failure");

  const canvas = await call({ type: "canvas" });
  assert.match(canvas.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
  const page = await fetch(canvas.url);
  assert.equal(page.status, 200);
  const token = new URL(canvas.url).searchParams.get("t");
  const stateResponse = await fetch(new URL("/api/state", canvas.url), { headers: { "x-token": token } });
  const view = await stateResponse.json();
  assert.equal(view.watches.length, 1);
  const forged = await fetch(new URL("/api/action", canvas.url), {
    method: "POST",
    headers: { "x-token": token, "content-type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ action: "remove", target: view.watches[0].id }),
  });
  assert.equal(forged.status, 403, "cross-origin action refused");
  console.log("copilot extension e2e: ok");
} finally {
  child.kill("SIGTERM");
  github.close();
  try {
    const pid = Number(readFileSync(join(state, "daemon.lock"), "utf8"));
    if (pid) process.kill(pid, "SIGTERM");
  } catch {
    // Daemon not started.
  }
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
