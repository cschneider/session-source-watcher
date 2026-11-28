# Contributing

The repository contains the first release of the watcher and its design.
Discuss behavior and harness contracts before adding a source or integration.

## Development

Use Node.js 22.13 or later. The daemon stores its state with the built-in
`node:sqlite` module, which prints an experimental warning; the npm scripts
silence it.

```sh
npm ci
npm run typecheck
npm test
npm run test:e2e
```

Install from the public npm registry so `package-lock.json` references only
public URLs. Add focused tests when implementing behavior. Keep the core independent of
harness SDKs and validate external data at runtime.

### Builds

| Command | Output | Used by |
| --- | --- | --- |
| `npm run build` | `dist/`: `tsc` output of `src/`, one module per file | The `ssw` command (`npx ssw` in a checkout) |
| `npm run package:copilot` | `dist/copilot-plugin/`: `extension.mjs` and `ssw.mjs`, each one esbuild bundle without `node_modules` | The Copilot extension, `install:copilot`, `test:e2e`, `test:live` |
| `npm run install:copilot` | The bundle copied to `~/.copilot/extensions/session-source-watcher/` | Local use with the Copilot CLI |

The extension bundle leaves `@github/copilot-sdk/extension` external, because
Copilot provides the SDK to its extensions. `ssw.mjs` holds the command line
and the daemon; the extension starts it with `node ssw.mjs daemon`. npm
package publication is disabled.

### Tests

| Command | Scope | Cost |
| --- | --- | --- |
| `npm run typecheck` | Source and tests, without output | Seconds |
| `npm test` | `test/*.test.ts`: core logic, the GitHub source against a fake HTTP API, the daemon over its real socket with a fake clock, source and adapter (`test/helpers.ts`), and the Copilot adapter's tracker and write extraction | Seconds |
| `npm run test:e2e` | The packaged extension and bundled daemon against a stub SDK and a fake GitHub API (`test/e2e/`) | Seconds |
| `npm run test:live` | The packaged extension in real Copilot sessions (`test/live/`, see below) | About 20 minutes and AI credits |

`npm test` compiles into `.test-build/` and runs Node's test runner. To run
selected tests:

```sh
npx tsc -p tsconfig.test.json
node --disable-warning=ExperimentalWarning --test --test-name-pattern="PacketTracker" ".test-build/test/**/*.test.js"
```

There is no CI. Before opening a pull request, run `npm run typecheck`,
`npm test` and, for changes to the Copilot adapter, packaging or delivery,
`npm run test:e2e`. Run `npm run test:live` when a change depends on Copilot
runtime behavior, such as message delivery, hooks or session events.

### Development overrides

| Variable | Effect |
| --- | --- |
| `SSW_STATE_DIR` | State, socket and logs in this directory instead of the per-user default; isolates a test daemon |
| `SSW_GITHUB_TOKEN` | Token for GitHub reads instead of `gh auth token` |
| `SSW_GITHUB_API_BASE` | GitHub API base URL, for a fake API |
| `SSW_DAEMON_COMMAND` | Command the extension runs to start the daemon, as a JSON array or a space-separated string |
| `SSW_DEBUG_LOG` | File for a JSON Lines trace of the extension's hooks, sends and reports; it records tool arguments, so keep it off in normal use |

## Live Copilot checks

`npm run test:live` runs the Copilot extension in real Copilot sessions and
checks delivery into an idle session, `clientTurnId` on enqueued messages,
own-write suppression through `onPostToolUse`, completion in Autopilot and
recovery after the runtime is killed. It runs real model turns, so it costs
AI credits and takes about 20 minutes. It needs a signed-in Copilot CLI with
extension support and the Copilot SDK, which is not a dependency:

```sh
npm install --no-save @github/copilot-sdk
npm run test:live                 # idle, writes, autopilot, restart
npm run test:live -- restart      # selected scenarios
```

The harness drives the session through the SDK, serves a scripted GitHub API
and puts a fake `gh` on the path, so nothing reaches GitHub. It sets
`SSW_DEBUG_LOG` to trace the extension's hooks, sends and reports, then
asserts against that trace, the daemon store and the session's event log.
`COPILOT_CLI_PATH` selects the CLI binary; `SSW_LIVE_KEEP=1` keeps the
scratch directory. GitHub MCP tool payloads, Protected Mode and the Copilot
app stay manual checks.

## Changes

Use feature branches and pull requests with plain Conventional Commits subjects.
Do not commit directly to `main`.

Use synthetic examples. Do not publish credentials, private URLs, customer data,
source evidence, real session identifiers or employer-confidential material.
Verify licensing before introducing dependencies or copied code, and preserve
required notices and attribution.

Contributions are provided under the repository's Apache License 2.0.
