# Contributing

The repository contains the first release of the watcher and its design.
Discuss behavior and harness contracts before adding a source or integration.

## Development

Use Node.js 22.13 or later.

```sh
npm ci
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Install from the public npm registry so `package-lock.json` references only
public URLs. Add focused tests when implementing behavior. Keep the core independent of
harness SDKs and validate external data at runtime.

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
