import { useEffect, useRef, useState } from 'react';
import { api, type Job, type JobRun } from '../api.js';

/** Right pane for the Scheduler: create form, or an editable task + run history. */
export function SchedulerDetail(props: {
  sel: string | 'new' | null;
  reloadSignal: number;
  onChange: () => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
}) {
  if (props.sel === 'new') {
    return <CreateTaskForm onCreated={props.onCreated} />;
  }
  if (props.sel) {
    return (
      <JobDetail
        jobId={props.sel}
        reloadSignal={props.reloadSignal}
        onChange={props.onChange}
        onDeleted={props.onDeleted}
      />
    );
  }
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-gray-400">
      Select a task, or create a new one.
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600">{props.label}</label>
      {props.children}
    </div>
  );
}

/** Shared editable task fields (used by both create and edit). */
function TaskFields(props: {
  name: string;
  setName: (v: string) => void;
  cronExpr: string;
  setCronExpr: (v: string) => void;
  instruction: string;
  setInstruction: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Task name">
        <input
          className="w-full rounded border border-border p-2 text-sm outline-none"
          placeholder="e.g. Morning tech news"
          value={props.name}
          onChange={(e) => props.setName(e.target.value)}
        />
      </Field>
      <Field label="Schedule (cron expression)">
        <input
          className="w-full rounded border border-border p-2 text-sm outline-none"
          placeholder="min hour day month weekday — e.g. 0 8 * * 1-5"
          value={props.cronExpr}
          onChange={(e) => props.setCronExpr(e.target.value)}
        />
      </Field>
      <Field label="Instruction (what the AI agent should do)">
        <textarea
          className="h-24 w-full rounded border border-border p-2 text-sm outline-none"
          placeholder="e.g. Research the latest AI news on the web and write a briefing with the top 5 items."
          value={props.instruction}
          onChange={(e) => props.setInstruction(e.target.value)}
        />
      </Field>
      <Field label="Save to category">
        <input
          className="w-full rounded border border-border p-2 text-sm outline-none"
          placeholder="e.g. collected"
          value={props.category}
          onChange={(e) => props.setCategory(e.target.value)}
        />
      </Field>
    </div>
  );
}

function CreateTaskForm(props: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [cronExpr, setCronExpr] = useState('0 8 * * *');
  const [instruction, setInstruction] = useState('');
  const [category, setCategory] = useState('collected');

  async function create() {
    // The AI agent runs the instruction and finds its own sources (FR-CRON-7).
    if (!name || !instruction.trim()) return;
    const job = await api.createJob({
      name,
      cron: cronExpr,
      action: 'collect',
      params: { instruction: instruction.trim(), sources: [], category },
      enabled: true
    });
    props.onCreated(job.id);
  }

  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="mb-4 text-xl font-bold">New task</h1>
      <div className="max-w-xl">
        <TaskFields
          name={name}
          setName={setName}
          cronExpr={cronExpr}
          setCronExpr={setCronExpr}
          instruction={instruction}
          setInstruction={setInstruction}
          category={category}
          setCategory={setCategory}
        />
        <button
          className="mt-4 rounded bg-accent px-4 py-1.5 text-sm font-medium text-white"
          onClick={create}
        >
          Create task
        </button>
      </div>
    </div>
  );
}

function JobDetail(props: {
  jobId: string;
  reloadSignal: number;
  onChange: () => void;
  onDeleted: () => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [name, setName] = useState('');
  const [cronExpr, setCronExpr] = useState('');
  const [instruction, setInstruction] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  // Only initialize the editable fields once per task, so an unrelated reload
  // (run now / enable-disable) doesn't discard unsaved edits.
  const initedFor = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([api.jobs(), api.jobRuns(props.jobId)]).then(([j, r]) => {
      if (!active) return;
      const found = j.jobs.find((x) => x.id === props.jobId) ?? null;
      setJob(found);
      setRuns(r.runs);
      if (found && initedFor.current !== props.jobId) {
        initedFor.current = props.jobId;
        setName(found.name);
        setCronExpr(found.cron);
        setInstruction(found.params.instruction ?? '');
        setCategory(found.params.category ?? 'collected');
      }
    });
    return () => {
      active = false;
    };
  }, [props.jobId, props.reloadSignal]);

  if (!job) return <div className="p-6 text-sm text-gray-400">Loading…</div>;

  async function save() {
    if (!name || !instruction.trim()) return;
    setStatus('Saving…');
    // Preserve any pre-existing sources (settable via API) for backward compat.
    await api.updateJob(job!.id, {
      name,
      cron: cronExpr,
      params: { instruction: instruction.trim(), sources: job!.params.sources ?? [], category }
    });
    setStatus('Saved.');
    props.onChange();
  }
  async function runNow() {
    setStatus('Running…');
    await api.runJob(job!.id);
    setStatus('Run complete.');
    props.onChange();
  }
  async function toggle() {
    await api.updateJob(job!.id, { enabled: !job!.enabled });
    props.onChange();
  }
  async function remove() {
    await api.deleteJob(job!.id);
    props.onDeleted();
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">{job.name}</h1>
        <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{job.cron}</span>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            job.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
          }`}
        >
          {job.enabled ? 'enabled' : 'disabled'}
        </span>
      </div>

      <div className="mb-4 flex items-center gap-3 text-sm">
        <button className="rounded bg-accent px-3 py-1 font-medium text-white" onClick={runNow}>
          Run now
        </button>
        <button className="hover:underline" onClick={toggle}>
          {job.enabled ? 'Disable' : 'Enable'}
        </button>
        <button className="text-red-500 hover:underline" onClick={remove}>
          Delete
        </button>
        <span className="text-xs text-gray-500">{status}</span>
      </div>

      <div className="max-w-xl">
        <TaskFields
          name={name}
          setName={setName}
          cronExpr={cronExpr}
          setCronExpr={setCronExpr}
          instruction={instruction}
          setInstruction={setInstruction}
          category={category}
          setCategory={setCategory}
        />
        <button
          className="mt-4 rounded bg-accent px-4 py-1.5 text-sm font-medium text-white"
          onClick={save}
        >
          Save changes
        </button>
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold">Run history</h2>
      <div className="space-y-1">
        {runs.map((r, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                r.status === 'success' ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span>{new Date(r.startedAt).toLocaleString()}</span>
            <span className="text-gray-500">{r.message}</span>
          </div>
        ))}
        {!runs.length && <p className="text-xs text-gray-400">No runs yet. Use “Run now”.</p>}
      </div>
    </div>
  );
}
