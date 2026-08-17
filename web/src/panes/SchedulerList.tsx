import { useEffect, useState } from 'react';
import { api, type Job } from '../api.js';

/**
 * Middle pane for the Scheduler (3-pane layout): a "New task" action plus the
 * list of scheduled tasks. Selecting a task (or "new") drives the right pane.
 */
export function SchedulerList(props: {
  selected: string | 'new' | null;
  onSelect: (sel: string | 'new') => void;
  reloadSignal: number;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    void api.jobs().then((r) => setJobs(r.jobs));
  }, [props.reloadSignal]);

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-2">
        <button
          className={`w-full rounded px-2 py-1.5 text-sm font-medium ${
            props.selected === 'new' ? 'bg-accent text-white' : 'bg-muted hover:bg-accent/10'
          }`}
          onClick={() => props.onSelect('new')}
        >
          + New task
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {jobs.map((job) => (
          <button
            key={job.id}
            className={`block w-full border-b border-border px-4 py-3 text-left hover:bg-muted ${
              props.selected === job.id ? 'bg-muted' : ''
            }`}
            onClick={() => props.onSelect(job.id)}
          >
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{job.name}</span>
              <span className="ml-auto rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {job.cron}
              </span>
            </div>
            {job.params.instruction && (
              <div className="mt-0.5 truncate text-xs text-gray-600">
                “{job.params.instruction}”
              </div>
            )}
            <div className="mt-0.5 text-xs text-gray-500">
              {job.enabled ? 'enabled' : 'disabled'}
              {job.params.sources.length ? ` · ${job.params.sources.length} source(s)` : ''}
            </div>
          </button>
        ))}
        {!jobs.length && <p className="p-4 text-sm text-gray-400">No tasks yet. Create one above.</p>}
      </div>
    </section>
  );
}
