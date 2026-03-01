# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

LeoClaw — a minimal Telegram bridge to Claude Code. Grammy receives messages, resolves session state (reply = resume, new = fresh), spawns `claude -p` with the workspace as CWD, and Claude uses MCP tools to reply. No SDK, no API costs. All intelligence lives in the workspace.

## Architecture

```
Telegram → Grammy bot (src/index.ts) → resolve session → claude -p --resume/--session-id → Claude loads workspace/CLAUDE.md + .mcp.json → uses Telegram MCP tools to reply
```

Two runtime paths:
- **Messages**: User text → queued/deduped → session resolved (reply = `--resume`, new = `--session-id`) → Claude spawned with `--output-format stream-json` (serialized per chat) → NDJSON events parsed in real-time → MCP tool calls detected from `assistant` events → fallback: `result` event text sent to chat
- **Crons**: Markdown files in `workspace/crons/` → compiled to launchd agents → `scripts/run-cron.sh` → `claude -p` (stateless) → MCP reply

Key in-memory state in the harness: `activeRuns` (Map of Sets of AbortControllers), `messageQueue` (buffer rapid messages), `activeTasks` (Map tracking background task processes), `chatLocks` (per-chat serialization), `chatActiveSession` (tracks active session per chat), `sessionStore` (message-to-session mappings, persisted to `sessions.json`).

## Project Layout

- `src/index.ts` — The harness: Telegram bot, message queue, Claude process spawner
- `packages/telegram-mcp/` — MCP server exposing 10 Telegram Bot API tools (send_message, send_photo, edit_message, delete_message, react, typing, edit_reply_markup, pin_message, ask_user, dispatch_task)
- `workspace/` — Claude's runtime workspace (CLAUDE.md identity, .mcp.json, skills, memory system, knowledge)
- `workspace/crons/` — Cron job definitions (one `.md` file per job, YAML frontmatter + prompt)
- `scripts/compile-crons.ts` — Compiler: reads cron .md files, converts TZ, generates launchd plist agents
- `scripts/run-cron.sh` — Runner: executes a single cron job via `claude -p`
- `scripts/run-leo-with-keychain.sh` — Keychain wrapper for the harness
- `config.json` / `config.example.json` — Runtime config (env vars take precedence with `LEO_*` prefix)

## Commands

```bash
# Development
pnpm dev                     # Watch mode (tsx)
pnpm build                   # Compile harness (tsc)
pnpm start                   # Run compiled harness

# Crons
pnpm compile:crons           # Compile .md files -> launchd agents
pnpm compile:crons:dry       # Preview without installing

# Telegram MCP package
cd packages/telegram-mcp
pnpm build                   # Compile MCP server
pnpm dev                     # Run MCP in dev mode

# Service (macOS)
pnpm start:keychain          # Start with Keychain token

# Git hooks
pnpm setup:hooks             # Install pre-commit secret scanning
```

No test suite exists. No linter/formatter is configured.

## Configuration

Precedence: env vars (`TELEGRAM_BOT_TOKEN`, `LEO_ALLOWED_USERS`, `LEO_WORKSPACE`, `LEO_CLAUDE_PATH`, `LEO_DANGEROUSLY_SKIP_PERMISSIONS`) → `config.json` → defaults.

Telegram token stored in macOS Keychain (`leoclaw.telegram_bot_token`), extracted by `scripts/run-leo-with-keychain.sh`.

## Important Distinctions

- **`workspace/CLAUDE.md`** is Leo's runtime identity file (loaded by Claude when the bot runs). Do not confuse with this file.
- **`workspace/.mcp.json`** configures MCP servers for the bot's Claude sessions, not for development.
- The MCP server defaults to MarkdownV2 parse_mode for Telegram messages. The harness's own command responses (`/crons`, `/tasks`, etc.) still use HTML.
- Claude is spawned as a child process via CLI (`claude -p` with `--resume` or `--session-id` and `--output-format stream-json`), not via any SDK. The harness parses NDJSON events to detect MCP tool calls and extract cost/session metadata.
- Messages are serialized per chat (one Claude process at a time). Crons and `dispatch_task` remain stateless.

## Conventions

- TypeScript strict mode, ES2022 target
- No abstractions — the harness is intentionally flat and minimal
- "Code is config" — behavior changes go in workspace files (CLAUDE.md, rules, skills), not harness code
- Behavioral rules live in `workspace/.claude/rules/` (auto-loaded by Claude Code at session start)
- Skills live in `workspace/.claude/skills/<name>/SKILL.md`
- Memory system: pillar files in `workspace/memory/pillars/`, daily buffer in `workspace/memory/buffer/`
- Session state: `sessions.json` maps message IDs to Claude session IDs (7-day TTL)
