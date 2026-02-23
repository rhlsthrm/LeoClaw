# LeoClaw Architecture

*This is a living doc. Update it when the system changes.*

## Philosophy
"Code is config." Claude Code IS the agent. LeoClaw is just plumbing.

Everything else (skills, memory, crons, communication) is workspace files that Claude reads and acts on. No SDK, no API costs, no abstraction layers.

## System Overview

```
Telegram User
    ↓ message (text, voice note, or photo)
Grammy Bot (src/index.ts)
    ↓ voice? → ElevenLabs Scribe v2 → transcribed text (optional)
    ↓ photo? → saved to workspace/tmp/ → path in prompt
    ↓ reply? → walk reply chain from messages.json → thread context
    ↓ prepends [chat_id, message_id] + <thread_context>
Claude Code (claude -p --continue, resumes conversation)
    ↓ reads .mcp.json, CLAUDE.md, workspace files
    ↓ uses MCP tools to reply
Telegram MCP Server (packages/telegram-mcp/)
    ↓ send_message, send_photo, edit, delete, react, typing, ask_user
Telegram User
```

## Source Code

| Component | Location | Purpose |
|-----------|----------|---------|
| Harness | `src/index.ts` | Telegram bot + Claude spawner + voice transcription + message store |
| Cron module | `src/cron.ts` | Markdown-based cron scheduling (croner) |
| Telegram MCP | `packages/telegram-mcp/src/index.ts` | MCP server: 7 Telegram Bot API tools |
| Config | `config.json` + env (`LEO_*`) | Non-secret runtime settings and overrides |
| Message store | `messages.json` | Reply chain history (100 msgs/chat, JSON) |

## Workspace

```
workspace/
├── CLAUDE.md              # Identity, rules, behavior. Always loaded by Claude.
├── ARCHITECTURE.md        # This file. System self-documentation.
├── .mcp.json              # MCP server config (auto-loaded by Claude Code)
├── .claude/skills/        # Claude Code skills (instructions for specific tasks)
└── crons/                 # Cron jobs (one .md file per job, YAML frontmatter + prompt)
```

## How Things Work

### Messages
1. Grammy bot receives Telegram message (text, voice, or photo), checks allowlist
2. Voice notes: downloaded from Telegram, transcribed via ElevenLabs Scribe v2, treated as text
3. Photos: downloaded, saved to workspace/tmp/, file path included in prompt
4. Message stored in `messages.json` with chatId, messageId, replyTo, text, from (user/bot)
5. If message is a reply: walks the reply chain from messages.json to assemble thread context
6. If not a reply: includes recent conversation history as context
7. Builds prompt: `[chat_id, message_id]` + `<thread_context>` + current message
8. Spawns `claude -p --continue "<prompt>" --output-format text` (resumes conversation)
9. Claude Code manages its own context window with built-in compaction
10. Claude Code loads CLAUDE.md + .mcp.json automatically
11. Claude uses Telegram MCP tools (send_message, etc.) to reply directly
12. If Claude doesn't use MCP tools, harness sends stdout as fallback
13. `/new` command starts a fresh session (no `--continue`)

### Message Debouncing
Rapid messages (within 3 seconds) are batched into a single Claude invocation.
This prevents wasted compute when the user sends multiple messages quickly.

### Crons
1. Markdown files in `workspace/crons/` — one `.md` file per job (YAML frontmatter + prompt body)
2. `src/cron.ts` parses files at startup and creates real cron timers via `croner`
3. Due crons spawn `claude -p` (fresh session)
4. Jobs execute serially via an internal queue (max 1 concurrent Claude session for crons)
5. Manage crons by editing `.md` files, then `/reload_crons` in Telegram. `/crons` shows status.

### Skills
Claude Code skills live in `.claude/skills/`. Each is a markdown file with instructions for a specific task. Claude reads them when relevant.

To add a skill:
1. Create `.claude/skills/<name>/SKILL.md`
2. Write clear instructions, commands, API patterns
3. Claude auto-discovers it from the workspace

### MCP Servers
Defined in `.mcp.json` at workspace root. Claude Code auto-loads them.

Built-in:
- `telegram` — send_message, send_photo, edit_message, delete_message, react, typing, ask_user

To add a new MCP server:
1. Build it (stdio transport, JSON-RPC)
2. Add entry to `.mcp.json`
3. Document the tools in CLAUDE.md or a skill file

### ask_user IPC
The `ask_user` MCP tool enables Claude to ask the user a question and block until they reply.
This works via filesystem-based IPC between the harness and the MCP server:
1. Claude calls `ask_user` → MCP server sends question to Telegram
2. MCP server writes a `.waiting` marker file
3. Harness sees the marker, routes the next user message to a `.reply` file instead of the queue
4. MCP server picks up the reply and returns it to Claude

## Dependencies

| Package | Purpose |
|---------|---------|
| grammy | Telegram Bot API |
| croner | Cron scheduling (real timers, timezone support) |
| gray-matter | YAML frontmatter parsing for cron files |
| @modelcontextprotocol/sdk | MCP server framework (telegram-mcp) |
