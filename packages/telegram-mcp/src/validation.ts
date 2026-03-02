/**
 * Security validation utilities extracted from index.ts for testability.
 * No side effects, no external dependencies beyond node:fs and node:path.
 */

import { existsSync, realpathSync } from "node:fs";
import { sep } from "node:path";

export const CHAT_ID_REGEX = /^-?\d+$/;

export const MAX_TIMEOUT_SECONDS = 600;

/**
 * Validate a chat_id: must be numeric and, if an allowlist is provided, must be in it.
 * Returns an error string on failure, null on success.
 */
export function validateChatId(chatId: string, allowedChatIds?: Set<string> | null): string | null {
  if (!CHAT_ID_REGEX.test(chatId)) return `Invalid chat_id: must be numeric, got "${chatId}"`;
  if (allowedChatIds && !allowedChatIds.has(chatId)) return `Unauthorized chat_id: ${chatId}`;
  return null;
}

/**
 * Returns true if the path is an absolute path to an existing file inside workspaceDir.
 * Uses realpathSync to resolve symlinks, and appends path.sep to prevent sibling-directory bypass.
 */
export function isLocalFile(s: string, workspaceDir: string): boolean {
  if (!s.startsWith("/") || !existsSync(s)) return false;
  let resolved: string;
  try {
    resolved = realpathSync(s);
  } catch {
    return false;
  }
  let baseDir: string;
  try {
    baseDir = realpathSync(workspaceDir);
  } catch {
    return false;
  }
  return resolved === baseDir || resolved.startsWith(baseDir + sep);
}

/**
 * Validate a timeout_seconds value: must be a positive number no greater than MAX_TIMEOUT_SECONDS.
 */
export function validateTimeout(val: unknown): val is number {
  return typeof val === "number" && val > 0 && val <= MAX_TIMEOUT_SECONDS;
}
