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
- **AI chat** — converse with the configured AI agent (a web-capable backend like agent-cli can search the web and search your notes during the reply); conversations auto-save as notes.
- **AI note search** — the agent can search across all of your notes (FR-FILE-6).
- **Selectable AI agent** — choose the backend: agent-cli or Claude Code (CLI). The Claude API is not used.
- **Settings page** — pick the active AI backend, set the AI output language, and edit per-backend settings (command, args, model).
- **Cron scheduling** — run recurring tasks by date/time or weekday; each task gives the AI agent an instruction to execute (the agent finds its own sources), not just a fixed crawl.
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

## Data layout

```
data/
├── notes/         # all Markdown, classified by category
│   ├── inbox/
│   ├── wiki/
│   └── collected/ # AI-collected notes
├── assets/        # binaries only (images / audio / video)
├── config.json
└── jobs/          # scheduled job definitions & run history
```

## Tech stack

TypeScript throughout. Server: Fastify. Web: React + Vite + Tailwind. Editor:
CodeMirror 6. Search: FlexSearch. Scheduling: node-cron.

## License

MIT
