import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Writable } from 'node:stream';
import type { AppConfig } from './config.js';

/** Rotate the log once it passes this size, keeping a single previous file. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

/**
 * Build the destination for the server log (FR-REL-4, NFR-7).
 *
 * On POSIX, Node writes to a TTY or a pipe **synchronously**: when the terminal
 * the server was started from is closed (or simply stops draining its buffer),
 * the next log write blocks the event loop for good — the process stays alive
 * but accepts no connections, answers no requests, and never reaps its child
 * processes. Logging to a plain file avoids that: file writes go through the
 * thread pool and cannot wedge the loop.
 *
 * `MNEMO_LOG=stdout` (or `"logTarget": "stdout"` in config.json) restores
 * console logging for development, where a live terminal is attached.
 */
export function createLogStream(config: AppConfig): NodeJS.WritableStream {
  if (config.logTarget === 'stdout') return process.stdout;
  try {
    mkdirSync(dirname(config.logFile), { recursive: true });
    rotateIfLarge(config.logFile);
    const stream = createWriteStream(config.logFile, { flags: 'a' });
    // A failing log file must never take the server down (FR-REL-4).
    stream.on('error', () => {});
    return stream;
  } catch {
    return nullStream();
  }
}

function rotateIfLarge(file: string): void {
  try {
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    // Rotation is best-effort; logging continues either way.
  }
}

/** Last-resort sink used when the log file cannot be opened. */
function nullStream(): NodeJS.WritableStream {
  return new Writable({ write: (_chunk, _encoding, cb) => cb() });
}
