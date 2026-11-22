use axum::{
    extract::{DefaultBodyLimit, Path, Query},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

const INDEX: &str = include_str!("index.html");
const APP: &str = include_str!("app.js");
const STYLE: &str = include_str!("style.css");
const MODULES: &[(&str, &str)] = &[
    ("dom.js", include_str!("dom.js")),
    ("vault.js", include_str!("vault.js")),
    ("store.js", include_str!("store.js")),
    ("llm.js", include_str!("llm.js")),
    ("models.js", include_str!("models.js")),
    ("rag.js", include_str!("rag.js")),
    ("chat.js", include_str!("chat.js")),
    ("settings.js", include_str!("settings.js")),
    ("views.js", include_str!("views.js")),
];
// Nur diese Datensätze dürfen gelesen und geschrieben werden; der Inhalt ist im Browser verschlüsselt.
const STORE_NAMES: &[&str] = &["vault"];

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/style.css", get(style))
        .route("/js/{name}", get(module))
        .route("/api/perplexity/chat/completions", post(perplexity_chat))
        .route("/api/images/brave", get(brave_images))
        .route("/api/images/openverse", get(openverse_images))
        .route("/api/images/wikimedia", get(wikimedia_images))
        .route(
            "/api/store/{name}",
            get(read_record).put(write_record).delete(delete_record),
        )
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000")
        .await
        .expect("Port 3000 ist belegt");
    println!("OpenSearchy läuft auf http://127.0.0.1:3000");
    axum::serve(listener, app).await.expect("Serverfehler");
}

#[derive(Deserialize)]
struct ImageQuery {
    q: String,
}

async fn image_proxy(url: String, api_key: Option<&str>, provider_name: &str) -> Response {
    let client = reqwest::Client::builder()
        .user_agent("OpenSearchy/0.1")
        .build()
        .expect("HTTP-Client konnte nicht erstellt werden");
    let mut request = client.get(url).header(header::ACCEPT, "application/json");
    if let Some(api_key) = api_key {
        request = request.header("X-Subscription-Token", api_key);
    }

    let upstream = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            eprintln!("{provider_name}-Bildsuche fehlgeschlagen: {err}");
            return (
                StatusCode::BAD_GATEWAY,
                format!("{provider_name} ist nicht erreichbar."),
            )
                .into_response();
        }
    };
    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_owned();
    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("{provider_name}-Bildantwort konnte nicht gelesen werden: {err}");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    (
        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
        [(header::CONTENT_TYPE, content_type)],
        bytes,
    )
        .into_response()
}

async fn brave_images(headers: HeaderMap, Query(query): Query<ImageQuery>) -> Response {
    let Some(api_key) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let url = reqwest::Url::parse("https://api.search.brave.com/res/v1/images/search")
        .expect("Brave-URL ist ungültig")
        .query_pairs_mut()
        .append_pair("q", query.q.trim())
        .append_pair("count", "12")
        .append_pair("safesearch", "strict")
        .finish()
        .to_string();
    image_proxy(url, Some(api_key), "Brave").await
}

async fn openverse_images(Query(query): Query<ImageQuery>) -> Response {
    let url = reqwest::Url::parse("https://api.openverse.org/v1/images/")
        .expect("Openverse-URL ist ungültig")
        .query_pairs_mut()
        .append_pair("q", query.q.trim())
        .append_pair("page_size", "12")
        .finish()
        .to_string();
    image_proxy(url, None, "Openverse").await
}

async fn wikimedia_images(Query(query): Query<ImageQuery>) -> Response {
    let url = reqwest::Url::parse("https://commons.wikimedia.org/w/api.php")
        .expect("Wikimedia-URL ist ungültig")
        .query_pairs_mut()
        .append_pair("action", "query")
        .append_pair("generator", "search")
        .append_pair("gsrsearch", &query.q.trim())
        .append_pair("gsrnamespace", "6")
        .append_pair("gsrlimit", "12")
        .append_pair("prop", "imageinfo")
        .append_pair("iiprop", "url|extmetadata")
        .append_pair("iiurlwidth", "800")
        .append_pair("format", "json")
        .append_pair("formatversion", "2")
        .finish()
        .to_string();
    image_proxy(url, None, "Wikimedia Commons").await
}

async fn perplexity_chat(headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let Some(api_key) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let result = reqwest::Client::new()
        .post("https://api.perplexity.ai/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await;

    let upstream = match result {
        Ok(response) => response,
        Err(err) => {
            eprintln!("Perplexity-Anfrage fehlgeschlagen: {err}");
            return (StatusCode::BAD_GATEWAY, "Perplexity ist nicht erreichbar.").into_response();
        }
    };
    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_owned();
    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("Perplexity-Antwort konnte nicht gelesen werden: {err}");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    (
        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
        [(header::CONTENT_TYPE, content_type)],
        bytes,
    )
        .into_response()
}

// Speicherort auf dem Gerät: ~/Library/Application Support/OpenSearchy (macOS), sonst ~/.local/share/opensearchy.
// Mit OPENSEARCHY_DATA_DIR lässt sich der Ort überschreiben.
fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("OPENSEARCHY_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = PathBuf::from(std::env::var("HOME").expect("HOME ist nicht gesetzt"));
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/OpenSearchy")
    } else {
        home.join(".local/share/opensearchy")
    }
}

fn record_path(name: &str) -> Option<PathBuf> {
    STORE_NAMES
        .contains(&name)
        .then(|| data_dir().join(format!("{name}.json")))
}

async fn read_record(Path(name): Path<String>) -> Response {
    let Some(path) = record_path(&name) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => (
            [
                (header::CONTENT_TYPE, "application/json; charset=utf-8"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            text,
        )
            .into_response(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND.into_response()
        }
        Err(err) => {
            eprintln!("Lesen von {} fehlgeschlagen: {err}", path.display());
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

// Schreibt atomar über eine temporäre Datei, damit ein Absturz keine halbe Datei hinterlässt.
async fn write_record(Path(name): Path<String>, body: String) -> Response {
    let Some(path) = record_path(&name) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let result = async {
        let dir = path.parent().unwrap_or(&path);
        tokio::fs::create_dir_all(dir).await?;
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, body).await?;
        tokio::fs::rename(&tmp, &path).await
    }
    .await;
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => {
            eprintln!("Schreiben von {} fehlgeschlagen: {err}", path.display());
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn delete_record(Path(name): Path<String>) -> Response {
    let Some(path) = record_path(&name) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::fs::remove_file(&path).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NO_CONTENT.into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn index() -> Html<&'static str> {
    Html(INDEX)
}

async fn app_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        APP,
    )
}

async fn style() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], STYLE)
}

async fn module(Path(name): Path<String>) -> Response {
    match MODULES.iter().find(|(file, _)| *file == name) {
        Some((_, source)) => (
            [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
            *source,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
