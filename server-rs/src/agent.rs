//! AI backend invocation (FR-AI-*, FR-REL-1..6).
//!
//! Every fault the TypeScript `run-cli.ts` contains is contained here too: the
//! run is bounded by a timeout, its output is capped, a missing command is
//! reported rather than thrown, and concurrent runs are limited so stuck
//! agents cannot pile up.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Semaphore;

use crate::config::AiConfig;

#[derive(Debug)]
pub struct BackendError {
    pub message: String,
}

impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl BackendError {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

pub struct Agent {
    limiter: Arc<Semaphore>,
}

impl Agent {
    pub fn new(max_concurrent: usize) -> Self {
        Self { limiter: Arc::new(Semaphore::new(max_concurrent.max(1))) }
    }

    /// Run the configured backend with `prompt` on stdin and return its stdout.
    pub async fn complete(
        &self,
        ai: &AiConfig,
        work_dir: &std::path::Path,
        prompt: &str,
    ) -> Result<String, BackendError> {
        let (command, args) = backend_command(ai);
        if command.is_empty() {
            return Err(BackendError::new(
                "No AI backend is configured (local mode has no chat). \
                 Choose a backend — agent-cli or Claude Code — on the Settings page.",
            ));
        }

        let timeout = Duration::from_millis(ai.timeout_ms);
        // Queue behind other runs; failing to get a slot in time is reported
        // rather than waited on forever (FR-REL-5).
        let permit = tokio::time::timeout(timeout, self.limiter.clone().acquire_owned())
            .await
            .map_err(|_| {
                BackendError::new("The AI agent is busy (other runs in progress). Try again shortly.")
            })?
            .map_err(|e| BackendError::new(e.to_string()))?;

        // agent-cli's `run` reads stdin line by line, so the prompt is
        // flattened to one line with a trailing newline to submit it.
        let stdin_text = if command.ends_with("agent-cli") {
            format!("{}\n", prompt.split_whitespace().collect::<Vec<_>>().join(" "))
        } else {
            prompt.to_string()
        };

        let mut child = Command::new(&command)
            .args(&args)
            .current_dir(work_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    BackendError::new(format!(
                        "AI backend command \"{command}\" was not found. \
                         Install it or correct the command on the Settings page."
                    ))
                } else {
                    BackendError::new(format!("AI backend \"{command}\" failed to start: {e}"))
                }
            })?;

        if let Some(mut stdin) = child.stdin.take() {
            // The child may exit before reading: a broken pipe is an error to
            // report, never a panic (FR-REL-2).
            let _ = stdin.write_all(stdin_text.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }

        let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => return Err(BackendError::new(format!("AI backend \"{command}\" failed: {e}"))),
            Err(_) => {
                return Err(BackendError::new(format!(
                    "AI backend \"{command}\" did not respond within {}s.",
                    ai.timeout_ms / 1000
                )))
            }
        };
        drop(permit);

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(BackendError::new(format!(
                "AI backend \"{command}\" exited with {}: {}",
                output.status,
                stderr.chars().take(500).collect::<String>()
            )));
        }

        // Cap what we keep, so a runaway CLI cannot exhaust memory (FR-REL-3).
        let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if stdout.len() > ai.max_output_bytes {
            stdout.truncate(ai.max_output_bytes);
        }
        Ok(if command.ends_with("agent-cli") { clean_agent_cli(&stdout) } else { stdout })
    }
}

fn backend_command(ai: &AiConfig) -> (String, Vec<String>) {
    let defaults: (&str, &[&str]) = match ai.kind.as_str() {
        "agent-cli" => ("agent-cli", &["run", "--auto-approve-tools"]),
        "claude-code" => ("claude", &["-p"]),
        _ => ("", &[]),
    };
    let settings = ai.backends.get(&ai.kind);
    let command = settings
        .and_then(|s| s.get("command"))
        .and_then(|c| c.as_str())
        .unwrap_or(defaults.0)
        .to_string();
    let args = settings
        .and_then(|s| s.get("args"))
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| defaults.1.iter().map(|s| s.to_string()).collect());
    (command, args)
}

/// agent-cli's REPL prints a banner and prefixes answers with "> ".
fn clean_agent_cli(raw: &str) -> String {
    raw.lines()
        .filter(|l| !l.starts_with("agent-cli ready"))
        .filter(|l| !l.starts_with("type /help for commands"))
        .filter(|l| {
            // banner lines look like "  key : value"
            !(l.starts_with("  ") && l.contains(" : "))
        })
        .map(|l| l.trim_start_matches(|c| c == '>' || c == ' '))
        .filter(|l| l.trim() != "[answer]")
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Map};

    fn ai(kind: &str, command: Option<&str>) -> AiConfig {
        let mut backends = Map::new();
        if let Some(c) = command {
            backends.insert(kind.to_string(), json!({ "command": c, "args": [] }));
        }
        AiConfig {
            kind: kind.to_string(),
            output_language: "ja".into(),
            backends,
            timeout_ms: 3_000,
            max_output_bytes: 1_000_000,
            max_concurrent_runs: 2,
        }
    }

    /// A missing command is reported, not a panic (FR-REL-2).
    #[tokio::test]
    async fn missing_command_is_reported() {
        let agent = Agent::new(2);
        let err = agent
            .complete(&ai("agent-cli", Some("mnemo-no-such-command")), std::path::Path::new("."), "hi")
            .await
            .unwrap_err();
        assert!(err.message.contains("was not found"), "{}", err.message);
    }

    /// A backend that never answers is stopped by the timeout (FR-REL-1).
    #[tokio::test]
    async fn timeout_stops_a_hanging_backend() {
        let agent = Agent::new(2);
        let mut cfg = ai("agent-cli", Some("sleep"));
        cfg.backends.insert("agent-cli".into(), json!({ "command": "sleep", "args": ["60"] }));
        cfg.timeout_ms = 500;
        let started = std::time::Instant::now();
        let err = agent.complete(&cfg, std::path::Path::new("."), "hi").await.unwrap_err();
        assert!(err.message.contains("did not respond"), "{}", err.message);
        assert!(started.elapsed() < Duration::from_secs(5), "gave up promptly");
    }

    /// The local fallback has no command to run (FR-AI-5).
    #[tokio::test]
    async fn local_backend_degrades_with_a_message() {
        let agent = Agent::new(1);
        let err = agent.complete(&ai("local", None), std::path::Path::new("."), "hi").await.unwrap_err();
        assert!(err.message.contains("No AI backend"), "{}", err.message);
    }

    #[test]
    fn strips_the_agent_cli_banner() {
        let raw = "agent-cli ready\n  id        : abc\ntype /help for commands\n> OK\n> \n";
        assert_eq!(clean_agent_cli(raw), "OK");
    }
}
