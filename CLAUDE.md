# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

LeoClaw — a minimal Telegram bridge to Claude Code. Grammy receives messages, spawns `claude -p` with the workspace as CWD, and Claude uses MCP tools to reply. No SDK, no API costs. ~380 lines of harness code; all intelligence lives in the workspace.

## Architecture

```
Telegram → Grammy bot (src/index.ts) → spawns `claude -p --continue` → Claude loads workspace/CLAUDE.md + .mcp.json → uses Telegram MCP tools to reply
```

Two runtime paths:
- **Messages**: User text → queued/deduped → Claude spawned with `--continue` (persistent session) → MCP reply (fallback: stdout sent to chat)
- **Crons**: Markdown files in `workspace/crons/` → `croner` timers → fresh Claude session (no `--continue`) → MCP reply

Key in-memory state in the harness: `activeRuns` (Map of AbortControllers), `messageQueue` (buffer rapid messages), `processing` (Set preventing concurrent per-chat processing).

## Project Layout

- `src/index.ts` — The harness: Telegram bot, message queue, Claude process spawner
- `src/cron.ts` — Cron module: parses markdown files, schedules with croner, serial execution queue
- `packages/telegram-mcp/` — MCP server exposing 9 Telegram Bot API tools (send_message, send_photo, edit_message, delete_message, react, typing, edit_reply_markup, pin_message, ask_user)
- `workspace/` — Claude's runtime workspace (CLAUDE.md identity, .mcp.json, skills, memory system, knowledge)
- `workspace/crons/` — Cron job definitions (one `.md` file per job, YAML frontmatter + prompt)
- `config.json` / `config.example.json` — Runtime config (env vars take precedence with `LEO_*` prefix)
- `ops/launchd/` — macOS launchd service template
- `scripts/` — Keychain wrapper and git hooks setup

## Commands

```bash
# Development
pnpm dev                     # Watch mode (tsx)
pnpm build                   # Compile harness (tsc)
pnpm start                   # Run compiled harness

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
- The harness uses HTML parse_mode for Telegram messages (not MarkdownV2).
- Claude is spawned as a child process via CLI (`claude -p`), not via any SDK.

## Conventions

- TypeScript strict mode, ES2022 target
- No abstractions — the harness is intentionally flat and minimal
- "Code is config" — behavior changes go in workspace files (CLAUDE.md, skills), not harness code
- Skills live in `workspace/.claude/skills/<name>/SKILL.md`
- Memory system: daily notes in `workspace/memory/YYYY-MM-DD.md`, knowledge in `workspace/knowledge/`
