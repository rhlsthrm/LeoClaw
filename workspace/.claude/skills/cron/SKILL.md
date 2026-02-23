# Cron Management

Manage scheduled tasks via markdown files.

## Location
`workspace/crons/` — one `.md` file per job.

## File Format
```markdown
---
schedule: "0 9 * * 1-5"
timezone: America/New_York
chat_id: "YOUR_CHAT_ID"
enabled: true
---

The prompt body goes here. This is what Claude receives when the cron fires.
```

### Frontmatter Fields
- `schedule` (required) — standard 5-field cron expression
- `chat_id` (required) — Telegram chat ID to send results to
- `timezone` (optional, default `UTC`) — IANA timezone for schedule
- `enabled` (optional, default `true`) — set `false` to pause

### Body
Freeform markdown. This is the prompt Claude receives when the job fires.

### Filename
Kebab-case, becomes the job name. Example: `daily-summary.md` → job name `daily-summary`.

## Operations

### Add a cron
Create a new `.md` file in `workspace/crons/`, then tell the user to run `/reload_crons`.

### Edit a cron
Edit the `.md` file directly (schedule, prompt, enabled flag), then `/reload_crons`.

### Disable a cron
Set `enabled: false` in the frontmatter, then `/reload_crons`.

### Delete a cron
Delete the `.md` file, then `/reload_crons`.

### List crons
Use `/crons` in Telegram to see all jobs, their schedules, and next run times.

## Notes
- Changes require `/reload_crons` to take effect (no polling, uses real timers)
- Jobs run serially — if two fire at the same time, one queues behind the other
- Cron fires `claude -p "prompt"` (fresh session)
- Output is sent to chat_id via MCP tools; stdout is fallback

## Cron Schedule Cheat Sheet
```
*     = every
*/5   = every 5
1,3,5 = specific values
1-5   = range (Mon-Fri for dow)

Field order: minute hour day-of-month month day-of-week
  0 9 * * 1-5    = 9am weekdays
  0 23 * * *     = 11pm daily
  0 5 * * 2,5    = 5am Tue+Fri
  30 6 * * 0     = 6:30am Sunday
```
