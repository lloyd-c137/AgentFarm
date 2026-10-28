use rusqlite::{Connection, params};
use serde::Serialize;
use std::{path::Path, sync::Mutex};
use tokio::sync::watch;

pub struct Store {
    pub(crate) db: Mutex<Connection>,
    pub(crate) changed: watch::Sender<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub id: String,
    pub source: String,
    pub src: String,
    pub name: String,
    pub full: String,
    pub state: String,
    pub round: i64,
    pub slot: i64,
    pub msg: String,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub need_since: Option<i64>,
    pub last_event_at: i64,
    pub created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippedView {
    pub name: String,
    pub q: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FarmSnapshot {
    pub version: i64,
    pub now: i64,
    pub tasks: Vec<TaskView>,
    pub shipped: Vec<ShippedView>,
    pub harvest_today: i64,
    pub harvest_week: i64,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        Self::from_connection(db)
    }

    pub fn memory() -> rusqlite::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(db: Connection) -> rusqlite::Result<Self> {
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
             INSERT OR IGNORE INTO meta(key, value) VALUES ('version', 1);
             CREATE TABLE IF NOT EXISTS tasks (
               id TEXT PRIMARY KEY, source TEXT NOT NULL, session_id TEXT NOT NULL,
               name TEXT NOT NULL, title TEXT NOT NULL, title_auto INTEGER NOT NULL DEFAULT 1,
               state TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 1, slot INTEGER NOT NULL,
               msg TEXT NOT NULL DEFAULT '', cwd_name TEXT, url TEXT, need_since INTEGER,
               waits_over10 INTEGER NOT NULL DEFAULT 0, waits_over60 INTEGER NOT NULL DEFAULT 0,
               last_event_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
               harvested_at INTEGER, quality TEXT);
             CREATE INDEX IF NOT EXISTS tasks_live ON tasks(harvested_at, slot);
             CREATE INDEX IF NOT EXISTS tasks_sweep ON tasks(harvested_at, state, last_event_at);",
        )?;
        let version: i64 = db.query_row("SELECT value FROM meta WHERE key='version'", [], |r| {
            r.get(0)
        })?;
        let (changed, _) = watch::channel(version);
        Ok(Self {
            db: Mutex::new(db),
            changed,
        })
    }

    pub fn version(&self) -> i64 {
        *self.changed.borrow()
    }

    pub(crate) fn bump_locked(&self, db: &Connection) -> rusqlite::Result<()> {
        db.execute("UPDATE meta SET value=value+1 WHERE key='version'", [])?;
        let next: i64 = db.query_row("SELECT value FROM meta WHERE key='version'", [], |r| {
            r.get(0)
        })?;
        self.changed.send_replace(next);
        Ok(())
    }

    pub fn snapshot(&self, tz_minutes: i64, now: i64) -> rusqlite::Result<FarmSnapshot> {
        let db = self.db.lock().expect("database lock poisoned");
        let mut stmt = db.prepare("SELECT id, source, name, title, state, round, slot, msg, cwd_name, url, need_since, last_event_at, created_at FROM tasks WHERE harvested_at IS NULL ORDER BY slot")?;
        let tasks = stmt
            .query_map([], |r| {
                let source: String = r.get(1)?;
                Ok(TaskView {
                    id: r.get(0)?,
                    src: source_name(&source),
                    source,
                    name: r.get(2)?,
                    full: r.get(3)?,
                    state: r.get(4)?,
                    round: r.get(5)?,
                    slot: r.get(6)?,
                    msg: r.get(7)?,
                    cwd: r.get(8)?,
                    url: r.get(9)?,
                    need_since: r.get(10)?,
                    last_event_at: r.get(11)?,
                    created_at: r.get(12)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let day_start =
            (now - tz_minutes * 60_000).div_euclid(86_400_000) * 86_400_000 + tz_minutes * 60_000;
        let mut shipped_stmt = db.prepare("SELECT name, COALESCE(quality, 'normal') FROM tasks WHERE harvested_at >= ? ORDER BY harvested_at")?;
        let shipped = shipped_stmt
            .query_map(params![day_start], |r| {
                Ok(ShippedView {
                    name: r.get(0)?,
                    q: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let harvest_week: i64 = db.query_row(
            "SELECT COUNT(*) FROM tasks WHERE harvested_at >= ?",
            params![now - 7 * 86_400_000],
            |r| r.get(0),
        )?;
        Ok(FarmSnapshot {
            version: self.version(),
            now,
            harvest_today: shipped.len() as i64,
            harvest_week,
            tasks,
            shipped,
        })
    }
}

pub fn source_name(source: &str) -> String {
    match source {
        "claude-code" => "Claude Code".into(),
        "codex" => "Codex".into(),
        "claude-web" => "Claude 聊天".into(),
        "chatgpt-web" => "ChatGPT 聊天".into(),
        _ => source.into(),
    }
}
