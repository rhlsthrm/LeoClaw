# 🦁 LeoClaw

Thin Telegram bridge to Claude Code. No SDK, no per-token billing. Flat-rate via your existing Claude Max subscription.

Named after my dog Leo, my best pal in the world. When I talk to my bot, it feels like talking to my furry bud who's eternally patient and helpful with me. That's the vibe I wanted.

## Architecture

```mermaid
flowchart LR
    T[Telegram] -->|reply| R[claude --resume]
    T -->|new msg| F[claude --session-id]
    CR[Cron / Task] --> S[claude -p]
    R -->|MCP tools| T
    F -->|MCP tools| T
    S -->|MCP tools| T
```

Reply to a message = Claude resumes the existing session. New message = fresh session. Crons and background tasks get their own sessions. Messages are serialized per chat (one Claude process at a time, the rest queue).

The outer loop is dumb plumbing. All intelligence lives in Claude Code via `CLAUDE.md`, `.claude/skills/`, `.claude/rules/`, and your workspace files. Zero agent infrastructure to maintain.

## Why

Different projects, different tradeoffs. LeoClaw bets on Claude Code being the agent so you don't have to build one.

| | OpenClaw | NanoClaw | **LeoClaw** |
|---|---------|----------|-------------|
| Lines of code | Large | ~5K | ~1K harness |
| Dependencies | Many | 20+ | 3 |
| Runtime | Custom agent + API | Agent SDK + containers | `claude` CLI |
| Cost | Per-token API | Per-token API / subscription | Max subscription (flat-rate) |
| Skills | Custom format | Custom format | Claude Code native |
| Memory | Custom system | Per-group files | Pillar-based (included) |

## Quick Start

```bash
git clone <this-repo>
cd LeoClaw
cp config.example.json config.json  # Edit non-secret runtime settings
pnpm install
pnpm dev
```

## Config

```json
{
  "allowedUsers": ["your-telegram-user-id"],
  "workspace": "/path/to/your/workspace",
  "claudePath": "/opt/homebrew/bin/claude",
  "dangerouslySkipPermissions": false,
  "model": "opus",
  "fallbackModel": "sonnet"
}
```

Runtime precedence is:
1. Environment variables (`LEO_*`, `TELEGRAM_BOT_TOKEN`)
2. `config.json`

Supported environment variables:
- `TELEGRAM_BOT_TOKEN` (required)
- `LEO_ALLOWED_USERS` (comma-separated IDs, e.g. `123,456`)
- `LEO_WORKSPACE`
- `LEO_CLAUDE_PATH`
- `LEO_DANGEROUSLY_SKIP_PERMISSIONS` (`true/false`)
- `LEO_MODEL` / `LEO_FALLBACK_MODEL`

## Secrets (macOS Keychain)

Store secrets in Keychain using the `leoclaw.*` naming convention:

```bash
# Telegram bot token (required)
security add-generic-password -a "$USER" -s "leoclaw.telegram_bot_token" -w "<token>" -U

# Any additional API keys your skills need
security add-generic-password -a "$USER" -s "leoclaw.<service_name>" -w "<key>" -U
```

Skills can read Keychain values in Python via `security find-generic-password -s leoclaw.<service_name> -w`, with env vars taking precedence. OAuth tokens or other read/write credentials that can't live in Keychain go in `secrets/` (gitignored).

Run Leo with the keychain wrapper:

```bash
./scripts/run-leo-with-keychain.sh
```

For launchd, use the template at `ops/launchd/com.leoclaw.bot.plist.example` and point it at `scripts/run-leo-with-keychain.sh`.

## Secret Scanning

Enable local pre-commit secret scanning:

```bash
brew install gitleaks
./scripts/setup-git-hooks.sh
```

CI scanning is enabled via `.github/workflows/secret-scan.yml` using `.gitleaks.toml`.

## Commands

- **Any text** — sent to Claude Code with a fresh session
- **Reply to a message** — resumes the Claude session that produced it
- **Voice/audio** — transcribed via Gemini, then processed as text
- **Photos** — downloaded and passed to Claude as image input
- **Callback buttons** — inline keyboard presses routed back to Claude
- `/stop` — abort all running Claude processes and clear the queue
- `/crons` — list active launchd cron agents
- `/compile_crons` — recompile cron markdown files to launchd agents
- `/tasks` — list running background tasks

## Project Structure

```
LeoClaw/
├── src/index.ts              # Harness: bot, queue, session management, task watcher
├── packages/telegram-mcp/    # MCP server (10 Telegram Bot API tools)
├── scripts/
│   ├── compile-crons.ts      # Cron .md → launchd plist compiler
│   ├── run-cron.sh           # Cron runner (spawns claude -p)
│   └── run-leo-with-keychain.sh
├── config.json               # Runtime settings (gitignored)
├── config.example.json
├── sessions.json             # Message → session mappings (gitignored)
└── workspace/                # Claude Code workspace
    ├── CLAUDE.md             # Identity + context
    ├── .claude/skills/       # Claude Code skills
    ├── .claude/rules/        # Auto-loaded behavioral rules
    ├── memory/               # Pillar-based memory system
    └── crons/                # Cron job definitions (.md files)
```

The `workspace/` directory is where Claude Code runs. It contains identity, skills, rules, and memory. Photos sent via Telegram are saved to `workspace/tmp/` and are not cleaned up automatically.

### Fork Pattern

```
Public repo (upstream): glue code, README, config template (+ workspace ignored)
Private repo/fork:      + workspace/, config.json, your skills/memory
```

Pull glue code updates from upstream. Your personal stuff never leaves the private fork.

## How It Works

1. **Sessions**: Reply to a bot message = `claude --resume` (picks up where it left off). New message = `claude --session-id` (fresh session). If resume fails, auto-retries as fresh.
2. **Stream-JSON**: Claude is spawned with `--output-format stream-json`. The harness parses NDJSON events in real-time, detecting MCP tool calls from `assistant` events and extracting cost/session metadata from `result` events. The `result` text is used as fallback if no MCP reply was sent.
3. **Background tasks**: Claude can dispatch long-running work via `dispatch_task`. The harness watches an IPC directory, spawns a separate Claude process, and tracks it.
4. **Memory**: Pillar-based system in `workspace/memory/`. Three-tier retrieval (pillar files, QMD search, Telegram search). Nightly synthesis cron keeps it clean.
5. **Skills**: Standard `.claude/skills/` directory. Claude Code reads them automatically.
6. **Crons**: Markdown files in `workspace/crons/` compiled to launchd agents via `pnpm compile:crons`. Each gets its own session for reply threading.

By default, LeoClaw does not pass `--dangerously-skip-permissions`. Set `dangerouslySkipPermissions: true` only if you explicitly need unattended operation (e.g. crons that run shell commands). When enabled, Claude gets unrestricted shell access. Run this on dedicated/isolated hardware, not your daily driver.

## Skills

LeoClaw is extensible through Claude Code's native skill system. Skills are markdown files that live in `workspace/.claude/skills/` and teach the bot new capabilities without touching harness code.

```
workspace/.claude/skills/
├── memory/           # Pillar-based memory system
├── morning-briefing/ # Daily news digest
├── summarize/        # URL/podcast transcription
├── telegram/         # Telegram CLI search & messaging
├── grok-search/      # Web + X/Twitter search via Grok
└── ...               # Drop in your own
```

**Installing skills:**

```bash
# From skills.sh marketplace
npx @anthropic-ai/claude-code skills install <skill-name>

# Or manually: drop a SKILL.md into a new folder
mkdir -p workspace/.claude/skills/my-skill
# Add your SKILL.md with instructions
```

Skills are just instructions. No code to compile, no plugins to register. Claude Code reads them automatically and gains the capability. Want a skill that generates images? Monitors prices? Drafts tweets? Write a SKILL.md describing how, point it at the right APIs, and it works.

## Memory System

```mermaid
flowchart TD
    MSG[Incoming Message] --> CLS{Needs context?}
    CLS -->|no| SKIP[Reply directly]
    CLS -->|yes| T1[Tier 1: Pillar Files]

    T1 -->|hit| REPLY[Reply + Memory Footer]
    T1 -->|miss| T2[Tier 2: QMD Search]

    T2 -->|hit| REPLY
    T2 -->|miss| T3[Tier 3: Telegram Search]
    T3 --> REPLY

    MSG -->|new fact| WRITE[Update pillar + buffer]
    MSG -->|decision| DEC[decisions.md]
    MSG -->|open loop| OL[open-loops.md]

    NIGHT[Nightly: dedupe + prune] -.-> WRITE
```

LeoClaw ships with a pillar-based memory system out of the box. Instead of dumping everything into one giant context file, memory is organized into small index files ("pillars") covering life domains:

```
memory/pillars/
├── health.md       # Sleep, fitness, medical, supplements
├── finance.md      # Portfolio, investments, crypto
├── work.md         # Role, workstreams, team
├── projects.md     # Side projects, content, tools
└── family.md       # Family, friends, relationships
```

**How it works:**
- On every message, the bot classifies the topic and reads only the 0-2 relevant pillar files. No wasted context.
- New facts get written to the relevant pillar immediately, plus appended to a daily buffer log for audit.
- When a pillar section grows too large, it overflows into `memory/detail/` automatically.
- Every response ends with a transparent footer showing what memory was read and written: `📚 Read: health, work · Wrote: health (added sleep data)`

**Yours to customize.** The five default pillars are a starting point. Rename them, add new ones, merge or remove existing ones. The bot restructures on the fly. Want a "travel" pillar? A "reading-list" pillar? Just tell it.

## Disclaimer

I built this for myself because I wanted more control over my OpenClaw system. It works great for my setup, but it's a personal project first. If you hit bugs, sorry! PRs and issues are welcome.

## License

MIT
