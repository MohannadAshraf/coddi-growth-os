ALTER TABLE commercial_candidate_actions ADD COLUMN prompt_version TEXT;
ALTER TABLE commercial_candidate_actions ADD COLUMN eligibility_version TEXT;
ALTER TABLE commercial_candidate_actions ADD COLUMN engine_version TEXT;
ALTER TABLE commercial_candidate_actions ADD COLUMN display_category TEXT;
ALTER TABLE commercial_candidate_actions ADD COLUMN survived_filter_reason TEXT;
ALTER TABLE commercial_candidate_actions ADD COLUMN outranked_reason TEXT;
ALTER TABLE commercial_candidate_actions ADD COLUMN superseded_at TEXT;
ALTER TABLE commercial_candidate_actions ADD COLUMN superseded_by_version TEXT;

ALTER TABLE recommendation_generation_runs ADD COLUMN eligibility_version TEXT;
ALTER TABLE recommendation_generation_runs ADD COLUMN superseded_at TEXT;
ALTER TABLE recommendation_generation_runs ADD COLUMN superseded_by_version TEXT;

ALTER TABLE action_scores ADD COLUMN eligibility_version TEXT;
ALTER TABLE action_scores ADD COLUMN display_category TEXT;
ALTER TABLE action_scores ADD COLUMN superseded_at TEXT;
ALTER TABLE action_scores ADD COLUMN superseded_by_version TEXT;

CREATE INDEX IF NOT EXISTS idx_commercial_candidate_actions_current_version
  ON commercial_candidate_actions(week_start, goal_id, goal_version, prompt_version, eligibility_version, superseded_at);

CREATE INDEX IF NOT EXISTS idx_action_scores_current_version
  ON action_scores(week_start, goal_id, goal_version, eligibility_version, superseded_at);
