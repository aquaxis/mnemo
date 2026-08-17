import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** How long a killed child gets to exit before it is force-killed. */
const KILL_GRACE_MS = 2000;

export interface RunCliOptions {
  command: string;
  args: string[];
  /** Text fed to the child's stdin; the child sees EOF afterwards. */
  prompt: string;
  /** Working directory — the notes corpus, so agent tools can read it (FR-FILE-6). */
  cwd?: string;
  /** Hard limit for the whole invocation (FR-REL-1). */
  timeoutMs: number;
  /** Cap on collected stdout/stderr (FR-REL-3). */
  maxOutputBytes: number;
  /** Diagnostics sink (FR-REL-6). */
  log?: (message: string, detail: Record<string, unknown>) => void;
}

export interface RunCliResult {
  stdout: string;
  /** True when the output hit `maxOutputBytes` and the child was stopped. */
  truncated: boolean;
  durationMs: number;
}

/** Error carrying the reason an invocation failed, for the UI (FR-REL-6). */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly reason: 'not-found' | 'timeout' | 'exit' | 'io' | 'busy'
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/**
 * Spawn a CLI backend, feed it the prompt on stdin, and collect stdout.
 *
 * Every failure mode is contained here so that a misbehaving backend can never
 * take the server down (FR-REL-1..3, FR-REL-6, NFR-7):
 *
 * - the promise settles exactly once, and the timer/listeners are always cleared;
 * - `spawn` errors (missing command, ENOENT) reject with an actionable message;
 * - stdin errors (EPIPE / ERR_STREAM_DESTROYED when the child exits before it
 *   reads the prompt) reject instead of surfacing as an uncaught exception that
 *   would kill the process;
 * - the invocation is bounded by `timeoutMs` (SIGTERM, then SIGKILL);
 * - output is capped at `maxOutputBytes` so a runaway CLI cannot exhaust memory.
 */
export function runCli(options: RunCliOptions): Promise<RunCliResult> {
  const { command, args, prompt, cwd, timeoutMs, maxOutputBytes, log } = options;
  const startedAt = Date.now();

  return new Promise<RunCliResult>((resolve, reject) => {
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    } catch (err) {
      reject(new BackendError(`Failed to start "${command}": ${message(err)}`, 'not-found'));
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (err: Error | null, result?: RunCliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const durationMs = Date.now() - startedAt;
      if (err) {
        log?.('AI backend invocation failed', {
          command: [command, ...args].join(' '),
          durationMs,
          error: err.message,
          stderr: stderr.slice(0, 500)
        });
        reject(err);
      } else {
        resolve({ ...result!, durationMs });
      }
    };

    /** Stop the child; SIGKILL if it ignores SIGTERM. */
    const stop = () => {
      if (child.killed || child.exitCode !== null) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const collect = (buffer: 'out' | 'err', chunk: Buffer) => {
      if (truncated) return;
      const text = chunk.toString();
      if (buffer === 'out') stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > maxOutputBytes) {
        truncated = true;
        log?.('AI backend output truncated', {
          command,
          maxOutputBytes,
          bytes: stdout.length + stderr.length
        });
        stop();
      }
    };

    child.stdout.on('data', (d: Buffer) => collect('out', d));
    child.stderr.on('data', (d: Buffer) => collect('err', d));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    // Spawn failure (e.g. the configured command is not installed).
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        err.code === 'ENOENT'
          ? new BackendError(
              `AI backend command "${command}" was not found. ` +
                `Install it or correct the command on the Settings page.`,
              'not-found'
            )
          : new BackendError(`AI backend "${command}" failed to start: ${err.message}`, 'io')
      );
    });

    // The child may exit before reading the prompt: writing then raises EPIPE /
    // ERR_STREAM_DESTROYED on stdin. Handle it — unhandled, it terminates the
    // server process (FR-REL-2).
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      finish(
        new BackendError(
          `AI backend "${command}" closed its input before the prompt was sent (${err.code ?? err.message}).`,
          'io'
        )
      );
    });

    const timer = setTimeout(() => {
      stop();
      finish(
        new BackendError(
          `AI backend "${command}" did not respond within ${Math.round(timeoutMs / 1000)}s.`,
          'timeout'
        )
      );
    }, timeoutMs);
    timer.unref?.();

    child.on('close', (code, signal) => {
      if (truncated) {
        finish(null, { stdout, truncated, durationMs: 0 });
        return;
      }
      if (code === 0) {
        finish(null, { stdout, truncated, durationMs: 0 });
        return;
      }
      finish(
        new BackendError(
          `AI backend "${command}" exited ${signal ? `on ${signal}` : `with code ${code}`}` +
            (stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : '.'),
          'exit'
        )
      );
    });

    child.stdin.write(prompt, (err) => {
      if (err) return; // reported by the stdin error handler above
      child.stdin.end();
    });
  });
}

/**
 * Limits how many backend invocations run at once (FR-REL-5): stuck or slow
 * agent runs queue instead of piling up as processes. Work that cannot start
 * within `timeoutMs` fails fast rather than waiting forever.
 */
export class RunLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private limit: number) {}

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.drain();
  }

  async run<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await task();
    } finally {
      this.active--;
      this.drain();
    }
  }

  private acquire(timeoutMs: number): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let waiting = true;
      const timer = setTimeout(() => {
        if (!waiting) return;
        waiting = false;
        reject(
          new BackendError(
            `The AI agent is busy (${this.limit} run(s) already in progress). Try again shortly.`,
            'busy'
          )
        );
      }, timeoutMs);
      timer.unref?.();
      this.queue.push(() => {
        if (!waiting) return; // this waiter already timed out
        waiting = false;
        clearTimeout(timer);
        this.active++;
        resolve();
      });
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length) {
      const next = this.queue.shift();
      next?.();
    }
  }
}

/** Resolve a command against PATH so a missing backend is reported up front (FR-REL-6). */
export function commandExists(command: string): boolean {
  if (!command) return false;
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      // try the next PATH entry
    }
  }
  return false;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
