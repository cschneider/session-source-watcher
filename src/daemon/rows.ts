// SPDX-License-Identifier: Apache-2.0

export interface BindingRow {
  id: string;
  harness: string;
  host_id: string;
  native_session_id: string;
  label: string | null;
  tier: string;
  status: string;
  busy: number;
  connection_epoch: number;
  last_seen_at: number;
  revision: number;
}

export interface GroupRow {
  id: string;
  source_type: string;
  source_key: string;
  source_url: string;
  locator_json: string;
  account: string;
  state: string;
  terminal: string | null;
  cadence_s: number;
  next_run_at: number;
  lease_owner: string | null;
  lease_until: number | null;
  failures: number;
  health: string;
  last_error: string | null;
  cache_json: string;
}

export interface SubscriptionRow {
  id: string;
  binding_id: string;
  group_id: string;
  changes_json: string;
  policy_json: string;
  origin: string;
  reason: string | null;
  baseline: string;
  state: string;
  generation: number;
  revision: number;
  baselined_at: number | null;
  expires_at: number | null;
  created_at: number;
}

export interface EventRow {
  id: string;
  subscription_id: string;
  generation: number;
  observation_id: string;
  urgency: string;
  state: string;
  packet_id: string | null;
  defer_until: number | null;
  created_at: number;
}

export interface PacketRow {
  id: string;
  binding_id: string;
  state: string;
  close_reason: string | null;
  title: string;
  text: string;
  urgency: string;
  attempts: number;
  next_attempt_at: number | null;
  connection_epoch: number | null;
  receipt: string | null;
  created_at: number;
  sent_at: number | null;
  admitted_at: number | null;
  consumed_at: number | null;
  closed_at: number | null;
}

export interface CheckpointRow {
  group_id: string;
  unit: string;
  coverage: string;
  cursor: string | null;
  last_full_at: number | null;
  complete_through: number | null;
  gap_from: number | null;
  last_error: string | null;
  next_due_at: number;
}

export interface ItemRow {
  group_id: string;
  item_key: string;
  unit: string;
  revision: number;
  fingerprint: string;
  projection_json: string;
  summary_json: string;
  missing_count: number;
  removed: number;
  last_seen_at: number;
}

export interface ObservationRow {
  id: string;
  group_id: string;
  item_key: string;
  revision: number;
  kind: string;
  category: string;
  version: string | null;
  actor: string | null;
  occurred_at: number | null;
  observed_at: number;
  summary_json: string;
  previous_json: string | null;
}
