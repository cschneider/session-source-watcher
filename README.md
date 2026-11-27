# Session source watcher

Keep an AI conversation informed about the resources it explicitly follows.

Session source watcher is a proposed local-first service for session-owned
subscriptions, deterministic change detection and durable change delivery.
Users and agents share one subscription registry; harness adapters connect it
to conversations and user interfaces.

**Status:** Architecture and TypeScript development scaffold. No watcher
service, source adapters, MCP server or harness integrations are implemented.

## Design

- Explicit subscriptions to resources such as issues, discussion threads,
  pull requests and builds.
- Quiet polling: unchanged checks do not invoke a language model.
- Coverage-aware checkpoints and a durable inbox/outbox.
- User and agent controls to view, add, configure, pause and remove subscriptions.
- Harness-neutral core with capability-based integration adapters.
- Local storage; no required hosted service.

Read [the architecture](docs/architecture.md) and
[the public prior-art overview](docs/prior-art.md).

## Development

Use Node.js 22.13 or later and npm.

```sh
npm ci
npm run typecheck
npm run build
```

The empty `src/index.ts` establishes the build entrypoint. JavaScript,
declarations and source maps are emitted to `dist/`. There is no runnable
service or test suite yet. npm package publication is disabled.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Do not submit credentials, private source
content or real session data in issues, fixtures, logs or examples.

## License

[Apache License 2.0](LICENSE).
