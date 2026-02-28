#!/usr/bin/env node
/**
 * LeoClaw — Thin Telegram bridge to Claude Code.
 *
 * Architecture: Telegram message → resolve session → claude -p --resume (stateful) → Telegram reply
 * No SDK, no API, no per-token cost. Just your Max subscription.
 *
 * Sessions: Reply = resume existing Claude session. New message = fresh session.
 * Per-chat serialization ensures one Claude process at a time.
 * Crons and dispatch_task get their own session IDs so replies can --resume them.
 */

import { Bot, BotError, Context } from "grammy";
import { spawn, ChildProcess, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync, watch, readdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { escapeHtml, parseBooleanEnv, parseAllowedUsersEnv } from "./utils.js";


// --- Types ---
interface ConfigFile {
  allowedUsers?: string[];
  workspace?: string;
  claudePath?: string;
  dangerouslySkipPermissions?: boolean;
  model?: string;
  fallbackModel?: string;
}

interface StoredMessage {
  messageId: number;
  chatId: string;
  text: string;
  from: "user" | "leo";
  replyTo?: number;
  timestamp: number;
}

interface SessionEntry {
  chatId: string;
  createdAt: number;
  lastUsedAt: number;
}

type SessionMode =
  | { type: "fresh"; sessionId: string }
  | { type: "resume"; sessionId: string }
  | { type: "stateless" };

// --- Config ---
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const CONFIG_FILE = join(ROOT, "config.json");
const MAX_MSG_LEN = 4096;
const MSG_STORE_FILE = join(ROOT, "messages.json");
const MSG_STORE_CAP = 100; // per chat
const SESSION_STORE_FILE = join(ROOT, "sessions.json");
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MEMORY_FOOTER_MARKER = "📚";
const DEFAULT_MEMORY_FOOTER = "📚 No memory used";

// escapeHtml, parseBooleanEnv, parseAllowedUsersEnv imported from ./utils.ts

function hasMemoryFooter(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  const lastLine = trimmed.split("\n").pop() ?? "";
  return lastLine.includes(MEMORY_FOOTER_MARKER);
}

function ensureMemoryFooter(text: string): string {
  if (hasMemoryFooter(text)) return text;
  const trimmed = text.trimEnd();
  if (!trimmed) return DEFAULT_MEMORY_FOOTER;
  return `${trimmed}\n\n${DEFAULT_MEMORY_FOOTER}`;
}

function ensureMemoryFooterWithinLimit(text: string, maxLen: number): string {
  const withFooter = ensureMemoryFooter(text);
  if (withFooter.length <= maxLen) return withFooter;
  const footerBlock = `\n\n${DEFAULT_MEMORY_FOOTER}`;
  const headLen = Math.max(0, maxLen - footerBlock.length);
  return `${withFooter.slice(0, headLen).trimEnd()}${footerBlock}`;
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

// Ensure LEO_ALLOWED_CHAT_IDS is set for child processes (MCP chat_id validation)
if (!process.env.LEO_ALLOWED_CHAT_IDS) {
  process.env.LEO_ALLOWED_CHAT_IDS = [...ALLOWED_USERS].join(",");
}
const WORKSPACE = process.env.LEO_WORKSPACE || configFile.workspace || ROOT;
const CLAUDE_PATH = process.env.LEO_CLAUDE_PATH || configFile.claudePath || "claude";
const DANGEROUSLY_SKIP_PERMISSIONS =
  parseBooleanEnv(process.env.LEO_DANGEROUSLY_SKIP_PERMISSIONS)
  ?? configFile.dangerouslySkipPermissions
  ?? false;
const CLAUDE_MODEL = process.env.LEO_MODEL || configFile.model || "opus";
const CLAUDE_FALLBACK_MODEL = process.env.LEO_FALLBACK_MODEL || configFile.fallbackModel || "sonnet";

// Environment allowlist for child Claude processes.
// Only these vars are passed to claude -p subprocesses (which spawn MCP servers).
const CHILD_ENV_ALLOWLIST = [
  // System
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM",
  // XDG
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  // Node
  "NODE_PATH", "NODE_OPTIONS",
  // LeoClaw (MCP server needs TELEGRAM_BOT_TOKEN and LEO_ALLOWED_CHAT_IDS)
  "TELEGRAM_BOT_TOKEN", "LEO_IPC_DIR", "LEO_WORKSPACE", "LEO_SESSION_ID",
  "LEO_ALLOWED_CHAT_IDS", "LEO_DANGEROUSLY_SKIP_PERMISSIONS",
  // Browser
  "AGENT_BROWSER_PROFILE",
  // Claude
  "CLAUDE_CODE_ENTRYPOINT",
];

function buildChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { ...env, ...extra };
}

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
    const pruned = msgs.splice(0, msgs.length - MSG_STORE_CAP);
    for (const p of pruned) {
      msgToSession.delete(`${p.chatId}:${p.messageId}`);
    }
  }
  messageStore.set(msg.chatId, msgs);
  saveMessageStore(messageStore);
}

// --- Session Store ---
// msgToSession: "chatId:messageId" → sessionId
const msgToSession = new Map<string, string>();
// sessionMap: sessionId → metadata
const sessionMap = new Map<string, SessionEntry>();

function loadSessionStore(): void {
  if (!existsSync(SESSION_STORE_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(SESSION_STORE_FILE, "utf-8")) as {
      messages?: Record<string, string>;
      sessions?: Record<string, SessionEntry>;
    };
    if (data.messages) {
      for (const [k, v] of Object.entries(data.messages)) msgToSession.set(k, v);
    }
    if (data.sessions) {
      for (const [k, v] of Object.entries(data.sessions)) sessionMap.set(k, v);
    }
  } catch {
    console.warn("[sessions] failed to load, starting fresh");
  }
}

function saveSessionStore(): void {
  const obj = {
    messages: Object.fromEntries(msgToSession),
    sessions: Object.fromEntries(sessionMap),
  };
  const tmp = SESSION_STORE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, SESSION_STORE_FILE);
}

function pruneStaleSessions(): void {
  const now = Date.now();
  const stale: string[] = [];
  for (const [sessionId, entry] of sessionMap) {
    if (now - entry.lastUsedAt > SESSION_MAX_AGE_MS) stale.push(sessionId);
  }
  for (const sessionId of stale) {
    sessionMap.delete(sessionId);
    for (const [key, sid] of msgToSession) {
      if (sid === sessionId) msgToSession.delete(key);
    }
  }
  if (stale.length) {
    console.log(`[sessions] pruned ${stale.length} stale sessions`);
    saveSessionStore();
  }
}

function resolveSession(chatId: string, replyTo?: number): { sessionId: string; isResume: boolean } {
  if (replyTo) {
    const existing = msgToSession.get(`${chatId}:${replyTo}`);
    if (existing && sessionMap.has(existing)) {
      const entry = sessionMap.get(existing)!;
      entry.lastUsedAt = Date.now();
      saveSessionStore();
      return { sessionId: existing, isResume: true };
    }
  }
  const sessionId = randomUUID();
  sessionMap.set(sessionId, { chatId, createdAt: Date.now(), lastUsedAt: Date.now() });
  saveSessionStore();
  return { sessionId, isResume: false };
}

function mapMessageToSession(chatId: string, messageId: number, sessionId: string): void {
  msgToSession.set(`${chatId}:${messageId}`, sessionId);
}

// Load and prune on startup
loadSessionStore();
pruneStaleSessions();

function ingestOutbox(chatId: string, sessionId?: string): number {
  const outboxPath = join(IPC_DIR, `${chatId}.outbox.jsonl`);
  if (!existsSync(outboxPath)) return 0;
  try {
    const content = readFileSync(outboxPath, "utf-8").trim();
    if (!content) { unlinkSync(outboxPath); return 0; }
    const lines = content.split("\n").filter(Boolean);
    let mapped = false;
    for (const line of lines) {
      const entry = JSON.parse(line) as {
        message_id: number;
        chat_id: string;
        text: string;
        reply_to_message_id?: number;
        timestamp: number;
        session_id?: string;
        suggested_actions?: Array<{ type: string; label: string; action?: string; target?: string }>;
        has_reply_markup?: boolean;
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
      // Map message to session: embedded session_id (cron/task) > explicit param (regular messages)
      const effectiveSessionId = entry.session_id || sessionId;
      if (effectiveSessionId) {
        if (!sessionMap.has(effectiveSessionId)) {
          sessionMap.set(effectiveSessionId, {
            chatId: entry.chat_id,
            createdAt: entry.timestamp,
            lastUsedAt: entry.timestamp,
          });
        }
        mapMessageToSession(chatId, entry.message_id, effectiveSessionId);
        mapped = true;
      }
      if (entry.suggested_actions?.length) {
        cacheSuggestions(chatId, entry.message_id, entry.suggested_actions);
      } else if (entry.has_reply_markup) {
        // Sentinel: message already has buttons, block fallback from overwriting them
        cacheSuggestions(chatId, entry.message_id, []);
      }
    }
    if (mapped) saveSessionStore();
    unlinkSync(outboxPath);
    console.log(`[outbox] ingested ${lines.length} messages for ${chatId}`);
    return lines.length;
  } catch (err: any) {
    console.error(`[outbox] ingest failed for ${chatId}:`, err.message);
    try { unlinkSync(outboxPath); } catch {}
    return 0;
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
const IPC_DIR = process.env.LEO_IPC_DIR || join(homedir(), ".leoclaw", "ipc");

// Ensure IPC dirs exist with restricted permissions (owner-only)
mkdirSync(IPC_DIR, { recursive: true, mode: 0o700 });
try { chmodSync(IPC_DIR, 0o700); } catch {}

function isWaitingForReply(chatId: string): boolean {
  return existsSync(join(IPC_DIR, `${chatId}.waiting`));
}

function deliverReply(chatId: string, text: string): void {
  mkdirSync(IPC_DIR, { recursive: true });
  writeFileSync(join(IPC_DIR, `${chatId}.reply`), text, "utf-8");
}

// --- State ---
const activeRuns = new Map<string, Set<AbortController>>();
const messageQueue = new Map<string, { text: string; messageId?: number; replyTo?: number }[]>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 3000;
const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const chatLocks = new Set<string>();
const chatActiveSession = new Map<string, string>();
const TASKS_IPC_DIR = join(IPC_DIR, "tasks");
const activeTasks = new Map<string, { description: string; chatId: string; startedAt: number }>();
const MAX_CONCURRENT_TASKS = 5;

// Generative UI: cache suggested actions per message for button routing
const suggestionsCache = new Map<string, Array<{ type: string; label: string; action?: string; target?: string }>>();
const SUGGESTIONS_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheSuggestions(chatId: string, messageId: number, actions: Array<{ type: string; label: string; action?: string; target?: string }>): void {
  const key = `${chatId}:${messageId}`;
  suggestionsCache.set(key, actions);
  setTimeout(() => suggestionsCache.delete(key), SUGGESTIONS_TTL_MS);
}

function scheduleProcessing(chatId: string, ctx: Context): void {
  const existing = debounceTimers.get(chatId);
  if (existing) clearTimeout(existing);

  debounceTimers.set(chatId, setTimeout(() => {
    debounceTimers.delete(chatId);
    processQueue(chatId, ctx);
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

bot.command("stop", async (ctx) => {
  const chatId = String(ctx.chat.id);

  // Abort running processes (their finally blocks will release chatLocks)
  const controllers = activeRuns.get(chatId);
  const count = controllers?.size ?? 0;
  if (controllers?.size) {
    for (const controller of controllers) controller.abort();
    activeRuns.delete(chatId);
  }

  // Clear queued messages so they don't drain after abort
  const queued = messageQueue.get(chatId)?.length ?? 0;
  messageQueue.delete(chatId);
  // NOTE: Do NOT clear chatLocks here. The running process's finally
  // block releases the lock when it exits. Clearing early would allow
  // concurrent execution during shutdown.

  if (count || queued) {
    await ctx.reply(`Stopped ${count} process${count !== 1 ? "es" : ""}, cleared ${queued} queued message${queued !== 1 ? "s" : ""}. ✋`);
  } else {
    await ctx.reply("Nothing running.");
  }
});

bot.command("crons", async (ctx) => {
  try {
    const output = execSync(
      'launchctl list | grep com.leoclaw.cron || echo "No LeoClaw cron agents loaded."',
      { encoding: "utf-8" },
    );
    await ctx.reply(`<pre>${escapeHtml(output.trim())}</pre>`, { parse_mode: "HTML" });
  } catch {
    await ctx.reply("Failed to query launchd. Run `pnpm compile:crons` to install.");
  }
});

bot.command("compile_crons", async (ctx) => {
  try {
    const output = execSync("tsx scripts/compile-crons.ts", {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 15000,
    });
    await ctx.reply(`<pre>${escapeHtml(output.slice(-500))}</pre>`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`Compile failed: ${(err.stderr || err.message).slice(0, 300)}`);
  }
});

bot.command("tasks", async (ctx) => {
  if (!activeTasks.size) {
    await ctx.reply("No background tasks running.");
    return;
  }
  const lines = [...activeTasks.entries()].map(([id, t]) => {
    const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `• <b>${escapeHtml(t.description)}</b>\n  <code>${escapeHtml(id)}</code> · ${mins}m${secs}s`;
  });
  await ctx.reply(`<b>Running tasks (${activeTasks.size}):</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
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
    // Map this message to the active session so future replies thread correctly
    const activeSession = chatActiveSession.get(chatId);
    if (activeSession) {
      mapMessageToSession(chatId, messageId, activeSession);
      saveSessionStore();
    }
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
    if (!telegramFile.file_path) {
      throw new Error(`getFile returned no file_path for file_id ${file.file_id}`);
    }
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
    if (!telegramFile.file_path) {
      throw new Error(`getFile returned no file_path for file_id ${photo.file_id}`);
    }
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${telegramFile.file_path}`;

    const tmpDir = join(WORKSPACE, "tmp");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

    const ext = telegramFile.file_path.split(".").pop() || "jpg";
    const filename = `photo_${chatId}_${messageId}.${ext}`;
    const filePath = join(tmpDir, filename);

    console.log(`[photo] downloading: ${telegramFile.file_path}`);
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

bot.on("callback_query:data", async (ctx) => {
  const rawChatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
  if (!rawChatId) return;
  const chatId = String(rawChatId);

  const data = ctx.callbackQuery.data;
  const originMessageId = ctx.callbackQuery.message?.message_id;

  // Ack immediately so Telegram clears the button spinner
  ctx.answerCallbackQuery().catch(() => {});

  // Remove buttons from the original message so they can't be clicked again
  if (originMessageId) {
    ctx.api
      .editMessageReplyMarkup(chatId, originMessageId, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
  }

  // Route suggest:msg buttons as regular reply messages (session resumes automatically)
  if (data.startsWith("suggest:msg:") && originMessageId) {
    const index = parseInt(data.split(":")[2], 10);
    const cached = suggestionsCache.get(`${chatId}:${originMessageId}`);
    if (cached && cached[index]) {
      const label = cached[index].label;
      // Inject as a regular message reply — session resumes via reply-to mapping
      if (!messageQueue.has(chatId)) messageQueue.set(chatId, []);
      messageQueue.get(chatId)!.push({
        text: label,
        messageId: originMessageId,
        replyTo: originMessageId,
      });
      processQueue(chatId, ctx);
      return;
    }
    // Expired/missing cache: fall through to normal callback flow
  }

  // Format as synthetic prompt (not stored in message store, callbacks are ephemeral)
  const text = `[callback_query]\ncallback_data: ${data}\norigin_message_id: ${originMessageId ?? "unknown"}`;

  // Skip debounce — buttons need fast response
  if (!messageQueue.has(chatId)) messageQueue.set(chatId, []);
  messageQueue.get(chatId)!.push({
    text,
    messageId: originMessageId,
    replyTo: originMessageId,
  });

  // Process immediately (concurrent with any running processes)
  processQueue(chatId, ctx);
});

async function processQueue(chatId: string, ctx: Context): Promise<void> {
  // Per-chat lock: one Claude process at a time
  if (chatLocks.has(chatId)) return; // items stay in queue, drained on unlock

  const queue = messageQueue.get(chatId);
  if (!queue?.length) return;

  // Take ALL queued messages (preserves debounce batching behavior)
  const messages = queue.splice(0);
  const combined = messages.map((m) => m.text).join("\n\n");
  const lastMsg = messages[messages.length - 1];

  chatLocks.add(chatId);

  // Typing indicator
  bot.api.sendChatAction(chatId, "typing").catch(() => {});
  const typingInterval = setInterval(() => {
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  try {
    // Ingest any pending outbox entries (e.g. from cron/task runs) so their sessions are available
    ingestOutbox(chatId);

    // Resolve session: reply → resume existing, no reply → fresh
    const { sessionId, isResume } = resolveSession(chatId, lastMsg.replyTo);
    let activeSessionId = sessionId;
    chatActiveSession.set(chatId, activeSessionId);

    // Map ALL user messages to session BEFORE spawning Claude
    for (const m of messages) {
      if (m.messageId) mapMessageToSession(chatId, m.messageId, activeSessionId);
    }
    saveSessionStore();

    // Build prompt (user text only) and system prompt (metadata + MCP instruction)
    const prompt = combined;
    const systemPrompt = [
      "IMPORTANT: Always prefer using the telegram MCP send_message tool to reply directly to the chat.",
      "",
      "Message context:",
      `- chat_id: ${chatId}`,
      `- message_id: ${lastMsg.messageId}`,
      `- timestamp: ${new Date().toISOString()}`,
    ].join("\n");
    const session: SessionMode = isResume
      ? { type: "resume", sessionId: activeSessionId }
      : { type: "fresh", sessionId: activeSessionId };

    let result: { text: string; mcpReplied: boolean };
    try {
      console.log(`[claude] starting for ${chatId} (session: ${activeSessionId}, resume: ${isResume}): "${combined.slice(0, 80)}"`);
      result = await runClaude(chatId, prompt, session, systemPrompt);
    } catch (err: any) {
      // Only retry as fresh if resume failed AND it wasn't an abort/timeout
      if (isResume && err.name !== "AbortError") {
        console.warn(`[session] resume failed for ${activeSessionId}, retrying fresh: ${err.message}`);
        const freshId = randomUUID();
        sessionMap.set(freshId, { chatId, createdAt: Date.now(), lastUsedAt: Date.now() });
        // Re-map all messages to the new session
        for (const m of messages) {
          if (m.messageId) mapMessageToSession(chatId, m.messageId, freshId);
        }
        activeSessionId = freshId;
        chatActiveSession.set(chatId, freshId);
        saveSessionStore();
        result = await runClaude(chatId, prompt, { type: "fresh", sessionId: freshId }, systemPrompt);
      } else {
        throw err;
      }
    }

    clearInterval(typingInterval);
    const mcpReplies = ingestOutbox(chatId, activeSessionId);
    const { text: response, mcpReplied } = result;
    console.log(`[claude] done for ${chatId}: ${response.length} chars, ${mcpReplies} outbox replies, mcpReplied: ${mcpReplied}`);

    // Only send stdout as fallback if Claude didn't reply via MCP tools
    // mcpReplied (stream) is optimistic (tool attempt); outbox is confirmed delivery — use outbox as ground truth
    if (mcpReplies === 0 && response && response !== "(no output)" && response.length > 5) {
      console.log(`[fallback] sending stdout for ${chatId} (${response.length} chars)`);
      const finalText = ensureMemoryFooterWithinLimit(response, MAX_MSG_LEN);
      let sentMsg;
      try {
        sentMsg = await bot.api.sendMessage(chatId, finalText, {
          reply_to_message_id: lastMsg.messageId,
          parse_mode: "Markdown",
        });
      } catch {
        console.log(`[fallback] Markdown parse failed for ${chatId}, retrying as plain text`);
        sentMsg = await bot.api.sendMessage(chatId, finalText, {
          reply_to_message_id: lastMsg.messageId,
        });
      }
      storeMessage({
        messageId: sentMsg.message_id,
        chatId,
        text: finalText,
        from: "leo",
        replyTo: lastMsg.messageId,
        timestamp: Date.now(),
      });
      mapMessageToSession(chatId, sentMsg.message_id, activeSessionId);
      saveSessionStore();
    }

  } catch (err: any) {
    clearInterval(typingInterval);
    ingestOutbox(chatId);
    if (err.name === "AbortError") return;
    console.error(`Error [${chatId}]:`, err.message);
    await ctx.reply(`Error: ${err.message.slice(0, 200)}`);
  } finally {
    chatLocks.delete(chatId);
    chatActiveSession.delete(chatId);

    // Drain: process next queued message(s) for this chat
    if (messageQueue.get(chatId)?.length) {
      processQueue(chatId, ctx);
    }
  }
}

// --- Async Tasks ---

function watchTasksDir(): void {
  mkdirSync(TASKS_IPC_DIR, { recursive: true });

  // Clean up orphaned .running files from previous harness instance
  for (const file of readdirSync(TASKS_IPC_DIR)) {
    if (file.endsWith(".running")) {
      console.log(`[tasks] cleaning orphaned: ${file}`);
      try { unlinkSync(join(TASKS_IPC_DIR, file)); } catch {}
    }
  }

  // Process any .md files queued while harness was down
  for (const file of readdirSync(TASKS_IPC_DIR)) {
    if (file.endsWith(".md")) {
      setTimeout(() => processTaskFile(file), 500);
    }
  }

  // Watch for new task files
  watch(TASKS_IPC_DIR, (_, filename) => {
    if (!filename?.endsWith(".md")) return;
    if (!existsSync(join(TASKS_IPC_DIR, filename))) return;
    setTimeout(() => processTaskFile(filename), 200);
  });

  console.log(`[tasks] watching ${TASKS_IPC_DIR}`);
}

function processTaskFile(filename: string): void {
  const taskFile = join(TASKS_IPC_DIR, filename);
  if (!existsSync(taskFile)) return;

  if (activeTasks.size >= MAX_CONCURRENT_TASKS) {
    console.warn(`[tasks] rejected ${filename}: at capacity (${MAX_CONCURRENT_TASKS} tasks running)`);
    return; // leave .md file for retry when a slot opens
  }

  try {
    const content = readFileSync(taskFile, "utf-8");

    // Parse YAML frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) {
      console.error(`[tasks] invalid task file: ${filename}`);
      unlinkSync(taskFile);
      return;
    }

    const frontmatter = fmMatch[1];
    const promptBody = fmMatch[2];

    const chatIdMatch = frontmatter.match(/^chat_id:\s*"?([^"\n]+)"?/m);
    const descMatch = frontmatter.match(/^description:\s*"?(.*?)"?\s*$/m);

    if (!chatIdMatch) {
      console.error(`[tasks] no chat_id in: ${filename}`);
      unlinkSync(taskFile);
      return;
    }

    const chatId = chatIdMatch[1];
    const description = descMatch?.[1] || "unnamed task";
    const taskId = filename.replace(".md", "");

    if (!ALLOWED_USERS.has(chatId)) {
      console.error(`[tasks] rejected ${filename}: unauthorized chat_id ${chatId}`);
      unlinkSync(taskFile);
      return;
    }

    // Rename to .running (acts as atomic lock — if another invocation already
    // picked this up, renameSync throws and we bail)
    const runningFile = join(TASKS_IPC_DIR, `${taskId}.running`);
    try {
      renameSync(taskFile, runningFile);
    } catch {
      console.log(`[tasks] already picked up: ${filename}`);
      return;
    }

    spawnTask(taskId, chatId, description, promptBody);
  } catch (err: any) {
    console.error(`[tasks] error processing ${filename}:`, err.message);
  }
}

function spawnTask(taskId: string, chatId: string, description: string, prompt: string): void {
  const controller = new AbortController();

  // Track in activeRuns for /stop and shutdown
  if (!activeRuns.has(chatId)) activeRuns.set(chatId, new Set());
  activeRuns.get(chatId)!.add(controller);

  activeTasks.set(taskId, { description, chatId, startedAt: Date.now() });

  // Give the task a session so replies can --resume its context
  const taskSessionId = randomUUID();
  sessionMap.set(taskSessionId, { chatId, createdAt: Date.now(), lastUsedAt: Date.now() });
  saveSessionStore();

  const fullPrompt = `Use the telegram MCP tools to send your response directly to chat_id ${chatId}.\n\n${prompt}`;
  const taskSystemPrompt = [
    "Task context:",
    `- chat_id: ${chatId}`,
    `- task: ${taskId}`,
  ].join("\n");

  const args = ["-p", fullPrompt, "--output-format", "text", "--model", CLAUDE_MODEL, "--session-id", taskSessionId, "--append-system-prompt", taskSystemPrompt];
  if (CLAUDE_FALLBACK_MODEL !== CLAUDE_MODEL) args.push("--fallback-model", CLAUDE_FALLBACK_MODEL);
  if (DANGEROUSLY_SKIP_PERMISSIONS) args.push("--dangerously-skip-permissions");

  const logDir = join(WORKSPACE, "tmp", "task-logs");
  mkdirSync(logDir, { recursive: true });

  const proc = spawn(CLAUDE_PATH, args, {
    cwd: WORKSPACE,
    signal: controller.signal,
    env: buildChildEnv({ CLAUDE_CODE_ENTRYPOINT: "cli", LEO_SESSION_ID: taskSessionId }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
  proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

  const timeout = setTimeout(() => {
    console.error(`[tasks] TIMEOUT: ${taskId}`);
    activeTasks.delete(taskId);
    const controllers = activeRuns.get(chatId);
    if (controllers) {
      controllers.delete(controller);
      if (controllers.size === 0) activeRuns.delete(chatId);
    }
    proc.kill("SIGTERM");
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
  }, CLAUDE_TIMEOUT_MS);

  proc.on("close", (code) => {
    clearTimeout(timeout);
    console.log(`[tasks] ${taskId} exited (code ${code})`);

    // Write log
    const logFile = join(logDir, `${taskId}.log`);
    try {
      writeFileSync(logFile, [
        `=== ${new Date().toISOString()} ===`,
        `Description: ${description}`,
        `Exit code: ${code}`,
        "",
        "--- stdout ---",
        stdout,
        "",
        "--- stderr ---",
        stderr,
      ].join("\n"));
    } catch {}

    // Cleanup
    activeTasks.delete(taskId);
    const controllers = activeRuns.get(chatId);
    if (controllers) {
      controllers.delete(controller);
      if (controllers.size === 0) activeRuns.delete(chatId);
    }
    try { unlinkSync(join(TASKS_IPC_DIR, `${taskId}.running`)); } catch {}

    ingestOutbox(chatId);
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    console.error(`[tasks] ${taskId} error:`, err.message);
    activeTasks.delete(taskId);
    const controllers = activeRuns.get(chatId);
    if (controllers) {
      controllers.delete(controller);
      if (controllers.size === 0) activeRuns.delete(chatId);
    }
    try { unlinkSync(join(TASKS_IPC_DIR, `${taskId}.running`)); } catch {}
  });

  console.log(`[tasks] spawned: ${taskId} — ${description} (pid: ${proc.pid})`);
}

// --- Stream-JSON event type (loose, tolerates unknown fields) ---
interface StreamEvent {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<{ type: string; name?: string; text?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  session_id?: string;
  [key: string]: unknown;
}

// --- Claude CLI ---
function runClaude(
  chatId: string,
  prompt: string,
  session: SessionMode = { type: "stateless" },
  systemPrompt?: string,
): Promise<{ text: string; mcpReplied: boolean }> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();

    // Track this run (multiple concurrent runs per chat)
    if (!activeRuns.has(chatId)) activeRuns.set(chatId, new Set());
    activeRuns.get(chatId)!.add(controller);

    function cleanup(): void {
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
      const controllers = activeRuns.get(chatId);
      if (controllers) {
        controllers.delete(controller);
        if (controllers.size === 0) activeRuns.delete(chatId);
      }
    }

    const args = ["-p", prompt, "--verbose", "--output-format", "stream-json", "--model", CLAUDE_MODEL];
    if (CLAUDE_FALLBACK_MODEL !== CLAUDE_MODEL) args.push("--fallback-model", CLAUDE_FALLBACK_MODEL);
    if (session.type === "resume") {
      args.push("--resume", session.sessionId);
    } else if (session.type === "fresh") {
      args.push("--session-id", session.sessionId);
    }
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    if (DANGEROUSLY_SKIP_PERMISSIONS) args.push("--dangerously-skip-permissions");

    const proc: ChildProcess = spawn(CLAUDE_PATH, args, {
      cwd: WORKSPACE,
      signal: controller.signal,
      env: buildChildEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderr = "";
    let resultText = "";
    let assistantText = ""; // accumulate text blocks from assistant events as fallback
    let mcpReplied = false;
    let settled = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    function processStreamEvent(event: StreamEvent): void {
      switch (event.type) {
        case "assistant": {
          const content = event.message?.content;
          if (!Array.isArray(content)) break;
          for (const block of content) {
            if (block.type === "tool_use" && typeof block.name === "string" && block.name.startsWith("mcp__telegram__")) {
              mcpReplied = true;
            }
            if (block.type === "text" && typeof block.text === "string") {
              assistantText = block.text; // keep last text block (most recent response)
            }
          }
          break;
        }
        case "result":
          if (typeof event.result === "string") {
            resultText = event.result;
          }
          console.log(`[claude] result: subtype=${event.subtype}, cost=$${event.total_cost_usd ?? "?"}, duration=${event.duration_ms ?? "?"}ms, turns=${event.num_turns ?? "?"}, session=${event.session_id ?? "?"}, resultLen=${typeof event.result === "string" ? event.result.length : `non-string:${typeof event.result}`}`);
          break;
      }
    }

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[claude] TIMEOUT after ${CLAUDE_TIMEOUT_MS / 1000}s for ${chatId}`);
      proc.kill("SIGTERM");
      // Give it 5s to exit gracefully, then force kill
      sigkillTimer = setTimeout(() => {
        sigkillTimer = null;
        try { proc.kill("SIGKILL"); } catch {}
      }, 5000);
      cleanup();
      reject(new Error(`Claude timed out after ${CLAUDE_TIMEOUT_MS / 60000} minutes`));
    }, CLAUDE_TIMEOUT_MS);

    proc.stdout?.on("data", (d: Buffer) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          processStreamEvent(JSON.parse(trimmed) as StreamEvent);
        } catch {
          console.warn(`[claude] unparseable stream line: ${trimmed.slice(0, 120)}`);
        }
      }
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("close", (code: number | null) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      cleanup();

      // Flush remaining buffer (split on newlines, not single-blob parse)
      if (stdoutBuf.trim()) {
        for (const line of stdoutBuf.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            processStreamEvent(JSON.parse(trimmed) as StreamEvent);
          } catch { /* skip */ }
        }
      }

      // Prefer result event text, fall back to last assistant text block, then "(no output)"
      const text = resultText.trim() || assistantText.trim() || "(no output)";
      if (code === 0 || text !== "(no output)") {
        resolve({ text, mcpReplied });
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      cleanup();
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

// --- Start ---
console.log("Leo starting...");
console.log(`Workspace: ${WORKSPACE}`);
console.log(`Allowed users: ${[...ALLOWED_USERS].join(", ")}`);
console.log(
  `Claude permissions bypass: ${DANGEROUSLY_SKIP_PERMISSIONS ? "enabled (unsafe)" : "disabled"}`
);

// Drain stale outbox files left by crons/tasks from before this boot.
// Without this, a cron's outbox entry poisons the next user message's
// fallback logic (harness sees mcpReplies > 0 and skips stdout relay).
for (const chatId of ALLOWED_USERS) {
  const stale = ingestOutbox(chatId);
  if (stale) console.log(`[startup] drained ${stale} stale outbox entries for ${chatId}`);
}

// Graceful shutdown: abort active Claude processes, stop bot
function shutdown(signal: string): void {
  console.log(`\n[${signal}] Shutting down...`);
  for (const [chatId, controllers] of activeRuns) {
    console.log(`[shutdown] aborting ${controllers.size} run(s) for ${chatId}`);
    for (const controller of controllers) {
      controller.abort();
    }
  }
  activeRuns.clear();
  messageQueue.clear();
  bot.stop();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Start async task watcher
watchTasksDir();

bot.catch((err: BotError<Context>) => {
  console.error("[bot error]", err.message);
});
bot.start({
  onStart: () => console.log("Leo is running. 🦁"),
  allowed_updates: ["message", "callback_query"],
});
