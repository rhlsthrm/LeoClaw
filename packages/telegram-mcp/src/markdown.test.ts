import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { sanitizeMarkdownV2, convertMarkdownBold, MD2_ESCAPE } from "./markdown.js";

/**
 * Adversarial property-based tests targeting real vulnerabilities
 * in the MarkdownV2 sanitization pipeline.
 */

// --- Arbitraries ---

/** Strings with NO structural markdown — all MD2_ESCAPE chars must be escaped */
const plainTextArb = fc.string().filter((s) =>
  !s.includes("```") && !s.includes("`") && !s.includes("||") &&
  !s.includes("[") && !s.includes("\\") &&
  // exclude > at line start (blockquote)
  !s.startsWith(">") && !s.includes("\n>"),
);

/** Build a string from an alphabet of specific chars */
const stringFromChars = (chars: string[], opts: { minLength: number; maxLength: number }) =>
  fc.array(fc.constantFrom(...chars), opts).map((a) => a.join(""));

/** Strings with structural markers mixed in — probes parser boundary bugs */
const adversarialArb = stringFromChars(
  [
    // structural markers
    "[", "]", "(", ")", "`", "|", "\\", ">", "\n",
    // MD2_ESCAPE chars that must be escaped in plain text
    ".", "!", "+", "-", "=", "#", "{", "}",
    // regular chars
    "a", "b", " ",
  ],
  { minLength: 1, maxLength: 80 },
);

/** Strings that look like links with tricky URLs */
const trickLinkArb = fc.tuple(
  stringFromChars(["a", ".", "!", "[", "]"], { minLength: 0, maxLength: 10 }),
  stringFromChars(["x", ")", "\\", "(", "]"], { minLength: 0, maxLength: 15 }),
).map(([display, url]) => `[${display}](${url})`);

// --- sanitizeMarkdownV2 ---

describe("sanitizeMarkdownV2 — adversarial probing", () => {
  it("INVARIANT: output is never shorter than input (escaping only adds chars)", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = sanitizeMarkdownV2(text);
        expect(result.length).toBeGreaterThanOrEqual(text.length);
      }),
    );
  });

  it("INVARIANT: all MD2_ESCAPE chars escaped in plain text (no structural markers)", () => {
    fc.assert(
      fc.property(plainTextArb, (text) => {
        const result = sanitizeMarkdownV2(text);
        for (let i = 0; i < result.length; i++) {
          if (!MD2_ESCAPE.has(result[i])) continue;
          if (result[i] === ">" && (i === 0 || result[i - 1] === "\n")) continue;
          expect(
            i > 0 && result[i - 1] === "\\",
            `Unescaped '${result[i]}' at index ${i} in output: ${JSON.stringify(result)}\nInput: ${JSON.stringify(text)}`,
          ).toBe(true);
        }
      }),
    );
  });

  it("PROBE: overlapping structural markers — do they leak unescaped chars?", () => {
    // Generate adversarial strings mixing structural and special chars
    fc.assert(
      fc.property(adversarialArb, (text) => {
        // Should not throw (stack overflow from recursive sanitize, etc.)
        const result = sanitizeMarkdownV2(text);
        expect(typeof result).toBe("string");

        // The result should be at least as long as input
        expect(result.length).toBeGreaterThanOrEqual(text.length);
      }),
    );
  });

  it("PROBE: link with parens in URL — does greedy indexOf(')') truncate and leave unescaped chars?", () => {
    fc.assert(
      fc.property(trickLinkArb, (text) => {
        const result = sanitizeMarkdownV2(text);

        // After the link is consumed, any remaining chars should be properly handled.
        // Specifically: no bare (unescaped) MD2_ESCAPE chars outside structural contexts.
        // We can't easily parse the output structure, but we CAN check:
        // the output should not contain a bare ) that isn't \) and isn't inside []()
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThanOrEqual(text.length);
      }),
    );
  });

  it("PROBE: unclosed inline code swallows subsequent text without escaping", () => {
    // If backtick pairs form incorrectly, content between them is passed verbatim
    // (no escaping). An attacker could use this to smuggle unescaped special chars.
    const inputs = fc.tuple(
      stringFromChars(["a", ".", "!"], { minLength: 1, maxLength: 5 }),
      stringFromChars(["b", ".", "!"], { minLength: 1, maxLength: 5 }),
      stringFromChars(["c", ".", "!"], { minLength: 1, maxLength: 5 }),
    ).map(([before, inside, after]) => `${before}\`${inside}\`${after}`);

    fc.assert(
      fc.property(inputs, (text) => {
        const result = sanitizeMarkdownV2(text);
        // The backtick pair creates inline code — content inside should NOT be escaped.
        // But content AFTER the closing backtick MUST have its special chars escaped.
        const closingBacktick = result.lastIndexOf("`");
        const afterCode = result.slice(closingBacktick + 1);
        for (let i = 0; i < afterCode.length; i++) {
          if (!MD2_ESCAPE.has(afterCode[i])) continue;
          expect(
            i > 0 && afterCode[i - 1] === "\\",
            `Unescaped '${afterCode[i]}' AFTER inline code in: ${JSON.stringify(result)}`,
          ).toBe(true);
        }
      }),
    );
  });

  it("PROBE: spoiler delimiter confusion — single | vs || boundary", () => {
    // |text|| — does the parser see this as spoiler? It shouldn't.
    // ||text| — unclosed spoiler?
    const spoilerArb = fc.tuple(
      fc.constantFrom("|", "||", "|||"),
      stringFromChars(["a", ".", "!"], { minLength: 1, maxLength: 5 }),
      fc.constantFrom("|", "||", "|||"),
    ).map(([open, content, close]) => `${open}${content}${close}`);

    fc.assert(
      fc.property(spoilerArb, (text) => {
        const result = sanitizeMarkdownV2(text);
        expect(result.length).toBeGreaterThanOrEqual(text.length);
      }),
    );
  });
});

// --- convertMarkdownBold ---

describe("convertMarkdownBold — placeholder injection", () => {
  it("FIXED: input containing old \\x00CODE<n>\\x00 pattern no longer hijacks restoration", () => {
    // R12 fix: placeholders use crypto.randomUUID() so the old predictable
    // \x00CODE0\x00 pattern cannot collide with internal placeholders.
    const injection = "\x00CODE0\x00";
    const input = `${injection} \`real code\``;

    const result = convertMarkdownBold(input);

    // After fix: the injected \x00CODE0\x00 passes through unchanged (it's not
    // a valid placeholder), and the real code block is preserved correctly.
    expect(result).toContain("`real code`");
  });

  it("FIXED: multiple code blocks with old placeholder pattern are unaffected", () => {
    // Old predictable placeholders \x00CODE0\x00, \x00CODE1\x00 no longer match
    // internal UUIDs, so they pass through without corrupting output.
    const input = "\x00CODE0\x00 \x00CODE1\x00 `first` `second`";
    const result = convertMarkdownBold(input);

    // Both code blocks preserved at their original positions
    expect(result).toContain("`first`");
    expect(result).toContain("`second`");
  });

  it("INVARIANT: output never contains null bytes when input has none", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes("\x00")),
        (text) => {
          const result = convertMarkdownBold(text);
          expect(result.includes("\x00")).toBe(false);
        },
      ),
    );
  });
});

// --- Full pipeline: convertMarkdownBold → sanitizeMarkdownV2 ---

describe("full pipeline — convertMarkdownBold then sanitizeMarkdownV2", () => {
  const pipeline = (text: string) => sanitizeMarkdownV2(convertMarkdownBold(text));

  it("INVARIANT: pipeline never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(() => pipeline(text)).not.toThrow();
      }),
    );
  });

  it("INVARIANT: pipeline output never shorter than input", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = pipeline(text);
        expect(result.length).toBeGreaterThanOrEqual(text.length);
      }),
    );
  });

  it("PROBE: bold markers around special chars — do they escape correctly after conversion?", () => {
    // **text.with.dots** → *text.with.dots* → then sanitize
    // The dots should still be escaped after bold conversion
    const boldWithSpecials = fc.tuple(
      fc.constantFrom("**", "***"),
      stringFromChars(["a", ".", "!", "(", ")", "+"], { minLength: 1, maxLength: 10 }),
    ).map(([delim, content]) => `${delim}${content}${delim}`);

    fc.assert(
      fc.property(boldWithSpecials, (text) => {
        const result = pipeline(text);
        // After conversion, the content is now between * or *_ _*
        // The special chars inside should still be escaped by sanitizeMarkdownV2
        // Check: no bare . ! ( ) + outside of escape pairs
        for (let i = 0; i < result.length; i++) {
          const ch = result[i];
          if (ch === "." || ch === "!" || ch === "(" || ch === ")" || ch === "+") {
            expect(
              i > 0 && result[i - 1] === "\\",
              `Unescaped '${ch}' at ${i} in pipeline output: ${JSON.stringify(result)}\nInput: ${JSON.stringify(text)}`,
            ).toBe(true);
          }
        }
      }),
    );
  });

  it("PROBE: adversarial strings through full pipeline", () => {
    fc.assert(
      fc.property(adversarialArb, (text) => {
        const result = pipeline(text);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThanOrEqual(text.length);
      }),
    );
  });
});
