use agent_farm::{server, store::Store};
use std::{env, path::PathBuf, process, sync::Arc, time::Duration};

#[tokio::main]
async fn main() {
    if env::args().nth(1).as_deref() != Some("--serve") {
        eprintln!("usage: agent-farm --serve");
        process::exit(2);
    }
    if let Err(error) = serve().await {
        eprintln!("Agent Farm: {error}");
        process::exit(1);
    }
}

async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let data = match env::var_os("AGENT_FARM_DATA_DIR") {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(env::var_os("HOME").ok_or("HOME is not set")?)
            .join("Library/Application Support/AgentFarm"),
    };
    std::fs::create_dir_all(&data)?;
    let token = server::load_or_create_token(&data.join("token"))?;
    let store = Arc::new(Store::open(data.join("farm.db"))?);
    let sweep_store = Arc::clone(&store);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.tick().await;
        loop {
            interval.tick().await;
            let _ = agent_farm::farm::sweep(&sweep_store, server::now_ms());
        }
    });
    let app = server::router(store, token);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:47321").await?;
    eprintln!("Agent Farm local service: http://127.0.0.1:47321/");
    server::serve(listener, app).await?;
    Ok(())
}
