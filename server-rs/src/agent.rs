//! AI backend invocation (FR-AI-*, FR-REL-1..6).
//!
//! Every fault the TypeScript `run-cli.ts` contains is contained here too: the
//! run is bounded by a timeout, its output is capped, a missing command is
//! reported rather than thrown, and concurrent runs are limited so stuck
//! agents cannot pile up.
//!
//! agent-cli is driven as a **turn**, not by pipe-and-EOF: its REPL reads the
//! prompt from stdin line by line, and closing stdin immediately after the
//! write raced EOF against the first read — the session then ended before the
//! exchange, producing empty replies and silent children. The pipe is now kept
//! open until the turn has streamed its answer (`[answer]` marker followed by
//! a quiet window) and is closed only then. One-shot backends (Claude Code)
//! keep the original EOF semantics: their CLI finishes when stdin ends.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::Semaphore;

use crate::config::AiConfig;

/// Silence window that ends an agent-cli **turn**: after the `[answer]` marker
/// the REPL streams the reply and prints its `> ` prompt (without a newline)
/// when the turn ends, then goes quiet. Streaming silence for this long after
/// a marker followed by answer text means the turn is done and the session can
/// be closed. (Verified live: ollama streams answer chunks with sub-second
/// gaps, so 1.5 s never cuts an answer short, and it fires well inside the
/// configured overall timeout.)
const TURN_QUIET: Duration = Duration::from_millis(1500);
/// How long the REPL gets to exit after EOF is sent on its stdin.
const EXIT_GRACE: Duration = Duration::from_millis(5000);

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

/// How an agent-cli turn ended without producing a full answer.
enum ReplExit {
    /// Nothing completed within the overall timeout (FR-REL-1).
    TimedOut,
    /// The child ended its session before any turn was answered.
    EndedBeforeAnswer,
    /// Reading the REPL stream failed.
    Io(String),
}

pub struct Agent {
    limiter: Arc<Semaphore>,
}

impl Agent {
    pub fn new(max_concurrent: usize) -> Self {
        Self { limiter: Arc::new(Semaphore::new(max_concurrent.max(1))) }
    }

    /// The invocation's time budget in words (FR-REL-8): the research prompt
    /// states it so the agent adapts its depth and wraps up inside the
    /// configured `ai.timeoutMs` instead of being cut off mid-answer.
    pub fn describe_budget(&self, ai: &AiConfig) -> String {
        let seconds = ai.timeout_ms / 1000;
        if seconds < 60 {
            return format!("about {seconds} s");
        }
        // Round a partial minute up: the wording says "about", and a budget
        // like 90 s reads better as "about 2 minutes" than "1 min 30 s".
        let minutes = seconds.div_ceil(60);
        let unit = if minutes == 1 { "1 minute" } else { "minutes" };
        format!("about {minutes} {unit}")
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

        // Which contract does the configured argv speak? A first argument of
        // `run` asks for the REPL (held-open turn, 0.43-era semantics; kept
        // for stored configurations that still select it). Every agent-cli
        // shipment since 0.46 also ships `one-shot <PROMPT>` — one prompt to
        // completion, the answer alone on stdout, the process done (verified
        // live, 2026-11-06) — and that is just the generic one-shot shape, so
        // it shares the EOF path below. The configured args come from
        // `data/config.json` first (FR-INSTALL-5); the built-in default now
        // selects `one-shot` too.
        let repl_mode = args.first().map(|a| a == "run").unwrap_or(false);
        // Build the final argv: one-shot takes the prompt as its positional
        // argument; REPL mode submits it on stdin as one line.
        let (child_args, stdin_text) = if repl_mode {
            (args.clone(), format!("{}\n", prompt.split_whitespace().collect::<Vec<_>>().join(" ")))
        } else if args.first().map(|a| a == "one-shot").unwrap_or(false) {
            // `one-shot <PROMPT>`: append the prompt as the positional.
            let mut a = args.clone();
            a.push(prompt.to_string());
            (a, String::new())
        } else {
            // Any other one-shot CLI (claude -p, ...): prompt on stdin.
            (args.clone(), prompt.to_string())
        };

        let mut child = Command::new(&command)
            .args(&child_args)
            .current_dir(work_dir)
            .stdin(if repl_mode || !stdin_text.is_empty() { Stdio::piped() } else { Stdio::null() })
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

        if !repl_mode {
            // One-shot invocation: hand over the stdin payload when there is
            // one, then wait for completion. A child that dies early reports
            // as a failure, never a panic (FR-REL-2).
            if !stdin_text.is_empty() {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(stdin_text.as_bytes()).await;
                    let _ = stdin.shutdown().await;
                }
            }
            let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
                Ok(Ok(out)) => out,
                Ok(Err(e)) => {
                    drop(permit);
                    return Err(BackendError::new(format!("AI backend \"{command}\" failed: {e}")));
                }
                // The timed-out future owned `child`; dropping it with
                // `kill_on_drop(true)` set kills and reaps the child, so no
                // explicit stop is needed here (FR-REL-1).
                Err(_) => {
                    drop(permit);
                    return Err(BackendError::new(format!(
                        "AI backend \"{command}\" did not respond within {}s.",
                        ai.timeout_ms / 1000
                    )));
                }
            };
            drop(permit);
            return finish(command, ai, output);
        }

        // ---- agent-cli: REPL turn protocol (FR-REL-1; stored `run` configs) ----
        let mut stdin: Option<ChildStdin> = child.stdin.take();
        if let Some(ref mut s) = stdin {
            // The pipe is deliberately NOT closed here: EOF now races the
            // REPL's first line read and can end the session before the
            // exchange (the cause of empty replies). It is closed once the
            // turn is complete. The child may still exit early: a broken
            // pipe is an error to report, never a panic (FR-REL-2).
            let _ = s.write_all(stdin_text.as_bytes()).await;
        }

        // Drain stderr so it can never fill its pipe and block the child.
        let mut stderr_pipe = child.stderr.take();
        let stderr_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            if let Some(pipe) = stderr_pipe.as_mut() {
                let mut chunk = [0u8; 8192];
                loop {
                    match pipe.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => bytes.extend_from_slice(&chunk[..n]),
                    }
                }
            }
            bytes
        });

        let stdout_pipe = child
            .stdout
            .take()
            .ok_or_else(|| BackendError::new(format!("AI backend \"{command}\" has no stdout")))?;
        let raw = match repl_turn(stdout_pipe, timeout).await {
            Ok(raw) => raw,
            Err(ReplExit::TimedOut) => {
                return Err(BackendError::new(format!(
                    "AI backend \"{command}\" did not respond within {}s.",
                    ai.timeout_ms / 1000
                )))
            }
            Err(ReplExit::EndedBeforeAnswer) => {
                return Err(BackendError::new(format!(
                    "AI backend \"{command}\" ended without answering — end of input reached \
                     the agent before any reply. (A prompt may have been lost; try again.)"
                )))
            }
            Err(ReplExit::Io(e)) => {
                return Err(BackendError::new(format!("AI backend \"{command}\" failed: {e}")))
            }
        };

        // Turn complete: end the session and give the child a moment to exit.
        if let Some(mut s) = stdin.take() {
            let _ = s.shutdown().await;
        }
        let status = match tokio::time::timeout(EXIT_GRACE, child.wait()).await {
            Ok(Ok(status)) => Some(status),
            _ => {
                let _ = child.start_kill();
                child.wait().await.ok()
            }
        };
        let stderr = match tokio::time::timeout(Duration::from_secs(2), stderr_task).await {
            Ok(Ok(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
            _ => String::new(),
        };
        drop(permit);

        if let Some(status) = status {
            if !status.success() {
                return Err(BackendError::new(format!(
                    "AI backend \"{command}\" exited with {status}: {}",
                    stderr.chars().take(500).collect::<String>()
                )));
            }
        }

        // Cap what we keep, so a runaway CLI cannot exhaust memory (FR-REL-3).
        let mut stdout = raw;
        if stdout.len() > ai.max_output_bytes {
            stdout.truncate(ai.max_output_bytes);
        }
        Ok(clean_agent_cli(&stdout))
    }
}

/// Read one agent-cli REPL turn from `stdout`.
///
/// The session starts with a banner, then answers stream after an
/// `[answer]` marker line. The turn is considered complete when, with answer
/// text behind the marker, the stream has been silent for `TURN_QUIET` —
/// the REPL printed its trailing `> ` prompt and is idle. Silence *before*
/// any marker (model thinking, a tool running) is not turn end: only the
/// overall timeout bounds that phase.
async fn repl_turn(
    mut stdout: tokio::process::ChildStdout,
    timeout: Duration,
) -> Result<String, ReplExit> {
    const MARKER: &[u8] = b"[answer]";
    let deadline = tokio::time::Instant::now() + timeout;
    let mut buf = vec![0u8; 8192];
    let mut transcript: Vec<u8> = Vec::new();
    // Byte position where the marker begins, once seen.
    let mut marker_at: Option<usize> = None;

    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(ReplExit::TimedOut);
        }
        let remaining = deadline - now;
        let has_answer = marker_at
            .map(|i| transcript[i + MARKER.len()..].iter().any(|b| !b.is_ascii_whitespace()))
            .unwrap_or(false);
        // After a streamed answer, a short silence ends the turn; before
        // that, only the deadline bounds the wait.
        let wait = if has_answer { remaining.min(TURN_QUIET) } else { remaining };

        match tokio::time::timeout(wait, stdout.read(&mut buf)).await {
            Err(_elapsed) => {
                return if has_answer {
                    Ok(String::from_utf8_lossy(&transcript).into_owned())
                } else {
                    Err(ReplExit::TimedOut)
                };
            }
            Ok(Ok(0)) => {
                // End of the child's stdout.
                return if has_answer {
                    Ok(String::from_utf8_lossy(&transcript).into_owned())
                } else {
                    Err(ReplExit::EndedBeforeAnswer)
                };
            }
            Ok(Ok(n)) => {
                let from = transcript.len();
                transcript.extend_from_slice(&buf[..n]);
                if marker_at.is_none() {
                    marker_at = find_marker(&transcript, from, MARKER);
                }
            }
            Ok(Err(e)) => return Err(ReplExit::Io(e.to_string())),
        }
    }
}

/// First occurrence of `marker` in `data` from `start` bytes backwards-
/// overlapping onward (a marker can straddle read boundaries).
fn find_marker(data: &[u8], start: usize, marker: &[u8]) -> Option<usize> {
    if marker.is_empty() || data.len() < marker.len() {
        return None;
    }
    let from = start.saturating_sub(marker.len() - 1);
    data[from..]
        .windows(marker.len())
        .position(|w| w == marker)
        .map(|p| from + p)
}

/// Map a finished one-shot output to the result, applying status/cap rules.
fn finish(
    command: String,
    ai: &AiConfig,
    output: std::process::Output,
) -> Result<String, BackendError> {
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
    Ok(stdout)
}

fn backend_command(ai: &AiConfig) -> (String, Vec<String>) {
    let defaults: (&str, &[&str]) = match ai.kind.as_str() {
        "agent-cli" => ("agent-cli", &["one-shot", "--auto-approve-tools"]),
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
/// ANSI colour sequences are stripped first so banner detection is stable
/// across terminals that force colour through a pipe.
fn clean_agent_cli(raw: &str) -> String {
    strip_ansi(raw)
        .lines()
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

/// Remove ANSI CSI escape sequences (`ESC [ ... final-byte`).
fn strip_ansi(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for c2 in chars.by_ref() {
                // The final byte of a CSI sequence is alphabetic (m, K, …).
                if c2.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
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

    /// A one-shot backend that never answers is stopped by the timeout (FR-REL-1).
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

    #[test]
    fn strips_csi_colour_codes() {
        let raw = "\u{1b}[2m2026-11-05T14:41:20Z\u{1b}[0m \u{1b}[32mINFO\u{1b}[0m agent_cli\nplain";
        assert_eq!(strip_ansi(raw), "2026-11-05T14:41:20Z INFO agent_cli\nplain");
    }

    /// A fake agent-cli that answers like the real REPL (banner suppressed,
    /// `[answer]` then trailing `> ` prompt, then waiting for EOF) is read as
    /// a completed turn: the pipe stays open until the answer has streamed.
    #[tokio::test]
    async fn agent_cli_turn_is_collected_from_the_repl_stream() {
        let dir = std::env::temp_dir().join(format!("mnemo-agent-cli-ok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("agent-cli");
        std::fs::write(
            &script,
            "#!/bin/bash\nread -r line\nprintf '[answer]\\n'\nsleep 0.3\nprintf 'OK\\n> '\ncat > /dev/null\nexit 0\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let mut cfg = ai("agent-cli", Some(script.to_str().unwrap()));
        // A first argv element of `run` is what selects the held-open REPL
        // turn; the stock helper carries no args, so set it here.
        cfg.backends.insert(
            "agent-cli".into(),
            json!({ "command": script.to_str().unwrap(), "args": ["run"] }),
        );
        cfg.timeout_ms = 10_000;
        let agent = Agent::new(2);
        let started = std::time::Instant::now();
        let out = agent.complete(&cfg, std::path::Path::new("."), "hi").await.unwrap();
        assert_eq!(out, "OK", "the turn answer is collected");
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "the turn ends by the quiet window, not by the overall timeout"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A child that ends before answering is reported, not turned into an
    /// empty reply.
    #[tokio::test]
    async fn child_ending_before_the_answer_is_reported() {
        let dir = std::env::temp_dir().join(format!("mnemo-agent-cli-eof-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("agent-cli");
        std::fs::write(&script, "#!/bin/bash\nexit 3\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let mut cfg = ai("agent-cli", Some(script.to_str().unwrap()));
        cfg.timeout_ms = 10_000;
        let agent = Agent::new(2);
        let err = agent.complete(&cfg, std::path::Path::new("."), "hi").await.unwrap_err();
        // A one-shot CLI that dies early is reported through its exit status
        // (FR-REL-2/FR-REL-6); the REPL-specific "ended without answering"
        // wording belongs to the held-open turn path only.
        assert!(err.message.contains("exited with"), "{}", err.message);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// agent-cli's one-shot contract (0.46+, verified live 2026-11-06): the
    /// prompt travels as the trailing positional argv element and stdout
    /// carries the answer alone. The invocation returns exactly that answer.
    #[tokio::test]
    async fn one_shot_agent_cli_answers_from_the_positional_prompt() {
        let dir = std::env::temp_dir().join(format!("mnemo-oneshot-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let seen = dir.join("seen.txt");
        let script = dir.join("agent-cli");
        // The mock records its trailing argv and answers; stdin stays closed.
        std::fs::write(
            &script,
            format!(
                "#!/bin/bash\nshift  # drop the subcommand \"one-shot\"\nprintf \'%s\\n\' \"$*\" > {}\necho ONE-SHOT-ANSWER\nexit 0\n",
                seen.to_str().unwrap().replace('\\', "\\\\")
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let mut cfg = ai("agent-cli", Some(script.to_str().unwrap()));
        cfg.backends.insert(
            "agent-cli".into(),
            json!({ "command": script.to_str().unwrap(), "args": ["one-shot", "--auto-approve-tools"] }),
        );
        cfg.timeout_ms = 10_000;
        let agent = Agent::new(2);
        let out = agent
            .complete(&cfg, std::path::Path::new("."), "what is 2+2?")
            .await
            .unwrap();
        assert_eq!(out.trim(), "ONE-SHOT-ANSWER", "stdout carries the answer alone");
        // The prompt arrived as the trailing positional, after the flags.
        let got = std::fs::read_to_string(&seen).unwrap();
        assert_eq!(got.trim(), "--auto-approve-tools what is 2+2?", "{}", got);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn marker_found_across_read_boundaries() {
        let data = b"prefix[answer]tail";
        assert_eq!(find_marker(data, 0, b"[answer]"), Some(6));
        assert_eq!(find_marker(b"short", 0, b"[answer]"), None);
    }
}
