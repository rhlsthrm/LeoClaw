# Memory System (Example)

This is an example memory skill. Customize it to fit your needs.

## Concept

A pillar-based memory architecture where information is organized into
life domains (pillars) with progressive disclosure.

## Directory Structure

```
memory/
  pillars/           # Compact index files (~500B-1.5KB each)
    work.md          # Work, career, projects
    health.md        # Health, fitness, medical
    personal.md      # Family, relationships, life events
  detail/            # Auto-created when a pillar section exceeds ~1.5KB
    work/            # e.g. specific project details
    health/          # e.g. detailed health tracking
  buffer/
    YYYY-MM-DD.md    # Daily append-only audit log
  decisions.md       # Cross-cutting decision log
  open-loops.md      # Active items needing follow-up
```

## Pillar File Format

```markdown
# Pillar Name

## Current
- Key fact 1
- Key fact 2

## Detail
- -> [topic](../detail/pillar/topic.md)

## Recent
- YYYY-MM-DD: What happened
```

## Read Flow (every message)

1. Classify the incoming message by topic
2. Read 0-2 relevant pillar files (they're small)
3. If deeper context needed, follow links to detail files
4. No history dependency? Skip memory entirely

## Write Flow

1. New fact learned → update the relevant pillar file
2. Append to `buffer/YYYY-MM-DD.md` (audit log, append-only)
3. Decisions → `decisions.md`
4. Open loops → `open-loops.md`

## Customization

Modify the pillar categories, file format, and read/write rules to
match your workflow. The key principle: keep pillar files small and
scannable, push detail into linked files.
