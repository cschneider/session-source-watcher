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

## Changes

Use feature branches and pull requests with plain Conventional Commits subjects.
Do not commit directly to `main`.

Use synthetic examples. Do not publish credentials, private URLs, customer data,
source evidence, real session identifiers or employer-confidential material.
Verify licensing before introducing dependencies or copied code, and preserve
required notices and attribution.

Contributions are provided under the repository's Apache License 2.0.
