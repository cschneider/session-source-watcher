# Prior art

These projects are architectural references, not selected dependencies.
Capabilities, maintenance status and licensing must be checked before reuse.
Each section summarizes the parts of a project's public architecture that bear
on the watcher, and what the [concrete design](design/watcher.md) takes from
it.

| Project or protocol | Relevant layer | Boundary |
| --- | --- | --- |
| [agent-wake](https://github.com/hraedon-labs/agent-wake) | Harness routing and event delivery | Push-only; no source collection or session-owned subscriptions |
| [OpenClaw automations](https://docs.openclaw.ai/automation/cron-jobs/schedules) | Deterministic change gates and session targeting | Part of a larger agent runtime, not a portable service |
| [Claude Code channels](https://code.claude.com/docs/en/channels) | Harness-specific event injection | Research preview; no acknowledgement or replay |
| [MCP resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) | Resource-update signaling | Notifications carry only a URI and do not wake a model |
| [Pipedream sources](https://pipedream.com/docs/components/contributing/api) | Polling sources, state and dedupe | Hosted; component licensing differs from a reusable library |
| [n8n](https://github.com/n8n-io/n8n) | Polling triggers and webhook lifecycle | Workflow executions, not exact-session delivery |
| [Composio triggers](https://docs.composio.dev/docs/triggers) | Hosted collection per connected account | Hosted credentials and delivery |
| [Inngest](https://www.inngest.com/docs) | Idempotency, batching, keyed concurrency | Execution primitives, not an application inbox |
| [Trigger.dev](https://trigger.dev/docs) | Idempotency keys, keyed queues, waitpoints | Background tasks, not conversation delivery |

## agent-wake

A Python daemon with thin per-harness adapters. External systems push signed
events over HTTP. The daemon deduplicates them in SQLite, routes them to a
configured destination, and hands a `wake` frame to the adapter connected for
that destination over a user-private Unix socket with newline-delimited JSON.
Adapters turn the frame into a harness primitive: an OpenCode plugin calls
`promptAsync`, and a Claude Code channel server emits a channel notification.
Each frame carries a daemon-minted acknowledgement ID per destination; queued
events are deleted on acknowledgement and dead-lettered after a bounded number
of attempts or a TTL. The project is frozen at version 0.1.0.

Taken into the design:

- Separate the sender, the principal and the destination. A destination names
  one session; one event fanned out to several sessions gets one queue row and
  one acknowledgement per session.
- A machine-readable capability matrix per harness, with live wake and
  next-session delivery reported separately, and "not verified" treated as
  unsupported.
- Delete-on-acknowledgement, an attempt cap, a TTL and a dead-letter state.
- Unknown protocol versions fail closed.
- A user-private socket directory, a lock file and newline-delimited frames
  with a size limit.

Avoided: an adapter-level "handed off" acknowledgement standing in for the
model's assessment, unauthenticated agent-registered routing labels, broadcast
to all sessions, and inferring adapter death from missed heartbeats during long
model turns.

## OpenClaw automations

Schedules run in the OpenClaw gateway with job state in SQLite. A condition
watcher is a headless script attached to a schedule: it receives its previous
state, returns whether to fire, and only a firing check starts a model turn.
The documented pull-request example diffs the head SHA and individual check
identities rather than an aggregate status. Jobs can target a named session;
such a job waits until that conversation is idle without holding a run slot,
and retries with exponential backoff. Stream sources batch a supervised
command's output with quiet-time and size limits, coalesce while a run is
pending, and do not retry a failed payload because a retry could duplicate
effects.

Taken into the design: deterministic identity-based diffs, state that advances
only with a committed delivery, delivery that waits for an idle session
instead of dropping, self-contained messages, and quiet-time plus size bounds
for batching. Wake text in OpenClaw is a trusted system event; untrusted bodies
are routed to restricted readers. The watcher keeps the same split between a
trusted header and a clearly delimited untrusted block.

## Claude Code channels

A channel is an MCP server spawned by one Claude Code session. It declares an
experimental channel capability and emits a notification with `content` and
identifier-only `meta`; the model sees it as a `<channel>` element. Events
queue while the session is busy and arrive together on the next turn. There is
no acknowledgement, event ID or replay, and events are dropped silently when
the session did not enable the channel.

Taken into the design: a channel is a viable message-tier adapter for Claude
Code, because the spawning session is the exact target. The adapter must add
what channels lack: event IDs in `meta`, an acknowledgement tool, and resending
unacknowledged packets with the same IDs after reconnecting.

## MCP resources

Servers declare `subscribe` and `listChanged`; clients subscribe to a URI and
receive `notifications/resources/updated` carrying only that URI, then re-read
it. The specification defines no persistence, acknowledgement or event
identity, and does not say that a notification starts a model turn.

Taken into the design: MCP is the portable surface for watch tools and pending
changes, not the wake mechanism. The watcher may also act as an MCP client of
upstream servers and treat their update notifications as hints to re-read.

## Pipedream sources

A source is a component with a timer or HTTP interface, a key-value store and
an emit function. Emitted events carry an `id`, and dedupe is one of `unique`
(a bounded cache of recent IDs), `greatest` or `last`. The GitHub pull-request
source builds IDs from the item ID plus its update time, so an edit is a new
event, and seeds its saved IDs on the first run without emitting. One
component serves both webhook and polling modes.

Taken into the design: composite `item:version` dedupe keys, baselining by
seeding state without emitting, and one source type for push and poll. Avoided:
a bounded in-memory ID ring, which re-emits old items once it overflows; the
watcher keeps dedupe in a durable table.

## n8n

Polling nodes keep a cursor in per-node static data. The Outlook trigger
starts from "now" on the first run, and writes its cursor only after a
successful fetch, so a failed poll retries the same window. The GitHub webhook
trigger reconciles remote state on activation: it checks whether its stored
hook still exists, adopts a matching one, and clears a stale ID.

Taken into the design: advance cursors only after a successful read, in the
same transaction as the change events; reconcile remote webhook registrations
instead of trusting stored IDs. Avoided: baselining by wall clock where the
provider offers a sequence or version, and observing overlapping polls without
preventing them.

## Composio triggers

A trigger type becomes an instance per connected account and is enabled or
disabled independently. Events from provider push and from polling (two
minutes by default) arrive in the same signed payload shape.

Taken into the design: one change format regardless of how a change was
detected, and collection scoped to an account.

## Inngest

The event ID is an idempotency key for 24 hours. Batching delivers an array of
events when a size limit or a timeout is reached, per key. Debounce keeps only
the latest event within a quiet period, bounded by a timeout. Concurrency
limits apply per key; singleton runs allow at most one run per key.

Taken into the design: per-session batching by size or timeout, and one
outstanding packet per session. Debounce only for state that supersedes itself,
such as a check's status; never for streams such as comments, where every item
matters.

## Trigger.dev

Idempotency keys deduplicate triggers for a configurable period (30 days by
default) but do not make side effects idempotent. Queues have total and
per-key concurrency limits; waiting runs do not hold a slot. Waitpoint tokens
pause a run until something completes the token or a timeout expires.

Taken into the design: the packet ID is the idempotency key handed to the
harness, admission is recorded separately from acknowledgement, and an
admitted packet waiting for its acknowledgement holds no worker capacity.
