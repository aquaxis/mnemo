import { useEffect, useRef, useState } from 'react';
import { api, type ChatMessage } from '../api.js';

/**
 * Turn a conversation into a scheduled task (FR-CHAT-9). The form is pre-filled
 * from the chat and saved through the ordinary jobs API, so the result is a
 * normal job that the Scheduler view lists, edits and runs.
 */
function ScheduleTaskForm(props: {
  instruction: string;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState(firstLine(props.instruction));
  const [cronExpr, setCronExpr] = useState('0 8 * * *');
  const [instruction, setInstruction] = useState(props.instruction);
  const [category, setCategory] = useState('collected');
  const [status, setStatus] = useState('');

  async function create() {
    if (!name.trim() || !instruction.trim()) {
      setStatus('Name and instruction are required.');
      return;
    }
    setStatus('Creating…');
    try {
      await api.createJob({
        name: name.trim(),
        cron: cronExpr.trim(),
        action: 'collect',
        params: { instruction: instruction.trim(), sources: [], category: category.trim() },
        enabled: true
      });
      props.onCreated(name.trim());
    } catch (err) {
      setStatus(`⚠️ ${err instanceof Error ? err.message : 'Could not create the task'}`);
    }
  }

  return (
    <div className="border-b border-border bg-muted/30 px-6 py-4">
      <div className="mx-auto max-w-2xl space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Schedule this as a recurring task</h2>
          <button className="text-xs text-gray-500 hover:underline" onClick={props.onClose}>
            Close
          </button>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Task name</label>
          <input
            className="w-full rounded border border-border p-2 text-sm outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            Schedule (cron expression)
          </label>
          <input
            className="w-full rounded border border-border p-2 text-sm outline-none"
            placeholder="min hour day month weekday — e.g. 0 8 * * 1-5"
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            Instruction (what the AI agent should do)
          </label>
          <textarea
            className="h-24 w-full rounded border border-border p-2 text-sm outline-none"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Save to category</label>
          <input
            className="w-full rounded border border-border p-2 text-sm outline-none"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white"
            onClick={create}
          >
            Create task
          </button>
          <span className="text-xs text-gray-500">{status}</span>
        </div>
      </div>
    </div>
  );
}

/** First non-empty line, trimmed to a usable task name. */
function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** Conversational chat with the configured AI agent (FR-CHAT). */
export function ChatView() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saveStatus, setSaveStatus] = useState('');
  const [scheduling, setScheduling] = useState(false);
  // The timeout in force, shown next to the elapsed time (FR-CHAT-7). Read from
  // the settings API so it tracks the configured value.
  const [timeoutSec, setTimeoutSec] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  // Lets the user cancel a slow reply; aborting also stops the agent run on the
  // server, so it does not keep holding a concurrency slot.
  const abortRef = useRef<AbortController | null>(null);
  // The note id backing this conversation (held in a ref so debounced saves use
  // the latest id and update in place instead of duplicating).
  const savedIdRef = useRef<string | undefined>(undefined);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  // Without the setting the elapsed time is shown alone (FR-CHAT-7).
  useEffect(() => {
    api
      .settings()
      .then((r) => setTimeoutSec(Math.round((r.ai?.timeoutMs ?? 0) / 1000) || null))
      .catch(() => setTimeoutSec(null));
  }, []);

  // Count the seconds while waiting: a slow backend should look slow, not stuck.
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const started = Date.now();
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000
    );
    return () => window.clearInterval(id);
  }, [busy]);

  // Auto-save after each completed exchange (last message from the assistant),
  // debounced, updating the same note in place (FR-CHAT-4).
  useEffect(() => {
    if (busy) return;
    if (!messages.length || messages[messages.length - 1].role !== 'assistant') return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const snapshot = messages;
    saveTimer.current = window.setTimeout(async () => {
      setSaveStatus('Saving…');
      try {
        const note = await api.saveChat(snapshot, savedIdRef.current);
        savedIdRef.current = note.id;
        setSaveStatus('Saved to Notes › chats');
      } catch {
        setSaveStatus('⚠️ Save failed');
      }
    }, 800);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { reply, scheduled, scheduleError } = await api.chat(next, controller.signal);
      // A recurring-task request is registered server-side; report what was
      // created so the user can confirm or correct it (FR-CHAT-9).
      const note = scheduled
        ? `\n\n---\n\n🗓 **Scheduled task registered** — see Scheduler to edit or run it.\n` +
          `- **Name:** ${scheduled.name}\n` +
          `- **Schedule:** \`${scheduled.cron}\`\n` +
          `- **Instruction:** ${scheduled.instruction}`
        : scheduleError
          ? `\n\n---\n\n⚠️ Could not register a scheduled task: ${scheduleError}`
          : '';
      setMessages([...next, { role: 'assistant', content: reply + note }]);
    } catch (err) {
      if (controller.signal.aborted) {
        setMessages([...next, { role: 'assistant', content: '⏹ Cancelled.' }]);
      } else {
        // Show what actually went wrong (missing backend, timeout, busy) rather
        // than a generic message (FR-REL-6).
        const detail = err instanceof Error ? err.message : String(err);
        setMessages([
          ...next,
          { role: 'assistant', content: `⚠️ Failed to reach the AI backend: ${detail}` }
        ]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  function newConversation() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    setMessages([]);
    savedIdRef.current = undefined;
    setSaveStatus('');
    setScheduling(false);
  }

  /** The latest user message seeds the task instruction (FR-CHAT-9). */
  const lastUserMessage =
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? input.trim();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-bold">Chat</h1>
          <p className="text-xs text-gray-500">
            Ask a question — the AI agent researches the web and answers in detail.
            Conversations save automatically; “Schedule task” turns one into a recurring job.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-xs text-gray-500">{saveStatus}</span>
          <button
            className="rounded border border-border px-3 py-1 hover:bg-muted disabled:opacity-50"
            disabled={!lastUserMessage.trim()}
            title="Turn this conversation into a recurring task"
            onClick={() => setScheduling((v) => !v)}
          >
            Schedule task
          </button>
          <button
            className="rounded border border-border px-3 py-1 hover:bg-muted disabled:opacity-50"
            disabled={!messages.length}
            onClick={newConversation}
          >
            New
          </button>
        </div>
      </header>

      {scheduling && (
        <ScheduleTaskForm
          instruction={lastUserMessage}
          onClose={() => setScheduling(false)}
          onCreated={(name) => {
            setScheduling(false);
            setSaveStatus(`Task “${name}” created — see Scheduler`);
          }}
        />
      )}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {!messages.length && (
          <p className="mt-8 text-center text-sm text-gray-400">
            Start a conversation with your AI agent.
          </p>
        )}
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                m.role === 'user'
                  ? 'self-end bg-accent text-white'
                  : 'self-start border border-border bg-muted/40'
              }`}
            >
              {m.content}
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-3 self-start rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-gray-500">
              <span>
                Thinking… {elapsed}s{timeoutSec ? ` / ${timeoutSec}s` : ''}
                {elapsed >= 20 && (
                  <span className="text-gray-400"> — the AI agent is still working</span>
                )}
              </span>
              <button className="text-xs underline hover:text-gray-700" onClick={cancel}>
                Cancel
              </button>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-border p-3">
        <div className="mx-auto max-w-2xl">
          <div className="flex items-end gap-2">
            <textarea
              className="h-11 max-h-40 flex-1 resize-none rounded border border-border p-2 text-sm outline-none"
              placeholder="Message the AI agent…  (Enter to send, Shift+Enter for newline)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={busy || !input.trim()}
              onClick={send}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
