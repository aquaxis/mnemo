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

pub const DEFAULT_TIMEOUT_MS: u64 = 300_000;
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 2_000_000;
pub const DEFAULT_MAX_CONCURRENT_RUNS: usize = 2;

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

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub port: u16,
    pub data_dir: PathBuf,
    pub ai: AiConfig,
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

    AppConfig {
        port,
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
