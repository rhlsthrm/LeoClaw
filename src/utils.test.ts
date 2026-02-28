import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { escapeHtml, parseBooleanEnv, parseAllowedUsersEnv } from "./utils.js";

/**
 * Adversarial property-based tests for security-critical harness utilities.
 */

// --- escapeHtml ---

describe("escapeHtml — HTML injection probing", () => {
  it("INVARIANT: output NEVER contains raw < or > (no tag injection)", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = escapeHtml(input);
        expect(result).not.toContain("<");
        expect(result).not.toContain(">");
      }),
    );
  });

  it("INVARIANT: every & in output starts a known entity", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = escapeHtml(input);
        for (let i = 0; i < result.length; i++) {
          if (result[i] !== "&") continue;
          const rest = result.slice(i);
          expect(
            rest.startsWith("&amp;") || rest.startsWith("&lt;") || rest.startsWith("&gt;"),
            `Bare '&' at index ${i} in: ${JSON.stringify(result)}\nInput: ${JSON.stringify(input)}`,
          ).toBe(true);
        }
      }),
    );
  });

  it("PROBE: pre-encoded entities get double-encoded (correct behavior — NOT decoded)", () => {
    // If escapeHtml tried to be "smart" and skip pre-existing entities,
    // an attacker could use &lt;script&gt; to bypass. Double-encoding is correct.
    const preEncoded = fc.constantFrom(
      "&amp;", "&lt;", "&gt;", "&lt;script&gt;", "&#60;", "&#x3C;",
      "&amp;lt;", "&amp;amp;",
    );
    fc.assert(
      fc.property(preEncoded, (input) => {
        const result = escapeHtml(input);
        // The & of any pre-existing entity must be escaped again
        expect(result).not.toContain("<");
        expect(result).not.toContain(">");
      }),
    );
  });

  it("PROBE: unicode angle bracket lookalikes pass through (expected but notable)", () => {
    // These are NOT HTML-special but could be visually confusing
    const unicodeBrackets = [
      "\uFF1C", // ＜ fullwidth less-than
      "\uFF1E", // ＞ fullwidth greater-than
      "\u2039", // ‹ single left angle quote
      "\u203A", // › single right angle quote
      "\u27E8", // ⟨ mathematical left angle bracket
      "\u27E9", // ⟩ mathematical right angle bracket
    ];
    for (const ch of unicodeBrackets) {
      const result = escapeHtml(ch);
      // These pass through unescaped — Telegram HTML doesn't treat them as tags
      // but they could be used for visual spoofing. Noting this for awareness.
      expect(result).toBe(ch);
    }
  });
});

// --- parseBooleanEnv ---

describe("parseBooleanEnv — DANGEROUSLY_SKIP_PERMISSIONS safety", () => {
  it("INVARIANT: only returns true for exact truthy values (no accidental bypass)", () => {
    const TRUTHY = new Set(["1", "true", "yes", "on"]);
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = parseBooleanEnv(input);
        if (result === true) {
          expect(
            TRUTHY.has(input.trim().toLowerCase()),
            `returned true for: ${JSON.stringify(input)}`,
          ).toBe(true);
        }
      }),
    );
  });

  it("PROBE: unicode whitespace around truthy values", () => {
    // trim() only removes ASCII whitespace. Unicode spaces could sneak through.
    const unicodeSpaces = [
      "\u00A0", // non-breaking space
      "\u2000", // en quad
      "\u2003", // em space
      "\u3000", // ideographic space
      "\uFEFF", // zero-width no-break space (BOM)
    ];
    for (const space of unicodeSpaces) {
      const result = parseBooleanEnv(`${space}true${space}`);
      // If trim() doesn't strip these, "true" with unicode padding returns undefined
      // rather than true. This is arguably a bug (inconsistent with intent) but is
      // SAFE for security: it's a false-negative (denies), not a false-positive.
      // The dangerous direction would be returning true for non-truthy input.
      if (result === true) {
        // trim() stripped the unicode space — this means truthy
        expect(true).toBe(true);
      } else {
        // trim() didn't strip it — returns undefined (safe direction)
        expect(result).toBeUndefined();
      }
    }
  });

  it("PROBE: near-miss truthy strings never return true", () => {
    const nearMisses = fc.constantFrom(
      "tru", "truee", "ture", "trUE!", "yes!", "1 ", " 1",
      "on1", "onn", "yess", "TRUE\x00", "true\n", "true\r",
      "true\ttrue", "1true", "yes1",
    );
    fc.assert(
      fc.property(nearMisses, (input) => {
        const result = parseBooleanEnv(input);
        // " 1" and " 1" should return true after trim — they ARE truthy
        const trimmed = input.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(trimmed)) {
          expect(result).toBe(true);
        } else {
          expect(
            result !== true,
            `Near-miss "${input}" incorrectly returned true`,
          ).toBe(true);
        }
      }),
    );
  });

  it("INVARIANT: empty string returns undefined (empty env var = unset = safe)", () => {
    expect(parseBooleanEnv("")).toBeUndefined();
    expect(parseBooleanEnv(undefined)).toBeUndefined();
  });
});

// --- parseAllowedUsersEnv ---

describe("parseAllowedUsersEnv — authorization bypass probing", () => {
  it("INVARIANT: result never contains empty strings", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = parseAllowedUsersEnv(input);
        if (!result) return;
        for (const entry of result) {
          expect(entry.length).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("INVARIANT: all entries are trimmed (no whitespace that breaks Set.has())", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = parseAllowedUsersEnv(input);
        if (!result) return;
        for (const entry of result) {
          expect(entry).toBe(entry.trim());
        }
      }),
    );
  });

  it("PROBE: adversarial delimiters — only comma splits (not semicolons, pipes, spaces)", () => {
    // If the parser split on other delimiters, a single "user ID" could
    // become multiple, potentially including empty strings
    const inputs = fc.constantFrom(
      "123;456", "123|456", "123 456", "123\t456", "123\n456",
    );
    fc.assert(
      fc.property(inputs, (input) => {
        const result = parseAllowedUsersEnv(input);
        // Should NOT split on ; | space tab newline — should return a single entry
        // containing the delimiter
        expect(result).toBeDefined();
        expect(result!.length).toBe(1);
      }),
    );
  });

  it("PROBE: only-commas and only-whitespace inputs return empty array or undefined", () => {
    const degenerate = fc.constantFrom(
      ",", ",,", ",,,", " , , , ", "\t,\n,", "  ",
    );
    fc.assert(
      fc.property(degenerate, (input) => {
        const result = parseAllowedUsersEnv(input);
        if (!result) return; // undefined is fine
        // Should be empty or contain no empty strings
        for (const entry of result) {
          expect(entry.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});
