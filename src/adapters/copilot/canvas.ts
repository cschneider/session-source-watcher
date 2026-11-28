// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface CanvasBackend {
  state(): Promise<unknown>;
  action(action: "pause" | "resume" | "remove" | "resolve", target: string): Promise<unknown>;
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Watches</title>
<style>
body{font:13px -apple-system,system-ui,sans-serif;margin:12px;color:#1f2328;background:#fff}
@media(prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}.row{border-color:#30363d}button{color:#e6edf3;background:#21262d;border-color:#30363d}}
h1{font-size:15px;margin:0 0 8px}.row{border:1px solid #d0d7de;border-radius:6px;padding:8px;margin:6px 0}
.meta{opacity:.75;font-size:12px;margin-top:2px}.state{font-weight:600}button{margin:4px 4px 0 0;font-size:12px;border:1px solid #d0d7de;border-radius:6px;padding:2px 8px;background:#f6f8fa;cursor:pointer}
.err{color:#cf222e}</style></head>
<body><h1>Watches</h1><div id="error" class="err"></div><div id="watches"></div><h1>Pending changes</h1><div id="pending"></div>
<script>
const token = new URLSearchParams(location.search).get("t");
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = String(text); if (cls) e.className = cls; return e; };
async function call(path, body) {
  const res = await fetch(path, { method: body ? "POST" : "GET", headers: { "x-token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function button(label, action, target) {
  const b = el("button", label);
  b.onclick = async () => { try { await call("/api/action", { action, target }); await load(); } catch (e) { document.getElementById("error").textContent = e.message; } };
  return b;
}
async function load() {
  try {
    const data = await call("/api/state");
    document.getElementById("error").textContent = "";
    const w = document.getElementById("watches"); w.replaceChildren();
    if (!data.watches.length) w.append(el("div", "No watches.", "meta"));
    for (const watch of data.watches) {
      const row = el("div", undefined, "row");
      const title = el("div"); title.append(el("span", watch.label + " ", "state"), el("span", watch.source.key));
      row.append(title);
      row.append(el("div", watch.state + " · " + watch.health + " · " + watch.changes.join(", ") + (watch.pending ? " · " + watch.pending + " pending" : ""), "meta"));
      row.append(el("div", (watch.origin === "agent" ? "added by agent" + (watch.reason ? ": " + watch.reason : "") : "added by you") + " · coverage " + watch.coverage, "meta"));
      if (watch.state === "active") row.append(button("Pause", "pause", watch.id));
      if (watch.state === "paused") row.append(button("Resume", "resume", watch.id));
      row.append(button("Remove", "remove", watch.id));
      w.append(row);
    }
    for (const r of data.removed) w.append(el("div", "removed by " + r.removedBy + ": " + r.source, "meta"));
    const p = document.getElementById("pending"); p.replaceChildren();
    if (!data.pending.events.length) p.append(el("div", "Nothing pending.", "meta"));
    for (const ev of data.pending.events) {
      const row = el("div", undefined, "row");
      const s = ev.summary;
      row.append(el("div", [s.what, s.detail, s.actor ? "@" + s.actor : ""].filter(Boolean).join(" · ")));
      row.append(el("div", ev.watch + " · " + ev.state + " · " + ev.urgency, "meta"));
      if (ev.state === "escalated" || ev.state === "unacknowledged") row.append(button("Resolve", "resolve", ev.id));
      p.append(row);
    }
  } catch (e) { document.getElementById("error").textContent = e.message; }
}
load(); setInterval(load, 5000);
</script></body></html>`;

/** A local page for the watch list. User actions here act with user authority. */
export class CanvasServer {
  private server: Server | undefined;
  private readonly token = randomBytes(24).toString("hex");
  private origin = "";

  constructor(private readonly backend: CanvasBackend) {}

  async start(): Promise<string> {
    if (this.server) return `${this.origin}/?t=${this.token}`;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    this.origin = `http://127.0.0.1:${port}`;
    return `${this.origin}/?t=${this.token}`;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }

  private send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    });
    res.end(type === "application/json" ? JSON.stringify(body) : String(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        if (url.searchParams.get("t") !== this.token) return this.send(res, 403, "Forbidden", "text/plain");
        return this.send(res, 200, PAGE, "text/html; charset=utf-8");
      }
      if (req.headers["x-token"] !== this.token) return this.send(res, 403, { error: "forbidden" });
      if (req.method === "GET" && url.pathname === "/api/state") return this.send(res, 200, await this.backend.state());
      if (req.method === "POST" && url.pathname === "/api/action") {
        if (req.headers.origin !== this.origin) return this.send(res, 403, { error: "bad origin" });
        const body = await readBody(req);
        const action = body["action"];
        const target = body["target"];
        if (!["pause", "resume", "remove", "resolve"].includes(String(action)) || typeof target !== "string") {
          return this.send(res, 400, { error: "bad request" });
        }
        return this.send(res, 200, await this.backend.action(action as "pause", target));
      }
      return this.send(res, 404, { error: "not found" });
    } catch (error) {
      return this.send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}") as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
