-- Orchard: long-term goals (one fruit tree each) and their milestones. A tree stays in its plot for good once picked.
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  farm_key TEXT NOT NULL REFERENCES farms(key),
  slot INTEGER NOT NULL,                -- orchard plot 0..5
  title TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  fruit TEXT NOT NULL,                  -- apple | orange | peach | lemon | cherry | pear
  due_date TEXT NOT NULL,               -- YYYY-MM-DD, required
  status TEXT NOT NULL DEFAULT 'growing', -- growing | paused
  created_at INTEGER NOT NULL,
  last_progress_at INTEGER NOT NULL,
  done_at INTEGER,                      -- set while every milestone is done
  harvested_at INTEGER                  -- fruit picked: the goal is achieved
);
CREATE UNIQUE INDEX goals_plot ON goals(farm_key, slot);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  title TEXT NOT NULL,
  ord INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX milestones_goal ON milestones(goal_id, ord);
