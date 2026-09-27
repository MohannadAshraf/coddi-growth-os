CREATE TABLE IF NOT EXISTS business_goals (
  goal_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('draft', 'interpreted', 'approved', 'active', 'archived')),
  preset_id TEXT,
  name TEXT NOT NULL,
  original_text TEXT,
  goal_spec_json TEXT NOT NULL,
  active_from_week TEXT,
  active_to_week TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (goal_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_goals_one_active
  ON business_goals(status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_business_goals_status
  ON business_goals(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_business_goals_active_window
  ON business_goals(active_from_week, active_to_week);

CREATE TABLE IF NOT EXISTS goal_interpretations (
  interpretation_id TEXT PRIMARY KEY,
  goal_id TEXT,
  input_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  raw_output_json TEXT NOT NULL,
  validated_goal_spec_json TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'invalid', 'unavailable')),
  validation_errors_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_goal_interpretations_goal
  ON goal_interpretations(goal_id, created_at);

CREATE INDEX IF NOT EXISTS idx_goal_interpretations_input_hash
  ON goal_interpretations(input_hash, created_at);

CREATE TABLE IF NOT EXISTS action_scores (
  score_id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  goal_version INTEGER NOT NULL,
  action_key TEXT NOT NULL,
  source_action_json TEXT NOT NULL,
  total_score REAL NOT NULL,
  goal_alignment_score REAL NOT NULL,
  financial_score REAL NOT NULL,
  urgency_score REAL NOT NULL,
  confidence_score REAL NOT NULL,
  severity_guardrail_score REAL NOT NULL,
  time_to_impact_score REAL NOT NULL,
  cross_functional_value_score REAL NOT NULL DEFAULT 0,
  must_show INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL,
  formula_json TEXT NOT NULL,
  final_action_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (week_start, goal_id, goal_version, action_key)
);

CREATE INDEX IF NOT EXISTS idx_action_scores_week_goal_rank
  ON action_scores(week_start, goal_id, goal_version, rank);

CREATE INDEX IF NOT EXISTS idx_action_scores_must_show
  ON action_scores(week_start, must_show, rank);
