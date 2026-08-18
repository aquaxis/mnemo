//! Binary asset store. Binaries live under `data/assets/{images,audio,video}`,
//! strictly separate from Markdown (FR-FILE-3).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn kind_for(ext: &str) -> &'static str {
    match ext {
        "mp3" | "wav" | "ogg" | "flac" => "audio",
        "mp4" | "webm" | "mov" | "mkv" => "video",
        _ => "images",
    }
}

/// A file name unique enough for an asset, without pulling in a uuid crate:
/// nanoseconds since the epoch plus the process id.
fn unique_stem() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}-{:x}", std::process::id())
}

pub struct AssetStore {
    assets_dir: PathBuf,
}

impl AssetStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { assets_dir: data_dir.join("assets") }
    }

    /// Save `data` under the directory matching the file's extension.
    pub fn save(&self, filename: &str, data: &[u8]) -> io::Result<(String, String)> {
        let ext = Path::new(filename)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let kind = kind_for(&ext);
        let dir = self.assets_dir.join(kind);
        fs::create_dir_all(&dir)?;
        let name = if ext.is_empty() {
            unique_stem()
        } else {
            format!("{}.{ext}", unique_stem())
        };
        let path = dir.join(&name);
        fs::write(&path, data)?;
        Ok((path.to_string_lossy().to_string(), format!("/assets/{kind}/{name}")))
    }
}
