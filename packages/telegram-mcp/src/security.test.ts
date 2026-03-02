import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { join, resolve } from "node:path";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { validateChatId, isLocalFile, MAX_TIMEOUT_SECONDS, validateTimeout, CHAT_ID_REGEX } from "./validation.js";

/**
 * Security tests for @leoclaw/telegram-mcp.
 *
 * Tests import directly from validation.ts (the production module) so that any
 * regression in the real implementation is caught here, not in a shadow copy.
 */

// --- R2: chat_id validation ---

describe("R2: chat_id rejects non-numeric and adversarial values", () => {
  it("rejects path traversal payloads with descriptive error", () => {
    const traversalPayloads = [
      "../../etc/passwd",
      "../../../tmp/evil",
      "/tmp/leo-ipc/../../etc/shadow",
    ];
    for (const payload of traversalPayloads) {
      const error = validateChatId(payload);
      expect(error).not.toBeNull();
      expect(error).toMatch(/must be numeric/);
    }
  });

  it("rejects non-numeric strings with descriptive error", () => {
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
      const error = validateChatId(value);
      expect(error).not.toBeNull();
      expect(error).toMatch(/must be numeric/);
    }
  });

  it("accepts valid numeric chat IDs", () => {
    expect(validateChatId("123456789")).toBeNull();
    expect(validateChatId("-1001234567890")).toBeNull(); // negative = group/channel
    expect(validateChatId("0")).toBeNull();
  });

  it("PROPERTY: non-numeric strings are always rejected", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !CHAT_ID_REGEX.test(s)),
        (input) => {
          const error = validateChatId(input);
          expect(error).not.toBeNull();
          expect(error).toMatch(/must be numeric/);
        },
      ),
    );
  });

  it("allowlist rejects unauthorized numeric chat_ids", () => {
    const allowed = new Set(["111", "222"]);
    expect(validateChatId("111", allowed)).toBeNull();
    const error = validateChatId("999", allowed);
    expect(error).not.toBeNull();
    expect(error).toMatch(/Unauthorized/);
  });

  it("allowlist accepts all numeric IDs when allowedChatIds is null (no restriction configured)", () => {
    expect(validateChatId("999999", null)).toBeNull();
    expect(validateChatId("999999", undefined)).toBeNull();
  });
});

// --- R7: isLocalFile restricts to workspace ---

describe("R7: isLocalFile restricts to workspace directory", () => {
  it("rejects system files outside workspace", () => {
    const WORKSPACE_DIR = "/Users/testuser/workspace";
    const sensitiveFiles = ["/etc/passwd", "/etc/hosts", "/etc/shells"];
    for (const file of sensitiveFiles) {
      expect(isLocalFile(file, WORKSPACE_DIR)).toBe(false);
    }
  });

  it("rejects relative paths (must start with /)", () => {
    const WORKSPACE_DIR = "/Users/testuser/workspace";
    expect(isLocalFile("etc/passwd", WORKSPACE_DIR)).toBe(false);
    expect(isLocalFile("./etc/passwd", WORKSPACE_DIR)).toBe(false);
  });

  it("accepts a file that exists inside the workspace", () => {
    // Use a real temp directory so existsSync passes
    const tmpDir = mkdtempSync(join(tmpdir(), "leoclaw-test-workspace-"));
    const testFile = join(tmpDir, "test.txt");
    writeFileSync(testFile, "test");
    try {
      expect(isLocalFile(testFile, tmpDir)).toBe(true);
    } finally {
      unlinkSync(testFile);
      rmdirSync(tmpDir);
    }
  });

  it("rejects a path that starts with the workspace prefix but escapes via sibling dir", () => {
    // This is the critical sibling-directory bypass test.
    // e.g. workspace=/tmp/ws, path=/tmp/ws-evil/file — a bare startsWith would accept this.
    // The fix appends path.sep so "/tmp/ws" only matches "/tmp/ws/..." not "/tmp/ws-evil/...".
    const tmpBase = mkdtempSync(join(tmpdir(), "leo-sibling-"));
    const workspaceDir = join(tmpBase, "workspace");
    const siblingDir = join(tmpBase, "workspace-evil");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    const evilFile = join(siblingDir, "payload.txt");
    writeFileSync(evilFile, "evil");
    try {
      expect(isLocalFile(evilFile, workspaceDir)).toBe(false);
    } finally {
      unlinkSync(evilFile);
      rmdirSync(siblingDir);
      rmdirSync(workspaceDir);
      rmdirSync(tmpBase);
    }
  });
});

// --- R2 also fixes R9 (path traversal in IPC filenames) ---

describe("R2+R9: numeric chat_id prevents IPC path traversal", () => {
  const IPC_DIR = "/home/testuser/.leoclaw/ipc";

  it("vulnerability proof: path.join with traversal chat_id escapes IPC_DIR", () => {
    // Not a test of production code — demonstrates why validateChatId is necessary.
    const chatId = "../../tmp/evil";
    const outboxPath = join(IPC_DIR, `${chatId}.outbox.jsonl`);
    expect(outboxPath).not.toContain(IPC_DIR);
  });

  it("validateChatId rejects traversal before path.join is called", () => {
    const error = validateChatId("../../tmp/evil");
    expect(error).not.toBeNull();
    expect(error).toMatch(/must be numeric/);
  });

  it("numeric chat_id stays within IPC_DIR", () => {
    const chatId = "123456789";
    expect(validateChatId(chatId)).toBeNull();
    const outboxPath = join(IPC_DIR, `${chatId}.outbox.jsonl`);
    expect(resolve(outboxPath).startsWith(resolve(IPC_DIR))).toBe(true);
  });

  it("PROPERTY: all numeric chat_ids produce paths inside IPC_DIR", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -999999999999, max: 999999999999 }).map(String),
        (chatId) => {
          expect(validateChatId(chatId)).toBeNull();
          const outboxPath = join(IPC_DIR, `${chatId}.outbox.jsonl`);
          expect(resolve(outboxPath).startsWith(resolve(IPC_DIR))).toBe(true);
        },
      ),
    );
  });
});

// --- dispatch_task YAML injection prevention ---

describe("dispatch_task: chat_id validation prevents YAML injection", () => {
  it("YAML injection chat_id is rejected by validateChatId before frontmatter generation", () => {
    const maliciousChatId = '"\nchat_id: "attacker_chat';
    const error = validateChatId(maliciousChatId);
    expect(error).not.toBeNull();
    expect(error).toMatch(/must be numeric/);
  });

  it("valid numeric chat_id is accepted and produces a single clean chat_id line", () => {
    const chatId = "123456789";
    expect(validateChatId(chatId)).toBeNull();
    // Simulate what dispatch_task builds — verify only one chat_id line
    const safeDesc = "legitimate task".replace(/["\n\r\\]/g, " ").trim();
    const lines = [
      "---",
      `chat_id: "${chatId}"`,
      `description: "${safeDesc}"`,
      `dispatched_at: "${new Date().toISOString()}"`,
      "---",
    ];
    const fm = lines.join("\n");
    expect(fm.match(/^chat_id:/gm)).toHaveLength(1);
  });
});

// --- ask_user timeout bounds ---

describe("ask_user: timeout must be a positive number bounded by MAX_TIMEOUT_SECONDS", () => {
  it("MAX_TIMEOUT_SECONDS is 600 (10 minutes)", () => {
    // Pinning the constant so a silent change is caught immediately
    expect(MAX_TIMEOUT_SECONDS).toBe(600);
  });

  it("rejects excessive timeouts", () => {
    expect(validateTimeout(86400)).toBe(false);     // 1 day
    expect(validateTimeout(2147483647)).toBe(false); // INT_MAX
    expect(validateTimeout(601)).toBe(false);        // boundary: one over the limit
  });

  it("accepts valid timeouts up to and including the limit", () => {
    expect(validateTimeout(1)).toBe(true);
    expect(validateTimeout(60)).toBe(true);
    expect(validateTimeout(300)).toBe(true);
    expect(validateTimeout(600)).toBe(true); // boundary: exactly the limit
  });

  it("rejects non-positive values", () => {
    expect(validateTimeout(0)).toBe(false);
    expect(validateTimeout(-1)).toBe(false);
  });

  it("rejects non-numeric values", () => {
    expect(validateTimeout("600")).toBe(false);
    expect(validateTimeout(null)).toBe(false);
    expect(validateTimeout(undefined)).toBe(false);
  });
});
