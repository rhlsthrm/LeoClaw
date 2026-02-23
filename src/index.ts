#!/usr/bin/env node
/**
 * LeoClaw — Thin Telegram bridge to Claude Code.
 *
 * Architecture: Telegram message → walk reply chain → claude -p (stateless) → Telegram reply
 * No SDK, no API, no per-token cost. Just your Max subscription.
 *
 * Context comes from reply chains, not session state. Each invocation is fresh.
 * Crons: Markdown files in workspace/crons/.
 */

import { Bot, BotError, Context } from "grammy";
import { spawn, ChildProcess, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createCronModule } from "./cron.js";

// --- Types ---
interface ConfigFile {
  allowedUsers?: string[];
  workspace?: string;
  claudePath?: string;
  dangerouslySkipPermissions?: boolean;
}

interface StoredMessage {
  messageId: number;
  chatId: string;
  text: string;
  from: "user" | "leo";
  replyTo?: number;
  timestamp: number;
}

// --- Config ---
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const CONFIG_FILE = join(ROOT, "config.json");
const MAX_MSG_LEN = 4096;
const MSG_STORE_FILE = join(ROOT, "messages.json");
const MSG_STORE_CAP = 100; // per chat

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseAllowedUsersEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function loadConfigFile(): ConfigFile {
  if (!existsSync(CONFIG_FILE)) return {};
  return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as ConfigFile;
}

const configFile = loadConfigFile();
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  throw new Error(
    "Missing Telegram bot token. Set TELEGRAM_BOT_TOKEN (recommended via keychain wrapper)."
  );
}

const allowedUsers = parseAllowedUsersEnv(process.env.LEO_ALLOWED_USERS)
  ?? configFile.allowedUsers?.map(String);
if (!allowedUsers?.length) {
  throw new Error(
    "Missing allowed users. Set LEO_ALLOWED_USERS (comma-separated IDs) or config.json.allowedUsers."
  );
}

const BOT_TOKEN = botToken;
const ALLOWED_USERS = new Set(allowedUsers);
const WORKSPACE = process.env.LEO_WORKSPACE || configFile.workspace || ROOT;
const CLAUDE_PATH = process.env.LEO_CLAUDE_PATH || configFile.claudePath || "claude";
const DANGEROUSLY_SKIP_PERMISSIONS =
  parseBooleanEnv(process.env.LEO_DANGEROUSLY_SKIP_PERMISSIONS)
  ?? configFile.dangerouslySkipPermissions
  ?? false;

// --- Message Store ---
function loadMessageStore(): Map<string, StoredMessage[]> {
  if (!existsSync(MSG_STORE_FILE)) return new Map();
  try {
    const data = JSON.parse(readFileSync(MSG_STORE_FILE, "utf-8")) as Record<string, StoredMessage[]>;
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveMessageStore(store: Map<string, StoredMessage[]>): void {
  const obj: Record<string, StoredMessage[]> = {};
  for (const [k, v] of store) obj[k] = v;
  const tmp = MSG_STORE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, MSG_STORE_FILE);
}

const messageStore = loadMessageStore();

function storeMessage(msg: StoredMessage): void {
  const msgs = messageStore.get(msg.chatId) ?? [];
  msgs.push(msg);
  // Prune oldest if over cap
  if (msgs.length > MSG_STORE_CAP) {
    msgs.splice(0, msgs.length - MSG_STORE_CAP);
  }
  messageStore.set(msg.chatId, msgs);
  saveMessageStore(messageStore);
}

function walkReplyChain(chatId: string, messageId: number): StoredMessage[] {
  const msgs = messageStore.get(chatId) ?? [];
  const byId = new Map(msgs.map((m) => [m.messageId, m]));
  const chain: StoredMessage[] = [];

  let current = byId.get(messageId);
  while (current) {
    chain.unshift(current);
    current = current.replyTo ? byId.get(current.replyTo) : undefined;
  }

  return chain;
}

function formatThreadContext(chain: StoredMessage[], currentMsgId: number): string {
  if (chain.length <= 1) return "";

  // Exclude the current message (it gets added separately)
  const history = chain.filter((m) => m.messageId !== currentMsgId);
  if (!history.length) return "";

  const lines = history.map((m) => {
    const role = m.from === "user" ? "User" : "Leo";
    return `[${role}]: ${m.text}`;
  });

  return `<thread_context>\n${lines.join("\n\n")}\n</thread_context>\n\n`;
}

function getRecentMessages(chatId: string, limit = 20): StoredMessage[] {
  const msgs = messageStore.get(chatId) ?? [];
  return msgs.slice(-limit);
}

function ingestOutbox(chatId: string): void {
  const outboxPath = join(IPC_DIR, `${chatId}.outbox.jsonl`);
  if (!existsSync(outboxPath)) return;
  try {
    const content = readFileSync(outboxPath, "utf-8").trim();
    if (!content) { unlinkSync(outboxPath); return; }
    const lines = content.split("\n").filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as {
        message_id: number;
        chat_id: string;
        text: string;
        reply_to_message_id?: number;
        timestamp: number;
      };
      const msgs = messageStore.get(chatId) ?? [];
      if (!msgs.some((m) => m.messageId === entry.message_id)) {
        storeMessage({
          messageId: entry.message_id,
          chatId: entry.chat_id,
          text: entry.text,
          from: "leo",
          replyTo: entry.reply_to_message_id,
          timestamp: entry.timestamp,
        });
      }
    }
    unlinkSync(outboxPath);
    console.log(`[outbox] ingested ${lines.length} messages for ${chatId}`);
  } catch (err: any) {
    console.error(`[outbox] ingest failed for ${chatId}:`, err.message);
    try { unlinkSync(outboxPath); } catch {}
  }
}

// --- ElevenLabs STT ---
function getElevenLabsKey(): string {
  const envKey = process.env.ELEVENLABS_API_KEY;
  if (envKey) return envKey;
  try {
    return execSync("security find-generic-password -s leoclaw.elevenlabs_api_key -w", {
      encoding: "utf-8",
    }).trim();
  } catch {
    throw new Error("ELEVENLABS_API_KEY not found in env or Keychain");
  }
}

async function transcribeVoice(fileUrl: string): Promise<string> {
  const apiKey = getElevenLabsKey();

  // Download the voice file from Telegram
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Failed to download voice: ${response.status}`);
  const audioBuffer = Buffer.from(await response.arrayBuffer());

  // Send to ElevenLabs Scribe
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");

  const sttResponse = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });

  if (!sttResponse.ok) {
    const errText = await sttResponse.text();
    throw new Error(`ElevenLabs STT failed (${sttResponse.status}): ${errText}`);
  }

  const result = await sttResponse.json() as { text: string };
  return result.text;
}

// --- IPC (ask_user) ---
const IPC_DIR = "/tmp/leo-ipc";

function isWaitingForReply(chatId: string): boolean {
  return existsSync(join(IPC_DIR, `${chatId}.waiting`));
}

function deliverReply(chatId: string, text: string): void {
  mkdirSync(IPC_DIR, { recursive: true });
  writeFileSync(join(IPC_DIR, `${chatId}.reply`), text, "utf-8");
}

// --- State ---
const activeRuns = new Map<string, AbortController>();
const messageQueue = new Map<string, { text: string; messageId: number; replyTo?: number }[]>();
const processing = new Set<string>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 3000;

function scheduleProcessing(chatId: string, ctx: Context): void {
  // If already processing, the while loop in processQueue picks up queued messages
  if (processing.has(chatId)) return;

  const existing = debounceTimers.get(chatId);
  if (existing) clearTimeout(existing);

  debounceTimers.set(chatId, setTimeout(() => {
    debounceTimers.delete(chatId);
    if (!processing.has(chatId)) {
      processQueue(chatId, ctx);
    }
  }, DEBOUNCE_MS));
}

// --- Bot ---
const bot = new Bot<Context>(BOT_TOKEN);

bot.use(async (ctx, next) => {
  const userId = String(ctx.from?.id);
  if (!ALLOWED_USERS.has(userId)) return;

  // Backfill: if replying to a bot message not in the store, capture it
  const reply = ctx.message?.reply_to_message;
  if (reply?.from?.is_bot && reply.text) {
    const chatId = String(ctx.chat!.id);
    const msgs = messageStore.get(chatId) ?? [];
    if (!msgs.some((m) => m.messageId === reply.message_id)) {
      storeMessage({
        messageId: reply.message_id,
        chatId,
        text: reply.text,
        from: "leo",
        replyTo: (reply as any).reply_to_message?.message_id as number | undefined,
        timestamp: (reply.date ?? 0) * 1000,
      });
    }
  }

  await next();
});

bot.command("new", async (ctx) => {
  await ctx.reply("Fresh session started. 🧹");
});

bot.command("stop", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const controller = activeRuns.get(chatId);
  if (controller) {
    controller.abort();
    activeRuns.delete(chatId);
    await ctx.reply("Stopped. ✋");
  } else {
    await ctx.reply("Nothing running.");
  }
});

bot.command("crons", async (ctx) => {
  const jobs = cronModule.listJobs();
  if (!jobs.length) {
    await ctx.reply("No crons configured.");
    return;
  }
  const lines = jobs.map((j) => {
    const status = j.error ? "⚠️" : j.enabled ? "✅" : "⏸️";
    const next = j.cronInstance?.nextRun()?.toISOString() ?? "—";
    let line = `${status} *${j.name}*\n   \`${j.schedule}\` (${j.timezone})\n   Next: ${next}`;
    if (j.error) line += `\n   Error: ${j.error}`;
    return line;
  });
  await ctx.reply(lines.join("\n\n"), { parse_mode: "Markdown" });
});

bot.command("reload_crons", async (ctx) => {
  const { total, active } = cronModule.reload();
  await ctx.reply(`Reloaded. ${total} jobs found, ${active} active.`);
});

bot.on("message:text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text;
  const messageId = ctx.message.message_id;
  const replyTo = ctx.message.reply_to_message?.message_id;
  if (text.startsWith("/")) return;

  // Store user message
  storeMessage({ messageId, chatId, text, from: "user", replyTo, timestamp: Date.now() });

  // If Claude is waiting for ask_user reply, deliver via IPC instead of queuing
  if (isWaitingForReply(chatId)) {
    console.log(`[ipc] delivering ask_user reply for ${chatId}: "${text.slice(0, 80)}"`);
    deliverReply(chatId, text);
    return;
  }

  if (!messageQueue.has(chatId)) messageQueue.set(chatId, []);
  messageQueue.get(chatId)!.push({ text, messageId, replyTo });

  scheduleProcessing(chatId, ctx);
});

bot.on(["message:voice", "message:audio"], async (ctx) => {
  const chatId = String(ctx.chat.id);
  const messageId = ctx.message.message_id;
  const replyTo = ctx.message.reply_to_message?.message_id;
  const file = ctx.message.voice ?? ctx.message.audio;
  if (!file) return;

  bot.api.sendChatAction(chatId, "typing").catch(() => {});

  try {
    const telegramFile = await ctx.api.getFile(file.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${telegramFile.file_path}`;

    console.log(`[voice] transcribing for ${chatId} (${file.duration}s)`);
    const transcript = await transcribeVoice(fileUrl);
    console.log(`[voice] transcribed: "${transcript.slice(0, 80)}"`);

    const caption = ctx.message.caption ? `${ctx.message.caption}\n\n` : "";
    const text = `${caption}[Voice note transcription]: ${transcript}`;

    // Store transcribed voice as user message
    storeMessage({ messageId, chatId, text, from: "user", replyTo, timestamp: Date.now() });

    if (!messageQueue.has(chatId)) messageQueue.set(chatId, []);
    messageQueue.get(chatId)!.push({ text, messageId, replyTo });

    scheduleProcessing(chatId, ctx);
  } catch (err: any) {
    console.error(`[voice] error for ${chatId}:`, err.message);
    await ctx.reply(`Voice transcription failed: ${err.message.slice(0, 200)}`);
  }
});

bot.on("message:photo", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const messageId = ctx.message.message_id;
  const replyTo = ctx.message.reply_to_message?.message_id;
  const photos = ctx.message.photo;
  if (!photos?.length) return;

  bot.api.sendChatAction(chatId, "typing").catch(() => {});

  try {
    // Highest resolution is last in the array
    const photo = photos[photos.length - 1];
    const telegramFile = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${telegramFile.file_path}`;

    const tmpDir = join(WORKSPACE, "tmp");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

    const ext = telegramFile.file_path?.split(".").pop() || "jpg";
    const filename = `photo_${chatId}_${messageId}.${ext}`;
    const filePath = join(tmpDir, filename);

    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Failed to download photo: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(filePath, buffer);

    console.log(`[photo] saved for ${chatId}: ${filePath}`);

    const caption = ctx.message.caption ? `${ctx.message.caption}\n\n` : "";
    const text = `${caption}[User sent a photo, saved at: ${filePath}]`;

    storeMessage({ messageId, chatId, text, from: "user", replyTo, timestamp: Date.now() });

    if (!messageQueue.has(chatId)) messageQueue.set(chatId, []);
    messageQueue.get(chatId)!.push({ text, messageId, replyTo });

    scheduleProcessing(chatId, ctx);
  } catch (err: any) {
    console.error(`[photo] error for ${chatId}:`, err.message);
    await ctx.reply(`Photo handling failed: ${err.message.slice(0, 200)}`);
  }
});

async function processQueue(chatId: string, ctx: Context): Promise<void> {
  processing.add(chatId);

  while (messageQueue.get(chatId)?.length) {
    const messages = messageQueue.get(chatId)!.splice(0);
    const combined = messages.map((m) => m.text).join("\n\n");
    const lastMsg = messages[messages.length - 1];

    // Thread context: explicit reply chain or recent conversation history
    const chain = lastMsg.replyTo
      ? walkReplyChain(chatId, lastMsg.messageId)
      : getRecentMessages(chatId);
    const threadContext = formatThreadContext(chain, lastMsg.messageId);

    // Show typing indicator immediately and keep it alive every 4s
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
    const typingInterval = setInterval(() => {
      bot.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);

    // Build prompt: thread context + current message
    const prompt = `[chat_id: ${chatId}, message_id: ${lastMsg.messageId}]\n\n${threadContext}${combined}`;

    try {
      console.log(`[claude] starting for ${chatId} (chain: ${chain.length}): "${combined.slice(0, 80)}"`);
      const response = await runClaude(chatId, prompt);
      clearInterval(typingInterval);
      ingestOutbox(chatId);
      console.log(`[claude] done for ${chatId}: ${response.length} chars`);
      // If Claude used MCP tools to reply, stdout may be empty or just tool logs.
      // Only send stdout as fallback if it looks like an actual response.
      if (response && response !== "(no output)" && !response.startsWith("[") && response.length > 5) {
        const sentMsg = await bot.api.sendMessage(chatId, response.slice(0, MAX_MSG_LEN), {
          reply_to_message_id: lastMsg.messageId,
        });
        // Store Leo's reply
        storeMessage({
          messageId: sentMsg.message_id,
          chatId,
          text: response,
          from: "leo",
          replyTo: lastMsg.messageId,
          timestamp: Date.now(),
        });
      }
    } catch (err: any) {
      clearInterval(typingInterval);
      ingestOutbox(chatId);
      if (err.name === "AbortError") return;
      console.error(`Error [${chatId}]:`, err.message);
      await ctx.reply(`Error: ${err.message.slice(0, 200)}`);
    }
  }

  processing.delete(chatId);
}

// --- Claude CLI ---
function runClaude(
  chatId: string,
  prompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    activeRuns.set(chatId, controller);

    const args = ["-p", prompt, "--output-format", "text"];
    if (DANGEROUSLY_SKIP_PERMISSIONS) args.push("--dangerously-skip-permissions");

    const proc: ChildProcess = spawn(CLAUDE_PATH, args, {
      cwd: WORKSPACE,
      signal: controller.signal,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("close", (code: number | null) => {
      activeRuns.delete(chatId);
      if (code === 0 || stdout.trim()) {
        resolve(stdout.trim() || "(no output)");
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });

    proc.on("error", (err: Error) => {
      activeRuns.delete(chatId);
      reject(err);
    });
  });
}

// --- Telegram helpers ---
function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LEN) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MAX_MSG_LEN);
    if (splitAt < MAX_MSG_LEN / 2) {
      splitAt = remaining.lastIndexOf(" ", MAX_MSG_LEN);
    }
    if (splitAt < MAX_MSG_LEN / 2) splitAt = MAX_MSG_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

async function sendToChat(chatId: string, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await bot.api.sendMessage(chatId, chunk);
  }
}

// --- Cron Module ---
const cronModule = createCronModule(join(WORKSPACE, "crons"), runClaude, sendToChat);

// --- Start ---
console.log("Leo starting...");
console.log(`Workspace: ${WORKSPACE}`);
console.log(`Allowed users: ${[...ALLOWED_USERS].join(", ")}`);
console.log(
  `Claude permissions bypass: ${DANGEROUSLY_SKIP_PERMISSIONS ? "enabled (unsafe)" : "disabled"}`
);

cronModule.start();

// Graceful shutdown: abort active Claude processes, stop bot
function shutdown(signal: string): void {
  console.log(`\n[${signal}] Shutting down...`);
  for (const [chatId, controller] of activeRuns) {
    console.log(`[shutdown] aborting run for ${chatId}`);
    controller.abort();
  }
  activeRuns.clear();
  bot.stop();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

bot.catch((err: BotError<Context>) => {
  console.error("[bot error]", err.message);
});
bot.start({
  onStart: () => console.log("Leo is running. 🦁"),
  allowed_updates: ["message"],
});
