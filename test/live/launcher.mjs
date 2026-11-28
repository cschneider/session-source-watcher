// SPDX-License-Identifier: Apache-2.0
// Launches a Copilot extension for an SDK-hosted session. The CLI normally
// maps `@github/copilot-sdk` imports to the SDK it injects through
// COPILOT_SDK_PATH; SDK hosts have to provide that mapping themselves.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const hook = `
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const sdk = process.env.COPILOT_SDK_PATH;
export async function resolve(specifier, context, next) {
  const match = /^@(github|microsoft)\\/copilot-sdk(\\/extension)?$/.exec(specifier);
  if (sdk && match) return { url: pathToFileURL(join(sdk, match[2] ? "extension.js" : "index.js")).href, shortCircuit: true };
  return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);
await import(pathToFileURL(process.argv[2]).href);
