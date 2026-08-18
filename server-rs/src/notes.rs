//! Note storage: the filesystem *is* the metadata (FR-NOTE-5, FR-NOTE-7,
//! FR-NOTE-8). A note is plain Markdown at `notes/<category>/<name>.md`; its
//! name is the title, its folder the category and its mtime the recency.
//!
//! This mirrors `server/src/storage/notes.ts` so both servers can run against
//! the same data directory during the migration.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// How long the category list is reused before the tree is walked again.
/// `get()` needs it on every lookup; re-walking each time made loading N notes
/// cost N tree walks (the O(n^2) fixed in the Node server).
const CATEGORY_TTL: Duration = Duration::from_secs(2);

/// Longest file name we create, in characters.
const MAX_NAME_CHARS: usize = 80;

#[derive(Debug, Clone, Serialize)]
pub struct NoteMeta {
    /// File basename without `.md`; also the displayed title.
    pub id: String,
    pub title: String,
    pub category: String,
    pub created: String,
    pub updated: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Note {
    #[serde(flatten)]
    pub meta: NoteMeta,
    pub body: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct NoteInput {
    pub title: Option<String>,
    pub category: Option<String>,
    pub body: Option<String>,
}

pub struct NoteStore {
    notes_dir: PathBuf,
    categories: Mutex<Option<(SystemTime, Vec<String>)>>,
}

impl NoteStore {
    pub fn new(data_dir: &Path) -> io::Result<Self> {
        let notes_dir = data_dir.join("notes");
        fs::create_dir_all(&notes_dir)?;
        Ok(Self { notes_dir, categories: Mutex::new(None) })
    }

    fn category_dir(&self, category: &str) -> PathBuf {
        let safe = sanitize_category(category);
        let safe = if safe.is_empty() { "inbox".to_string() } else { safe };
        let mut p = self.notes_dir.clone();
        for seg in safe.split('/') {
            p.push(seg);
        }
        p
    }

    fn file_path(&self, category: &str, id: &str) -> PathBuf {
        self.category_dir(category).join(format!("{id}.md"))
    }

    /// All category folders as relative paths, nested included (FR-FILE-5).
    pub fn list_categories(&self) -> Vec<String> {
        fn walk(dir: &Path, rel: &str, out: &mut Vec<String>) {
            let Ok(entries) = fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                // The directory entry already carries the type, so a folder of
                // N notes costs one read_dir instead of N stat calls.
                if !matches!(entry.file_type(), Ok(t) if t.is_dir()) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                out.push(path.clone());
                walk(&entry.path(), &path, out);
            }
        }
        let mut out = Vec::new();
        walk(&self.notes_dir, "", &mut out);
        out.sort();
        out
    }

    /// Cached category list (see `CATEGORY_TTL`).
    fn categories(&self) -> Vec<String> {
        let mut guard = self.categories.lock().unwrap();
        if let Some((at, list)) = guard.as_ref() {
            if at.elapsed().unwrap_or(CATEGORY_TTL) < CATEGORY_TTL {
                return list.clone();
            }
        }
        let list = self.list_categories();
        *guard = Some((SystemTime::now(), list.clone()));
        list
    }

    fn invalidate(&self) {
        *self.categories.lock().unwrap() = None;
    }

    pub fn create_category(&self, category: &str) -> io::Result<()> {
        fs::create_dir_all(self.category_dir(category))?;
        self.invalidate();
        Ok(())
    }

    /// Note metadata, newest-modified first (FR-NOTE-8, FR-UI-9).
    pub fn list(&self, category: Option<&str>) -> Vec<NoteMeta> {
        let categories = match category {
            Some(c) => vec![c.to_string()],
            None => self.categories(),
        };
        let mut notes = Vec::new();
        for cat in categories {
            let dir = self.category_dir(&cat);
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.ends_with(".md") || !matches!(entry.file_type(), Ok(t) if t.is_file()) {
                    continue;
                }
                if let Some(meta) = read_meta(&entry.path(), &cat) {
                    notes.push(meta);
                }
            }
        }
        // Newest first; ties break by name so the list is deterministic —
        // bulk-copied notes often share an mtime to the millisecond.
        notes.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));
        notes
    }

    /// Locate a note by id (its file name) across all categories.
    pub fn get(&self, id: &str) -> Option<Note> {
        for cat in self.categories() {
            let path = self.file_path(&cat, id);
            if path.is_file() {
                return read_note(&path, &cat);
            }
        }
        None
    }

    pub fn create(&self, input: &NoteInput) -> io::Result<Note> {
        let category = {
            let c = sanitize_category(input.category.as_deref().unwrap_or("inbox"));
            if c.is_empty() { "inbox".to_string() } else { c }
        };
        self.create_category(&category)?;
        let id = self.unique_name(&category, &file_name_for(input.title.as_deref()), None);
        self.write_body(&category, &id, input.body.as_deref().unwrap_or(""))?;
        Ok(read_note(&self.file_path(&category, &id), &category).expect("just written"))
    }

    pub fn update(&self, id: &str, input: &NoteInput) -> io::Result<Option<Note>> {
        let Some(existing) = self.get(id) else { return Ok(None) };

        let next_category = match input.category.as_deref() {
            Some(c) => {
                let s = sanitize_category(c);
                if s.is_empty() { "inbox".to_string() } else { s }
            }
            None => existing.meta.category.clone(),
        };
        // Renaming the note renames the file, so id, name and title stay one
        // and the same thing (FR-NOTE-7).
        let desired = match input.title.as_deref() {
            Some(t) => file_name_for(Some(t)),
            None => existing.meta.id.clone(),
        };

        let mut next_id = existing.meta.id.clone();
        if desired != existing.meta.id || next_category != existing.meta.category {
            self.create_category(&next_category)?;
            let allow = if desired == existing.meta.id { Some(existing.meta.id.as_str()) } else { None };
            next_id = self.unique_name(&next_category, &desired, allow);
            let old = self.file_path(&existing.meta.category, &existing.meta.id);
            if old.is_file() {
                fs::rename(&old, self.file_path(&next_category, &next_id))?;
            }
            self.invalidate();
        }

        match input.body.as_deref() {
            Some(body) => self.write_body(&next_category, &next_id, body)?,
            None => {
                if !self.file_path(&next_category, &next_id).is_file() {
                    self.write_body(&next_category, &next_id, &existing.body)?;
                }
            }
        }
        Ok(read_note(&self.file_path(&next_category, &next_id), &next_category))
    }

    pub fn delete(&self, id: &str) -> io::Result<bool> {
        let Some(existing) = self.get(id) else { return Ok(false) };
        let path = self.file_path(&existing.meta.category, &existing.meta.id);
        if path.is_file() {
            fs::remove_file(path)?;
        }
        Ok(true)
    }

    /// Write the note as plain Markdown - never a frontmatter block (FR-NOTE-5).
    fn write_body(&self, category: &str, id: &str, body: &str) -> io::Result<()> {
        fs::create_dir_all(self.category_dir(category))?;
        let text = strip_frontmatter(body).trim();
        let out = if text.is_empty() { String::new() } else { format!("{text}\n") };
        fs::write(self.file_path(category, id), out)
    }

    /// `name`, or `name-2`, `name-3`, ... when the file already exists.
    fn unique_name(&self, category: &str, name: &str, allow: Option<&str>) -> String {
        let mut candidate = name.to_string();
        let mut n = 2;
        while Some(candidate.as_str()) != allow && self.file_path(category, &candidate).exists() {
            candidate = format!("{name}-{n}");
            n += 1;
        }
        candidate
    }
}

fn iso(t: SystemTime) -> String {
    // ISO-8601 in UTC with milliseconds, matching the Node server's output.
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (d.as_secs() as i64, d.subsec_millis());
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (h, mi, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    let (y, mo, da) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{da:02}T{h:02}:{mi:02}:{s:02}.{ms:03}Z")
}

/// Howard Hinnant's days->civil algorithm (no chrono dependency).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn read_meta(path: &Path, category: &str) -> Option<NoteMeta> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let created = meta.created().unwrap_or(modified);
    let id = path.file_stem()?.to_string_lossy().to_string();
    Some(NoteMeta {
        title: id.clone(),
        id,
        category: category.to_string(),
        created: iso(created),
        updated: iso(modified),
    })
}

fn read_note(path: &Path, category: &str) -> Option<Note> {
    let meta = read_meta(path, category)?;
    let raw = fs::read_to_string(path).ok()?;
    // A note written before the frontmatter-free model may still start with a
    // YAML block: hide it rather than showing it as content (FR-NOTE-9).
    Some(Note { meta, body: strip_frontmatter(&raw).trim().to_string() })
}

/// Drop a leading `---\n ... \n---\n` block, if present (FR-NOTE-9).
fn strip_frontmatter(s: &str) -> &str {
    let rest = match s.strip_prefix("---\n") {
        Some(r) => r,
        None => match s.strip_prefix("---\r\n") {
            Some(r) => r,
            None => return s,
        },
    };
    for marker in ["\n---\n", "\r\n---\r\n"] {
        if let Some(i) = rest.find(marker) {
            return &rest[i + marker.len()..];
        }
    }
    s
}

fn sanitize_segment(value: &str) -> String {
    let mapped: String = value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' })
        .collect();
    mapped.trim_matches('-').to_string()
}

/// Sanitize a (possibly nested) category path, keeping the `/` separators so
/// `wiki/subtopic` maps to nested folders under `notes/` (FR-FILE-5).
fn sanitize_category(category: &str) -> String {
    category
        .split('/')
        .map(sanitize_segment)
        .filter(|s| !s.is_empty() && s != "." && s != "..")
        .collect::<Vec<_>>()
        .join("/")
}

/// Turn a title into the note's file name (FR-NOTE-7). Non-ASCII titles are
/// kept as-is; only what a path cannot hold is replaced.
pub fn file_name_for(title: Option<&str>) -> String {
    let replaced: String = title
        .unwrap_or("")
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches('.').trim();
    let capped: String = trimmed.chars().take(MAX_NAME_CHARS).collect();
    let capped = capped.trim().to_string();
    if capped.is_empty() { "Untitled".to_string() } else { capped }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "mnemo-rs-{tag}-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Notes are plain Markdown; no YAML block is ever written (FR-NOTE-5).
    #[test]
    fn writes_plain_markdown() {
        let dir = tmp_dir("plain");
        let store = NoteStore::new(&dir).unwrap();
        let note = store
            .create(&NoteInput {
                title: Some("Release notes".into()),
                category: Some("wiki".into()),
                body: Some("# Hi\n\nbody".into()),
            })
            .unwrap();
        let raw = fs::read_to_string(dir.join("notes/wiki").join(format!("{}.md", note.meta.id))).unwrap();
        assert_eq!(raw, "# Hi\n\nbody\n");
        assert!(!raw.starts_with("---"));
        fs::remove_dir_all(dir).ok();
    }

    /// The file is named after the title, and the title is the file name
    /// (FR-NOTE-7): non-ASCII survives, path characters do not, and a repeated
    /// name gets a suffix instead of overwriting.
    #[test]
    fn names_files_after_titles() {
        assert_eq!(file_name_for(Some("Weekly Rust releases")), "Weekly Rust releases");
        assert_eq!(file_name_for(Some("毎朝のAIニュース/要約")), "毎朝のAIニュース 要約");
        assert_eq!(file_name_for(Some("   ")), "Untitled");
        assert_eq!(file_name_for(None), "Untitled");
        assert_eq!(file_name_for(Some("Rust 1.93 released")), "Rust 1.93 released");
        assert!(file_name_for(Some(&"x".repeat(200))).chars().count() <= MAX_NAME_CHARS);

        let dir = tmp_dir("names");
        let store = NoteStore::new(&dir).unwrap();
        let a = store.create(&NoteInput { title: Some("dup".into()), category: Some("inbox".into()), body: None }).unwrap();
        let b = store.create(&NoteInput { title: Some("dup".into()), category: Some("inbox".into()), body: None }).unwrap();
        assert_eq!(a.meta.id, "dup");
        assert_eq!(b.meta.id, "dup-2");
        fs::remove_dir_all(dir).ok();
    }

    /// Renaming a note renames its file and keeps the body (FR-NOTE-7).
    #[test]
    fn rename_moves_the_file() {
        let dir = tmp_dir("rename");
        let store = NoteStore::new(&dir).unwrap();
        store
            .create(&NoteInput { title: Some("Draft".into()), category: Some("inbox".into()), body: Some("keep me".into()) })
            .unwrap();
        let renamed = store
            .update("Draft", &NoteInput { title: Some("Final report".into()), ..Default::default() })
            .unwrap()
            .unwrap();
        assert_eq!(renamed.meta.id, "Final report");
        assert_eq!(renamed.body, "keep me");
        assert!(store.get("Draft").is_none());
        fs::remove_dir_all(dir).ok();
    }

    /// A note from an earlier release still opens, with its YAML block hidden
    /// and its file untouched until the user saves (FR-NOTE-9).
    #[test]
    fn legacy_frontmatter_is_hidden_not_destroyed() {
        let dir = tmp_dir("legacy");
        let store = NoteStore::new(&dir).unwrap();
        fs::create_dir_all(dir.join("notes/collected")).unwrap();
        let path = dir.join("notes/collected/old-note.md");
        let original = "---\nid: 1234\ntitle: Old note\n---\n\nThe body survives.\n";
        fs::write(&path, original).unwrap();

        let read = store.get("old-note").unwrap();
        assert_eq!(read.meta.title, "old-note");
        assert_eq!(read.body, "The body survives.");
        assert_eq!(fs::read_to_string(&path).unwrap(), original, "untouched until saved");

        store.update("old-note", &NoteInput { body: Some(read.body.clone()), ..Default::default() }).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "The body survives.\n");
        fs::remove_dir_all(dir).ok();
    }

    /// Nested categories map to nested folders (FR-FILE-5).
    #[test]
    fn nested_categories() {
        let dir = tmp_dir("nested");
        let store = NoteStore::new(&dir).unwrap();
        let note = store
            .create(&NoteInput { title: Some("Sub".into()), category: Some("wiki/subtopic".into()), body: None })
            .unwrap();
        assert_eq!(note.meta.category, "wiki/subtopic");
        assert!(dir.join("notes/wiki/subtopic/Sub.md").is_file());
        assert!(store.list_categories().contains(&"wiki/subtopic".to_string()));
        fs::remove_dir_all(dir).ok();
    }
}
