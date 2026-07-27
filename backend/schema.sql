CREATE TABLE IF NOT EXISTS player_records (
  player_id TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score > 0 AND score <= 10000000),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id)
);

CREATE INDEX IF NOT EXISTS idx_player_records_rank
ON player_records (score DESC, updated_at ASC);
