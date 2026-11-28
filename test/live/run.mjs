// SPDX-License-Identifier: Apache-2.0
// Live verification of the packaged Copilot extension in a real Copilot
// session. It drives the session through the Copilot SDK, serves a fake
// GitHub API and a fake `gh`, and checks the daemon store and the session
// event log. It runs real model turns, so it costs AI credits.
//
//   npm install --no-save @github/copilot-sdk
//   npm run test:live            # all scenarios
//   npm run test:live -- idle    # selected scenarios, in order
//
// COPILOT_CLI_PATH selects the CLI binary (default: `copilot` on PATH).
// SSW_LIVE_KEEP=1 keeps the scratch directory for inspection.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const built = join(root, "dist/copilot-plugin/com.github.copilot/extensions/session-source-watcher");
const PR = "https://github.com/octo/app/pull/7";
const ALL = ["idle", "writes", "autopilot", "restart"];
const selected = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

let sdk;
try {
  sdk = await import("@github/copilot-sdk");
} catch {
  console.error("Missing @github/copilot-sdk. Install it with: npm install --no-save @github/copilot-sdk");
  process.exit(2);
}
const { CopilotClient, RuntimeConnection, approveAll } = sdk;
const sdkDist = dirname(fileURLToPath(import.meta.resolve("@github/copilot-sdk")));
if (!existsSync(join(built, "extension.mjs"))) {
  console.error("Run `npm run package:copilot` first.");
  process.exit(2);
}

// --- Scratch workspace ---------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "ssw-live-"));
const project = join(dir, "project");
const extDir = join(project, ".github/extensions/session-source-watcher");
const bin = join(dir, "bin");
const state = join(dir, "state");
const traceFile = join(dir, "trace.jsonl");
mkdirSync(extDir, { recursive: true });
mkdirSync(bin);
for (const file of ["extension.mjs", "ssw.mjs"]) copyFileSync(join(built, file), join(extDir, file));
execFileSync("git", ["init", "-q"], { cwd: project });

// --- Fake GitHub API -----------------------------------------------------
const sha = "a".repeat(40);
const pr = { updatedAt: Date.parse("2027-01-04T09:00:00Z"), reviews: [], comments: [] };
let nextId = 1000;
const user = (login) => ({ login, type: "User" });
const touch = () => (pr.updatedAt += 60_000);
const iso = (ms) => new Date(ms).toISOString();
function addComment(login, body) {
  touch();
  const id = nextId++;
  pr.comments.push({ id, user: user(login), body, created_at: iso(pr.updatedAt), updated_at: iso(pr.updatedAt), html_url: `${PR}#issuecomment-${id}` });
  return id;
}
function addReview(login, reviewState, body) {
  touch();
  const id = nextId++;
  pr.reviews.push({ id, user: user(login), state: reviewState, body, submitted_at: iso(pr.updatedAt), html_url: `${PR}#pullrequestreview-${id}` });
  return id;
}
const github = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && url.pathname === "/_test/comment") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const id = addComment("live-user", JSON.parse(raw || "{}").body ?? "");
      send({ id, url: `${PR}#issuecomment-${id}` });
    });
    return;
  }
  const path = url.pathname;
  if (path === "/user") return send({ login: "live-user" });
  if (path === "/repos/octo/app/pulls/7") {
    return send({ state: "open", merged: false, draft: false, title: "Fix parsing", updated_at: iso(pr.updatedAt), html_url: PR, head: { sha, ref: "fix" }, base: { ref: "main" } });
  }
  if (path === "/repos/octo/app/pulls/7/reviews") return send(pr.reviews);
  if (path === "/repos/octo/app/issues/7/comments") return send(pr.comments);
  if (path.endsWith("/check-runs")) return send({ check_runs: [] });
  if (path.endsWith("/status")) return send({ statuses: [] });
  return send([]);
});
await new Promise((ready) => github.listen(0, "127.0.0.1", ready));
const apiBase = `http://127.0.0.1:${github.address().port}`;

// A fake `gh` that posts the comment to the fake API and prints its URL, like `gh pr comment`.
writeFileSync(
  join(bin, "gh"),
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "pr" || args[1] !== "comment") { console.error("fake gh: unsupported command"); process.exit(1); }
const flag = args.findIndex((arg) => arg === "--body" || arg === "-b");
const response = await fetch(${JSON.stringify(apiBase)} + "/_test/comment", { method: "POST", body: JSON.stringify({ body: flag >= 0 ? args[flag + 1] : "" }) });
console.log((await response.json()).url);
`,
);
chmodSync(join(bin, "gh"), 0o755);

Object.assign(process.env, {
  PATH: `${bin}:${process.env.PATH}`,
  SSW_STATE_DIR: state,
  SSW_GITHUB_TOKEN: "live-token",
  SSW_GITHUB_API_BASE: apiBase,
  SSW_DEBUG_LOG: traceFile,
  SSW_DAEMON_COMMAND: JSON.stringify([process.execPath, "--disable-warning=ExperimentalWarning", join(extDir, "ssw.mjs"), "daemon"]),
});

// --- Copilot session -----------------------------------------------------
const cliPath = process.env.COPILOT_CLI_PATH ?? execFileSync("which", ["copilot"], { encoding: "utf8" }).trim();
const sessionConfig = {
  workingDirectory: project,
  requestExtensions: true,
  extensionSdkPath: sdkDist,
  filesystem: { trustWorkingDirectory: true },
  onPermissionRequest: approveAll,
};
let client;
let session;
let extensionRunning = false;

async function startClient() {
  extensionRunning = false;
  client = new CopilotClient({
    extensionLaunchProvider: {
      resolve: async (request) => ({
        launch: {
          executable: "/bin/sh",
          args: ["-c", `exec "$1" "$2" "$3" 2>>"${join(dir, "extension.stderr")}"`, "sh", process.execPath, join(root, "test/live/launcher.mjs"), request.modulePath],
          env: { ...process.env },
        },
      }),
    },
    runtime: RuntimeConnection.forStdio({ path: cliPath, args: ["--experimental", "--log-dir", join(dir, "logs")], env: { ...process.env } }),
  });
  await client.start();
}
function observe() {
  session.on((event) => {
    if (event.type === "session.extensions_loaded" && JSON.stringify(event.data).includes('"running"')) extensionRunning = true;
  });
}
async function ready() {
  await waitFor("extension running", () => extensionRunning, 60_000);
}

// --- Inspection helpers --------------------------------------------------
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(what, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2_000);
  }
}
function query(sql, ...params) {
  if (!existsSync(join(state, "state.db"))) return [];
  const db = new DatabaseSync(join(state, "state.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}
const packetsSince = (ms) => query("SELECT * FROM packets WHERE created_at > ? ORDER BY created_at", ms);
function sessionEvents() {
  const home = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
  const file = join(home, "session-state", session.sessionId, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function trace(kind) {
  if (!existsSync(traceFile)) return [];
  return readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => !kind || entry.kind === kind);
}
// Autopilot continuations repeat the clientTurnId with source "autopilot"; count the watcher's own messages.
const deliveries = (packet) =>
  sessionEvents().filter((event) => event.type === "user.message" && event.data?.clientTurnId === packet && event.data?.source === "automation-session-source-watcher");
const continuations = (packet) => sessionEvents().filter((event) => event.type === "user.message" && event.data?.clientTurnId === packet && event.data?.source === "autopilot");
async function closedPacket(since, timeoutMs) {
  const packet = await waitFor("a packet", () => packetsSince(since)[0], timeoutMs);
  return waitFor(`packet ${packet.id} to close`, () => query("SELECT * FROM packets WHERE id = ? AND state = 'closed'", packet.id)[0], 5 * 60_000);
}
async function turn(prompt) {
  return session.sendAndWait({ prompt }, 5 * 60_000);
}

const results = [];
function record(check, ok, evidence) {
  results.push({ check, ok, evidence });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check}: ${evidence}`);
}

// --- Scenarios -----------------------------------------------------------
async function setup() {
  await startClient();
  session = await client.createSession(sessionConfig);
  observe();
  await ready();
  await turn(`Watch ${PR} with watch_add (reason "live verification", policy cadenceS 30). Reply only "ok".`);
  await waitFor("baseline", () => query("SELECT 1 FROM checkpoints WHERE unit = 'comments.issue' AND complete_through IS NOT NULL")[0], 120_000);
}

const scenarios = {
  // A batched change reaches an idle session: the message is enqueued and must start a turn.
  async idle() {
    const since = Date.now();
    addComment("alice", "Could you rename parseThing to parse?");
    const packet = await closedPacket(since, 4 * 60_000);
    const seen = deliveries(packet.id);
    const sent = trace("send").filter((entry) => entry.packet === packet.id);
    const startedTurn = sessionEvents().some((event) => event.type === "assistant.turn_start" && seen[0] && event.timestamp > seen[0].timestamp);
    record("idle session starts a turn", seen.length === 1 && startedTurn, `delivery=${seen[0]?.data?.delivery}, turn started=${startedTurn}, close=${packet.close_reason}`);
    record(
      "clientTurnId on an enqueued message",
      sent[0]?.urgency === "batched" && seen[0]?.data?.clientTurnId === packet.id && seen[0]?.data?.source === "automation-session-source-watcher",
      `urgency=${sent[0]?.urgency}, source=${seen[0]?.data?.source}, clientTurnId matches=${seen[0]?.data?.clientTurnId === packet.id}`,
    );
  },

  // The agent's own `gh pr comment` is reported from onPostToolUse and suppressed.
  async writes() {
    const since = Date.now();
    await turn('Run this shell command exactly and reply "done": gh pr comment 7 --repo octo/app --body "Renamed as requested."');
    const post = trace("onPostToolUse").filter((entry) => entry.writes?.length);
    record("onPostToolUse payload yields the write", post.length >= 1, post[0] ? `tool=${post[0].toolName}, args=${JSON.stringify(post[0].toolArgs).slice(0, 120)}, writes=${JSON.stringify(post[0].writes)}` : `tools seen: ${trace("onPostToolUse").map((entry) => entry.toolName).join(",")}`);
    const comment = pr.comments.at(-1);
    await waitFor("the echo to be read", () => query("SELECT 1 FROM items WHERE item_key = ?", `comment:${comment.id}`)[0], 120_000);
    await sleep(70_000); // past the batch delay
    const consumed = query("SELECT consumed_by FROM expected_writes WHERE item_key = ?", `comment:${comment.id}`)[0]?.consumed_by;
    const packets = packetsSince(since);
    record("own write suppressed", Boolean(consumed) && packets.length === 0, `expected write consumed=${Boolean(consumed)}, packets since=${packets.length}`);
  },

  // In Autopilot the runtime continues on its own; onAgentStop must fire once per packet.
  async autopilot() {
    await session.rpc.mode.set({ mode: "autopilot" });
    try {
      const since = Date.now();
      const before = trace("onAgentStop").length;
      addReview("bob", "CHANGES_REQUESTED", "Please add a test for the empty input case.");
      const packet = await closedPacket(since, 3 * 60_000);
      const idle = await waitFor("session idle", () => trace("event").find((entry) => entry.type === "session.idle" && Date.parse(entry.at) > packet.closed_at - 5_000), 5 * 60_000).catch(() => undefined);
      await sleep(5_000);
      const stops = trace("onAgentStop").slice(before);
      const lastStop = Date.parse(stops.at(-1)?.at ?? "");
      const completions = trace("report").filter((entry) => entry.packet === packet.id && entry.status === "completed");
      const after = Date.parse(completions[0]?.at ?? "") - lastStop;
      record(
        "completion after the last Autopilot continuation",
        deliveries(packet.id).length === 1 && completions.length === 1 && after >= 0,
        `deliveries=${deliveries(packet.id).length}, continuations=${continuations(packet.id).length}, onAgentStop=${stops.length}, completed reports=${completions.length}, ${after} ms after the last stop, idle seen=${Boolean(idle)}`,
      );
    } finally {
      await session.rpc.mode.set({ mode: "interactive" });
    }
  },

  // Kill the runtime while a packet is queued behind a busy turn, then resume.
  async restart() {
    const since = Date.now();
    void session.send({ prompt: 'Run the shell command "sleep 150" and then reply "slept".' });
    await waitFor("busy turn", () => sessionEvents().some((event) => event.type === "tool.execution_start" && Date.parse(event.timestamp) > since), 60_000);
    addComment("carol", "One more nit: the README example is outdated.");
    const packet = await waitFor("an admitted packet", () => query("SELECT * FROM packets WHERE created_at > ? AND receipt IS NOT NULL", since)[0], 4 * 60_000);
    const sessionId = session.sessionId;
    await client.forceStop();
    await startClient();
    session = await client.resumeSession(sessionId, sessionConfig);
    observe();
    await ready();
    const closed = await waitFor(`packet ${packet.id} to close`, () => query("SELECT * FROM packets WHERE id = ? AND state = 'closed'", packet.id)[0], 6 * 60_000);
    const sends = trace("send").filter((entry) => entry.packet === packet.id).length;
    // The runtime drops its pending queue when it stops, so the packet is sent again on the new connection.
    record("exactly one delivery after kill and resume", deliveries(packet.id).length === 1, `deliveries=${deliveries(packet.id).length}, sends=${sends}, close=${closed.close_reason}`);

    const after = Date.now();
    addReview("dave", "APPROVED", "Looks good.");
    const next = await closedPacket(after, 3 * 60_000);
    const seen = deliveries(next.id);
    record("clientTurnId after a restart", seen.length === 1, `clientTurnId matches=${seen[0]?.data?.clientTurnId === next.id}, close=${next.close_reason}`);
  },
};

let failed = false;
try {
  await setup();
  for (const name of selected) {
    if (!scenarios[name]) throw new Error(`unknown scenario ${name}; choose from ${ALL.join(", ")}`);
    console.log(`--- ${name}`);
    try {
      await scenarios[name]();
    } catch (error) {
      record(name, false, error instanceof Error ? error.message : String(error));
    }
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await client?.stop().catch(() => client?.forceStop());
  try {
    const pid = Number(readFileSync(join(state, "daemon.lock"), "utf8"));
    if (pid) process.kill(pid, "SIGTERM");
  } catch {
    // No daemon was started.
  }
  github.close();
  failed ||= results.some((result) => !result.ok);
  if (failed || process.env.SSW_LIVE_KEEP) console.log(`Scratch directory kept: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
