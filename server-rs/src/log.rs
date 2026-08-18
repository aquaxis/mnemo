//! Server log destination (FR-REL-7).
//!
//! Writing to an inherited terminal is synchronous on POSIX, so a closed or
//! stalled terminal would block the server. Logging therefore goes to a file
//! under the data directory; `MNEMO_LOG=stdout` opts back into the console.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Logger {
    file: Option<Mutex<std::fs::File>>,
    to_stdout: bool,
}

impl Logger {
    pub fn new(path: &PathBuf, to_stdout: bool) -> Self {
        if to_stdout {
            return Self { file: None, to_stdout: true };
        }
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let file = OpenOptions::new().create(true).append(true).open(path).ok();
        Self { file: file.map(Mutex::new), to_stdout: false }
    }

    pub fn log(&self, level: &str, message: &str) {
        let line = format!("{{\"level\":\"{level}\",\"msg\":{}}}\n", json_string(message));
        if self.to_stdout {
            // A dead terminal must not take the server down.
            let _ = std::io::stdout().write_all(line.as_bytes());
            return;
        }
        if let Some(file) = &self.file {
            if let Ok(mut f) = file.lock() {
                let _ = f.write_all(line.as_bytes());
            }
        }
    }

    pub fn info(&self, message: &str) {
        self.log("info", message);
    }

    pub fn warn(&self, message: &str) {
        self.log("warn", message);
    }
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}
