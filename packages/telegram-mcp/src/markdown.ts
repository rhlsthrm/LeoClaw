/**
 * MarkdownV2 sanitization utilities extracted from index.ts for testability.
 * Handles Telegram MarkdownV2 escaping and bold/italic conversion.
 */

import { randomUUID } from "node:crypto";

// Characters that are special in MarkdownV2 and need escaping in regular text.
// Formatting delimiters (* _ ~) are intentionally excluded — the LLM handles those.
export const MD2_ESCAPE = new Set(".!+-=#{}()[]|>".split(""));

/**
 * Convert standard Markdown bold/italic to MarkdownV2 equivalents.
 * Claude writes **bold** and ***bold italic*** but MarkdownV2 uses *bold* and *_italic_*.
 *
 * R12 fix: Uses crypto.randomUUID() for placeholders to prevent injection via
 * predictable \x00CODE<n>\x00 patterns.
 */
export function convertMarkdownBold(text: string): string {
  // Preserve code blocks and inline code from conversion
  const protected_: { placeholder: string; original: string }[] = [];
  let result = text.replace(/```[\s\S]*?```|`[^`]+`/g, (match) => {
    const placeholder = `\x00${randomUUID()}\x00`;
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

/**
 * Escape special characters for Telegram MarkdownV2.
 * Handles code blocks, inline code, links, blockquotes, and spoilers as
 * structural contexts where characters are not escaped.
 */
export function sanitizeMarkdownV2(text: string): string {
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
