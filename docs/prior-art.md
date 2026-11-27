# Prior art

These projects are architectural references, not selected dependencies.
Capabilities, maintenance status and licensing must be checked before reuse.

| Project or protocol | Relevant layer | Boundary |
| --- | --- | --- |
| [agent-wake](https://github.com/hraedon-labs/agent-wake) | Harness routing and event delivery | Does not establish our source collection or session-subscription UI |
| [OpenClaw condition watchers](https://docs.openclaw.ai/automation/cron-jobs/schedules) | Deterministic change gates | Part of a larger agent runtime, not a portable service by itself |
| [Composio triggers](https://docs.composio.dev/docs/triggers) | Hosted source collection and authorization | Hosted credentials and delivery require a separate trust/deployment decision |
| [Pipedream Connect](https://pipedream.com/docs/connect/components/triggers) | Hosted integration sources | Component licensing is not equivalent to a permissive reusable library |
| [Inngest](https://www.inngest.com/docs/self-hosting) | Durable execution infrastructure | Execution primitives are not automatically an application inbox |
| [Trigger.dev](https://trigger.dev/docs/self-hosting/overview) | Background task infrastructure | Source subscriptions and conversation delivery remain separate |
| [n8n](https://github.com/n8n-io/n8n) | Visual integration orchestration | Integration nodes do not imply exact-session delivery |
| [MCP resource subscriptions](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) | Resource-update signaling | Notifications do not mandate a model turn or durable replay |
| [Claude Code channels](https://code.claude.com/docs/en/channels) | Harness-specific event injection | Availability and lifecycle depend on that harness |

The project's narrow scope is session-owned subscription controls,
coverage-aware state and a portable delivery contract. Reuse compatible
components where useful without treating source collection, event admission and
assessment completion as the same operation.
