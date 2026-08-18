//! Scheduled jobs (FR-CRON-1..8): definitions and run history live under
//! `data/jobs/`, matching `server/src/scheduler/scheduler.ts` byte for byte so
//! either server can read them.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Newest runs kept in `runs.json`.
const MAX_RUNS: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub name: String,
    pub cron: String,
    pub action: String,
    pub params: JobParams,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobRun {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "finishedAt")]
    pub finished_at: String,
    pub status: String,
    #[serde(rename = "createdNotes")]
    pub created_notes: Vec<String>,
    pub message: String,
}

/// Fields a client may send when creating or updating a job.
#[derive(Debug, Default, Deserialize)]
pub struct JobPatch {
    pub name: Option<String>,
    pub cron: Option<String>,
    pub action: Option<String>,
    pub params: Option<JobParams>,
    pub enabled: Option<bool>,
}

pub struct JobStore {
    jobs_file: PathBuf,
    runs_file: PathBuf,
    write_lock: Mutex<()>,
}

impl JobStore {
    pub fn new(data_dir: &Path) -> io::Result<Self> {
        let dir = data_dir.join("jobs");
        fs::create_dir_all(&dir)?;
        Ok(Self {
            jobs_file: dir.join("jobs.json"),
            runs_file: dir.join("runs.json"),
            write_lock: Mutex::new(()),
        })
    }

    fn read<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
        fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn list(&self) -> Vec<Job> {
        Self::read(&self.jobs_file)
    }

    pub fn runs_for(&self, id: &str) -> Vec<JobRun> {
        Self::read::<JobRun>(&self.runs_file)
            .into_iter()
            .filter(|r| r.job_id == id)
            .collect()
    }

    fn write_jobs(&self, jobs: &[Job]) -> io::Result<()> {
        fs::write(&self.jobs_file, format!("{}\n", serde_json::to_string_pretty(jobs)?))
    }

    pub fn create(&self, patch: JobPatch) -> io::Result<Job> {
        let _guard = self.write_lock.lock().unwrap();
        let job = Job {
            id: new_id(),
            name: patch.name.unwrap_or_default(),
            cron: patch.cron.unwrap_or_else(|| "0 8 * * *".into()),
            action: patch.action.unwrap_or_else(|| "collect".into()),
            params: patch.params.unwrap_or(JobParams {
                instruction: None,
                sources: Vec::new(),
                category: None,
            }),
            enabled: patch.enabled.unwrap_or(true),
        };
        let mut jobs = self.list();
        jobs.push(job.clone());
        self.write_jobs(&jobs)?;
        Ok(job)
    }

    pub fn update(&self, id: &str, patch: JobPatch) -> io::Result<Option<Job>> {
        let _guard = self.write_lock.lock().unwrap();
        let mut jobs = self.list();
        let Some(slot) = jobs.iter_mut().find(|j| j.id == id) else { return Ok(None) };
        if let Some(v) = patch.name { slot.name = v; }
        if let Some(v) = patch.cron { slot.cron = v; }
        if let Some(v) = patch.action { slot.action = v; }
        if let Some(v) = patch.params { slot.params = v; }
        if let Some(v) = patch.enabled { slot.enabled = v; }
        let updated = slot.clone();
        self.write_jobs(&jobs)?;
        Ok(Some(updated))
    }

    pub fn delete(&self, id: &str) -> io::Result<bool> {
        let _guard = self.write_lock.lock().unwrap();
        let jobs = self.list();
        let next: Vec<Job> = jobs.iter().filter(|j| j.id != id).cloned().collect();
        if next.len() == jobs.len() {
            return Ok(false);
        }
        self.write_jobs(&next)?;
        Ok(true)
    }

    pub fn get(&self, id: &str) -> Option<Job> {
        self.list().into_iter().find(|j| j.id == id)
    }

    /// Record a run, newest first, keeping the most recent `MAX_RUNS`.
    pub fn append_run(&self, run: &JobRun) -> io::Result<()> {
        let _guard = self.write_lock.lock().unwrap();
        let mut runs: Vec<JobRun> = Self::read(&self.runs_file);
        runs.insert(0, run.clone());
        runs.truncate(MAX_RUNS);
        fs::write(&self.runs_file, format!("{}\n", serde_json::to_string_pretty(&runs)?))
    }
}

/// UUID-shaped id (v4 layout) from the system clock and process id — enough to
/// be unique here, and it keeps the crate dependency-free.
fn new_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let pid = std::process::id() as u128;
    let mut x = nanos ^ (pid << 64) ^ (nanos << 32);
    let mut hex = String::with_capacity(32);
    for _ in 0..32 {
        // xorshift over the mixed seed
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        hex.push(char::from_digit(((x >> 4) & 0xf) as u32, 16).unwrap_or('0'));
    }
    format!(
        "{}-{}-4{}-a{}-{}",
        &hex[0..8], &hex[8..12], &hex[13..16], &hex[17..20], &hex[20..32]
    )
}

/// A 5-field cron expression (minute hour day month weekday).
#[derive(Debug, Clone)]
pub struct Cron {
    minute: Vec<u32>,
    hour: Vec<u32>,
    day: Vec<u32>,
    month: Vec<u32>,
    weekday: Vec<u32>,
}

impl Cron {
    pub fn parse(expr: &str) -> Option<Self> {
        let f: Vec<&str> = expr.split_whitespace().collect();
        if f.len() != 5 {
            return None;
        }
        Some(Cron {
            minute: field(f[0], 0, 59)?,
            hour: field(f[1], 0, 23)?,
            day: field(f[2], 1, 31)?,
            month: field(f[3], 1, 12)?,
            weekday: field(f[4], 0, 6)?,
        })
    }

    /// Whether the expression fires at this local wall-clock minute.
    pub fn matches(&self, min: u32, hour: u32, day: u32, month: u32, weekday: u32) -> bool {
        self.minute.contains(&min)
            && self.hour.contains(&hour)
            && self.day.contains(&day)
            && self.month.contains(&month)
            && self.weekday.contains(&(weekday % 7))
    }
}

/// Expand one cron field: `*`, `a`, `a-b`, `*/n`, `a-b/n` and comma lists.
fn field(spec: &str, min: u32, max: u32) -> Option<Vec<u32>> {
    let mut out = Vec::new();
    for part in spec.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, s)) => (r, s.parse::<u32>().ok().filter(|n| *n > 0)?),
            None => (part, 1),
        };
        let (lo, hi) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (a.parse().ok()?, b.parse().ok()?)
        } else {
            let v: u32 = range.parse().ok()?;
            (v, v)
        };
        if lo < min || hi > max || lo > hi {
            return None;
        }
        let mut v = lo;
        while v <= hi {
            out.push(v);
            v += step;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cron_expressions() {
        assert!(Cron::parse("0 8 * * *").is_some());
        assert!(Cron::parse("*/15 * * * 1-5").is_some());
        assert!(Cron::parse("every morning").is_none(), "prose is not a schedule");
        assert!(Cron::parse("0 8 * *").is_none(), "five fields are required");
        assert!(Cron::parse("99 8 * * *").is_none(), "out of range");
    }

    #[test]
    fn matches_the_expected_minute() {
        let c = Cron::parse("0 8 * * *").unwrap();
        assert!(c.matches(0, 8, 18, 8, 1));
        assert!(!c.matches(1, 8, 18, 8, 1));
        assert!(!c.matches(0, 9, 18, 8, 1));

        let weekly = Cron::parse("0 9 * * 1").unwrap();
        assert!(weekly.matches(0, 9, 18, 8, 1), "monday");
        assert!(!weekly.matches(0, 9, 19, 8, 2), "tuesday");

        let every15 = Cron::parse("*/15 * * * *").unwrap();
        assert!(every15.matches(30, 12, 1, 1, 0));
        assert!(!every15.matches(31, 12, 1, 1, 0));
    }

    #[test]
    fn ids_look_like_uuids_and_differ() {
        let a = new_id();
        let b = new_id();
        assert_eq!(a.len(), 36);
        assert_ne!(a, b);
    }
}
