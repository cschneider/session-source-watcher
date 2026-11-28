// SPDX-License-Identifier: Apache-2.0
// Installs the built Copilot extension as a user extension.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const built = "dist/copilot-plugin/com.github.copilot/extensions/session-source-watcher";
if (!existsSync(join(built, "extension.mjs"))) {
  console.error('Build the plugin first: npm run package:copilot');
  process.exit(1);
}
const home = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
const target = join(home, "extensions", "session-source-watcher");
mkdirSync(target, { recursive: true });
cpSync(built, target, { recursive: true });
console.log(`Installed ${target}. Start a new Copilot session to load it.`);
