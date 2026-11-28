// SPDX-License-Identifier: Apache-2.0
// Builds the Copilot plugin: a single-file extension plus the bundled `ssw`
// command it starts the daemon with.
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const root = "dist/copilot-plugin";
const extensionDir = join(root, "com.github.copilot", "extensions", "session-source-watcher");
rmSync(root, { recursive: true, force: true });
mkdirSync(extensionDir, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "eof",
  banner: { js: "import { createRequire as __sswCreateRequire } from 'node:module'; const require = __sswCreateRequire(import.meta.url);" },
};

await build({
  ...common,
  entryPoints: ["src/adapters/copilot/extension.ts"],
  outfile: join(extensionDir, "extension.mjs"),
  external: ["@github/copilot-sdk/extension"],
});
await build({ ...common, entryPoints: ["src/cli/main.ts"], outfile: join(extensionDir, "ssw.mjs") });

writeFileSync(
  join(root, "plugin.json"),
  `${JSON.stringify(
    {
      name: "session-source-watcher",
      description: "Session-owned watches; the watcher messages the session when something it waits on changes.",
      version: pkg.version,
      license: pkg.license,
      extensions: { "com.github.copilot": {} },
    },
    null,
    2,
  )}\n`,
);
console.log(`Built ${root}`);
