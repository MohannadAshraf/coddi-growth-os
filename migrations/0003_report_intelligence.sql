CREATE TABLE IF NOT EXISTS diagnosis_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  goal_id TEXT,
  goal_version INTEGER,
  evidence_schema_version TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  diagnosis_json TEXT NOT NULL,
  evidence_packet_json TEXT NOT NULL,
  performance_bridge_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (week_start, goal_id, goal_version, data_hash)
);

CREATE INDEX IF NOT EXISTS idx_diagnosis_snapshots_week
  ON diagnosis_snapshots(week_start, created_at);

CREATE TABLE IF NOT EXISTS recommendation_generation_runs (
  generation_id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  goal_id TEXT,
  goal_version INTEGER,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  evidence_schema_version TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generated', 'skipped', 'invalid', 'failed')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (week_start, goal_id, goal_version, prompt_version, data_hash)
);

CREATE INDEX IF NOT EXISTS idx_recommendation_generation_runs_week
  ON recommendation_generation_runs(week_start, created_at);

CREATE TABLE IF NOT EXISTS commercial_candidate_actions (
  candidate_id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  goal_id TEXT,
  goal_version INTEGER,
  candidate_key TEXT NOT NULL,
  generation_id TEXT,
  data_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  recommendation_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  entity_name TEXT,
  intervention_type TEXT NOT NULL,
  expected_metric TEXT NOT NULL,
  expected_direction TEXT NOT NULL,
  confidence REAL NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('accepted', 'rejected')),
  rejection_reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL,
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  action_json TEXT NOT NULL,
  score_json TEXT NOT NULL DEFAULT '{}',
  rank INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (week_start, goal_id, goal_version, candidate_key, data_hash)
);

CREATE INDEX IF NOT EXISTS idx_commercial_candidate_actions_week_goal_rank
  ON commercial_candidate_actions(week_start, goal_id, goal_version, validation_status, rank);

CREATE INDEX IF NOT EXISTS idx_commercial_candidate_actions_type
  ON commercial_candidate_actions(week_start, category, recommendation_type);

CREATE TABLE IF NOT EXISTS money_risk_estimates (
  estimate_id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  amount REAL,
  currency TEXT,
  formula TEXT NOT NULL,
  confidence TEXT NOT NULL,
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (week_start, candidate_key, metric)
);

CREATE INDEX IF NOT EXISTS idx_money_risk_estimates_week
  ON money_risk_estimates(week_start, amount);

CREATE TABLE IF NOT EXISTS ad_product_mappings (
  mapping_id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  product_id TEXT,
  product_title TEXT,
  variant_id TEXT,
  sku TEXT,
  mapping_source TEXT NOT NULL CHECK (mapping_source IN ('manual', 'deterministic_suggestion', 'imported')),
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'rejected', 'archived')) DEFAULT 'active',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (week_start, ad_id, product_id, variant_id, mapping_source)
);

CREATE INDEX IF NOT EXISTS idx_ad_product_mappings_week_ad
  ON ad_product_mappings(week_start, ad_id, status);

CREATE INDEX IF NOT EXISTS idx_ad_product_mappings_product
  ON ad_product_mappings(product_id, variant_id, status);

CREATE TABLE IF NOT EXISTS creative_metadata (
  creative_id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  creative_name TEXT,
  thumbnail_url TEXT,
  preview_url TEXT,
  body_text TEXT,
  title_text TEXT,
  destination_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('available', 'unavailable')) DEFAULT 'unavailable',
  unavailable_reason TEXT,
  source_json TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (week_start, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_creative_metadata_week_ad
  ON creative_metadata(week_start, ad_id, status);
