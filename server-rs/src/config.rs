//! Application configuration (`data/config.json`), mirroring `server/src/config.ts`.
//!
//! Missing keys are filled from defaults on read and user values always win, so
//! a config written by an older release keeps working (FR-INSTALL-5).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// User-selectable backends (FR-AI-1, C-8); `local` is the internal fallback.
pub const AI_BACKENDS: [&str; 2] = ["agent-cli", "claude-code"];

pub const DEFAULT_TIMEOUT_MS: u64 = 600_000;
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 2_000_000;
pub const DEFAULT_MAX_CONCURRENT_RUNS: usize = 2;

/// Curl-accessible web-search endpoint (FR-AGENT-7); the URL-encoded query is
/// appended and the request carries `Accept: application/json`.
pub const DEFAULT_SEARCH_ENDPOINT: &str = "https://s.jina.ai/?q=";
pub const DEFAULT_SEARCH_TIMEOUT_MS: u64 = 20_000;
/// Ask search endpoints for hits without page text by default (update #27):
/// Mnemo crawls the pages it selects itself, so the content would be discarded.
pub const DEFAULT_SEARCH_NO_CONTENT: bool = true;

// Per-backend settings stay as raw JSON: the UI may send keys this server does
// not model, and they must survive a round trip through the settings page.

#[derive(Debug, Clone, Serialize)]
pub struct AiConfig {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "outputLanguage")]
    pub output_language: String,
    pub backends: Map<String, Value>,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: u64,
    #[serde(rename = "maxOutputBytes")]
    pub max_output_bytes: usize,
    #[serde(rename = "maxConcurrentRuns")]
    pub max_concurrent_runs: usize,
}

/// One web-search provider (FR-AGENT-7). `api_key`, when set, is sent as
/// `Authorization: Bearer …`; it is a local secret, never committed (NFR-5).
///
/// The key held here is already **resolved** from the environment — see
/// [`resolve_api_key`] — so callers send it as-is.
///
/// `no_content` asks the endpoint for hits **without page text**
/// (`X-Respond-With: no-content`, update #27): Mnemo uses search only to find
/// sources and crawls the pages itself, so the content is otherwise fetched and
/// discarded. It is per-provider because an endpoint that does not understand
/// the header may reject the request.
#[derive(Debug, Clone)]
pub struct SearchProvider {
    pub url: String,
    pub api_key: String,
    pub no_content: bool,
}

/// Expand `$NAME` / `${NAME}` in `raw` from the environment (update #27).
///
/// The instructions write the search call as
/// `-H "Authorization: Bearer $JINA_API_KEY"`, so a configured key that *is* a
/// variable reference must be substituted rather than sent literally. An unset
/// variable expands to nothing, which leaves the provider keyless — reported as
/// the endpoint's `401` and skipped, never fatal (FR-AI-5).
///
/// Text with no `$` is returned unchanged, so an ordinary key is untouched.
fn expand_env(raw: &str) -> String {
    if !raw.contains('$') {
        return raw.to_string();
    }
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '$' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        // `${NAME}`
        let (name, next) = if chars.get(i + 1) == Some(&'{') {
            match chars[i + 2..].iter().position(|c| *c == '}') {
                Some(end) => {
                    let name: String = chars[i + 2..i + 2 + end].iter().collect();
                    (name, i + 2 + end + 1)
                }
                // Unterminated `${` — not a reference; keep it verbatim.
                None => {
                    out.push('$');
                    i += 1;
                    continue;
                }
            }
        } else {
            // `$NAME`
            let end = chars[i + 1..]
                .iter()
                .position(|c| !(c.is_ascii_alphanumeric() || *c == '_'))
                .map(|p| i + 1 + p)
                .unwrap_or(chars.len());
            (chars[i + 1..end].iter().collect::<String>(), end)
        };
        if name.is_empty() {
            // A bare `$` is a literal.
            out.push('$');
            i += 1;
            continue;
        }
        out.push_str(&std::env::var(&name).unwrap_or_default());
        i = next;
    }
    out
}

/// Resolve a provider's API key (update #27).
///
/// 1. A configured value is used, with `$NAME` / `${NAME}` expanded from the
///    environment (the form the instructions use).
/// 2. When nothing is configured, the key is taken from the environment
///    directly: `JINA_API_KEY` for a Jina endpoint — the name the instructions
///    use, so an existing shell already works — otherwise, and as the fallback
///    for any provider, `MNEMO_SEARCH_API_KEY`.
///
/// Resolution happens at load time and is never written back: `save_settings`
/// touches only `ai.*`, so the placeholder stays in `config.json` and the real
/// secret lives only in memory (NFR-5).
fn resolve_api_key(configured: &str, url: &str) -> String {
    let expanded = expand_env(configured.trim());
    if !expanded.trim().is_empty() {
        return expanded.trim().to_string();
    }
    if url.contains("jina.ai") {
        if let Ok(key) = std::env::var("JINA_API_KEY") {
            if !key.trim().is_empty() {
                return key.trim().to_string();
            }
        }
    }
    std::env::var("MNEMO_SEARCH_API_KEY").unwrap_or_default().trim().to_string()
}

/// Web-search settings (FR-AGENT-7). Search is not tied to one site (update #26):
/// `providers` is the resolved, ordered list actually queried — the singular
/// config `endpoint`/`apiKey` (kept for back-compat) followed by any `endpoints`.
/// When `providers` is empty, search is disabled.
#[derive(Debug, Clone)]
pub struct SearchConfig {
    pub timeout_ms: u64,
    pub providers: Vec<SearchProvider>,
}

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub port: u16,
    pub data_dir: PathBuf,
    pub ai: AiConfig,
    pub search: SearchConfig,
    pub log_file: PathBuf,
    pub log_to_stdout: bool,
}

fn default_backends() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(
        "agent-cli".into(),
        json!({ "command": "agent-cli", "args": ["run", "--auto-approve-tools"], "model": null }),
    );
    m.insert(
        "claude-code".into(),
        json!({ "command": "claude", "args": ["-p"], "model": null }),
    );
    m.insert("local".into(), json!({}));
    m
}

fn read_json(path: &Path) -> Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Seed `data/` from `templates/` on first run (FR-INSTALL-3).
///
/// Only when the data directory is missing or empty, and `config.json` only
/// when it does not exist — an update must never reset notes or settings
/// (FR-INSTALL-4, NFR-1b).
pub fn seed_data_dir(data_dir: &Path, templates_dir: &Path) -> io::Result<()> {
    let empty = !data_dir.exists()
        || fs::read_dir(data_dir).map(|mut d| d.next().is_none()).unwrap_or(true);
    if !empty {
        return Ok(());
    }
    fs::create_dir_all(data_dir)?;
    let template_notes = templates_dir.join("notes");
    if template_notes.is_dir() {
        copy_tree(&template_notes, &data_dir.join("notes"))?;
    }
    let example = templates_dir.join("config.example.json");
    let target = data_dir.join("config.json");
    if example.is_file() && !target.exists() {
        fs::copy(example, target)?;
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Create the runtime layout (FR-FILE-*, FR-FILE-7).
pub fn ensure_layout(data_dir: &Path) -> io::Result<()> {
    for dir in [
        "notes",
        "notes/inbox",
        "notes/wiki",
        "notes/collected",
        "assets/images",
        "assets/audio",
        "assets/video",
        "jobs",
        "logs",
        "scripts",
    ] {
        fs::create_dir_all(data_dir.join(dir))?;
    }
    Ok(())
}

/// Read `data/config.json`, filling gaps from the defaults.
pub fn load(data_dir: PathBuf) -> AppConfig {
    let file = read_json(&data_dir.join("config.json"));
    let ai = file.get("ai").and_then(|v| v.as_object()).cloned().unwrap_or_default();

    // User backends win over the shipped defaults, key by key.
    let mut backends = default_backends();
    if let Some(user) = ai.get("backends").and_then(|v| v.as_object()) {
        for (k, v) in user {
            backends.insert(k.clone(), v.clone());
        }
    }

    let env_port = std::env::var("MNEMO_PORT").ok().and_then(|p| p.parse::<u16>().ok());
    let port = env_port
        .or_else(|| file.get("port").and_then(|v| v.as_u64()).map(|p| p as u16))
        .unwrap_or(3000);

    let positive = |v: Option<&Value>, default: u64| -> u64 {
        v.and_then(|v| v.as_u64()).filter(|n| *n > 0).unwrap_or(default)
    };

    let log_to_stdout = std::env::var("MNEMO_LOG").ok().as_deref() == Some("stdout")
        || file.get("logTarget").and_then(|v| v.as_str()) == Some("stdout");

    // Web search (FR-AGENT-7). An explicit "" endpoint is kept (disables search);
    // a missing key falls back to the default.
    let search_obj = file.get("search").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let endpoint = search_obj
        .get("endpoint")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_SEARCH_ENDPOINT.to_string());
    let api_key = search_obj.get("apiKey").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // `X-Respond-With: no-content` is on unless turned off (update #27); an
    // `endpoints` entry may override it for that provider alone.
    let no_content = search_obj
        .get("noContent")
        .and_then(|v| v.as_bool())
        .unwrap_or(DEFAULT_SEARCH_NO_CONTENT);

    // Resolve the ordered provider list (update #26): the singular endpoint
    // first (when non-empty), then any `endpoints` entries. An entry may be a
    // bare URL string or `{ "url", "apiKey" }`; blank URLs are dropped.
    // Keys are resolved from the environment here (update #27), so every
    // consumer of `providers` gets a ready-to-send value.
    let mut providers = Vec::new();
    if !endpoint.trim().is_empty() {
        let api_key = resolve_api_key(&api_key, &endpoint);
        providers.push(SearchProvider { url: endpoint.clone(), api_key, no_content });
    }
    if let Some(list) = search_obj.get("endpoints").and_then(|v| v.as_array()) {
        for entry in list {
            let (url, key, entry_no_content) = match entry {
                Value::String(s) => (s.clone(), String::new(), no_content),
                Value::Object(o) => (
                    o.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    o.get("apiKey").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    // Falls back to the block-level setting when the entry is silent.
                    o.get("noContent").and_then(|v| v.as_bool()).unwrap_or(no_content),
                ),
                _ => continue,
            };
            if !url.trim().is_empty() {
                let api_key = resolve_api_key(&key, &url);
                providers.push(SearchProvider { url, api_key, no_content: entry_no_content });
            }
        }
    }

    let search = SearchConfig {
        timeout_ms: positive(search_obj.get("timeoutMs"), DEFAULT_SEARCH_TIMEOUT_MS),
        providers,
    };

    AppConfig {
        port,
        search,
        ai: AiConfig {
            kind: ai.get("type").and_then(|v| v.as_str()).unwrap_or("agent-cli").to_string(),
            output_language: ai
                .get("outputLanguage")
                .and_then(|v| v.as_str())
                .unwrap_or("ja")
                .to_string(),
            backends,
            timeout_ms: positive(ai.get("timeoutMs"), DEFAULT_TIMEOUT_MS),
            max_output_bytes: positive(ai.get("maxOutputBytes"), DEFAULT_MAX_OUTPUT_BYTES as u64)
                as usize,
            max_concurrent_runs: positive(
                ai.get("maxConcurrentRuns"),
                DEFAULT_MAX_CONCURRENT_RUNS as u64,
            ) as usize,
        },
        log_file: file
            .get("logFile")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("logs/mnemo.log")),
        log_to_stdout,
        data_dir,
    }
}

/// Settings patch from the UI (FR-SETTINGS-2/3).
#[derive(Debug, Default, Deserialize)]
pub struct SettingsPatch {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    #[serde(rename = "outputLanguage")]
    pub output_language: Option<String>,
    pub backends: Option<Map<String, Value>>,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
}

/// Persist an AI settings patch and return the reloaded configuration.
/// Only the keys the patch carries are touched; the rest of `config.json`
/// (including keys this server does not know) is preserved.
pub fn save_settings(data_dir: &Path, patch: &SettingsPatch) -> io::Result<AppConfig> {
    let path = data_dir.join("config.json");
    let mut current = read_json(&path);
    let mut ai = current.get("ai").and_then(|v| v.as_object()).cloned().unwrap_or_default();

    if let Some(kind) = &patch.kind {
        ai.insert("type".into(), json!(kind));
    }
    if let Some(lang) = &patch.output_language {
        ai.insert("outputLanguage".into(), json!(lang));
    }
    if let Some(ms) = patch.timeout_ms.filter(|n| *n > 0) {
        ai.insert("timeoutMs".into(), json!(ms));
    }
    if let Some(patch_backends) = &patch.backends {
        let mut backends = ai.get("backends").and_then(|v| v.as_object()).cloned().unwrap_or_default();
        for (k, v) in patch_backends {
            backends.insert(k.clone(), v.clone());
        }
        ai.insert("backends".into(), Value::Object(backends));
    }

    current.insert("ai".into(), Value::Object(ai));
    fs::write(&path, format!("{:#}\n", Value::Object(current)))?;
    Ok(load(data_dir.to_path_buf()))
}

/// Whether a backend's command is present on PATH (FR-REL-6).
pub fn backend_available(config: &AiConfig, backend: &str) -> bool {
    if backend == "local" {
        return true;
    }
    let default = match backend {
        "agent-cli" => "agent-cli",
        "claude-code" => "claude",
        _ => "",
    };
    let command = config
        .backends
        .get(backend)
        .and_then(|b| b.get("command"))
        .and_then(|c| c.as_str())
        .unwrap_or(default);
    command_exists(command)
}

pub fn command_exists(command: &str) -> bool {
    if command.is_empty() {
        return false;
    }
    let candidate = Path::new(command);
    if candidate.is_absolute() {
        return candidate.is_file();
    }
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|p| !p.is_empty())
        .any(|dir| Path::new(dir).join(command).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Environment variables are process-wide, but `cargo test` runs tests in
    /// parallel threads of one process — so any test whose result depends on
    /// the search-key variables must hold this lock, and start from a known
    /// (cleared) environment. Without it a test that exports `JINA_API_KEY`
    /// makes an unrelated test see a key it never set.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        // A panic in one test must not poison the lock for the rest.
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("JINA_API_KEY");
        std::env::remove_var("MNEMO_SEARCH_API_KEY");
        guard
    }

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "mnemo-cfg-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// A fresh install seeds data/ from templates/ (FR-INSTALL-3).
    #[test]
    fn seeds_a_fresh_data_dir() {
        let root = tmp("seed");
        let templates = root.join("templates");
        fs::create_dir_all(templates.join("notes/inbox")).unwrap();
        fs::write(templates.join("notes/inbox/welcome.md"), "hi").unwrap();
        fs::write(templates.join("config.example.json"), "{\"port\":3000}").unwrap();

        let data = root.join("data");
        seed_data_dir(&data, &templates).unwrap();
        assert!(data.join("notes/inbox/welcome.md").is_file());
        assert!(data.join("config.json").is_file());
        fs::remove_dir_all(root).ok();
    }

    /// An update must never reset notes or settings (FR-INSTALL-4, NFR-1b).
    #[test]
    fn never_overwrites_existing_data() {
        let root = tmp("keep");
        let templates = root.join("templates");
        fs::create_dir_all(templates.join("notes/inbox")).unwrap();
        fs::write(templates.join("notes/inbox/welcome.md"), "template").unwrap();
        fs::write(templates.join("config.example.json"), "{\"port\":3000}").unwrap();

        let data = root.join("data");
        fs::create_dir_all(data.join("notes/inbox")).unwrap();
        fs::write(data.join("notes/inbox/mine.md"), "keep me").unwrap();
        fs::write(data.join("config.json"), "{\"port\":4321}").unwrap();

        seed_data_dir(&data, &templates).unwrap();
        assert_eq!(fs::read_to_string(data.join("notes/inbox/mine.md")).unwrap(), "keep me");
        assert_eq!(fs::read_to_string(data.join("config.json")).unwrap(), "{\"port\":4321}");
        assert!(!data.join("notes/inbox/welcome.md").exists(), "templates are not re-applied");
        fs::remove_dir_all(root).ok();
    }

    /// Keys added by a later release are filled from defaults while user values
    /// win (FR-INSTALL-5).
    #[test]
    fn fills_missing_keys_from_defaults() {
        let root = tmp("merge");
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(
            data.join("config.json"),
            r#"{"port":4321,"ai":{"type":"claude-code","backends":{"agent-cli":{"model":"mine"}}}}"#,
        )
        .unwrap();

        std::env::remove_var("MNEMO_PORT");
        let cfg = load(data.clone());
        assert_eq!(cfg.port, 4321, "user port preserved");
        assert_eq!(cfg.ai.kind, "claude-code", "user backend preserved");
        assert_eq!(cfg.ai.output_language, "ja", "missing key from defaults");
        assert_eq!(cfg.ai.timeout_ms, DEFAULT_TIMEOUT_MS);
        assert_eq!(cfg.ai.max_concurrent_runs, DEFAULT_MAX_CONCURRENT_RUNS);
        assert_eq!(
            cfg.ai.backends["agent-cli"]["model"].as_str(),
            Some("mine"),
            "user backend setting wins"
        );
        assert!(cfg.ai.backends.contains_key("claude-code"), "missing backend from defaults");
        fs::remove_dir_all(root).ok();
    }

    /// Web search: a missing `search` block gets defaults; an explicit empty
    /// endpoint is kept (disables search); a user `timeoutMs` wins (FR-AGENT-7).
    #[test]
    fn search_config_defaults_and_overrides() {
        let _env = env_guard();
        std::env::remove_var("MNEMO_PORT");

        let root = tmp("search-default");
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("config.json"), r#"{"port":3000}"#).unwrap();
        let cfg = load(data.clone());
        assert_eq!(cfg.search.timeout_ms, DEFAULT_SEARCH_TIMEOUT_MS);
        assert_eq!(cfg.search.providers.len(), 1, "the default endpoint is one provider");
        assert_eq!(cfg.search.providers[0].url, DEFAULT_SEARCH_ENDPOINT);
        assert_eq!(cfg.search.providers[0].api_key, "", "no key by default");
        fs::remove_dir_all(&root).ok();

        let root = tmp("search-disabled");
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(
            data.join("config.json"),
            r#"{"search":{"endpoint":"","timeoutMs":5000}}"#,
        )
        .unwrap();
        let cfg = load(data.clone());
        assert_eq!(cfg.search.timeout_ms, 5000, "user timeout wins");
        assert!(cfg.search.providers.is_empty(), "no endpoint and no endpoints → search disabled");
        fs::remove_dir_all(&root).ok();
    }

    /// Multiple search sites: the singular endpoint plus `endpoints` entries
    /// (object and bare-string forms) resolve to an ordered provider list, blanks
    /// dropped (FR-AGENT-7, update #26).
    #[test]
    fn search_endpoints_resolve_to_a_provider_list() {
        let _env = env_guard();
        std::env::remove_var("MNEMO_PORT");
        let root = tmp("search-multi");
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(
            data.join("config.json"),
            r#"{"search":{"endpoint":"https://a.test/?q=","apiKey":"ka","endpoints":[
                {"url":"https://b.test/?q=","apiKey":"kb"},
                "https://c.test/?q=",
                {"url":""}
            ]}}"#,
        )
        .unwrap();
        let cfg = load(data.clone());
        let urls: Vec<&str> = cfg.search.providers.iter().map(|p| p.url.as_str()).collect();
        assert_eq!(urls, ["https://a.test/?q=", "https://b.test/?q=", "https://c.test/?q="]);
        assert_eq!(cfg.search.providers[0].api_key, "ka", "primary key");
        assert_eq!(cfg.search.providers[1].api_key, "kb", "object entry key");
        assert_eq!(cfg.search.providers[2].api_key, "", "bare-string entry has no key");
        fs::remove_dir_all(&root).ok();
    }

    /// The search key is resolved from the environment (update #27): a
    /// `$JINA_API_KEY` placeholder is substituted, an empty key falls back to
    /// the environment, and a literal configured key still wins.
    #[test]
    fn search_api_key_resolves_from_the_environment() {
        let _env = env_guard();
        std::env::remove_var("MNEMO_PORT");
        std::env::set_var("JINA_API_KEY", "jina-secret");
        std::env::set_var("MNEMO_SEARCH_API_KEY", "generic-secret");

        let write = |name: &str, json: &str| {
            let root = tmp(name);
            let data = root.join("data");
            fs::create_dir_all(&data).unwrap();
            fs::write(data.join("config.json"), json).unwrap();
            (root, data)
        };

        // 1. `$JINA_API_KEY` is replaced by the variable's value, not sent literally.
        let (root, data) = write("key-placeholder", r#"{"search":{"apiKey":"$JINA_API_KEY"}}"#);
        assert_eq!(load(data).search.providers[0].api_key, "jina-secret");
        fs::remove_dir_all(&root).ok();

        // `${NAME}` is accepted too, and expands inside surrounding text.
        let (root, data) = write("key-braced", r#"{"search":{"apiKey":"pre-${JINA_API_KEY}"}}"#);
        assert_eq!(load(data).search.providers[0].api_key, "pre-jina-secret");
        fs::remove_dir_all(&root).ok();

        // 2. An empty key falls back to the environment: JINA_API_KEY for a
        //    Jina endpoint, MNEMO_SEARCH_API_KEY for anything else.
        let (root, data) = write("key-empty-jina", r#"{"search":{"apiKey":""}}"#);
        assert_eq!(load(data).search.providers[0].api_key, "jina-secret");
        fs::remove_dir_all(&root).ok();

        let (root, data) = write("key-empty-other", r#"{"search":{"endpoint":"https://other.test/?q="}}"#);
        assert_eq!(load(data).search.providers[0].api_key, "generic-secret");
        fs::remove_dir_all(&root).ok();

        // 3. A literal configured key wins over the environment — a stale
        //    exported variable must not override what the user set.
        let (root, data) = write("key-literal", r#"{"search":{"apiKey":"typed-by-hand"}}"#);
        assert_eq!(load(data).search.providers[0].api_key, "typed-by-hand");
        fs::remove_dir_all(&root).ok();

        // 4. An unset variable leaves the provider keyless rather than sending
        //    the placeholder text (the endpoint then 401s and is skipped).
        std::env::remove_var("JINA_API_KEY");
        std::env::remove_var("MNEMO_SEARCH_API_KEY");
        let (root, data) = write("key-unset", r#"{"search":{"apiKey":"$JINA_API_KEY"}}"#);
        assert_eq!(load(data).search.providers[0].api_key, "");
        fs::remove_dir_all(&root).ok();

        // Per-provider entries resolve the same way.
        std::env::set_var("JINA_API_KEY", "jina-secret");
        let (root, data) = write(
            "key-entries",
            r#"{"search":{"endpoint":"","endpoints":[{"url":"https://s.jina.ai/?q=","apiKey":"$JINA_API_KEY"}]}}"#,
        );
        assert_eq!(load(data).search.providers[0].api_key, "jina-secret");
        fs::remove_dir_all(&root).ok();
        std::env::remove_var("JINA_API_KEY");
    }

    /// `X-Respond-With: no-content` is on by default, can be turned off for the
    /// whole block, and an `endpoints` entry may override either way (update #27).
    #[test]
    fn search_no_content_defaults_and_per_provider_override() {
        let _env = env_guard();
        std::env::remove_var("MNEMO_PORT");

        let write = |name: &str, json: &str| {
            let root = tmp(name);
            let data = root.join("data");
            fs::create_dir_all(&data).unwrap();
            fs::write(data.join("config.json"), json).unwrap();
            (root, data)
        };

        // Default: on, including for an installation whose config predates the key.
        let (root, data) = write("nc-default", r#"{"port":3000}"#);
        assert!(load(data).search.providers[0].no_content, "on by default");
        fs::remove_dir_all(&root).ok();

        // Turned off block-wide; a bare-string entry inherits that.
        let (root, data) = write(
            "nc-off",
            r#"{"search":{"noContent":false,"endpoints":["https://b.test/?q="]}}"#,
        );
        let cfg = load(data);
        assert!(!cfg.search.providers[0].no_content, "block-level off");
        assert!(!cfg.search.providers[1].no_content, "bare-string entry inherits the block");
        fs::remove_dir_all(&root).ok();

        // An entry overrides the block in either direction.
        let (root, data) = write(
            "nc-entry",
            r#"{"search":{"noContent":false,"endpoints":[
                {"url":"https://b.test/?q=","noContent":true},
                {"url":"https://c.test/?q="}
            ]}}"#,
        );
        let cfg = load(data);
        assert!(!cfg.search.providers[0].no_content, "primary follows the block");
        assert!(cfg.search.providers[1].no_content, "entry opts back in");
        assert!(!cfg.search.providers[2].no_content, "silent entry inherits the block");
        fs::remove_dir_all(&root).ok();
    }

    /// Resolving a key must not write it back — the placeholder stays in
    /// `config.json`, so the real secret never lands on disk (NFR-5).
    #[test]
    fn resolved_search_key_is_not_persisted() {
        let _env = env_guard();
        std::env::remove_var("MNEMO_PORT");
        std::env::set_var("JINA_API_KEY", "must-not-be-written");
        let root = tmp("key-not-persisted");
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("config.json"), r#"{"search":{"apiKey":"$JINA_API_KEY"}}"#).unwrap();

        let patch = SettingsPatch { output_language: Some("en".into()), ..Default::default() };
        let cfg = save_settings(&data, &patch).unwrap();
        assert_eq!(cfg.search.providers[0].api_key, "must-not-be-written", "resolved in memory");

        let on_disk = fs::read_to_string(data.join("config.json")).unwrap();
        assert!(on_disk.contains("$JINA_API_KEY"), "placeholder kept");
        assert!(!on_disk.contains("must-not-be-written"), "secret must not reach the file");
        fs::remove_dir_all(&root).ok();
        std::env::remove_var("JINA_API_KEY");
    }

    /// Saving settings must not drop keys this server does not model.
    #[test]
    fn save_settings_preserves_unknown_keys() {
        let root = tmp("save");
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("config.json"), r#"{"port":4321,"custom":{"keep":true}}"#).unwrap();

        let patch = SettingsPatch {
            output_language: Some("en".into()),
            ..Default::default()
        };
        save_settings(&data, &patch).unwrap();
        let raw: Value = serde_json::from_str(&fs::read_to_string(data.join("config.json")).unwrap()).unwrap();
        assert_eq!(raw["port"], 4321, "unrelated keys survive");
        assert_eq!(raw["custom"]["keep"], true);
        assert_eq!(raw["ai"]["outputLanguage"], "en");
        fs::remove_dir_all(root).ok();
    }
}
