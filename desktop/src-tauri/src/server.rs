use crate::{farm, store::Store};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{HeaderMap, Request, StatusCode, header::HOST},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::Path as FsPath, sync::Arc, time::Duration};
use tokio::net::TcpListener;

#[derive(Clone)]
struct AppState {
    store: Arc<Store>,
    token: Arc<String>,
}

pub fn router(store: Arc<Store>, token: String) -> Router {
    let state = AppState {
        store,
        token: Arc::new(token),
    };
    Router::new()
        .route("/api/me", get(me))
        .route("/api/farm", get(farm_state))
        .route("/api/tasks/{id}/harvest", post(harvest))
        .route(
            "/ingest/{source}",
            post(ingest).layer(axum::extract::DefaultBodyLimit::max(1 << 20)),
        )
        .fallback(not_found)
        .layer(middleware::from_fn(validate_request))
        .with_state(state)
}

pub async fn serve(listener: TcpListener, app: Router) -> std::io::Result<()> {
    axum::serve(listener, app).await
}

async fn validate_request(req: Request<Body>, next: Next) -> Response {
    let host_ok = req
        .headers()
        .get(HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h == "127.0.0.1:47321" || h == "localhost:47321");
    if !host_ok {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Some(origin) = req.headers().get("Origin").and_then(|h| h.to_str().ok()) {
        if origin != "http://127.0.0.1:47321" && origin != "http://localhost:47321" {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    if req.method() != axum::http::Method::GET
        && req.uri().path().starts_with("/api/")
        && req
            .headers()
            .get("X-Agent-Farm")
            .and_then(|h| h.to_str().ok())
            != Some("1")
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

async fn me() -> Json<Value> {
    Json(json!({"mode":"local"}))
}

#[derive(Deserialize)]
struct FarmQuery {
    v: Option<i64>,
    tz: Option<i64>,
    wait: Option<u64>,
}

async fn farm_state(State(state): State<AppState>, Query(q): Query<FarmQuery>) -> Response {
    let mut changes = state.store.changed.subscribe();
    let version = state.store.version();
    if q.v == Some(version) {
        if let Some(wait) = q.wait {
            let wait = wait.min(30);
            let _ = tokio::time::timeout(Duration::from_secs(wait), async {
                loop {
                    if changes.changed().await.is_err() || *changes.borrow() != version {
                        break;
                    }
                }
            })
            .await;
            if state.store.version() == version {
                return StatusCode::NO_CONTENT.into_response();
            }
        } else {
            return StatusCode::NO_CONTENT.into_response();
        }
    }
    match state
        .store
        .snapshot(q.tz.unwrap_or(0).clamp(-840, 840), now_ms())
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn ingest(
    State(state): State<AppState>,
    Path(source): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !matches!(
        source.as_str(),
        "claude-code" | "codex" | "claude-web" | "chatgpt-web"
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let token = headers
        .get("Authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|v| {
            let (scheme, token) = v.split_once(' ')?;
            scheme
                .eq_ignore_ascii_case("Bearer")
                .then_some(token.trim())
        });
    if token != Some(state.token.as_str()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if body.len() > (1 << 20) {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if let Some(event) = farm::normalize(&body) {
        if farm::apply_event(&state.store, &source, &event, now_ms()).is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    StatusCode::OK.into_response()
}

async fn harvest(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let db = state.store.db.lock().expect("database lock poisoned");
    let task = match db.query_row("SELECT state,need_since,waits_over10,waits_over60 FROM tasks WHERE id=? AND harvested_at IS NULL", [&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))) {
        Ok(task) => task, Err(rusqlite::Error::QueryReturnedNoRows) => return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response(), Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let now = now_ms();
    let running = if farm::needs(&task.0) {
        task.1.map_or(0, |since| now - since)
    } else {
        0
    };
    let over10 = task.2 + i64::from(running > 10 * 60_000);
    let over60 = task.3 + i64::from(running > 60 * 60_000);
    let quality = if over10 == 0 {
        "gold"
    } else if over60 == 0 {
        "silver"
    } else {
        "normal"
    };
    let result = db.execute(
        "UPDATE tasks SET harvested_at=?,quality=? WHERE id=? AND harvested_at IS NULL",
        params![now, quality, id],
    );
    match result {
        Ok(1) => {
            if state.store.bump_locked(&db).is_err() {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            Json(json!({"ok":true})).into_response()
        }
        Ok(_) => (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn load_or_create_token(path: &FsPath) -> std::io::Result<String> {
    if path.exists() {
        return std::fs::read_to_string(path).map(|s| s.trim().to_owned());
    }
    use std::os::unix::fs::OpenOptionsExt;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    use std::io::Write;
    writeln!(file, "{token}")?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn req(uri: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header("Host", "127.0.0.1:47321")
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn local_mode_and_security_statuses() {
        let app = router(Arc::new(Store::memory().unwrap()), "good".into());
        let response = app.clone().oneshot(req("/api/me")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            json!({"mode":"local"})
        );
        let mut wrong_host = req("/api/me");
        wrong_host
            .headers_mut()
            .insert("Host", "evil.example".parse().unwrap());
        assert_eq!(
            app.clone().oneshot(wrong_host).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let mut bad_token = req("/ingest/codex");
        *bad_token.method_mut() = axum::http::Method::POST;
        bad_token
            .headers_mut()
            .insert("Authorization", "Bearer bad".parse().unwrap());
        assert_eq!(
            app.clone().oneshot(bad_token).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let mut bad_origin = req("/api/me");
        bad_origin
            .headers_mut()
            .insert("Origin", "https://evil.example".parse().unwrap());
        assert_eq!(
            app.oneshot(bad_origin).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let app = router(Arc::new(Store::memory().unwrap()), "good".into());
        let mut missing_write_header = req("/api/tasks/nope/harvest");
        *missing_write_header.method_mut() = axum::http::Method::POST;
        assert_eq!(
            app.oneshot(missing_write_header).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn version_poll_returns_204_and_wakes_after_an_event() {
        let app = router(Arc::new(Store::memory().unwrap()), "good".into());
        assert_eq!(
            app.clone()
                .oneshot(req("/api/farm?v=1"))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        let waiting_app = app.clone();
        let waiting = tokio::spawn(async move {
            waiting_app
                .oneshot(req("/api/farm?v=1&wait=5"))
                .await
                .unwrap()
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let mut post = Request::builder()
            .method("POST")
            .uri("/ingest/codex")
            .header("Host", "127.0.0.1:47321")
            .header("Authorization", "bEaReR good")
            .body(Body::from(r#"{"event":"prompt","session_id":"long-poll"}"#))
            .unwrap();
        // Ensure the test request exercises the exact HTTP route, not the farm function directly.
        post.headers_mut()
            .insert("Content-Type", "application/json".parse().unwrap());
        assert_eq!(
            app.clone().oneshot(post).await.unwrap().status(),
            StatusCode::OK
        );
        let response = waiting.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["tasks"][0]["state"],
            "working"
        );
    }
}
