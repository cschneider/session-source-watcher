#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { execFile, spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connectDaemon } from "../protocol/client.js";
import type { Connection } from "../protocol/connection.js";
import type { PendingView, WatchView } from "../protocol/methods.js";
import { resolvePaths } from "../protocol/paths.js";

const USAGE = `Usage: ssw <command> [options]

Commands:
  daemon [--detach] [--no-idle-exit]   Run the watcher daemon
  status                               Daemon, collectors and budgets
  sessions                             Sessions known to the daemon
  list [--session <id>]                Watches of a session
  add <url> [--session <id>] [--changes a,b] [--reason <text>]
  pause <watch> [--session <id>]       Pause a watch
  resume <watch> [--session <id>]      Resume a watch
  remove <watch> [--session <id>]      Remove a watch; agents cannot re-add it
  pending [--session <id>]             Pending, unconfirmed and escalated changes
  resolve <event> [--session <id>]     Close an escalated or unacknowledged change
  doctor                               Check credentials, socket and daemon
  service install                      Start the daemon at login

Add --json to print raw results.`;

const script = fileURLToPath(import.meta.url);
const daemonCommand = [process.execPath, script, "daemon"];

async function user(): Promise<Connection> {
  const { connection } = await connectDaemon({ role: "cli", client: "ssw", daemonCommand });
  return connection;
}

async function confirm(question: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("This command acts with your authority and needs an interactive terminal to confirm.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") throw new Error("Cancelled.");
}

function printWatches(result: { watches: WatchView[]; removed: Array<{ source: string; removedBy: string; removedAt: string | null }> }): void {
  if (!result.watches.length) console.log("No watches.");
  for (const watch of result.watches) {
    const pending = watch.pending ? ` · ${watch.pending} pending` : "";
    console.log(`${watch.label}  ${watch.source.key}  [${watch.state}, ${watch.health}]${pending}`);
    const origin = watch.origin === "agent" ? `added by agent${watch.reason ? `: "${watch.reason}"` : ""}` : "added by you";
    const until = watch.until.length ? ` · until ${watch.until.join(" or ")}` : "";
    const expires = watch.expiresAt ? ` · expires ${watch.expiresAt}` : "";
    console.log(`      ${watch.changes.join(", ")} · ${origin}${until}${expires}`);
    console.log(`      coverage ${watch.coverage}`);
  }
  for (const removed of result.removed) console.log(`removed: ${removed.source} (by ${removed.removedBy}, ${removed.removedAt ?? "?"})`);
}

function printPending(view: PendingView): void {
  if (!view.events.length && !view.packets.length) console.log("Nothing pending.");
  for (const packet of view.packets) console.log(`message ${packet.id}  ${packet.state}${packet.closeReason ? ` (${packet.closeReason})` : ""}  ${packet.title}`);
  for (const event of view.events) {
    const s = event.summary;
    const text = [s["what"], s["detail"], s["actor"] ? `@${String(s["actor"])}` : ""].filter(Boolean).join(" · ");
    console.log(`${event.id}  ${event.watch}  ${event.state}  ${event.urgency}  ${text}`);
  }
}

async function runDaemon(detach: boolean, idleExit: boolean): Promise<void> {
  const paths = resolvePaths();
  if (detach) {
    const child = spawn(process.execPath, [script, "daemon", ...(idleExit ? [] : ["--no-idle-exit"])], { detached: true, stdio: "ignore" });
    child.unref();
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        (await connectDaemon({ role: "cli", client: "ssw" })).connection.close();
        console.log(`Daemon running; socket ${paths.socket}`);
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
  // Loaded lazily: only the daemon needs the store and the sources.
  const { AlreadyRunning, Daemon } = await import("../daemon/daemon.js");
  const { defaultSources } = await import("./sources.js");
  let daemon: InstanceType<typeof Daemon>;
  try {
    daemon = new Daemon({ paths, sources: defaultSources(), idleExitMs: idleExit ? 10 * 60_000 : 0 });
    await daemon.start();
  } catch (error) {
    if (error instanceof AlreadyRunning) {
      console.error(error.message);
      process.exitCode = 0;
      return;
    }
    throw error;
  }
  daemon.onStop = () => process.exit(0);
  const stop = () => void daemon.stop();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

function check(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}: ${detail}`);
  return ok;
}

async function doctor(): Promise<void> {
  const paths = resolvePaths();
  let healthy = true;
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  healthy &&= check("Node.js", major > 22 || (major === 22 && minor >= 13), process.versions.node);
  try {
    const mode = statSync(paths.stateDir).mode & 0o777;
    healthy &&= check("State directory", (mode & 0o077) === 0, `${paths.stateDir} (mode ${mode.toString(8)})`);
  } catch {
    check("State directory", true, `${paths.stateDir} (created on first start)`);
  }
  const token = await new Promise<boolean>((resolve) =>
    execFile("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 10_000 }, (error, stdout) => resolve(!error && !!stdout.trim())),
  );
  healthy &&= check("GitHub CLI credentials", token || !!process.env["SSW_GITHUB_TOKEN"], token ? "gh auth token works for github.com" : 'run "gh auth login"');
  try {
    const { connection } = await connectDaemon({ role: "cli", client: "ssw-doctor", startTimeoutMs: 1 });
    const status = (await connection.request<Record<string, unknown>>("status")) as {
      watches: number;
      sessions: number;
      collectors: Array<{ source: string; health: string; error: string | null }>;
    };
    connection.close();
    check("Daemon", true, `${status.watches} active watches, ${status.sessions} connected sessions`);
    for (const collector of status.collectors) {
      healthy &&= check(`Collector ${collector.source}`, collector.health !== "blocked", collector.error ?? collector.health);
    }
  } catch {
    check("Daemon", true, `not running; it starts on demand (socket ${paths.socket})`);
  }
  if (!healthy) process.exitCode = 1;
}

function installService(): void {
  const label = "io.github.session-source-watcher";
  if (process.platform === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    mkdirSync(dirname(path), { recursive: true });
    const args = [process.execPath, script, "daemon", "--no-idle-exit"].map((arg) => `    <string>${arg}</string>`).join("\n");
    writeFileSync(
      path,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`,
    );
    console.log(`Wrote ${path}\nLoad it with: launchctl bootstrap gui/$(id -u) ${path}`);
    return;
  }
  if (process.platform === "linux") {
    const path = join(homedir(), ".config", "systemd", "user", "session-source-watcher.service");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `[Unit]
Description=Session source watcher

[Service]
ExecStart=${process.execPath} ${script} daemon --no-idle-exit
Restart=on-failure

[Install]
WantedBy=default.target
`,
    );
    console.log(`Wrote ${path}\nEnable it with: systemctl --user enable --now session-source-watcher`);
    return;
  }
  throw new Error("Service installation is supported on macOS and Linux.");
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      session: { type: "string" },
      changes: { type: "string" },
      reason: { type: "string" },
      json: { type: "boolean" },
      detach: { type: "boolean" },
      "no-idle-exit": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, argument] = positionals;
  const out = (result: unknown, human: (value: never) => void) => (values.json ? console.log(JSON.stringify(result, null, 2)) : human(result as never));
  const session = values.session;

  switch (command) {
    case undefined:
    case "help":
      console.log(USAGE);
      return;
    case "daemon":
      return runDaemon(!!values.detach, !values["no-idle-exit"]);
    case "doctor":
      return doctor();
    case "service":
      if (argument !== "install") throw new Error("Usage: ssw service install");
      return installService();
  }

  const connection = await user();
  try {
    switch (command) {
      case "status":
        out(await connection.request("status"), (s: Record<string, unknown>) => console.log(JSON.stringify(s, null, 2)));
        break;
      case "sessions":
        out(await connection.request("sessions.list"), (rows: Array<Record<string, unknown>>) => {
          if (!rows.length) console.log("No sessions.");
          for (const row of rows) console.log(`${String(row["id"])}  ${String(row["harness"])}  ${String(row["status"])}  ${String(row["watches"])} watches  ${String(row["label"] ?? row["session"])}`);
        });
        break;
      case "list":
        out(await connection.request("watch.list", { session }), printWatches);
        break;
      case "pending":
        out(await connection.request("watch.pending", { session }), printPending);
        break;
      case "add": {
        if (!argument) throw new Error("Usage: ssw add <url> [--session <id>]");
        await confirm(`Watch ${argument}${session ? ` for session ${session}` : ""}?`);
        const params: Record<string, unknown> = { session, source: argument };
        if (values.changes) params["changes"] = values.changes.split(",").map((change) => change.trim());
        if (values.reason) params["reason"] = values.reason;
        out(await connection.request("watch.add", params), (watch: WatchView) => console.log(`Watching ${watch.label}: ${watch.source.key}`));
        break;
      }
      case "pause":
      case "resume":
      case "remove":
      case "resolve": {
        if (!argument) throw new Error(`Usage: ssw ${command} <${command === "resolve" ? "event" : "watch"}> [--session <id>]`);
        await confirm(`${command[0]!.toUpperCase()}${command.slice(1)} ${argument}?`);
        const method = command === "resolve" ? "escalation.resolve" : `watch.${command}`;
        const params = command === "resolve" ? { session, event: argument } : { session, watch: argument };
        out(await connection.request(method, params), (result: unknown) => console.log(JSON.stringify(result)));
        break;
      }
      default:
        throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } finally {
    connection.close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
