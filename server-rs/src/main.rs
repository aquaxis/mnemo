//! Mnemo server, Rust port (server-only migration; the React app in `web/` is
//! unchanged and served from here).
//!
//! This binary currently serves the notes, category, search and static routes;
//! chat, jobs, settings and assets still live in the TypeScript server, so the
//! two can run side by side against the same data directory while the port is
//! completed.

mod agent;
mod assets;
mod config;
mod crawler;
mod jobs;
mod log;
mod notes;
mod proposal;
mod search;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use axum::routing::{any, get, post, put};
use axum::Router;
use serde::Deserialize;
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

use agent::Agent;
use assets::AssetStore;
use config::{AppConfig, SettingsPatch};
use log::Logger;
use jobs::{Cron, Job, JobPatch, JobRun, JobStore};
use notes::{NoteInput, NoteStore};
use search::SearchService;

/// Largest asset upload accepted, in bytes.
const MAX_UPLOAD_BYTES: usize = 256 * 1024 * 1024;

struct AppState {
    notes: NoteStore,
    search: SearchService,
    assets: AssetStore,
    jobs: JobStore,
    agent: Agent,
    logger: Logger,
    /// Reloaded whenever settings are saved (FR-SETTINGS-3).
    config: std::sync::RwLock<AppConfig>,
}

impl AppState {
    fn config(&self) -> AppConfig {
        self.config.read().unwrap().clone()
    }

    /// Which selectable backends have their command on PATH (FR-REL-6).
    fn availability(&self) -> serde_json::Value {
        let cfg = self.config();
        let mut map = serde_json::Map::new();
        for b in config::AI_BACKENDS {
            map.insert(b.to_string(), json!(config::backend_available(&cfg.ai, b)));
        }
        serde_json::Value::Object(map)
    }
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
    // Seed from templates/ on first run, then make sure the layout exists.
    let templates_dir = PathBuf::from(
        std::env::var("MNEMO_TEMPLATES_DIR").unwrap_or_else(|_| "templates".to_string()),
    );
    config::seed_data_dir(&data_dir, &templates_dir)?;
    config::ensure_layout(&data_dir)?;
    let cfg = config::load(data_dir.clone());
    let port = cfg.port;

    let logger = Logger::new(&cfg.log_file, cfg.log_to_stdout);
    let store = NoteStore::new(&data_dir)?;
    let search = SearchService::new();
    let started = std::time::Instant::now();
    search.rebuild(&store);
    let index_ms = started.elapsed().as_millis();
    logger.info(&format!("indexed notes in {index_ms} ms"));
    if !config::backend_available(&cfg.ai, &cfg.ai.kind) {
        logger.warn(&format!(
            "the configured AI backend '{}' was not found on PATH",
            cfg.ai.kind
        ));
    }

    let log_file = cfg.log_file.clone();
    let log_to_stdout = cfg.log_to_stdout;
    let state = Arc::new(AppState {
        notes: store,
        search,
        assets: AssetStore::new(&data_dir),
        jobs: JobStore::new(&data_dir)?,
        agent: Agent::new(cfg.ai.max_concurrent_runs),
        logger,
        config: std::sync::RwLock::new(cfg),
    });

    // Cron ticker: one pass a minute over the enabled jobs (FR-CRON-1/2).
    tokio::spawn(scheduler_loop(state.clone()));

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
        .route("/api/assets", post(upload_asset).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/ai/backends", get(ai_backends))
        .route("/api/ai/backend", put(select_backend))
        .route("/api/jobs", get(list_jobs).post(create_job))
        .route("/api/jobs/:id", put(update_job).delete(delete_job))
        .route("/api/jobs/:id/runs", get(job_runs))
        .route("/api/jobs/:id/run", post(run_job_now))
        .route("/api/agent/collect", post(collect))
        .route("/api/chat", post(chat))
        .route("/api/chat/save", post(save_chat))
        // Endpoints still served by the TypeScript server must answer as API
        // routes, not fall through to the SPA shell: a client parsing JSON
        // would otherwise choke on an HTML page with status 200.
        .route("/api/*rest", any(api_not_ported))
        .with_state(state.clone());

    // Static: binary assets under /assets/, the built web app everywhere else,
    // falling back to the SPA shell for client-side routes.
    let app = api
        .nest_service("/assets", ServeDir::new(data_dir.join("assets")))
        .fallback_service(
            ServeDir::new(&web_dist).not_found_service(ServeFile::new(&index_html)),
        );

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            // Startup failures must be readable: the log goes to a file, so a
            // bare error string on the console would be the only clue.
            if e.kind() == std::io::ErrorKind::AddrInUse {
                eprintln!(
                    "Mnemo failed to start: port {port} is already in use — another instance is \
                     probably still running.\n  Find it with:  ss -ltnp | grep :{port}\n  \
                     Stop it with:  kill <pid>"
                );
            } else {
                eprintln!("Mnemo failed to start: {e}");
            }
            std::process::exit(1);
        }
    };
    println!(
        "Mnemo (Rust) running on http://localhost:{port}\n  data:  {}\n  log:   {}\n  index: {index_ms} ms",
        data_dir.display(),
        if log_to_stdout { "(stdout)".to_string() } else { log_file.display().to_string() }
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

/// Placeholder for the endpoints not ported yet (chat, jobs, settings, assets).
async fn api_not_ported(AxumPath(rest): AxumPath<String>) -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": format!("/api/{rest} is not implemented by the Rust server yet"),
        })),
    )
}

// --- Assets (FR-FILE-3) ------------------------------------------------------
async fn upload_asset(State(s): State<Arc<AppState>>, mut form: Multipart) -> impl IntoResponse {
    while let Ok(Some(field)) = form.next_field().await {
        let filename = field.file_name().unwrap_or("upload").to_string();
        let Ok(bytes) = field.bytes().await else { continue };
        return match s.assets.save(&filename, &bytes) {
            Ok((path, url)) => Json(json!({ "path": path, "url": url })).into_response(),
            Err(e) => server_error(e).into_response(),
        };
    }
    (StatusCode::BAD_REQUEST, Json(json!({ "error": "No file" }))).into_response()
}

// --- Settings (FR-SETTINGS-1..3) ---------------------------------------------
async fn get_settings(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    let cfg = s.config();
    Json(json!({
        "backends": config::AI_BACKENDS,
        "ai": cfg.ai,
        "port": cfg.port,
        "available": s.availability(),
        "logFile": if cfg.log_to_stdout { serde_json::Value::Null } else { json!(cfg.log_file) },
    }))
}

async fn put_settings(
    State(s): State<Arc<AppState>>,
    Json(patch): Json<SettingsPatch>,
) -> impl IntoResponse {
    if let Some(kind) = &patch.kind {
        if !config::AI_BACKENDS.contains(&kind.as_str()) {
            return unknown_backend().into_response();
        }
    }
    let data_dir = s.config().data_dir;
    match config::save_settings(&data_dir, &patch) {
        Ok(next) => {
            let selected = next.ai.kind.clone();
            let ai = next.ai.clone();
            *s.config.write().unwrap() = next;
            s.logger.info(&format!("settings saved (backend: {selected})"));
            Json(json!({ "ai": ai, "selected": selected, "available": s.availability() }))
                .into_response()
        }
        Err(e) => server_error(e).into_response(),
    }
}

async fn ai_backends(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({
        "backends": config::AI_BACKENDS,
        "selected": s.config().ai.kind,
        "available": s.availability(),
    }))
}

#[derive(Deserialize)]
struct BackendChoice {
    #[serde(rename = "type")]
    kind: Option<String>,
}

async fn select_backend(
    State(s): State<Arc<AppState>>,
    Json(body): Json<BackendChoice>,
) -> impl IntoResponse {
    let Some(kind) = body.kind.filter(|k| config::AI_BACKENDS.contains(&k.as_str())) else {
        return unknown_backend().into_response();
    };
    let data_dir = s.config().data_dir;
    let patch = SettingsPatch { kind: Some(kind), ..Default::default() };
    match config::save_settings(&data_dir, &patch) {
        Ok(next) => {
            let selected = next.ai.kind.clone();
            *s.config.write().unwrap() = next;
            Json(json!({ "selected": selected })).into_response()
        }
        Err(e) => server_error(e).into_response(),
    }
}

fn unknown_backend() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "Unknown backend", "backends": config::AI_BACKENDS })),
    )
}

// --- Scheduled jobs (FR-CRON-*) ----------------------------------------------
async fn list_jobs(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({ "jobs": s.jobs.list() }))
}

async fn create_job(
    State(s): State<Arc<AppState>>,
    Json(patch): Json<JobPatch>,
) -> impl IntoResponse {
    match s.jobs.create(patch) {
        Ok(job) => Json(job).into_response(),
        Err(e) => server_error(e).into_response(),
    }
}

async fn update_job(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(patch): Json<JobPatch>,
) -> impl IntoResponse {
    match s.jobs.update(&id, patch) {
        Ok(Some(job)) => Json(job).into_response(),
        Ok(None) => not_found().into_response(),
        Err(e) => server_error(e).into_response(),
    }
}

async fn delete_job(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    match s.jobs.delete(&id) {
        Ok(true) => Json(json!({ "deleted": true })).into_response(),
        Ok(false) => not_found().into_response(),
        Err(e) => server_error(e).into_response(),
    }
}

async fn job_runs(State(s): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> impl IntoResponse {
    Json(json!({ "runs": s.jobs.runs_for(&id) }))
}

async fn run_job_now(
    State(s): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    match run_job(s.clone(), &id).await {
        Some(run) => Json(run).into_response(),
        None => not_found().into_response(),
    }
}

/// Execute a job: the agent runs its instruction and the output is saved as a
/// note (FR-CRON-7); only that knowledge output becomes a note (FR-CRON-8).
async fn run_job(s: Arc<AppState>, id: &str) -> Option<JobRun> {
    let job: Job = s.jobs.get(id)?;
    let started_at = now_iso();
    let cfg = s.config();
    let instruction = job.params.instruction.clone().unwrap_or_default();

    let (status, created, message) = if instruction.trim().is_empty() {
        ("error".to_string(), Vec::new(), "the task has no instruction".to_string())
    } else {
        let prompt = instruction_prompt(&instruction, &cfg.ai.output_language);
        match s.agent.complete(&cfg.ai, &cfg.data_dir, &prompt).await {
            Ok(output) => {
                let body = format!(
                    "> AI task run on {started_at}\n\n**Task:** {instruction}\n\n---\n\n{}\n",
                    output.trim()
                );
                let input = NoteInput {
                    title: Some(if job.name.trim().is_empty() {
                        first_line(&instruction)
                    } else {
                        job.name.clone()
                    }),
                    category: Some(job.params.category.clone().unwrap_or_else(|| "collected".into())),
                    body: Some(body),
                };
                match s.notes.create(&input) {
                    Ok(note) => {
                        s.search.upsert(&s.notes, &note.meta.id);
                        ("success".to_string(), vec![note.meta.id], "Produced 1 note(s)".to_string())
                    }
                    Err(e) => ("error".to_string(), Vec::new(), e.to_string()),
                }
            }
            Err(e) => ("error".to_string(), Vec::new(), e.message),
        }
    };

    let run = JobRun {
        job_id: id.to_string(),
        started_at,
        finished_at: now_iso(),
        status,
        created_notes: created,
        message,
    };
    s.logger.info(&format!("job {} finished: {}", job.name, run.message));
    let _ = s.jobs.append_run(&run);
    Some(run)
}

/// One pass a minute: run every enabled job whose schedule matches (FR-CRON-1).
async fn scheduler_loop(s: Arc<AppState>) {
    let mut last_minute = u64::MAX;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        let (minute_stamp, min, hour, day, month, weekday) = local_now();
        if minute_stamp == last_minute {
            continue;
        }
        last_minute = minute_stamp;
        for job in s.jobs.list() {
            if !job.enabled {
                continue;
            }
            let Some(cron) = Cron::parse(&job.cron) else { continue };
            if cron.matches(min, hour, day, month, weekday) {
                let state = s.clone();
                let id = job.id.clone();
                tokio::spawn(async move {
                    run_job(state, &id).await;
                });
            }
        }
    }
}

// --- Chat (FR-CHAT) ----------------------------------------------------------
#[derive(Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatRequest {
    #[serde(default)]
    messages: Vec<ChatMessage>,
}

async fn chat(State(s): State<Arc<AppState>>, Json(req): Json<ChatRequest>) -> impl IntoResponse {
    let cfg = s.config();
    let last_user = req
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();

    // If the message asks for a recurring task, analyse it *alongside* the
    // reply: in sequence the two agent runs add up and can approach the
    // timeout (FR-CHAT-9).
    let proposal_task = {
        let s = s.clone();
        let cfg = cfg.clone();
        let text = last_user.clone();
        tokio::spawn(async move {
            if text.trim().is_empty() || !proposal::mentions_cadence(&text) {
                return None;
            }
            let prompt = proposal::proposal_prompt(&text);
            match s.agent.complete(&cfg.ai, &cfg.data_dir, &prompt).await {
                Ok(raw) => proposal::parse_proposal(&raw).map(Ok),
                Err(e) => Some(Err(e.message)),
            }
        })
    };

    let prompt = chat_prompt(&req.messages, &cfg.ai.output_language);
    let reply = match s.agent.complete(&cfg.ai, &cfg.data_dir, &prompt).await {
        Ok(reply) => reply,
        Err(e) => {
            s.logger.warn(&format!("chat failed: {}", e.message));
            format!("⚠️ {}", e.message)
        }
    };

    let mut body = json!({ "reply": reply });
    match proposal_task.await.unwrap_or(None) {
        Some(Ok(p)) => {
            let patch = JobPatch {
                name: Some(p.name),
                cron: Some(p.cron),
                action: Some("collect".into()),
                params: Some(jobs::JobParams {
                    instruction: Some(p.instruction),
                    sources: Vec::new(),
                    category: Some(p.category),
                }),
                enabled: Some(true),
            };
            match s.jobs.create(patch) {
                Ok(job) => {
                    s.logger.info(&format!("registered a task from chat: {}", job.name));
                    body["scheduled"] = json!({
                        "id": job.id,
                        "name": job.name,
                        "cron": job.cron,
                        "instruction": job.params.instruction.unwrap_or_default(),
                    });
                }
                Err(e) => body["scheduleError"] = json!(e.to_string()),
            }
        }
        Some(Err(message)) => {
            s.logger.warn(&format!("could not register a task from chat: {message}"));
            body["scheduleError"] = json!(message);
        }
        None => {}
    }
    Json(body).into_response()
}

// --- Agent collection (FR-AGENT-1..4) ----------------------------------------
#[derive(Deserialize)]
struct CollectRequest {
    #[serde(default)]
    sources: Vec<String>,
    category: Option<String>,
}

/// Crawl each source, summarize it with the configured backend, and save the
/// summary as a note (FR-AGENT-1..4, FR-AGENT-6).
async fn collect(
    State(s): State<Arc<AppState>>,
    Json(req): Json<CollectRequest>,
) -> impl IntoResponse {
    let cfg = s.config();
    let category = req.category.unwrap_or_else(|| "collected".into());
    let mut created: Vec<String> = Vec::new();
    let mut errors: Vec<serde_json::Value> = Vec::new();

    for url in req.sources {
        match crawler::crawl(&url).await {
            Ok(page) => {
                let prompt = summarize_prompt(&page.title, &page.text, &cfg.ai.output_language);
                let summary = match s.agent.complete(&cfg.ai, &cfg.data_dir, &prompt).await {
                    Ok(out) => out,
                    Err(e) => {
                        errors.push(json!({ "url": url, "message": e.message }));
                        continue;
                    }
                };
                // Provenance lives in the body: notes carry no frontmatter.
                let source = &page.url;
                let body = format!(
                    "> Collected from [{source}]({source}) on {}\n\n{}\n",
                    now_iso(),
                    summary.trim()
                );
                let input = NoteInput {
                    title: Some(page.title.clone()),
                    category: Some(category.clone()),
                    body: Some(body),
                };
                match s.notes.create(&input) {
                    Ok(note) => {
                        s.search.upsert(&s.notes, &note.meta.id);
                        created.push(note.meta.id);
                    }
                    Err(e) => errors.push(json!({ "url": url, "message": e.to_string() })),
                }
            }
            Err(message) => errors.push(json!({ "url": url, "message": message })),
        }
    }
    Json(json!({ "createdNotes": created, "errors": errors }))
}

fn summarize_prompt(title: &str, text: &str, lang: &str) -> String {
    let excerpt: String = text.chars().take(12_000).collect();
    format!(
        "Summarize the following web page titled \"{title}\". Return 3-5 concise key points as a          Markdown bullet list (\"- \"), then a one-paragraph summary. Write the key points and the          summary in {}.\n\n{excerpt}",
        language_name(lang)
    )
}

#[derive(Deserialize)]
struct SaveChatRequest {
    #[serde(default)]
    messages: Vec<ChatMessage>,
    id: Option<String>,
    title: Option<String>,
}

/// Persist a conversation as a Markdown note under `chats` (FR-CHAT-4).
async fn save_chat(
    State(s): State<Arc<AppState>>,
    Json(req): Json<SaveChatRequest>,
) -> impl IntoResponse {
    if req.messages.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "No messages" }))).into_response();
    }
    let first_user = req
        .messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_else(|| "Chat".into());
    let title = req
        .title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| first_line(&first_user).chars().take(60).collect());
    let body = req
        .messages
        .iter()
        .map(|m| format!("**{}:**\n\n{}", if m.role == "user" { "You" } else { "AI" }, m.content))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    let input = NoteInput {
        title: Some(title),
        category: Some("chats".into()),
        body: Some(body),
    };
    let saved = match req.id {
        Some(id) => s.notes.update(&id, &input).map(|o| o.map(|n| n)),
        None => s.notes.create(&input).map(Some),
    };
    match saved {
        Ok(Some(note)) => {
            s.search.upsert(&s.notes, &note.meta.id);
            Json(note).into_response()
        }
        Ok(None) => not_found().into_response(),
        Err(e) => server_error(e).into_response(),
    }
}

fn language_name(code: &str) -> &str {
    match code {
        "en" => "English",
        "ja" => "Japanese",
        "zh" => "Chinese",
        "ko" => "Korean",
        "es" => "Spanish",
        "fr" => "French",
        "de" => "German",
        other => other,
    }
}

/// Where the agent may read and write (FR-FILE-6, FR-FILE-7).
const WORKSPACE_RULES: &str = "Your working directory is Mnemo's data directory. It contains:\n- \"notes/\" - the user's knowledge as Markdown files, one subfolder per category. Search and read here when the question is about the user's notes; write nothing here except Markdown notes.\n- \"scripts/\" - put any script, fetch command or other generated working file you create HERE, never under \"notes/\".\n- \"assets/\", \"jobs/\", \"logs/\" - Mnemo's own storage. Ignore them; do not read or search them.\n";

fn chat_prompt(messages: &[ChatMessage], lang: &str) -> String {
    let history = messages
        .iter()
        .map(|m| format!("{}: {}", if m.role == "user" { "User" } else { "Assistant" }, m.content))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "You are Mnemo's research assistant. Respond in {}.\n         For any question about facts, events, products or documentation, research the latest          information before answering: search broadly, prefer recent material, and cross-check          several independent sources rather than answering from memory.\n         Answer in depth with Markdown headings and lists, state the date or version of what you          report, and end with a \"Sources\" list of the pages you used. If you could not search,          say so and mark the answer unverified.\n{}\n{}\nAssistant:",
        language_name(lang),
        WORKSPACE_RULES,
        history
    )
}

fn instruction_prompt(instruction: &str, lang: &str) -> String {
    format!(
        "You are an AI agent. Perform the following task and return the result as Markdown.          Write the result in {}.\n{}         Return the result as your answer - Mnemo saves it as a note itself, so do not write the          report into \"notes/\" yourself.\n\nTask:\n{}\n",
        language_name(lang),
        WORKSPACE_RULES,
        instruction
    )
}

fn first_line(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Task");
    line.chars().take(80).collect()
}

fn now_iso() -> String {
    notes::iso_now()
}

/// Local wall-clock parts for the cron tick: (minute stamp, min, hour, day, month, weekday).
fn local_now() -> (u64, u32, u32, u32, u32, u32) {
    notes::local_clock()
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
