/**
 * Pure utility functions extracted from index.ts for testability.
 * No side effects, no external dependencies beyond node:path.
 */

import { join } from "node:path";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export const ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL",
  "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "NODE_PATH", "NODE_OPTIONS",
  "LEO_IPC_DIR", "LEO_WORKSPACE",
  "TELEGRAM_BOT_TOKEN", "LEO_ALLOWED_CHAT_IDS",
  "AGENT_BROWSER_PROFILE",
];

export function buildChildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { ...env, ...extra };
}

export function parseAllowedUsersEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function getIpcDir(): string {
  return process.env.LEO_IPC_DIR || join(process.env.HOME || "/tmp", ".leoclaw", "ipc");
}

export function sanitizeCallbackData(data: string): string {
  return data.replace(/[\n\r]/g, " ");
}

export function parseTaskChatId(frontmatter: string): string | null {
  const match = frontmatter.match(/^chat_id:\s*"?([^"\n]+)"?/m);
  return match ? match[1] : null;
}
