// SPDX-License-Identifier: Apache-2.0

export interface WatchedSource {
  /** Canonical key, e.g. github.com/owner/repo#42. */
  key: string;
  url: string;
  headRef?: string | undefined;
}

export interface ObservedWrite {
  source: string;
  item: string;
  change: "create" | "update" | "push";
  version?: string;
}

const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "zsh", "sh"]);

function prKey(owner: string, repo: string, number: string, host = "github.com"): string {
  return `${host}/${owner}/${repo}#${number}`.toLowerCase();
}

/** Identifiers in GitHub URLs that a mutating call printed or returned. */
function fromUrls(text: string, watched: Map<string, WatchedSource>): ObservedWrite[] {
  const writes: ObservedWrite[] = [];
  const pattern = /https:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/files)?#(issuecomment|pullrequestreview|discussion_r)-?(\d+)/g;
  for (const match of text.matchAll(pattern)) {
    const [, host, owner, repo, number, kind, id] = match;
    const key = prKey(owner!, repo!, number!, host!);
    const source = watched.get(key);
    if (!source) continue;
    const item = kind === "issuecomment" ? `comment:${id}` : kind === "pullrequestreview" ? `review:${id}` : `review-comment:${id}`;
    writes.push({ source: source.url, item, change: "create" });
  }
  return writes;
}

function commandOf(args: unknown): string {
  if (typeof args === "string") return args;
  const record = args as Record<string, unknown> | null;
  const command = record?.["command"] ?? record?.["cmd"] ?? record?.["script"];
  return typeof command === "string" ? command : "";
}

function isMutatingGh(command: string): boolean {
  if (/\bgh\s+pr\s+(comment|review)\b/.test(command)) return true;
  if (/\bgh\s+api\b/.test(command) && /(-X|--method)\s*(POST|PATCH|PUT)\b/i.test(command)) return true;
  if (/\bgh\s+api\b/.test(command) && /\s(-f|-F|--field|--raw-field|--input)\s/.test(command) && !/(-X|--method)\s*GET\b/i.test(command)) return true;
  return false;
}

/** Writes made by a successful tool call, limited to watched sources. */
export function extractWrites(toolName: string, toolArgs: unknown, resultText: string, sources: readonly WatchedSource[]): ObservedWrite[] {
  if (!sources.length) return [];
  const watched = new Map(sources.map((source) => [source.key.toLowerCase(), source]));
  const name = toolName.toLowerCase();
  const writes: ObservedWrite[] = [];

  if (SHELL_TOOLS.has(name)) {
    const command = commandOf(toolArgs);
    if (isMutatingGh(command)) {
      writes.push(...fromUrls(resultText, watched));
      // gh api responses for edits carry the updated comment as JSON.
      if (/(-X|--method)\s*PATCH\b/i.test(command)) {
        for (const match of resultText.matchAll(/"html_url"\s*:\s*"([^"]+)"[\s\S]*?"updated_at"\s*:\s*"([^"]+)"/g)) {
          for (const write of fromUrls(match[1]!, watched)) writes.push({ ...write, change: "update", version: match[2]! });
        }
      }
    }
    if (/\bgit\s+push\b/.test(command)) {
      for (const match of resultText.matchAll(/\b([0-9a-f]{7,40})\.\.\.?([0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)/g)) {
        const branch = match[4]!;
        for (const source of sources) {
          if (source.headRef && source.headRef === branch) writes.push({ source: source.url, item: "head", change: "push", version: match[2]! });
        }
      }
    }
    return dedupe(writes);
  }

  // GitHub MCP tools that create or update comments and reviews.
  if (/github/.test(name) && /(create|add|update|submit|reply|edit)/.test(name)) {
    const isUpdate = /(update|edit)/.test(name);
    for (const match of resultText.matchAll(/"html_url"\s*:\s*"([^"]+)"/g)) {
      for (const write of fromUrls(match[1]!, watched)) {
        if (!isUpdate) writes.push(write);
        else {
          const updated = /"updated_at"\s*:\s*"([^"]+)"/.exec(resultText)?.[1];
          if (updated) writes.push({ ...write, change: "update", version: updated });
        }
      }
    }
  }
  return dedupe(writes);
}

function dedupe(writes: ObservedWrite[]): ObservedWrite[] {
  const seen = new Set<string>();
  return writes.filter((write) => {
    const key = `${write.source}|${write.item}|${write.change}|${write.version ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
