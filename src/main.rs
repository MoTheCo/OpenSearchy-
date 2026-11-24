use axum::{
    extract::{DefaultBodyLimit, Path, Query},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
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
        .route("/api/search/brave", get(brave_search))
        .route("/api/images/brave", get(brave_images))
        .route("/api/images/openverse", get(openverse_images))
        .route("/api/images/wikimedia", get(wikimedia_images))
        .route("/api/maps/search", get(map_search))
        .route("/api/maps/nearby", get(map_nearby))
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

async fn brave_search(headers: HeaderMap, Query(query): Query<ImageQuery>) -> Response {
    let Some(api_key) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let url = reqwest::Url::parse("https://api.search.brave.com/res/v1/web/search")
        .expect("Brave-URL ist ungültig")
        .query_pairs_mut()
        .append_pair("q", query.q.trim())
        .append_pair("count", "6")
        .append_pair("safesearch", "moderate")
        .finish()
        .to_string();
    image_proxy(url, Some(api_key), "Brave Search").await
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

async fn map_search(Query(query): Query<ImageQuery>) -> Response {
    let url = reqwest::Url::parse("https://nominatim.openstreetmap.org/search")
        .expect("Nominatim-URL ist ungültig")
        .query_pairs_mut()
        .append_pair("q", query.q.trim())
        .append_pair("format", "jsonv2")
        .append_pair("addressdetails", "1")
        .append_pair("limit", "6")
        .finish()
        .to_string();
    let client = reqwest::Client::builder()
        .user_agent("OpenSearchy/0.1 (local search application)")
        .build()
        .expect("HTTP-Client konnte nicht erstellt werden");
    let upstream = match client
        .get(url)
        .header(header::ACCEPT, "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) => {
            eprintln!("Karten-Suche fehlgeschlagen: {err}");
            return (
                StatusCode::BAD_GATEWAY,
                "OpenStreetMap ist nicht erreichbar.",
            )
                .into_response();
        }
    };
    let status = upstream.status();
    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("Karten-Antwort konnte nicht gelesen werden: {err}");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    (
        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        bytes,
    )
        .into_response()
}

#[derive(Deserialize)]
struct NearbyQuery {
    category: String,
    term: Option<String>,
    south: f64,
    west: f64,
    north: f64,
    east: f64,
}

async fn map_nearby(Query(query): Query<NearbyQuery>) -> Response {
    let tags: &[(&str, &str)] = match query.category.as_str() {
        "doctors" => &[
            ("amenity", "doctors"),
            ("amenity", "clinic"),
            ("healthcare", "doctor"),
        ],
        "dentist" => &[("amenity", "dentist"), ("healthcare", "dentist")],
        "hospital" => &[("amenity", "hospital"), ("healthcare", "hospital")],
        "pharmacy" => &[("amenity", "pharmacy"), ("healthcare", "pharmacy")],
        "physician" => &[("amenity", "doctors"), ("healthcare", "physiotherapist")],
        "named" => &[],
        _ => return (StatusCode::BAD_REQUEST, "Unbekannte Kartenkategorie.").into_response(),
    };
    if ![query.south, query.west, query.north, query.east]
        .iter()
        .all(|value| value.is_finite())
        || query.south < -90.0
        || query.north > 90.0
        || query.west < -180.0
        || query.east > 180.0
        || query.south >= query.north
        || query.west >= query.east
        || (query.north - query.south) * (query.east - query.west) > 4.0
    {
        return (StatusCode::BAD_REQUEST, "Ungültiger Suchbereich.").into_response();
    }
    let bbox = format!(
        "{},{},{},{}",
        query.south, query.west, query.north, query.east
    );
    let filters = if query.category == "named" {
        let Some(term) = query
            .term
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        else {
            return (StatusCode::BAD_REQUEST, "Ein Name ist erforderlich.").into_response();
        };
        let escaped = term.chars().fold(String::new(), |mut result, character| {
            if "\\.^$|?*+()[]{}".contains(character) {
                result.push('\\');
            }
            if character == '"' {
                result.push('\\');
            }
            result.push(character);
            result
        });
        format!(
            "nwr[\"name\"~\"{escaped}\",i]({bbox});nwr[\"operator\"~\"{escaped}\",i]({bbox});nwr[\"healthcare:speciality\"~\"{escaped}\",i]({bbox});"
        )
    } else {
        tags.iter()
            .map(|(key, value)| format!("nwr[\"{key}\"=\"{value}\"]({bbox});"))
            .collect::<String>()
    };
    let overpass_query = format!("[out:json][timeout:25];({filters});out center 60;");
    let client = reqwest::Client::builder()
        .user_agent("OpenSearchy/0.1 (local search application)")
        .build()
        .expect("HTTP-Client konnte nicht erstellt werden");
    let endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
    ];
    for endpoint in endpoints {
        let upstream = match client
            .post(endpoint)
            .form(&[("data", &overpass_query)])
            .send()
            .await
        {
            Ok(response) if response.status().is_server_error() => {
                eprintln!(
                    "Overpass-Instanz {endpoint} antwortet mit {}",
                    response.status()
                );
                continue;
            }
            Ok(response) => response,
            Err(err) => {
                eprintln!("Overpass-Instanz {endpoint} fehlgeschlagen: {err}");
                continue;
            }
        };
        let status = upstream.status();
        let bytes = match upstream.bytes().await {
            Ok(bytes) => bytes,
            Err(err) => {
                eprintln!("Overpass-Antwort von {endpoint} konnte nicht gelesen werden: {err}");
                continue;
            }
        };
        return (
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            bytes,
        )
            .into_response();
    }
    (
        StatusCode::BAD_GATEWAY,
        "OpenStreetMap-Detailsuche ist derzeit nicht erreichbar.",
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
