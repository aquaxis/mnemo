import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import type { Collector } from '../agent/collector.js';

export interface Job {
  id: string;
  name: string;
  cron: string;
  action: 'collect';
  params: { instruction?: string; sources: string[]; category?: string };
  enabled: boolean;
}

export interface JobRun {
  jobId: string;
  startedAt: string;
  finishedAt: string;
  status: 'success' | 'error';
  createdNotes: string[];
  message: string;
}

/**
 * Cron-style scheduler (FR-CRON-1..4). Job definitions and run history are
 * persisted under data/jobs/ so schedules survive restarts.
 */
export class Scheduler {
  private readonly jobsDir: string;
  private readonly jobsFile: string;
  private readonly runsFile: string;
  private tasks = new Map<string, cron.ScheduledTask>();

  constructor(dataDir: string, private readonly collector: Collector) {
    this.jobsDir = join(dataDir, 'jobs');
    mkdirSync(this.jobsDir, { recursive: true });
    this.jobsFile = join(this.jobsDir, 'jobs.json');
    this.runsFile = join(this.jobsDir, 'runs.json');
  }

  private readJobs(): Job[] {
    if (!existsSync(this.jobsFile)) return [];
    try {
      return JSON.parse(readFileSync(this.jobsFile, 'utf8')) as Job[];
    } catch {
      return [];
    }
  }

  private writeJobs(jobs: Job[]): void {
    writeFileSync(this.jobsFile, JSON.stringify(jobs, null, 2), 'utf8');
  }

  private readRuns(): JobRun[] {
    if (!existsSync(this.runsFile)) return [];
    try {
      return JSON.parse(readFileSync(this.runsFile, 'utf8')) as JobRun[];
    } catch {
      return [];
    }
  }

  private appendRun(run: JobRun): void {
    const runs = this.readRuns();
    runs.unshift(run);
    writeFileSync(this.runsFile, JSON.stringify(runs.slice(0, 500), null, 2), 'utf8');
  }

  /** Register all enabled jobs on startup. */
  start(): void {
    for (const job of this.readJobs()) {
      if (job.enabled) this.register(job);
    }
  }

  private register(job: Job): void {
    this.unregister(job.id);
    if (!cron.validate(job.cron)) return;
    const task = cron.schedule(job.cron, () => {
      void this.run(job.id);
    });
    this.tasks.set(job.id, task);
  }

  private unregister(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
  }

  list(): Job[] {
    return this.readJobs();
  }

  create(input: Omit<Job, 'id'>): Job {
    const job: Job = { ...input, id: randomUUID() };
    const jobs = this.readJobs();
    jobs.push(job);
    this.writeJobs(jobs);
    if (job.enabled) this.register(job);
    return job;
  }

  update(id: string, patch: Partial<Omit<Job, 'id'>>): Job | null {
    const jobs = this.readJobs();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return null;
    const updated: Job = { ...jobs[idx], ...patch, id };
    jobs[idx] = updated;
    this.writeJobs(jobs);
    if (updated.enabled) this.register(updated);
    else this.unregister(id);
    return updated;
  }

  delete(id: string): boolean {
    const jobs = this.readJobs();
    const next = jobs.filter((j) => j.id !== id);
    if (next.length === jobs.length) return false;
    this.writeJobs(next);
    this.unregister(id);
    return true;
  }

  runsFor(id: string): JobRun[] {
    return this.readRuns().filter((r) => r.jobId === id);
  }

  /** Execute a job immediately (used by cron triggers and manual runs). */
  async run(id: string): Promise<JobRun | null> {
    const job = this.readJobs().find((j) => j.id === id);
    if (!job) return null;
    const startedAt = new Date().toISOString();
    try {
      // The AI agent executes the task instruction (FR-CRON-7); with no
      // instruction this degrades to plain source collection.
      const outcome = await this.collector.runTask({ ...job.params, title: job.name }, startedAt);
      const run: JobRun = {
        jobId: id,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: outcome.errors.length && !outcome.createdNotes.length ? 'error' : 'success',
        createdNotes: outcome.createdNotes,
        message: outcome.errors.length
          ? `Produced ${outcome.createdNotes.length} note(s), ${outcome.errors.length} error(s)`
          : `Produced ${outcome.createdNotes.length} note(s)`
      };
      this.appendRun(run);
      return run;
    } catch (err) {
      const run: JobRun = {
        jobId: id,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'error',
        createdNotes: [],
        message: err instanceof Error ? err.message : String(err)
      };
      this.appendRun(run);
      return run;
    }
  }
}
