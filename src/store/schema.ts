// SPDX-License-Identifier: Apache-2.0

/** Ordered migrations; index + 1 is the schema version. */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE bindings (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  host_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  label TEXT,
  tier TEXT NOT NULL,
  status TEXT NOT NULL,
  busy INTEGER NOT NULL DEFAULT 0,
  connection_epoch INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  UNIQUE (harness, host_id, native_session_id)
);

CREATE TABLE collection_groups (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  account TEXT NOT NULL,
  state TEXT NOT NULL,
  terminal TEXT,
  cadence_s INTEGER NOT NULL,
  next_run_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  health TEXT NOT NULL,
  last_error TEXT,
  cache_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (source_type, source_key, account)
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES bindings(id),
  group_id TEXT NOT NULL REFERENCES collection_groups(id),
  changes_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  origin TEXT NOT NULL,
  reason TEXT,
  baseline TEXT NOT NULL,
  state TEXT NOT NULL,
  generation INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  baselined_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_live_subscription
  ON subscriptions (binding_id, group_id) WHERE state <> 'removed';

CREATE TABLE tombstones (
  binding_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  removed_by TEXT NOT NULL,
  removed_at INTEGER NOT NULL,
  PRIMARY KEY (binding_id, group_id)
);

CREATE TABLE checkpoints (
  group_id TEXT NOT NULL REFERENCES collection_groups(id),
  unit TEXT NOT NULL,
  coverage TEXT NOT NULL,
  cursor TEXT,
  last_full_at INTEGER,
  complete_through INTEGER,
  gap_from INTEGER,
  last_error TEXT,
  next_due_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, unit)
);

CREATE TABLE items (
  group_id TEXT NOT NULL REFERENCES collection_groups(id),
  item_key TEXT NOT NULL,
  unit TEXT NOT NULL,
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  missing_count INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, item_key)
);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collection_groups(id),
  item_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  category TEXT NOT NULL,
  version TEXT,
  actor TEXT,
  occurred_at INTEGER,
  observed_at INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  previous_json TEXT,
  UNIQUE (group_id, item_key, revision, kind)
);

CREATE TABLE expected_writes (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES bindings(id),
  group_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  change TEXT NOT NULL,
  version TEXT,
  reported_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_by TEXT
);
CREATE INDEX expected_by_binding ON expected_writes (binding_id, group_id, item_key);

CREATE TABLE packets (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES bindings(id),
  state TEXT NOT NULL,
  close_reason TEXT,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  urgency TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  connection_epoch INTEGER,
  receipt TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  admitted_at INTEGER,
  consumed_at INTEGER,
  closed_at INTEGER
);
CREATE UNIQUE INDEX one_open_packet
  ON packets (binding_id) WHERE state <> 'closed';

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  generation INTEGER NOT NULL,
  observation_id TEXT NOT NULL REFERENCES observations(id),
  urgency TEXT NOT NULL,
  state TEXT NOT NULL,
  packet_id TEXT REFERENCES packets(id),
  defer_until INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (subscription_id, observation_id)
);
CREATE INDEX events_by_state ON events (state, subscription_id);
CREATE INDEX events_by_packet ON events (packet_id);

CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  packet_id TEXT,
  outcome TEXT NOT NULL,
  defer_until INTEGER,
  actor TEXT NOT NULL,
  note TEXT,
  at INTEGER NOT NULL
);

CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subscription_id TEXT,
  detail_json TEXT NOT NULL
);

CREATE TABLE budgets (
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  remaining INTEGER,
  rate_limit INTEGER,
  reset_at INTEGER,
  PRIMARY KEY (provider, account)
);
`,
];
