use crate::store::Store;
use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const NEEDS: &[&str] = &["approval", "reply", "error", "stalled"];
const COLS: i64 = 8;

pub fn needs(state: &str) -> bool {
    NEEDS.contains(&state)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    pub kind: String,
    pub sid: String,
    pub cwd_name: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub msg: Option<String>,
}

#[derive(Clone, Debug)]
struct Task {
    id: String,
    state: String,
    round: i64,
    slot: i64,
    msg: String,
    need_since: Option<i64>,
    waits_over10: i64,
    waits_over60: i64,
    title: String,
    name: String,
    title_auto: bool,
    cwd_name: Option<String>,
    url: Option<String>,
    last_event_at: i64,
    created_at: i64,
    harvested_at: Option<i64>,
    is_new: bool,
}

fn text(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or("").to_owned()
}
fn clip(s: &str, max: usize) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

pub fn normalize(body: &Value) -> Option<Event> {
    if !body.is_object() {
        return None;
    }
    let name = text(body.get("hook_event_name").or_else(|| body.get("event")));
    let sid = clip(
        &text(
            body.get("session_id")
                .or_else(|| body.get("conversation_id")),
        ),
        200,
    );
    if sid.is_empty() {
        return None;
    }
    let cwd_name = body
        .get("cwd")
        .and_then(Value::as_str)
        .and_then(|p| p.split(['/', '\\']).filter(|p| !p.is_empty()).next_back())
        .map(str::to_owned);
    let url = body
        .get("url")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| clip(s, 300));
    let (kind, title, msg) = match name.as_str() {
        "UserPromptSubmit" | "prompt" => (
            "prompt",
            Some(clip(
                &text(body.get("prompt").or_else(|| body.get("title"))),
                60,
            )),
            None,
        ),
        "PermissionRequest" | "permission" => {
            let m = body
                .get("tool_input")
                .and_then(|v| v.get("description"))
                .and_then(Value::as_str)
                .or_else(|| body.get("tool_name").and_then(Value::as_str))
                .or_else(|| body.get("message").and_then(Value::as_str));
            ("permission", None, Some(clip(m.unwrap_or(""), 60)))
        }
        "Notification" => {
            let t = text(body.get("notification_type"));
            if t == "permission_prompt"
                || (t.is_empty()
                    && text(body.get("message"))
                        .to_lowercase()
                        .contains("permission"))
            {
                (
                    "permission",
                    None,
                    Some(clip(&text(body.get("message")), 60)),
                )
            } else if t == "idle_prompt" {
                ("stop", None, Some(String::new()))
            } else {
                return None;
            }
        }
        "Stop" | "Interrupt" | "stop" => (
            "stop",
            None,
            Some(clip(
                &text(
                    body.get("last_assistant_message")
                        .or_else(|| body.get("message")),
                ),
                80,
            )),
        ),
        "StopFailure" | "error" => {
            let m = body
                .get("error")
                .or_else(|| body.get("error_type"))
                .or_else(|| body.get("message"));
            let message = m
                .map(|v| text(Some(v)))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "API 出错".into());
            ("error", None, Some(clip(&message, 80)))
        }
        "SessionEnd" | "end" => ("end", None, None),
        "PreToolUse" | "PostToolUse" | "activity" => ("activity", None, None),
        _ => return None,
    };
    Some(Event {
        kind: kind.into(),
        sid,
        cwd_name,
        url,
        title,
        msg,
    })
}

fn short_name(title: &str) -> String {
    let mut width = 0;
    let mut out = String::new();
    for ch in title.chars() {
        width += if (ch as u32) <= 0xff { 1 } else { 2 };
        if width > 16 {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn source_row(source: &str) -> i64 {
    match source {
        "codex" => 0,
        "claude-code" => 1,
        "claude-web" => 2,
        _ => 3,
    }
}

fn free_slot(used: &HashSet<i64>, source: &str) -> Option<i64> {
    let pref = source_row(source);
    [pref, 3, 0, 1, 2].into_iter().find_map(|row| {
        (0..COLS)
            .map(|col| row * COLS + col)
            .find(|slot| !used.contains(slot))
    })
}

fn quality(t: &Task, now: i64) -> &'static str {
    let running = if NEEDS.contains(&t.state.as_str()) {
        t.need_since.map_or(0, |since| now - since)
    } else {
        0
    };
    let over10 = t.waits_over10 + i64::from(running > 10 * 60_000);
    let over60 = t.waits_over60 + i64::from(running > 60 * 60_000);
    if over10 == 0 {
        "gold"
    } else if over60 == 0 {
        "silver"
    } else {
        "normal"
    }
}

fn load_task(db: &rusqlite::Connection, id: &str) -> rusqlite::Result<Option<Task>> {
    db.query_row("SELECT id,state,round,slot,msg,need_since,waits_over10,waits_over60,title,name,title_auto,cwd_name,url,last_event_at,created_at,harvested_at FROM tasks WHERE id=?", [id], |r| {
        Ok(Task { id: r.get(0)?, state: r.get(1)?, round: r.get(2)?, slot: r.get(3)?, msg: r.get(4)?, need_since: r.get(5)?, waits_over10: r.get(6)?, waits_over60: r.get(7)?, title: r.get(8)?, name: r.get(9)?, title_auto: r.get::<_, i64>(10)? != 0, cwd_name: r.get(11)?, url: r.get(12)?, last_event_at: r.get(13)?, created_at: r.get(14)?, harvested_at: r.get(15)?, is_new: false })
    }).optional()
}

pub fn apply_event(store: &Store, source: &str, event: &Event, now: i64) -> rusqlite::Result<bool> {
    let mut hasher = Sha256::new();
    hasher.update(format!("local-farm|{source}|{}", event.sid));
    let id: String = hasher.finalize()[..10]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let db = store.db.lock().expect("database lock poisoned");
    let mut task = load_task(&db, &id)?;
    if task.as_ref().is_some_and(|t| t.harvested_at.is_some()) {
        if event.kind != "prompt" {
            return Ok(false);
        }
        db.execute("DELETE FROM tasks WHERE id=?", [&id])?;
        task = None;
    }
    if task.is_none() {
        if event.kind == "end" || event.kind == "activity" {
            return Ok(false);
        }
        let used = {
            let mut stmt = db.prepare("SELECT slot FROM tasks WHERE harvested_at IS NULL")?;
            stmt.query_map([], |r| r.get::<_, i64>(0))?
                .collect::<rusqlite::Result<HashSet<_>>>()?
        };
        let Some(slot) = free_slot(&used, source) else {
            return Ok(false);
        };
        let title = event
            .title
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                event
                    .cwd_name
                    .as_ref()
                    .map(|cwd| format!("{cwd} 里的任务"))
                    .unwrap_or_else(|| "新任务".into())
            });
        task = Some(Task {
            id: id.clone(),
            state: "working".into(),
            round: 1,
            slot,
            msg: "AI 正在干活".into(),
            need_since: None,
            waits_over10: 0,
            waits_over60: 0,
            name: short_name(&title),
            title_auto: event.title.as_deref().unwrap_or("").is_empty(),
            title,
            cwd_name: event.cwd_name.clone(),
            url: event.url.clone(),
            last_event_at: now,
            created_at: now,
            harvested_at: None,
            is_new: true,
        });
        if event.kind == "prompt" {
            write_task(&db, task.as_ref().unwrap(), source, &event.sid, now)?;
            store.bump_locked(&db)?;
            return Ok(true);
        }
    }
    let mut t = task.unwrap();
    let was_need = NEEDS.contains(&t.state.as_str());
    if t.cwd_name.is_none() {
        t.cwd_name = event.cwd_name.clone();
    }
    if event.url.is_some() {
        t.url = event.url.clone();
    }
    match event.kind.as_str() {
        "prompt" => {
            if was_need {
                let waited = now - t.need_since.unwrap_or(now);
                t.waits_over10 += i64::from(waited > 10 * 60_000);
                t.waits_over60 += i64::from(waited > 60 * 60_000);
                t.round += 1;
            }
            t.state = "working".into();
            t.need_since = None;
            t.msg = "AI 正在干活".into();
            if t.title_auto {
                if let Some(title) = event.title.as_deref().filter(|s| !s.is_empty()) {
                    t.title = title.into();
                    t.name = short_name(title);
                    t.title_auto = false;
                }
            }
        }
        "permission" => {
            if !was_need {
                t.need_since = Some(now);
            } else if t.need_since.is_none() {
                t.need_since = Some(now);
            }
            t.state = "approval".into();
            t.msg = event
                .msg
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| format!("请求授权：{s}"))
                .unwrap_or_else(|| "请求授权".into());
        }
        "stop" => {
            if !was_need {
                t.need_since = Some(now);
            } else if t.need_since.is_none() {
                t.need_since = Some(now);
            }
            t.state = "reply".into();
            t.msg = event
                .msg
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("AI 做完一轮，等你回复")
                .into();
        }
        "error" => {
            if !was_need {
                t.need_since = Some(now);
            } else if t.need_since.is_none() {
                t.need_since = Some(now);
            }
            t.state = "error".into();
            t.msg = event.msg.clone().unwrap_or_default();
        }
        "activity" => {
            if t.state != "stalled" && now - t.last_event_at < 60_000 {
                return Ok(false);
            }
            if t.state == "stalled" {
                t.state = "working".into();
                t.need_since = None;
                t.msg = "重新上报，继续干活".into();
            }
        }
        "end" => {
            if t.is_new {
                return Ok(false);
            }
            db.execute(
                "UPDATE tasks SET harvested_at=?,quality=?,last_event_at=? WHERE id=?",
                params![now, quality(&t, now), now, t.id],
            )?;
            store.bump_locked(&db)?;
            return Ok(true);
        }
        _ => return Ok(false),
    }
    write_task(&db, &t, source, &event.sid, now)?;
    store.bump_locked(&db)?;
    Ok(true)
}

fn write_task(
    db: &rusqlite::Connection,
    t: &Task,
    source: &str,
    sid: &str,
    now: i64,
) -> rusqlite::Result<()> {
    if t.is_new {
        db.execute("INSERT INTO tasks(id,source,session_id,name,title,title_auto,state,round,slot,msg,cwd_name,url,need_since,waits_over10,waits_over60,last_event_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![t.id, source, sid, t.name, t.title, i64::from(t.title_auto), t.state, t.round, t.slot, t.msg, t.cwd_name, t.url, t.need_since, t.waits_over10, t.waits_over60, now, t.created_at])?;
    } else {
        db.execute("UPDATE tasks SET name=?,title=?,title_auto=?,state=?,round=?,slot=?,msg=?,cwd_name=?,url=?,need_since=?,waits_over10=?,waits_over60=?,last_event_at=? WHERE id=?",
            params![t.name, t.title, i64::from(t.title_auto), t.state, t.round, t.slot, t.msg, t.cwd_name, t.url, t.need_since, t.waits_over10, t.waits_over60, now, t.id])?;
    }
    Ok(())
}

pub fn sweep(store: &Store, now: i64) -> rusqlite::Result<(usize, usize)> {
    let db = store.db.lock().expect("database lock poisoned");
    let stalled = db.execute("UPDATE tasks SET state='stalled',need_since=?,msg='30 分钟没有任何上报，可能卡住了或忘了汇报' WHERE harvested_at IS NULL AND state='working' AND last_event_at < ?", params![now, now - 30 * 60_000])?;
    let harvested = db.execute("UPDATE tasks SET harvested_at=?,quality=CASE WHEN waits_over60=0 THEN 'silver' ELSE 'normal' END WHERE harvested_at IS NULL AND state IN ('reply','approval','error','stalled') AND COALESCE(need_since,last_event_at) < ?", params![now, now - 24 * 60 * 60_000])?;
    db.execute(
        "DELETE FROM tasks WHERE harvested_at IS NOT NULL AND harvested_at < ?",
        [now - 30 * 86_400_000],
    )?;
    if stalled + harvested > 0 {
        store.bump_locked(&db)?;
    }
    drop(db);
    Ok((stalled, harvested))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::json;

    fn event(kind: &str, sid: &str, title: Option<&str>, msg: Option<&str>) -> Event {
        Event {
            kind: kind.into(),
            sid: sid.into(),
            cwd_name: None,
            url: None,
            title: title.map(str::to_owned),
            msg: msg.map(str::to_owned),
        }
    }
    fn state(store: &Store, sid: &str) -> String {
        store
            .db
            .lock()
            .unwrap()
            .query_row("SELECT state FROM tasks WHERE session_id=?", [sid], |r| {
                r.get(0)
            })
            .unwrap()
    }
    fn harvest_quality(store: &Store, sid: &str) -> String {
        store
            .db
            .lock()
            .unwrap()
            .query_row("SELECT quality FROM tasks WHERE session_id=?", [sid], |r| {
                r.get(0)
            })
            .unwrap()
    }

    #[test]
    fn lifecycle_authorization_reply_stall_recovery_and_harvest() {
        let store = Store::memory().unwrap();
        apply_event(
            &store,
            "claude-code",
            &event("prompt", "life", Some("Lifecycle"), None),
            1_000,
        )
        .unwrap();
        assert_eq!(state(&store, "life"), "working");
        apply_event(
            &store,
            "claude-code",
            &event("permission", "life", None, Some("shell")),
            2_000,
        )
        .unwrap();
        assert_eq!(state(&store, "life"), "approval");
        apply_event(
            &store,
            "claude-code",
            &event("prompt", "life", None, None),
            3_000,
        )
        .unwrap();
        assert_eq!(state(&store, "life"), "working");
        apply_event(
            &store,
            "claude-code",
            &event("stop", "life", None, Some("Ready")),
            4_000,
        )
        .unwrap();
        assert_eq!(state(&store, "life"), "reply");
        apply_event(
            &store,
            "claude-code",
            &event("prompt", "life", None, None),
            5_000,
        )
        .unwrap();
        assert_eq!(sweep(&store, 5_000 + 31 * 60_000).unwrap().0, 1);
        assert_eq!(state(&store, "life"), "stalled");
        apply_event(
            &store,
            "claude-code",
            &event("activity", "life", None, None),
            5_000 + 32 * 60_000,
        )
        .unwrap();
        assert_eq!(state(&store, "life"), "working");
        apply_event(
            &store,
            "claude-code",
            &event("end", "life", None, None),
            5_000 + 33 * 60_000,
        )
        .unwrap();
        assert_eq!(harvest_quality(&store, "life"), "gold");
    }

    #[test]
    fn harvest_quality_gold_silver_normal() {
        for (sid, wait, want) in [
            ("gold", 5 * 60_000, "gold"),
            ("silver", 20 * 60_000, "silver"),
            ("normal", 70 * 60_000, "normal"),
        ] {
            let store = Store::memory().unwrap();
            apply_event(
                &store,
                "codex",
                &event("prompt", sid, Some(sid), None),
                1_000,
            )
            .unwrap();
            apply_event(&store, "codex", &event("stop", sid, None, None), 2_000).unwrap();
            apply_event(
                &store,
                "codex",
                &event("end", sid, None, None),
                2_000 + wait,
            )
            .unwrap();
            assert_eq!(harvest_quality(&store, sid), want);
        }
    }

    #[test]
    fn field_capacity_unknown_event_and_normalization() {
        let store = Store::memory().unwrap();
        for i in 0..32 {
            apply_event(
                &store,
                "codex",
                &event("prompt", &format!("s{i}"), None, None),
                i,
            )
            .unwrap();
        }
        let version = store.version();
        assert!(
            !apply_event(
                &store,
                "codex",
                &event("prompt", "overflow", None, None),
                100
            )
            .unwrap()
        );
        let count: i64 = store
            .db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 32);
        assert_eq!(store.version(), version);
        assert!(normalize(&json!({"event":"unrecognized", "session_id":"x"})).is_none());
        assert!(normalize(&json!({"event":"prompt", "session_id":"x"})).is_some());
    }
}
