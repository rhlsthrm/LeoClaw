#!/usr/bin/env tsx
/**
 * Compile cron markdown files into macOS launchd agents.
 *
 * Reads workspace/crons/*.md, parses frontmatter, converts schedules
 * from their specified timezone to the system's local timezone, generates
 * plist files in ~/Library/LaunchAgents, and bootstraps them via launchctl.
 * Also cleans up any legacy crontab block from previous installations.
 *
 * Usage: tsx scripts/compile-crons.ts [--dry-run]
 */

import matter from "gray-matter";
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const CRONS_DIR = join(ROOT, "workspace", "crons");
const RUNNER = join(ROOT, "scripts", "run-cron.sh");
const MARKER_START = "# BEGIN LEOCLAW CRONS";
const MARKER_END = "# END LEOCLAW CRONS";

const dryRun = process.argv.includes("--dry-run");

// --- Types ---

interface CronEntry {
  name: string;
  schedule: string;
  timezone: string;
  chatId: string;
  enabled: boolean;
  silent: boolean;
  error?: string;
}

// --- Timezone conversion ---

/** Get UTC offset in minutes for a timezone (e.g., "UTC" -> 0, "Asia/Dubai" -> 240). */
function getTimezoneOffsetMinutes(tz: string): number {
  if (tz === "UTC" || tz === "GMT") return 0;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(new Date());
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  if (tzPart === "UTC" || tzPart === "GMT") return 0;
  const match = tzPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3] || "0", 10));
}

/** Get the system's local timezone name. */
function getSystemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Expand a cron field like "1-5" or "2,4" or "9,14" into individual values. */
function expandField(field: string, min: number, max: number): number[] {
  if (field === "*") return [];
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(\d+)-(\d+)\/(\d+)$/);
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (stepMatch) {
      const [, start, end, step] = stepMatch.map(Number);
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (rangeMatch) {
      const [, start, end] = rangeMatch.map(Number);
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }
  return [...values].sort((a, b) => a - b);
}

/** Compact sorted number array back into cron field (e.g., [1,2,3,4,5] -> "1-5"). */
function compactField(values: number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length === 0) return "*";
  if (sorted.length === 1) return String(sorted[0]);

  // Detect contiguous ranges
  const ranges: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      end = sorted[++i];
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    i++;
  }
  return ranges.join(",");
}

/**
 * Convert a cron expression from one timezone to another.
 * Only handles whole-hour offsets. Handles hour wrap and day-of-week shift.
 *
 * Note: Does NOT handle DST transitions. Works correctly for fixed-offset
 * timezones (UTC, Asia/Dubai, etc.).
 */
function convertScheduleTimezone(
  schedule: string,
  fromTz: string,
  toTz: string,
): string {
  const fromOffset = getTimezoneOffsetMinutes(fromTz);
  const toOffset = getTimezoneOffsetMinutes(toTz);
  const deltaMinutes = toOffset - fromOffset;

  if (deltaMinutes === 0) return schedule;

  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Skip conversion for wildcard/step hours (e.g., "*/2", "*")
  if (hour === "*" || hour.includes("/")) {
    return schedule;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  const deltaMin = deltaMinutes % 60;

  // Handle minute offset (rare, but support it)
  let minuteValues: number[] | null = null;
  let extraHourCarry = 0;
  if (deltaMin !== 0 && minute !== "*") {
    const mins = expandField(minute, 0, 59);
    minuteValues = mins.map((m) => {
      const newM = m + deltaMin;
      if (newM >= 60) {
        extraHourCarry = 1;
        return newM - 60;
      }
      if (newM < 0) {
        extraHourCarry = -1;
        return newM + 60;
      }
      return newM;
    });
  }

  // Convert hours
  const hourValues = expandField(hour, 0, 23);
  const totalHourShift = deltaHours + extraHourCarry;

  const convertedHours: number[] = [];
  const dayShifts = new Set<number>();

  for (const h of hourValues) {
    let newHour = h + totalHourShift;
    let dayShift = 0;
    while (newHour >= 24) {
      newHour -= 24;
      dayShift += 1;
    }
    while (newHour < 0) {
      newHour += 24;
      dayShift -= 1;
    }
    convertedHours.push(newHour);
    dayShifts.add(dayShift);
  }

  // Check for mixed day shifts (different hours wrapping differently)
  const shifts = [...dayShifts];
  if (shifts.length > 1) {
    console.warn(
      `  Warning: Hours in "${schedule}" wrap across midnight differently. Using unconverted schedule.`,
    );
    return schedule;
  }

  const dayShift = shifts[0] ?? 0;
  const newHour = compactField(convertedHours);
  const newMinute = minuteValues ? compactField(minuteValues) : minute;

  // Shift day-of-week if needed
  let newDow = dayOfWeek;
  if (dayShift !== 0 && dayOfWeek !== "*") {
    const dowValues = expandField(dayOfWeek, 0, 6);
    const shifted = dowValues.map((d) => (((d + dayShift) % 7) + 7) % 7);
    newDow = compactField(shifted);
  }

  return `${newMinute} ${newHour} ${dayOfMonth} ${month} ${newDow}`;
}

// --- Launchd plist generation ---

interface CalendarInterval {
  Month?: number;
  Day?: number;
  Weekday?: number;
  Hour?: number;
  Minute?: number;
}

/**
 * Convert a local-timezone cron expression into launchd StartCalendarInterval dicts.
 * Expands multi-value fields into the cartesian product of intervals.
 */
function cronToCalendarIntervals(localSchedule: string): CalendarInterval[] {
  const parts = localSchedule.trim().split(/\s+/);
  if (parts.length !== 5) return [{}];

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const minutes = minute === "*" || minute.includes("/") ? [] : expandField(minute, 0, 59);
  const hours = hour === "*" || hour.includes("/") ? [] : expandField(hour, 0, 23);
  const doms = dayOfMonth === "*" ? [] : expandField(dayOfMonth, 1, 31);
  const months = month === "*" ? [] : expandField(month, 1, 12);
  const dows = dayOfWeek === "*" ? [] : expandField(dayOfWeek, 0, 6);

  if (minute.includes("/") || hour.includes("/")) {
    const base: CalendarInterval = {};
    if (minutes.length === 1) base.Minute = minutes[0];
    if (hours.length === 1) base.Hour = hours[0];
    if (doms.length === 1) base.Day = doms[0];
    if (months.length === 1) base.Month = months[0];
    if (dows.length === 1) base.Weekday = dows[0];
    return [base];
  }

  let intervals: CalendarInterval[] = [{}];

  if (minutes.length === 1) {
    for (const iv of intervals) iv.Minute = minutes[0];
  } else if (minutes.length > 1) {
    intervals = minutes.flatMap((m) => intervals.map((iv) => ({ ...iv, Minute: m })));
  }

  if (hours.length === 1) {
    for (const iv of intervals) iv.Hour = hours[0];
  } else if (hours.length > 1) {
    intervals = hours.flatMap((h) => intervals.map((iv) => ({ ...iv, Hour: h })));
  }

  if (doms.length === 1) {
    for (const iv of intervals) iv.Day = doms[0];
  } else if (doms.length > 1) {
    intervals = doms.flatMap((d) => intervals.map((iv) => ({ ...iv, Day: d })));
  }

  if (months.length === 1) {
    for (const iv of intervals) iv.Month = months[0];
  } else if (months.length > 1) {
    intervals = months.flatMap((m) => intervals.map((iv) => ({ ...iv, Month: m })));
  }

  if (dows.length === 1) {
    for (const iv of intervals) iv.Weekday = dows[0];
  } else if (dows.length > 1) {
    intervals = dows.flatMap((w) => intervals.map((iv) => ({ ...iv, Weekday: w })));
  }

  return intervals;
}

const LABEL_PREFIX = "com.leoclaw.cron";
const LAUNCH_AGENTS_DIR = join(
  process.env.HOME || "/Users/rahul",
  "Library",
  "LaunchAgents",
);

function calendarIntervalToXml(iv: CalendarInterval, indent: string): string {
  const lines = [`${indent}<dict>`];
  if (iv.Month !== undefined) lines.push(`${indent}  <key>Month</key>`, `${indent}  <integer>${iv.Month}</integer>`);
  if (iv.Day !== undefined) lines.push(`${indent}  <key>Day</key>`, `${indent}  <integer>${iv.Day}</integer>`);
  if (iv.Weekday !== undefined) lines.push(`${indent}  <key>Weekday</key>`, `${indent}  <integer>${iv.Weekday}</integer>`);
  if (iv.Hour !== undefined) lines.push(`${indent}  <key>Hour</key>`, `${indent}  <integer>${iv.Hour}</integer>`);
  if (iv.Minute !== undefined) lines.push(`${indent}  <key>Minute</key>`, `${indent}  <integer>${iv.Minute}</integer>`);
  lines.push(`${indent}</dict>`);
  return lines.join("\n");
}

function buildPlistXml(entry: CronEntry, localSchedule: string): string {
  const label = `${LABEL_PREFIX}.${entry.name}`;
  const intervals = cronToCalendarIntervals(localSchedule);

  let calendarXml: string;
  if (intervals.length === 1) {
    calendarXml = calendarIntervalToXml(intervals[0], "    ");
  } else {
    const items = intervals.map((iv) => calendarIntervalToXml(iv, "      ")).join("\n");
    calendarXml = `    <array>\n${items}\n    </array>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${RUNNER}</string>
        <string>${entry.name}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${join(ROOT, "workspace")}</string>
    <key>StartCalendarInterval</key>
${calendarXml}
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${process.env.HOME || "/Users/rahul"}</string>
        <key>LEO_KEYCHAIN_SERVICE</key>
        <string>leoclaw.telegram_bot_token</string>
        <key>LEO_KEYCHAIN_ACCOUNT</key>
        <string>${process.env.USER || "rahul"}</string>
        <key>LEO_CLAUDE_PATH</key>
        <string>/opt/homebrew/bin/claude</string>
        <key>LEO_DANGEROUSLY_SKIP_PERMISSIONS</key>
        <string>${process.env.LEO_DANGEROUSLY_SKIP_PERMISSIONS || "false"}</string>
    </dict>
</dict>
</plist>`;
}

const UID = process.getuid?.() ?? 501;
const DOMAIN_TARGET = `gui/${UID}`;

function bootoutExistingPlists(): string[] {
  const removed: string[] = [];
  if (!existsSync(LAUNCH_AGENTS_DIR)) return removed;

  const files = readdirSync(LAUNCH_AGENTS_DIR).filter(
    (f) => f.startsWith(`${LABEL_PREFIX}.`) && f.endsWith(".plist"),
  );

  for (const file of files) {
    const label = file.replace(".plist", "");
    const plistPath = join(LAUNCH_AGENTS_DIR, file);
    try {
      spawnSync("launchctl", ["bootout", `${DOMAIN_TARGET}/${label}`], {
        timeout: 5000,
      });
    } catch {}
    try {
      unlinkSync(plistPath);
    } catch {}
    removed.push(label);
  }

  return removed;
}

function bootstrapPlist(plistPath: string): { ok: boolean; error?: string } {
  const result = spawnSync("launchctl", ["bootstrap", DOMAIN_TARGET, plistPath], {
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.error?.message || "unknown error").trim() };
  }
  return { ok: true };
}

function removeCrontabBlock(): boolean {
  const current = getCurrentCrontab();
  const startIdx = current.indexOf(MARKER_START);
  const endIdx = current.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) return false;

  const before = current.slice(0, startIdx).trimEnd();
  const after = current.slice(endIdx + MARKER_END.length).trimStart();
  const merged = before + (after ? "\n\n" + after : "") + "\n";

  const tmpFile = join(ROOT, ".crontab.tmp");
  writeFileSync(tmpFile, merged);
  const result = spawnSync("crontab", [tmpFile], { encoding: "utf-8", timeout: 30000 });
  try { unlinkSync(tmpFile); } catch {}

  if (result.status !== 0) {
    console.warn(
      "  Warning: Could not update crontab automatically.",
      "\n  Run manually: crontab -l | sed '/# BEGIN LEOCLAW CRONS/,/# END LEOCLAW CRONS/d' | crontab -",
    );
    return false;
  }
  return true;
}

// --- Cron file parsing ---

function parseCronFile(filePath: string): CronEntry {
  const name = basename(filePath, ".md");

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return {
      name,
      schedule: "",
      timezone: "UTC",
      chatId: "",
      enabled: false,
      silent: false,
      error: `Invalid cron name: "${name}" (only alphanumeric, - and _ allowed)`,
    };
  }

  const raw = readFileSync(filePath, "utf-8");

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    return {
      name,
      schedule: "",
      timezone: "UTC",
      chatId: "",
      enabled: false,
      silent: false,
      error: "Invalid YAML frontmatter",
    };
  }

  const { schedule, timezone, chat_id, enabled, silent } = parsed.data;

  if (!schedule || !chat_id) {
    return {
      name,
      schedule: schedule || "",
      timezone: timezone || "UTC",
      chatId: chat_id || "",
      enabled: false,
      silent: false,
      error: `Missing required field: ${!schedule ? "schedule" : "chat_id"}`,
    };
  }

  return {
    name,
    schedule,
    timezone: timezone || "UTC",
    chatId: String(chat_id),
    enabled: enabled !== false,
    silent: silent === true,
  };
}

// --- Crontab (legacy, used for cleanup) ---

function getCurrentCrontab(): string {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
  } catch {
    return "";
  }
}

// --- Main ---

const systemTz = getSystemTimezone();
console.log(`System timezone: ${systemTz}`);
console.log(`Crons directory: ${CRONS_DIR}`);
console.log("");

const files = readdirSync(CRONS_DIR).filter((f) => f.endsWith(".md"));
const entries: CronEntry[] = files.map((f) =>
  parseCronFile(join(CRONS_DIR, f)),
);

console.log(`Found ${entries.length} cron files:`);
for (const e of entries) {
  const status = e.error
    ? `  ${e.error}`
    : e.enabled
      ? "ok"
      : "disabled";
  const schedInfo = e.enabled && !e.error ? ` (${e.schedule} ${e.timezone})` : "";
  console.log(`  ${e.name}: ${status}${schedInfo}`);
}

const enabled = entries.filter((e) => e.enabled && !e.error);

if (dryRun) {
  console.log("\n--- DRY RUN: Generated plist files ---\n");
  for (const entry of enabled) {
    const localSchedule = convertScheduleTimezone(entry.schedule, entry.timezone, systemTz);
    const xml = buildPlistXml(entry, localSchedule);
    const filename = `${LABEL_PREFIX}.${entry.name}.plist`;
    console.log(`=== ${filename} ===`);
    console.log(`Schedule: ${entry.schedule} ${entry.timezone} -> ${localSchedule} ${systemTz}`);
    console.log(xml);
    console.log("");
  }
  console.log(`${enabled.length} plist files would be generated.`);
  process.exit(0);
}

// 1. Bootout existing plists
const removed = bootoutExistingPlists();
if (removed.length > 0) {
  console.log(`\nUnloaded ${removed.length} existing plist(s).`);
}

// 2. Generate and bootstrap new plists
mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });

let loaded = 0;
let failed = 0;
for (const entry of enabled) {
  const localSchedule = convertScheduleTimezone(entry.schedule, entry.timezone, systemTz);
  const xml = buildPlistXml(entry, localSchedule);
  const filename = `${LABEL_PREFIX}.${entry.name}.plist`;
  const plistPath = join(LAUNCH_AGENTS_DIR, filename);

  writeFileSync(plistPath, xml);

  const result = bootstrapPlist(plistPath);
  if (result.ok) {
    console.log(`  Loaded: ${entry.name} (${entry.schedule} ${entry.timezone} -> ${localSchedule})`);
    loaded++;
  } else {
    console.error(`  FAILED: ${entry.name}: ${result.error}`);
    failed++;
  }
}

// 3. Clean up old crontab block
const hadCrontab = removeCrontabBlock();
if (hadCrontab) {
  console.log("\nRemoved old LEOCLAW CRONS block from crontab.");
}

console.log(`\nInstalled ${loaded} launchd agent(s)${failed > 0 ? `, ${failed} failed` : ""}.`);
if (loaded > 0) {
  console.log("Verify with: launchctl list | grep com.leoclaw.cron");
}
