# LeoClaw

A self-extending agent harness built on Claude Code. ~400 lines of plumbing that turns a Mac mini into a personal AI agent you talk to through Telegram.

Think [OpenClaw](https://github.com/nichochar/open-claw) but leaner: no SDK, no API costs, no framework. Just Claude Code as the runtime and Telegram as the interface.

## What is this?

LeoClaw spawns [Claude Code](https://docs.anthropic.com/en/docs/claude-code) as a child process and lets it do everything. Grammy receives Telegram messages, resumes the right Claude conversation based on threads, and Claude uses MCP tools to reply directly. The harness is plumbing. Claude is the agent.

No SDK. No API costs. No per-token billing. Just your Claude Max/Pro subscription and a Mac running 24/7.

## Why?

Most AI agent frameworks rebuild tool calling, context management, and agentic loops from scratch on top of raw API completions. LeoClaw goes the opposite direction: Claude Code already has a world-class agentic harness with tool calling, skills, MCP plugins, context compaction, and code-quality guarantees. Why rebuild any of that?

**Design goals:**

- **Use Claude Code's built-in agentic harness.** Threading, tool calling, skills, compaction, plugins, coding quality. Don't reinvent what already works.
- **Controllable context window.** Claude resumes conversations based on Telegram threads. Context is managed by Claude Code's own compaction, not an ever-growing prompt. `/new` starts a fresh session when you want a clean slate.
- **Telegram-only communication channel.** One interface, optimized for mobile. No web dashboard, no Slack, no Discord. Just Telegram.
- **Mac mini as hardware.** Physically accessible, always-on, with macOS Keychain for secrets and launchd for process management. No cloud dependencies.
- **Self-extending architecture.** The bot reads its own architecture docs and skill files. It knows how it's built and can add capabilities to itself.

## Architecture

```
Telegram User
    ↓ message (text, voice, photo)
Grammy Bot (src/index.ts)
    ↓ debounce rapid messages (3s window)
    ↓ voice? → ElevenLabs STT → text (optional)
    ↓ photo? → saved to workspace/tmp/
    ↓ build thread context from reply chain
    ↓ prepend [chat_id, message_id] metadata
Claude Code (claude -p --continue, resumes conversation)
    ↓ loads workspace/CLAUDE.md + .mcp.json
    ↓ uses MCP tools to reply
Telegram MCP Server
    ↓ send_message, send_photo, edit, delete, react, typing, ask_user
Telegram User
```

Conversations persist via Claude Code's `--continue` flag. Claude manages its own context window with built-in compaction. Thread context from reply chains is prepended to each prompt so Claude understands the Telegram conversation structure. `/new` starts a fresh session.

## Quick Start

### Prerequisites

- **macOS** (for Keychain integration; Linux works with env vars instead)
- **Node.js** 20+
- **pnpm** (`npm install -g pnpm`)
- **Claude Code** CLI installed (`npm install -g @anthropic-ai/claude-code`)
- **Claude Max or Pro subscription** (Claude Code requires one)
- **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)

### Setup

```bash
# Clone and install
git clone https://github.com/YOUR_USER/LeoClaw.git
cd LeoClaw
pnpm install

# Configure
cp config.example.json config.json
# Edit config.json: add your Telegram user ID to allowedUsers

# Set up workspace
cp workspace/CLAUDE.md.example workspace/CLAUDE.md
cp workspace/.mcp.json.example workspace/.mcp.json
# Edit workspace/CLAUDE.md: define your bot's identity and behavior

# Build
pnpm build

# Store bot token in Keychain (macOS)
security add-generic-password -a "$USER" -s "leoclaw.telegram_bot_token" -w 'YOUR_BOT_TOKEN' -U

# Run
pnpm start:keychain

# Or run with env var directly
TELEGRAM_BOT_TOKEN=your_token LEO_ALLOWED_USERS=your_telegram_id pnpm start
```

### Development

```bash
pnpm dev  # Watch mode with hot reload
```

### Run as a Service (macOS)

```bash
# Copy and edit the launchd plist
cp ops/launchd/com.leoclaw.bot.plist.example ~/Library/LaunchAgents/com.leoclaw.bot.plist
# Edit: replace YOUR_USER and paths

# Load
launchctl load ~/Library/LaunchAgents/com.leoclaw.bot.plist

# Check logs
tail -f logs/stdout.log
```

## Configuration

| Source | Example | Precedence |
|--------|---------|------------|
| Env var | `TELEGRAM_BOT_TOKEN=xxx` | Highest |
| Env var | `LEO_ALLOWED_USERS=123,456` | Highest |
| Env var | `LEO_WORKSPACE=./workspace` | Highest |
| Env var | `LEO_CLAUDE_PATH=claude` | Highest |
| Env var | `LEO_DANGEROUSLY_SKIP_PERMISSIONS=true` | Highest |
| config.json | `{"allowedUsers": ["123"]}` | Medium |
| Defaults | workspace=repo root, claude=PATH | Lowest |

## Project Structure

```
LeoClaw/
├── src/
│   ├── index.ts              # The harness (~400 lines)
│   └── cron.ts               # Markdown-based cron scheduling
├── packages/
│   └── telegram-mcp/         # MCP server for Telegram Bot API
│       └── src/index.ts      # 7 tools: send, photo, edit, delete, react, typing, ask_user
├── workspace/                # Claude's runtime workspace
│   ├── CLAUDE.md.example     # Bot identity template (copy to CLAUDE.md)
│   ├── ARCHITECTURE.md       # Self-knowledge doc
│   ├── .mcp.json.example     # MCP config template (copy to .mcp.json)
│   ├── .claude/skills/       # Skill definitions
│   │   ├── cron/SKILL.md     # Cron management instructions
│   │   └── memory/SKILL.md   # Memory system example
│   └── crons/                # Cron job definitions
│       └── example.md        # Sample cron job (disabled)
├── ops/launchd/              # macOS service template
├── scripts/                  # Keychain wrapper, git hooks
├── config.example.json       # Config template
├── CLAUDE.md                 # Dev instructions (for working on the harness)
└── .github/workflows/        # Secret scanning CI
```

## Key Concepts

### The Workspace

The `workspace/` directory is where all the intelligence lives. The harness code is just plumbing.

- **`workspace/CLAUDE.md`** — Your bot's identity, personality, rules, and behavior. This is loaded on every Claude invocation. Make it yours.
- **`workspace/ARCHITECTURE.md`** — The bot's self-knowledge. It reads this to understand how it's built, so it can extend itself.
- **`workspace/.mcp.json`** — MCP server configuration. Claude Code auto-loads this.
- **`workspace/.claude/skills/`** — Skill files that teach the bot how to do specific things.

### Skills

Skills are markdown files that teach Claude how to perform specific tasks. Drop a `SKILL.md` file in `.claude/skills/<name>/` and Claude auto-discovers it.

Example uses: memory management, cron scheduling, API integrations, content pipelines, code generation patterns.

### Crons

Scheduled tasks defined as markdown files in `workspace/crons/`. Each file has YAML frontmatter (schedule, timezone, chat_id) and a prompt body.

```markdown
---
schedule: "0 9 * * 1-5"
timezone: America/New_York
chat_id: "YOUR_CHAT_ID"
enabled: true
---

Good morning! Summarize the top 3 Hacker News stories.
```

Telegram commands:
- `/crons` — list all jobs and their next run times
- `/reload_crons` — reload after editing cron files

### Thread Context

Claude resumes conversations using `--continue`, so it has full memory of prior messages in the session. The harness also maintains a message store (`messages.json`) and walks Telegram reply chains to build thread context. This context is prepended to each prompt so Claude understands which message you're replying to and the conversation flow.

`/new` starts a fresh Claude session when you want a clean context window.

### Voice Notes

If you set up an [ElevenLabs](https://elevenlabs.io) API key, voice notes are automatically transcribed using Scribe v2 and processed as text. Optional.

```bash
# macOS Keychain
security add-generic-password -a "$USER" -s "leoclaw.elevenlabs_api_key" -w 'YOUR_KEY' -U

# Or env var
export ELEVENLABS_API_KEY=your_key
```

### Photos

Photos sent to the bot are downloaded, saved to `workspace/tmp/`, and the file path is included in the prompt. Claude can read the image (it's multimodal) and respond accordingly.

### ask_user

The `ask_user` MCP tool lets Claude ask you a question and wait for your reply before continuing. This enables multi-step workflows where Claude needs your input mid-task.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh session (clears greeting) |
| `/stop` | Abort the currently running Claude process |
| `/crons` | List all cron jobs and their status |
| `/reload_crons` | Reload cron jobs after editing files |

## Extending

The whole point is that the bot can extend itself. Because Claude Code reads the workspace files, you can:

1. **Add skills** — Create `.claude/skills/<name>/SKILL.md` with instructions
2. **Add MCP servers** — Build a new MCP server, add it to `.mcp.json`
3. **Add crons** — Create a `.md` file in `workspace/crons/`
4. **Change behavior** — Edit `workspace/CLAUDE.md`
5. **Add memory** — Implement a memory system via skills and workspace files
6. **Ask the bot to do it** — It reads `ARCHITECTURE.md` and knows how to modify itself

## Security

- **Allowlist** — Only configured Telegram user IDs can interact with the bot
- **Secret scanning** — Pre-commit hooks and CI via gitleaks
- **Keychain** — Bot token and API keys stored in macOS Keychain, not in files
- **Permission mode** — Claude Code runs with default permissions unless you explicitly set `dangerouslySkipPermissions`

## FAQ

**Why not use the Claude API directly?**
Claude Code gives you tool calling, skills, MCP plugins, context compaction, coding ability, and an agentic loop for free. The API gives you raw completions. Claude Code is the better agent harness.

**Why Telegram?**
It's fast, mobile-first, supports rich media, has a good bot API, and reply threading maps naturally to conversation context. One channel, optimized well.

**How does context work?**
Claude resumes conversations via `--continue`, so it has full memory within a session. Claude Code's built-in compaction handles context limits automatically. Reply chains from Telegram provide conversation structure. `/new` gives you a fresh session when context gets stale.

**Why Mac mini?**
Physical access means you can use Keychain for secrets, launchd for service management, and local tools (browsers, file system, etc.) that cloud VMs can't easily provide. The bot can ask you to physically intervene when needed.

**Can I run this on Linux?**
The harness itself is platform-agnostic. You'd replace Keychain with env vars or a different secret manager, and launchd with systemd. Everything else works as-is.

## License

MIT
