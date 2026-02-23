/**
 * Cron module — markdown-file-based cron scheduling.
 *
 * Each .md file in the crons directory defines a job:
 *   frontmatter: schedule, timezone, chat_id, enabled
 *   body: the prompt Claude receives
 *
 * Uses croner for real cron scheduling (no polling).
 * Jobs execute serially via an internal queue.
 */

import { Cron } from "croner";
import matter from "gray-matter";
import { readdirSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

// --- Types ---

interface CronJob {
  name: string;
  schedule: string;
  timezone: string;
  chatId: string;
  enabled: boolean;
  prompt: string;
  cronInstance: Cron | null;
  error?: string;
}

type RunClaudeFn = (
  chatId: string,
  prompt: string,
) => Promise<string>;

type SendToChatFn = (chatId: string, text: string) => Promise<void>;

// --- Module ---

export function createCronModule(
  cronsDir: string,
  runClaude: RunClaudeFn,
  sendToChat: SendToChatFn
) {
  let jobs: CronJob[] = [];
  const queue: CronJob[] = [];
  let running = false;

  function parseCronFile(filePath: string): CronJob {
    const name = basename(filePath, ".md");
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
        prompt: "",
        cronInstance: null,
        error: "Invalid YAML frontmatter",
      };
    }

    const { schedule, timezone, chat_id, enabled } = parsed.data;

    if (!schedule || !chat_id) {
      return {
        name,
        schedule: schedule || "",
        timezone: timezone || "UTC",
        chatId: chat_id || "",
        enabled: false,
        prompt: parsed.content.trim(),
        cronInstance: null,
        error: `Missing required field: ${!schedule ? "schedule" : "chat_id"}`,
      };
    }

    return {
      name,
      schedule,
      timezone: timezone || "UTC",
      chatId: String(chat_id),
      enabled: enabled !== false,
      prompt: parsed.content.trim(),
      cronInstance: null,
    };
  }

  function enqueue(job: CronJob): void {
    queue.push(job);
    processQueue();
  }

  async function processQueue(): Promise<void> {
    if (running) return;
    running = true;

    while (queue.length > 0) {
      const job = queue.shift()!;
      console.log(`[cron] Firing: ${job.name}`);

      try {
        const cronPrompt = `[chat_id: ${job.chatId}, cron: ${job.name}]\n\nUse the telegram MCP tools to send your response directly to chat_id ${job.chatId}.\n\n${job.prompt}`;
        const response = await runClaude(
          `cron-${job.name}`,
          cronPrompt,
        );
        if (response && !response.startsWith("[") && response.length > 5) {
          await sendToChat(job.chatId, `🕐 *${job.name}*\n\n${response}`);
        }
      } catch (err: any) {
        console.error(`[cron] "${job.name}" failed:`, err.message);
        await sendToChat(
          job.chatId,
          `❌ Cron "${job.name}" failed: ${err.message.slice(0, 200)}`
        );
      }
    }

    running = false;
  }

  function loadAndSchedule(): void {
    if (!existsSync(cronsDir)) {
      mkdirSync(cronsDir, { recursive: true });
      console.log(`[cron] Created crons directory: ${cronsDir}`);
    }

    const files = readdirSync(cronsDir).filter((f) => f.endsWith(".md"));
    jobs = [];

    for (const file of files) {
      const job = parseCronFile(join(cronsDir, file));
      jobs.push(job);

      if (job.error) {
        console.warn(`[cron] Skipped "${job.name}": ${job.error}`);
        continue;
      }

      if (!job.enabled) {
        console.log(`[cron] Paused: ${job.name}`);
        continue;
      }

      try {
        job.cronInstance = new Cron(job.schedule, { timezone: job.timezone }, () => {
          enqueue(job);
        });
        console.log(
          `[cron] Scheduled: ${job.name} (${job.schedule}, ${job.timezone})`
        );
      } catch (err: any) {
        job.error = `Bad cron expression: ${err.message}`;
        console.warn(`[cron] Skipped "${job.name}": ${job.error}`);
      }
    }
  }

  function stopAll(): void {
    for (const job of jobs) {
      job.cronInstance?.stop();
      job.cronInstance = null;
    }
  }

  function start(): void {
    loadAndSchedule();
    const active = jobs.filter((j) => j.cronInstance).length;
    console.log(`[cron] Loaded ${jobs.length} jobs (${active} active)`);
  }

  function reload(): { total: number; active: number } {
    stopAll();
    loadAndSchedule();
    const active = jobs.filter((j) => j.cronInstance).length;
    console.log(`[cron] Reloaded: ${jobs.length} jobs (${active} active)`);
    return { total: jobs.length, active };
  }

  function listJobs(): CronJob[] {
    return jobs.map((j) => ({
      ...j,
      cronInstance: j.cronInstance,
    }));
  }

  return { start, reload, stopAll, listJobs };
}
