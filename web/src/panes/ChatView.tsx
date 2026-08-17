import { useEffect, useRef, useState } from 'react';
import { api, type ChatMessage } from '../api.js';

/** Conversational chat with the configured AI agent (FR-CHAT). */
export function ChatView() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);
  // The note id backing this conversation (held in a ref so debounced saves use
  // the latest id and update in place instead of duplicating).
  const savedIdRef = useRef<string | undefined>(undefined);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

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
    try {
      const { reply } = await api.chat(next);
      setMessages([...next, { role: 'assistant', content: reply }]);
    } catch {
      setMessages([...next, { role: 'assistant', content: '⚠️ Failed to reach the AI backend.' }]);
    } finally {
      setBusy(false);
    }
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
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-bold">Chat</h1>
          <p className="text-xs text-gray-500">
            Talk to the AI agent configured in Settings (it can search the web).
            Conversations save automatically.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-xs text-gray-500">{saveStatus}</span>
          <button
            className="rounded border border-border px-3 py-1 hover:bg-muted disabled:opacity-50"
            disabled={!messages.length}
            onClick={newConversation}
          >
            New
          </button>
        </div>
      </header>

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
            <div className="self-start rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-gray-400">
              …
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
