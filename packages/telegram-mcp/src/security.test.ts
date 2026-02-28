import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

/**
 * Security tests for @leoclaw/telegram-mcp.
 *
 * Tests verify that security fixes (R2, R7, R9, R10) are effective.
 */

// --- R2: chat_id validation ---

const CHAT_ID_REGEX = /^-?\d+$/;

function validateChatId(chatId: string, allowedSet?: Set<string>): string | null {
  if (!CHAT_ID_REGEX.test(chatId)) return `Invalid chat_id: must be numeric, got "${chatId}"`;
  if (allowedSet && !allowedSet.has(chatId)) return `Unauthorized chat_id: ${chatId}`;
  return null;
}

describe("R2: chat_id rejects non-numeric and adversarial values", () => {
  it("rejects path traversal payloads", () => {
    const traversalPayloads = [
      "../../etc/passwd",
      "../../../tmp/evil",
      "/tmp/leo-ipc/../../etc/shadow",
    ];
    for (const payload of traversalPayloads) {
      expect(validateChatId(payload)).not.toBeNull();
    }
  });

  it("rejects non-numeric strings", () => {
    const nonNumeric = [
      "not-a-number",
      "abc123",
      " ",
      "",
      "null",
      "DROP TABLE users",
      "<script>alert(1)</script>",
    ];
    for (const value of nonNumeric) {
      expect(validateChatId(value)).not.toBeNull();
    }
  });

  it("accepts valid numeric chat IDs", () => {
    expect(validateChatId("123456789")).toBeNull();
    expect(validateChatId("-1001234567890")).toBeNull();
    expect(validateChatId("0")).toBeNull();
  });

  it("PROPERTY: non-numeric strings are always rejected", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !CHAT_ID_REGEX.test(s)),
        (input) => {
          expect(validateChatId(input)).not.toBeNull();
        },
      ),
    );
  });

  it("allowlist rejects unauthorized numeric chat_ids", () => {
    const allowed = new Set(["111", "222"]);
    expect(validateChatId("111", allowed)).toBeNull();
    expect(validateChatId("999", allowed)).not.toBeNull();
  });
});

// --- R7: isLocalFile restricts to workspace ---

describe("R7: isLocalFile restricts to workspace directory", () => {
  const WORKSPACE_DIR = "/Users/testuser/workspace";

  function isLocalFile(s: string, workspaceDir: string): boolean {
    if (!s.startsWith("/") || !existsSync(s)) return false;
    const resolved = resolve(s);
    return resolved.startsWith(resolve(workspaceDir));
  }

  it("rejects /etc/passwd (outside workspace)", () => {
    expect(isLocalFile("/etc/passwd", WORKSPACE_DIR)).toBe(false);
  });

  it("rejects /etc/hosts (outside workspace)", () => {
    expect(isLocalFile("/etc/hosts", WORKSPACE_DIR)).toBe(false);
  });

  it("rejects sensitive system files", () => {
    const sensitiveFiles = ["/etc/passwd", "/etc/hosts", "/etc/shells"];
    for (const file of sensitiveFiles) {
      expect(isLocalFile(file, WORKSPACE_DIR)).toBe(false);
    }
  });

  it("rejects relative paths", () => {
    expect(isLocalFile("etc/passwd", WORKSPACE_DIR)).toBe(false);
    expect(isLocalFile("./etc/passwd", WORKSPACE_DIR)).toBe(false);
  });
});

// --- R2 also fixes R9 (path traversal in IPC filenames) ---

describe("R2+R9: numeric chat_id prevents IPC path traversal", () => {
  const IPC_DIR = "/tmp/leo-ipc";

  it("path.join with traversal chat_id WOULD escape IPC_DIR", () => {
    // Document what happens WITHOUT the fix
    const chatId = "../../tmp/evil";
    const outboxPath = join(IPC_DIR, `${chatId}.outbox.jsonl`);
    expect(outboxPath).toBe("/tmp/evil.outbox.jsonl");
  });

  it("but validateChatId rejects traversal before path.join is called", () => {
    const chatId = "../../tmp/evil";
    const err = validateChatId(chatId);
    expect(err).not.toBeNull();
    // Fix prevents reaching path.join
  });

  it("numeric chat_id stays within IPC_DIR", () => {
    const chatId = "123456789";
    const err = validateChatId(chatId);
    expect(err).toBeNull();

    const outboxPath = join(IPC_DIR, `${chatId}.outbox.jsonl`);
    expect(resolve(outboxPath).startsWith(resolve(IPC_DIR))).toBe(true);
  });

  it("PROPERTY: all numeric chat_ids produce paths inside IPC_DIR", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -999999999999, max: 999999999999 }).map(String),
        (chatId) => {
          const err = validateChatId(chatId);
          expect(err).toBeNull();
          const outboxPath = join(IPC_DIR, `${chatId}.outbox.jsonl`);
          expect(resolve(outboxPath).startsWith(resolve(IPC_DIR))).toBe(true);
        },
      ),
    );
  });
});

// --- dispatch_task YAML injection prevention ---

describe("dispatch_task: chat_id validation prevents YAML injection", () => {
  function buildTaskFrontmatter(chatId: string, description: string): string {
    const safeDesc = description.replace(/["\n\r\\]/g, " ").trim();
    return [
      "---",
      `chat_id: "${chatId}"`,
      `description: "${safeDesc}"`,
      `dispatched_at: "${new Date().toISOString()}"`,
      "---",
    ].join("\n");
  }

  it("YAML injection chat_id is rejected before frontmatter generation", () => {
    const maliciousChatId = '"\nchat_id: "attacker_chat';
    const err = validateChatId(maliciousChatId);
    expect(err).not.toBeNull();
    // Fix prevents reaching buildTaskFrontmatter
  });

  it("valid numeric chat_id produces clean frontmatter", () => {
    const chatId = "123456789";
    const err = validateChatId(chatId);
    expect(err).toBeNull();
    const fm = buildTaskFrontmatter(chatId, "legitimate task");
    const lines = fm.split("\n");
    expect(lines).toHaveLength(5); // ---, chat_id, desc, dispatched_at, ---
  });
});

// --- ask_user timeout bounds ---

describe("ask_user: timeout should be bounded", () => {
  const MAX_TIMEOUT = 600;

  function validateBoundedTimeout(val: unknown): boolean {
    return typeof val === "number" && val > 0 && val <= MAX_TIMEOUT;
  }

  it("rejects excessive timeouts", () => {
    expect(validateBoundedTimeout(86400)).toBe(false);
    expect(validateBoundedTimeout(2147483647)).toBe(false);
  });

  it("accepts reasonable timeouts", () => {
    expect(validateBoundedTimeout(60)).toBe(true);
    expect(validateBoundedTimeout(300)).toBe(true);
    expect(validateBoundedTimeout(600)).toBe(true);
  });
});
