CREATE TABLE IF NOT EXISTS scores (
  week TEXT NOT NULL,
  player_id TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score > 0 AND score <= 50000),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (week, player_id)
);

CREATE INDEX IF NOT EXISTS idx_scores_week_rank
ON scores (week, score DESC, updated_at ASC);
