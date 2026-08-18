//! Full-text search over notes (FR-AGENT-5).
//!
//! The Node server uses FlexSearch with a `forward` tokenizer, which indexes
//! every token prefix — the only way it can match inside Japanese text, where
//! there are no word breaks — and that cost ~1 GB of memory for a 15 MB corpus.
//!
//! Here the corpus itself is the index: bodies are held lowercased in memory
//! (~2× the text, tens of MB) and a query is a substring scan. That matches
//! Japanese and English alike, needs no tokenizer, and on this corpus answers
//! in single-digit milliseconds. If it ever stops scaling, tantivy + lindera is
//! the next step — the interface here is what that would replace.

use std::sync::RwLock;

use crate::notes::{NoteMeta, NoteStore};

struct Entry {
    meta: NoteMeta,
    /// Lowercased title + body, searched as one haystack.
    haystack: String,
}

pub struct SearchService {
    entries: RwLock<Vec<Entry>>,
}

impl SearchService {
    pub fn new() -> Self {
        Self { entries: RwLock::new(Vec::new()) }
    }

    /// Load every note into the corpus. Cheap enough to run synchronously at
    /// startup (measured well under a second for 1,433 notes).
    pub fn rebuild(&self, notes: &NoteStore) {
        let mut entries = Vec::new();
        for meta in notes.list(None) {
            if let Some(note) = notes.get(&meta.id) {
                entries.push(Entry {
                    haystack: format!("{}\n{}", note.meta.title, note.body).to_lowercase(),
                    meta: note.meta,
                });
            }
        }
        *self.entries.write().unwrap() = entries;
    }

    /// Reflect a single write immediately, so a saved note is searchable at once.
    pub fn upsert(&self, notes: &NoteStore, id: &str) {
        let mut entries = self.entries.write().unwrap();
        entries.retain(|e| e.meta.id != id);
        if let Some(note) = notes.get(id) {
            entries.push(Entry {
                haystack: format!("{}\n{}", note.meta.title, note.body).to_lowercase(),
                meta: note.meta,
            });
        }
    }

    pub fn remove(&self, id: &str) {
        self.entries.write().unwrap().retain(|e| e.meta.id != id);
    }

    /// Notes containing `query`, title matches first, then most recent.
    ///
    /// The scan is split across the available cores: one thread over 17 MB of
    /// text takes ~20 ms, which is slower than an index lookup, while eight
    /// take a few milliseconds — and the corpus still costs tens of megabytes
    /// instead of the ~1 GB an in-memory prefix index needs.
    pub fn search(&self, query: &str, limit: usize) -> Vec<NoteMeta> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Vec::new();
        }
        let entries = self.entries.read().unwrap();
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            .min(entries.len().max(1));
        let chunk = entries.len().div_ceil(threads.max(1));

        let mut hits: Vec<(bool, &NoteMeta)> = std::thread::scope(|scope| {
            let handles: Vec<_> = entries
                .chunks(chunk.max(1))
                .map(|part| {
                    let q = &q;
                    scope.spawn(move || {
                        part.iter()
                            .filter(|e| e.haystack.contains(q.as_str()))
                            .map(|e| (e.meta.title.to_lowercase().contains(q.as_str()), &e.meta))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });

        hits.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then(b.1.updated.cmp(&a.1.updated))
                .then_with(|| a.1.id.cmp(&b.1.id))
        });
        hits.into_iter().take(limit).map(|(_, m)| m.clone()).collect()
    }
}
