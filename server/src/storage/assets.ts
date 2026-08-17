import { writeFileSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

const KIND_BY_EXT: Record<string, 'images' | 'audio' | 'video'> = {
  '.png': 'images', '.jpg': 'images', '.jpeg': 'images', '.gif': 'images',
  '.webp': 'images', '.svg': 'images',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.flac': 'audio',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mkv': 'video'
};

/**
 * Binary asset store. Binaries live under data/assets/{images,audio,video},
 * strictly separate from Markdown (FR-FILE-3).
 */
export class AssetStore {
  private readonly assetsDir: string;

  constructor(dataDir: string) {
    this.assetsDir = join(dataDir, 'assets');
  }

  save(filename: string, data: Buffer): { path: string; url: string } {
    const ext = extname(filename).toLowerCase();
    const kind = KIND_BY_EXT[ext] ?? 'images';
    const dir = join(this.assetsDir, kind);
    mkdirSync(dir, { recursive: true });
    const id = `${randomUUID()}${ext}`;
    const path = join(dir, id);
    writeFileSync(path, data);
    return { path, url: `/assets/${kind}/${id}` };
  }
}
