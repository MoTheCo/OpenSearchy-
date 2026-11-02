use axum::{
    extract::Path,
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};

const INDEX: &str = include_str!("index.html");
const APP: &str = include_str!("app.js");
const STYLE: &str = include_str!("style.css");
const MODULES: &[(&str, &str)] = &[
    ("dom.js", include_str!("dom.js")),
    ("vault.js", include_str!("vault.js")),
    ("llm.js", include_str!("llm.js")),
    ("models.js", include_str!("models.js")),
    ("rag.js", include_str!("rag.js")),
    ("chat.js", include_str!("chat.js")),
    ("settings.js", include_str!("settings.js")),
    ("views.js", include_str!("views.js")),
];

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/style.css", get(style))
        .route("/js/{name}", get(module));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000")
        .await
        .expect("Port 3000 ist belegt");
    println!("OpenSearchy läuft auf http://127.0.0.1:3000");
    axum::serve(listener, app).await.expect("Serverfehler");
}

async fn index() -> Html<&'static str> {
    Html(INDEX)
}

async fn app_js() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], APP)
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
