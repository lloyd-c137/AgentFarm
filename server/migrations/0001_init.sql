-- Agent Farm: one farm per signed-in person, devices that report events, tasks that grow as crops.
CREATE TABLE farms (
  key TEXT PRIMARY KEY,               -- sha-256 of the email, first 24 hex chars
  email TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1, -- bumped on every change; pages poll with it
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  farm_key TEXT NOT NULL REFERENCES farms(key),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,    -- sha-256 of the token; the token itself is shown once
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE INDEX devices_farm ON devices(farm_key);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                -- farm + source + session id, hashed
  farm_key TEXT NOT NULL REFERENCES farms(key),
  source TEXT NOT NULL,               -- claude-code | codex | claude-web | chatgpt-web
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,                 -- short name shown on the board
  title TEXT NOT NULL,                -- longer title shown in the crop's details
  title_auto INTEGER NOT NULL DEFAULT 1, -- 1 while the title is a placeholder; the first prompt replaces it
  state TEXT NOT NULL,                -- working | approval | reply | error | stalled
  round INTEGER NOT NULL DEFAULT 1,
  slot INTEGER NOT NULL,
  msg TEXT NOT NULL DEFAULT '',
  cwd_name TEXT,
  url TEXT,
  need_since INTEGER,                 -- when it started waiting on you
  waits_over10 INTEGER NOT NULL DEFAULT 0,
  waits_over60 INTEGER NOT NULL DEFAULT 0,
  last_event_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  harvested_at INTEGER,
  quality TEXT                        -- gold | silver | normal, set at harvest
);
CREATE INDEX tasks_farm_live ON tasks(farm_key, harvested_at);
CREATE INDEX tasks_sweep ON tasks(harvested_at, state, last_event_at);
