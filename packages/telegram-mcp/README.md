# @leoclaw/telegram-mcp

Minimal MCP server that exposes Telegram Bot API actions as tools for Claude Code.

## Tools

| Tool | Description |
|------|-------------|
| `send_message` | Send text (HTML formatting) |
| `send_photo` | Send photo (URL, file_id, or local path) |
| `edit_message` | Edit an existing message |
| `delete_message` | Delete a message |
| `react` | Add emoji reaction |
| `typing` | Show typing indicator |
| `ask_user` | Ask user a question and wait for reply (IPC-based) |

## Setup

```bash
pnpm install
pnpm build
```

## Environment

- `TELEGRAM_BOT_TOKEN` (required) — Your bot token from @BotFather
- `LEO_IPC_DIR` (optional) — IPC directory for ask_user (default: `/tmp/leo-ipc`)
