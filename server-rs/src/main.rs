//! Mnemo server, Rust port (server-only migration; the React app in `web/` is
//! unchanged and served from here).
//!
//! This binary currently serves the notes, category, search and static routes;
//! chat, jobs, settings and assets still live in the TypeScript server, so the
//! two can run side by side against the same data directory while the port is
//! completed.

mod notes;
mod search;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

use notes::{NoteInput, NoteStore};
use search::SearchService;

struct AppState {
    notes: NoteStore,
    search: SearchService,
}

#[derive(Deserialize)]
struct CategoryQuery {
    category: Option<String>,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
}

#[derive(Deserialize)]
struct NewCategory {
    name: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = PathBuf::from(
        std::env::var("MNEMO_DATA_DIR").unwrap_or_else(|_| "data".to_string()),
    );
    let port: u16 = std::env::var("MNEMO_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3001);

    let store = NoteStore::new(&data_dir)?;
    let search = SearchService::new();
    let started = std::time::Instant::now();
    search.rebuild(&store);
    let index_ms = started.elapsed().as_millis();

    let state = Arc::new(AppState { notes: store, search });

    let web_dist = PathBuf::from(
        std::env::var("MNEMO_WEB_DIST").unwrap_or_else(|_| "web/dist".to_string()),
    );
    let index_html = web_dist.join("index.html");

    let api = Router::new()
        .route("/api/categories", get(list_categories).post(create_category))
        .route("/api/notes", get(list_notes).post(create_note))
        .route(
            "/api/notes/:id",
            get(get_note).put(update_note).delete(delete_note),
        )
        .route("/api/search", get(search_notes))
        .with_state(state.clone());

    // Static: binary assets under /assets/, the built web app everywhere else,
    // falling back to the SPA shell for client-side routes.
    let app = api
        .nest_service("/assets", ServeDir::new(data_dir.join("assets")))
        .fallback_service(
            ServeDir::new(&web_dist).not_found_service(ServeFile::new(&index_html)),
        );

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!(
        "Mnemo (Rust) running on http://localhost:{port}\n  data:  {}\n  index: {index_ms} ms",
        data_dir.display()
    );
    axum::serve(listener, app).await?;
    Ok(())
}

async fn list_categories(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({ "categories": s.notes.list_categories() }))
}

async fn create_category(
    State(s): State<Arc<AppState>>,
    Json(body): Json<NewCategory>,
) -> impl IntoResponse {
    match s.notes.create_category(&body.name) {
        Ok(()) => Json(json!({ "categories": s.notes.list_categories() })).into_response(),
        Err(e) => server_error(e).into_response(),
    }
}

async fn list_notes(
    State(s): State<Arc<AppState>>,
    Query(q): Query<CategoryQuery>,
) -> impl IntoResponse {
    Json(json!({ "notes": s.notes.list(q.category.as_deref()) }))
}

async fn get_note(State(s): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> impl IntoResponse {
    match s.notes.get(&id) {
        Some(note) => Json(note).into_response(),
        None => not_found().into_response(),
    }
}

async fn create_note(
    State(s): State<Arc<AppState>>,
    Json(input): Json<NoteInput>,
) -> impl IntoResponse {
    match s.notes.create(&input) {
        Ok(note) => {
            s.search.upsert(&s.notes, &note.meta.id);
            Json(note).into_response()
        }
        Err(e) => server_error(e).into_response(),
    }
}

async fn update_note(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<NoteInput>,
) -> impl IntoResponse {
    match s.notes.update(&id, &input) {
        Ok(Some(note)) => {
            // A rename changes the id, so drop the old entry as well.
            if note.meta.id != id {
                s.search.remove(&id);
            }
            s.search.upsert(&s.notes, &note.meta.id);
            Json(note).into_response()
        }
        Ok(None) => not_found().into_response(),
        Err(e) => server_error(e).into_response(),
    }
}

async fn delete_note(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    match s.notes.delete(&id) {
        Ok(true) => {
            s.search.remove(&id);
            Json(json!({ "deleted": true })).into_response()
        }
        Ok(false) => not_found().into_response(),
        Err(e) => server_error(e).into_response(),
    }
}

async fn search_notes(
    State(s): State<Arc<AppState>>,
    Query(q): Query<SearchQuery>,
) -> impl IntoResponse {
    let notes = s.search.search(q.q.as_deref().unwrap_or(""), 30);
    Json(json!({ "notes": notes }))
}

fn not_found() -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" })))
}

fn server_error(e: std::io::Error) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
}
