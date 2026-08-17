# Mnemo

English | [日本語](./README_ja.md)

**Mnemo** is an integrated, Markdown-based knowledge database — an omnipotent
archive of memory and knowledge. It combines note-taking (Obsidian-style live
Markdown editing), a wiki, AI-agent web collection, and scheduled tasks, storing
everything as portable Markdown files.

The name comes from **Mnemosyne**, the Greek goddess of memory.

## Features

- **Three-pane UI** (navigation · note list · editor), modeled on the shadcn Mail layout; the left and middle panes collapse.
- **Live Markdown editor** — Obsidian-style inline live preview (CodeMirror 6 + [codemirror-live-markdown](https://codemirror-live-markdown.vercel.app/)).
- **AI information collection** — crawl web pages, extract key points, save them as notes.
- **AI chat (research mode)** — ask a question and the agent researches the **latest** information on the web (several searches, recent sources cross-checked) before answering in detail with a list of sources; it can search your notes too. Conversations auto-save as notes, show the elapsed time against the timeout while working, and can be cancelled.
- **Schedule a task by asking** — say “every morning, collect the AI news” and Mnemo recognizes the request, rewrites it into a proper agent instruction, and registers it in the Scheduler; the reply tells you what was created. A **Schedule task** button does the same manually.
- **AI note search** — the agent can search across all of your notes (FR-FILE-6).
- **Selectable AI agent** — choose the backend: agent-cli or Claude Code (CLI). The Claude API is not used.
- **Settings page** — pick the active AI backend, set the AI output language, and edit per-backend settings (command, args, model).
- **Cron scheduling** — run recurring tasks by date/time or weekday; each task gives the AI agent an instruction to execute (the agent finds its own sources), not just a fixed crawl. Tasks can be created in the Scheduler view or straight from a chat.
- **Markdown-first storage** — all knowledge as Markdown, organized into nested folders (categories); binaries stored separately.

## Requirements

- Node.js >= 18 (no Python is used anywhere).

## Install (one-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/aquaxis/mnemo/main/install.sh | sh
```

Or into a specific directory:

```bash
curl -fsSL https://raw.githubusercontent.com/aquaxis/mnemo/main/install.sh | sh -s -- my-mnemo
```

## Update (your data is never touched)

From inside an installation:

```bash
npm run update
```

Or re-run the one-liner on an existing installation — it updates instead of
reinstalling:

```bash
curl -fsSL https://raw.githubusercontent.com/aquaxis/mnemo/main/install.sh | sh -s -- my-mnemo
```

An update refreshes the source and rebuilds; **`data/` is never written,
moved, or deleted** — your notes (including nested folders), binary assets,
`data/config.json`, and scheduled jobs with their run history all survive. New
configuration keys added by a release are filled from defaults without
discarding your settings.

The update is deliberately conservative: with a git checkout it is
`git pull --ff-only`, so local changes or a diverged branch abort with a message
instead of being overwritten. Without git, the release is downloaded to a
temporary directory and only source paths are copied over the installation. If
the target directory is not a Mnemo installation, the script refuses to touch it.

## Manual setup

```bash
git clone https://github.com/aquaxis/mnemo.git
cd mnemo
npm install
npm start           # builds the web app and launches the server
```

Then open <http://localhost:3000>.

### Development

```bash
npm run dev         # Vite dev server (5173) + API server (3000) with proxy
```

## Configuration

On first run, `data/` is seeded from `templates/`. Edit `data/config.json`:

```json
{
  "port": 3000,
  "ai": {
    "type": "agent-cli",
    "outputLanguage": "ja",
    "timeoutMs": 300000,
    "maxOutputBytes": 2000000,
    "maxConcurrentRuns": 2,
    "backends": {
      "agent-cli": { "command": "agent-cli", "args": ["run", "--auto-approve-tools"] },
      "claude-code": { "command": "claude", "args": ["-p"] }
    }
  }
}
```

`ai.type` selects the active AI agent backend and `ai.outputLanguage` (e.g. `en`,
`ja`) sets the language of AI-generated summaries. The defaults are **agent-cli**
and **Japanese** output. You can change these (and edit per-backend settings) from
the **Settings** page in the app:

- `agent-cli` — the [agent-cli](https://github.com/aquaxis/agent-cli) command (default; run as `agent-cli run --auto-approve-tools`, using its own configured provider).
- `claude-code` — the Claude Code CLI (print mode). The Claude API is **not** used.
- `local` — offline heuristic, no API or install required (internal fallback).

The CLI agent runs with the notes directory as its working directory, so it can
search and read all your notes to answer.

If the selected backend is unavailable, Mnemo falls back to the local heuristic
so collection never hard-fails.

### Reliability settings

| Key | Default | Meaning |
|-----|---------|---------|
| `ai.timeoutMs` | `300000` | A backend that does not answer within this time is stopped and the failure is reported, so chat and tasks never hang. The default is sized for research answers, which take minutes. Also editable on the Settings page. |
| `ai.maxOutputBytes` | `2000000` | Cap on the output collected from a backend, so a runaway CLI cannot exhaust memory. |
| `ai.maxConcurrentRuns` | `2` | How many agent runs (chat, collection, scheduled tasks) may run at once; the rest queue. |

### Logs

Mnemo writes its log to `data/logs/mnemo.log` and prints only a startup line to
the console. This is deliberate: on Linux/macOS, writing to a terminal is a
*blocking* operation for Node, so a server started in a terminal that is later
closed (or that stops draining, e.g. a dropped SSH session) would freeze —
the process stays alive but stops answering requests. Logging to a file keeps
the server running no matter what happens to the terminal.

Set `MNEMO_LOG=stdout` (or `"logTarget": "stdout"` in `config.json`) to log to
the console instead, e.g. during development.

To keep Mnemo running after you close the terminal, start it detached:

```bash
nohup npm start >/dev/null 2>&1 &
```

### Troubleshooting: chat does not answer

1. Open **Settings** — a backend whose command is missing is flagged there.
2. Check `data/logs/mnemo.log`; every failed backend invocation is logged with
   the command, exit status, duration, and error output.
3. Chat replies now carry the reason (backend not found, timed out, busy), so a
   failure is visible instead of silent.

## Data layout

```
data/
├── notes/         # all Markdown, classified by category
│   ├── inbox/
│   ├── wiki/
│   └── collected/ # AI-collected notes
├── assets/        # binaries only (images / audio / video)
├── config.json
├── logs/          # server log (mnemo.log)
├── scripts/       # scripts & working files produced by tasks
└── jobs/          # scheduled job definitions & run history
```

`notes/` holds knowledge as Markdown only. When a task needs a helper script or
another generated file, the agent writes it to `scripts/` — the agent runs in
the data directory, reads `notes/` to search your knowledge, and keeps its own
working files out of it.

Upgrading from an earlier version: files an agent wrote under `data/notes/`
(e.g. `data/notes/scripts/`) stay where they are — nothing is deleted for you.
Move them to `data/scripts/` if you want them out of the note list.

## Tech stack

TypeScript throughout. Server: Fastify. Web: React + Vite + Tailwind. Editor:
CodeMirror 6. Search: FlexSearch. Scheduling: node-cron.

## License

MIT
