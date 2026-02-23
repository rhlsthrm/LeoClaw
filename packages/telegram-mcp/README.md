# @leoclaw/telegram-mcp

Minimal Telegram MCP server for Claude Code. Lets Claude talk to users directly via Telegram Bot API instead of returning stdout.

## Tools

| Tool | Description |
|------|-------------|
| `send_message` | Send text with Markdown formatting |
| `send_photo` | Send photo by URL or file_id |
| `edit_message` | Edit an existing message |
| `delete_message` | Delete a message |
| `react` | Add emoji reaction |
| `typing` | Show typing indicator |

## Setup

Add to `.mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["../packages/telegram-mcp/dist/index.js"]
    }
  }
}
```

Set `TELEGRAM_BOT_TOKEN` in your shell or service environment before launching Claude Code.
