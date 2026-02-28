#!/usr/bin/env node
/**
 * @leoclaw/telegram-mcp — Minimal Telegram MCP server for Claude Code.
 *
 * Exposes Telegram Bot API actions as MCP tools so Claude can
 * communicate directly with users instead of returning stdout.
 *
 * Env: TELEGRAM_BOT_TOKEN (required)
 *
 * Tools: send_message, send_photo, edit_message, delete_message, react, typing,
 *         edit_reply_markup, pin_message, ask_user
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, extname } from "node:path";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// --- Security: chat_id validation ---

const ALLOWED_CHAT_IDS = process.env.LEO_ALLOWED_CHAT_IDS
  ? new Set(process.env.LEO_ALLOWED_CHAT_IDS.split(",").map(s => s.trim()).filter(Boolean))
  : null;

const CHAT_ID_REGEX = /^-?\d+$/;

/** Validate chat_id: must be numeric and (if configured) in the allowlist. */
function validateChatId(chatId: string): string | null {
  if (!CHAT_ID_REGEX.test(chatId)) return `Invalid chat_id: must be numeric, got "${chatId}"`;
  if (ALLOWED_CHAT_IDS && !ALLOWED_CHAT_IDS.has(chatId)) return `Unauthorized chat_id: ${chatId}`;
  return null;
}

// --- Helpers ---

type ParseMode = "HTML" | "MarkdownV2" | "Markdown";
const MEMORY_FOOTER_MARKER = "📚";
const DEFAULT_MEMORY_FOOTER = "📚 No memory used";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
};

function isLocalFile(s: string): boolean {
  return s.startsWith("/") && existsSync(s);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

// --- MarkdownV2 Sanitizer ---
// Characters that are special in MarkdownV2 and need escaping in regular text.
// Formatting delimiters (* _ ~) are intentionally excluded — the LLM handles those.
const MD2_ESCAPE = new Set(".!+-=#{}()[]|>".split(""));

// Convert standard Markdown bold/italic to MarkdownV2 equivalents.
// Claude writes **bold** and ***bold italic*** but MarkdownV2 uses *bold* and *_italic_*.
function convertMarkdownBold(text: string): string {
  // Preserve code blocks and inline code from conversion
  const protected_: { placeholder: string; original: string }[] = [];
  let idx = 0;
  let result = text.replace(/```[\s\S]*?```|`[^`]+`/g, (match) => {
    const placeholder = `\x00CODE${idx++}\x00`;
    protected_.push({ placeholder, original: match });
    return placeholder;
  });
  // ***text*** → *_text_* (bold italic)
  result = result.replace(/\*{3}(.+?)\*{3}/g, "*_$1_*");
  // **text** → *text* (bold)
  result = result.replace(/\*{2}(.+?)\*{2}/g, "*$1*");
  // Restore protected sections
  for (const { placeholder, original } of protected_) {
    result = result.replace(placeholder, original);
  }
  return result;
}

function sanitizeMarkdownV2(text: string): string {
  const out: string[] = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    // Already escaped: pass through
    if (text[i] === "\\" && i + 1 < len) {
      out.push(text[i], text[i + 1]);
      i += 2;
      continue;
    }

    // Code block ```...```: pass through verbatim (no escaping inside)
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      if (end !== -1) {
        out.push(text.slice(i, end + 3));
        i = end + 3;
        continue;
      }
    }

    // Inline code `...`: pass through verbatim
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        out.push(text.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }

    // Link [text](url): sanitize display text, leave URL alone
    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const display = text.slice(i + 1, closeBracket);
          const url = text.slice(closeBracket + 2, closeParen);
          out.push("[", sanitizeMarkdownV2(display), "](", url.replace(/([)\\])/g, "\\$1"), ")");
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Blockquote > at line start: preserve
    if (text[i] === ">" && (i === 0 || text[i - 1] === "\n")) {
      out.push(">");
      i++;
      continue;
    }

    // Spoiler ||...||: preserve delimiters, sanitize content
    if (text[i] === "|" && text[i + 1] === "|") {
      const end = text.indexOf("||", i + 2);
      if (end !== -1) {
        const inner = text.slice(i + 2, end);
        out.push("||", sanitizeMarkdownV2(inner), "||");
        i = end + 2;
        continue;
      }
    }

    // Special chars that need escaping in regular text
    if (MD2_ESCAPE.has(text[i])) {
      out.push("\\", text[i]);
      i++;
      continue;
    }

    // Everything else (regular chars + formatting delimiters * _ ~): pass through
    out.push(text[i]);
    i++;
  }

  return out.join("");
}

const MAX_RETRIES = 3;

// --- Interfaces ---

interface SendMessageArgs {
  chat_id: string;
  text: string;
  parse_mode?: ParseMode;
  reply_to_message_id?: number;
  reply_markup?: string;
}

interface SendPhotoArgs {
  chat_id: string;
  photo: string;
  caption?: string;
  parse_mode?: ParseMode;
  reply_to_message_id?: number;
}

interface EditMessageArgs {
  chat_id: string;
  message_id: number;
  text: string;
  parse_mode?: ParseMode;
  reply_markup?: string;
}

interface DeleteMessageArgs {
  chat_id: string;
  message_id: number;
}

interface ReactArgs {
  chat_id: string;
  message_id: number;
  emoji: string;
}

interface TypingArgs {
  chat_id: string;
}

interface EditReplyMarkupArgs {
  chat_id: string;
  message_id: number;
  reply_markup?: string;
}

interface PinMessageArgs {
  chat_id: string;
  message_id: number;
  disable_notification?: boolean;
}

// --- Telegram API helper with retries ---

async function tg(method: string, body: Record<string, unknown>): Promise<unknown> {
  // Convert standard Markdown bold → MarkdownV2 bold, then sanitize
  if (body.parse_mode === "MarkdownV2") {
    if (typeof body.text === "string") body = { ...body, text: sanitizeMarkdownV2(convertMarkdownBold(body.text)) };
    if (typeof body.caption === "string") body = { ...body, caption: sanitizeMarkdownV2(convertMarkdownBold(body.caption)) };
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network error (DNS, timeout, connection refused)
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`Telegram ${method}: network error after ${MAX_RETRIES + 1} attempts: ${lastError.message}`);
    }

    const data = await res.json() as {
      ok: boolean; result?: unknown; description?: string;
      parameters?: { retry_after?: number };
    };

    if (data.ok) return data.result;

    // Parse mode failure: strip parse_mode and retry once (not counted as retry attempt)
    if (body.parse_mode && data.description?.includes("can't parse entities")) {
      const { parse_mode: _, ...plain } = body;
      const retry = await fetch(`${API}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(plain),
      });
      const retryData = await retry.json() as { ok: boolean; result?: unknown; description?: string };
      if (!retryData.ok) throw new Error(`Telegram ${method}: ${retryData.description}`);
      return retryData.result;
    }

    // Rate limited: use Telegram's retry_after header
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const wait = (data.parameters?.retry_after ?? 1) * 1000;
      await sleep(wait);
      continue;
    }

    // Server error (5xx): retry with exponential backoff
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    // Non-retryable error
    throw new Error(`Telegram ${method}: ${data.description}`);
  }

  throw lastError ?? new Error(`Telegram ${method}: max retries exceeded`);
}

/** Send a Telegram API request with multipart form-data (for file uploads). */
async function tgUpload(
  method: string,
  fields: Record<string, string | undefined>,
  fileField: string,
  filePath: string,
): Promise<unknown> {
  // Sanitize MarkdownV2 caption before upload
  if (fields.parse_mode === "MarkdownV2" && fields.caption) {
    fields = { ...fields, caption: sanitizeMarkdownV2(convertMarkdownBold(fields.caption)) };
  }

  const buildForm = (includeParseMode: boolean) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      if (!includeParseMode && k === "parse_mode") continue;
      form.append(k, v);
    }
    const buf = readFileSync(filePath);
    const mime = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
    const blob = new Blob([buf], { type: mime });
    form.append(fileField, blob, filePath.split("/").pop()!);
    return form;
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API}/${method}`, { method: "POST", body: buildForm(true) });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`Telegram ${method}: network error after ${MAX_RETRIES + 1} attempts: ${lastError.message}`);
    }

    const data = await res.json() as {
      ok: boolean; result?: unknown; description?: string;
      parameters?: { retry_after?: number };
    };

    if (data.ok) return data.result;

    // Parse mode failure: strip and retry once
    if (fields.parse_mode && data.description?.includes("can't parse entities")) {
      const retry = await fetch(`${API}/${method}`, { method: "POST", body: buildForm(false) });
      const retryData = await retry.json() as { ok: boolean; result?: unknown; description?: string };
      if (!retryData.ok) throw new Error(`Telegram ${method}: ${retryData.description}`);
      return retryData.result;
    }

    // Rate limited
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const wait = (data.parameters?.retry_after ?? 1) * 1000;
      await sleep(wait);
      continue;
    }

    // Server error
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    throw new Error(`Telegram ${method}: ${data.description}`);
  }

  throw lastError ?? new Error(`Telegram ${method}: max retries exceeded`);
}

// --- Safe wrapper: catches throws and returns isError instead of crashing ---

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function safe<T>(handler: (args: T) => Promise<ToolResult>): (args: T) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  };
}

// --- MCP Server ---

const server = new McpServer({
  name: "telegram",
  version: "0.1.0",
});

server.tool(
  "send_message",
  "Send a text message to a Telegram chat. Supports MarkdownV2 formatting.",
  {
    chat_id: z.string().describe("Telegram chat ID"),
    text: z.string().describe("Message text. Use MarkdownV2 formatting: *bold*, _italic_, `code`, ```block```, [link](url). Escape special chars: _ * [ ] ( ) ~ ` > # + - = | { } . ! with backslash. Plain text is fine too."),
    parse_mode: z.enum(["MarkdownV2", "HTML", "Markdown"]).optional().describe("Parse mode (default: MarkdownV2)"),
    reply_to_message_id: z.coerce.number().optional().describe("Message ID to reply to"),
    reply_markup: z.string().optional().describe("JSON string of InlineKeyboardMarkup or ReplyKeyboardMarkup"),
  },
  safe(async ({ chat_id, text, parse_mode, reply_to_message_id, reply_markup }: SendMessageArgs) => {
    const chatErr = validateChatId(chat_id);
    if (chatErr) return { content: [{ type: "text" as const, text: chatErr }], isError: true };
    const finalText = ensureMemoryFooter(text);
    const body: Record<string, unknown> = { chat_id, text: finalText, parse_mode: parse_mode ?? "MarkdownV2" };
    if (reply_to_message_id) body.reply_parameters = { message_id: reply_to_message_id };
    if (reply_markup) {
      try {
        body.reply_markup = JSON.parse(reply_markup);
      } catch {
        return { content: [{ type: "text" as const, text: `Invalid reply_markup JSON: ${reply_markup.slice(0, 100)}` }], isError: true };
      }
    }
    const result = await tg("sendMessage", body);

    // Log to outbox so harness can track Leo's messages
    try {
      mkdirSync(IPC_DIR, { recursive: true });
      const sentMsg = result as { message_id: number };
      const outboxEntry: Record<string, unknown> = {
          message_id: sentMsg.message_id,
          chat_id,
          text: finalText,
          reply_to_message_id,
          timestamp: Date.now(),
        };
      if (SESSION_ID) outboxEntry.session_id = SESSION_ID;
      appendFileSync(
        join(IPC_DIR, `${chat_id}.outbox.jsonl`),
        JSON.stringify(outboxEntry) + "\n",
        "utf-8"
      );
    } catch {}

    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  })
);

server.tool(
  "send_photo",
  "Send a photo to a Telegram chat. Supports URLs, file_ids, and local file paths.",
  {
    chat_id: z.string().describe("Telegram chat ID"),
    photo: z.string().describe("Photo URL, file_id, or absolute local file path"),
    caption: z.string().optional().describe("Photo caption (MarkdownV2 supported)"),
    parse_mode: z.enum(["MarkdownV2", "HTML", "Markdown"]).optional().describe("Parse mode for caption (default: MarkdownV2)"),
    reply_to_message_id: z.coerce.number().optional().describe("Message ID to reply to"),
  },
  safe(async ({ chat_id, photo, caption, parse_mode, reply_to_message_id }: SendPhotoArgs) => {
    const chatErr = validateChatId(chat_id);
    if (chatErr) return { content: [{ type: "text" as const, text: chatErr }], isError: true };
    let result: unknown;

    if (isLocalFile(photo)) {
      const fields: Record<string, string | undefined> = {
        chat_id,
        caption,
        parse_mode: parse_mode ?? (caption ? "MarkdownV2" : undefined),
      };
      if (reply_to_message_id) {
        fields.reply_parameters = JSON.stringify({ message_id: reply_to_message_id });
      }
      result = await tgUpload("sendPhoto", fields, "photo", photo);
    } else {
      const body: Record<string, unknown> = { chat_id, photo };
      if (caption) body.caption = caption;
      if (caption) body.parse_mode = parse_mode ?? "MarkdownV2";
      if (reply_to_message_id) body.reply_parameters = { message_id: reply_to_message_id };
      result = await tg("sendPhoto", body);
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  })
);

server.tool(
  "edit_message",
  "Edit an existing text message.",
  {
    chat_id: z.string().describe("Telegram chat ID"),
    message_id: z.number().describe("Message ID to edit"),
    text: z.string().describe("New message text"),
    parse_mode: z.enum(["MarkdownV2", "HTML", "Markdown"]).optional(),
    reply_markup: z.string().optional().describe("JSON string of InlineKeyboardMarkup"),
  },
  safe(async ({ chat_id, message_id, text, parse_mode, reply_markup }: EditMessageArgs) => {
    const chatErr = validateChatId(chat_id);
    if (chatErr) return { content: [{ type: "text" as const, text: chatErr }], isError: true };
    const finalText = ensureMemoryFooter(text);
    const body: Record<string, unknown> = { chat_id, message_id, text: finalText, parse_mode: parse_mode ?? "MarkdownV2" };
    if (reply_markup) {
      try {
        body.reply_markup = JSON.parse(reply_markup);
      } catch {
        return { content: [{ type: "text" as const, text: `Invalid reply_markup JSON: ${reply_markup.slice(0, 100)}` }], isError: true };
      }
    }
    const result = await tg("editMessageText", body);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  })
);

server.tool(
  "delete_message",
  "Delete a message from a chat.",
  {
    chat_id: z.string().describe("Telegram chat ID"),
    message_id: z.number().describe("Message ID to delete"),
  },
  safe(async ({ chat_id, message_id }: DeleteMessageArgs) => {
    const chatErr = validateChatId(chat_id);
    if (chatErr) return { content: [{ type: "text" as const, text: chatErr }], isError: true };
    const result = await tg("deleteMessage", { chat_id, message_id });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  })
);

server.tool(
  "react",
  "Add an emoji reaction to a message.",
  {
    chat_id: z.string().describe("Telegram chat ID"),
    message_id: z.number().describe("Message ID to react to"),
    emoji: z.string().describe("Emoji to react with (e.g. 👍, 🔥, ❤️)"),
  },
  safe(async ({ chat_id, message_id, emoji }: ReactArgs) => {
    const chatErr = validateChatId(chat_id);
    if (chatErr) return { content: [{ type: "text" as const, text: chatErr }], isError: true };
    const result = await tg("setMessageReaction", {
      chat_id, message_id,
      reaction: [{ type: "emoji", emoji }],
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  })
);

server.tool(
  "typing",
  "Show typing indicator in a chat. Call before long operations.",
  {
    chat_id: z.string().describe("Telegram chat ID"),
  },
  safe(async ({ chat_id }: TypingArgs) => {
    const chatErr = validateChatId(chat_id);
    if (chatErr) return { content: [{ type: "text" as const, text: chatErr }], isError: true };
    await tg("sendChatAction", { chat_id, action: "typing" });
    return { content: [{ type: "text" as const, text: "ok" }] };
  })
);

server.tool(
  "edit_reply_markup",
  "Update or remove inline keyboard buttons on an existing message. Omit reply_markup to remove all buttons.",
  {
    chat_id: z.string().describe("Telegram chat ID"),
    message_id: z.number().describe("Message ID to update buttons on"),
    reply_markup: z.string().optional().describe("JSON string of InlineKeyboardMarkup, or omit to remove buttons"),
  },
  safe(async ({ chat_id, message_id, reply_markup }: EditReplyMarkupArgs) => {
    const chatErr = validateChatId(chat_id);
    if (chatErr) return { content: [{ type: "text" as const, text: chatErr }], isError: true };
    const body: Record<string, unknown> = { chat_id, message_id };
    if (reply_markup) {
      try {
        body.reply_markup = JSON.parse(reply_markup);
      } catch {
        return { content: [{ type: "text" as const, text: `Invalid reply_markup JSON: ${reply_markup.slice(0, 100)}` }], isError: true };
      }
    } else {
      body.reply_markup = { inline_keyboard: [] };
    }
    const result = await tg("editMessageReplyMarkup", body);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  })
);

server.tool(
  "pin_message",
  "Pin a message in a Telegram chat.",
  {
    chat_id: z.string().describe("Telegram chat ID"),
    message_id: z.number().describe("Message ID to pin"),
    disable_notification: z.boolean().optional().describe("Pin silently (default: true)"),
  },
  safe(async ({ chat_id, message_id, disable_notification }: PinMessageArgs) => {
    const chatErr = validateChatId(chat_id);
    if (chatErr) return { content: [{ type: "text" as const, text: chatErr }], isError: true };
    const result = await tg("pinChatMessage", {
      chat_id,
      message_id,
      disable_notification: disable_notification ?? true,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  })
);

// --- IPC ---

const IPC_DIR = process.env.LEO_IPC_DIR || (process.env.HOME ? `${process.env.HOME}/.leoclaw/ipc` : "/tmp/leo-ipc");
const TASKS_IPC_DIR = join(IPC_DIR, "tasks");
const SESSION_ID = process.env.LEO_SESSION_ID;

interface AskUserArgs {
  chat_id: string;
  question: string;
  timeout_seconds?: number;
}

server.tool(
  "ask_user",
  "Ask the user a question and wait for their reply. Use this when you need input, confirmation, or a decision from the user before continuing. The tool blocks until the user responds (up to timeout).",
  {
    chat_id: z.string().describe("Telegram chat ID"),
    question: z.string().describe("The question to ask the user"),
    timeout_seconds: z.number().optional().describe("Max seconds to wait for reply (default: 300)"),
  },
  safe(async ({ chat_id, question, timeout_seconds }: AskUserArgs) => {
    const chatErr = validateChatId(chat_id);
    if (chatErr) return { content: [{ type: "text" as const, text: chatErr }], isError: true };
    const finalText = ensureMemoryFooter(question);
    // Send the question via Telegram
    const result = await tg("sendMessage", {
      chat_id,
      text: finalText,
      parse_mode: "MarkdownV2",
    });

    // Log to outbox
    try {
      mkdirSync(IPC_DIR, { recursive: true });
      const sentMsg = result as { message_id: number };
      const outboxEntry: Record<string, unknown> = {
          message_id: sentMsg.message_id,
          chat_id,
          text: finalText,
          timestamp: Date.now(),
        };
      if (SESSION_ID) outboxEntry.session_id = SESSION_ID;
      appendFileSync(
        join(IPC_DIR, `${chat_id}.outbox.jsonl`),
        JSON.stringify(outboxEntry) + "\n",
        "utf-8"
      );
    } catch {}

    // Write waiting marker so harness knows to route next reply to IPC
    mkdirSync(IPC_DIR, { recursive: true });
    const waitingFile = join(IPC_DIR, `${chat_id}.waiting`);
    const replyFile = join(IPC_DIR, `${chat_id}.reply`);

    // Clean up any stale reply file
    if (existsSync(replyFile)) unlinkSync(replyFile);

    writeFileSync(waitingFile, question, "utf-8");

    // Poll for reply
    const timeout = (timeout_seconds ?? 300) * 1000;
    const pollInterval = 500;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (existsSync(replyFile)) {
        const reply = readFileSync(replyFile, "utf-8");
        // Clean up IPC files
        try { unlinkSync(replyFile); } catch {}
        try { unlinkSync(waitingFile); } catch {}
        return { content: [{ type: "text" as const, text: reply }] };
      }
      await sleep(pollInterval);
    }

    // Timeout: clean up waiting marker
    try { unlinkSync(waitingFile); } catch {}
    return { content: [{ type: "text" as const, text: "[ask_user timeout: no reply received within " + (timeout_seconds ?? 300) + "s]" }] };
  })
);

// --- dispatch_task ---

interface DispatchTaskArgs {
  chat_id: string;
  description: string;
  prompt: string;
}

server.tool(
  "dispatch_task",
  "Dispatch a long-running task to run in the background as a separate Claude process. Use for coding tasks, research, or anything that would take more than ~30 seconds. The background process has full workspace and MCP tool access and will report results directly via Telegram. Your current session is free to continue immediately.\n\nIMPORTANT: The background process has NO shared context with your current session. Include ALL necessary context in the prompt — file paths, requirements, constraints, chat_id for replies.",
  {
    chat_id: z.string().describe("Chat ID for the background process to report results to"),
    description: z.string().describe("Short task description (shown in /tasks listing)"),
    prompt: z.string().describe("Complete prompt for the background Claude process. Must be self-contained with all context needed."),
  },
  safe(async ({ chat_id, description, prompt }: DispatchTaskArgs) => {
    const chatErr = validateChatId(chat_id);
    if (chatErr) return { content: [{ type: "text" as const, text: chatErr }], isError: true };
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    mkdirSync(TASKS_IPC_DIR, { recursive: true });

    const taskFile = join(TASKS_IPC_DIR, `${id}.md`);
    const safeDesc = description.replace(/["\n\r\\]/g, " ").trim();
    const content = [
      "---",
      `chat_id: "${chat_id}"`,
      `description: "${safeDesc}"`,
      `dispatched_at: "${new Date().toISOString()}"`,
      "---",
      prompt,
    ].join("\n");

    writeFileSync(taskFile, content, "utf-8");

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ task_id: id, status: "dispatched", description }),
      }],
    };
  })
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
