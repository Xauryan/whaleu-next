import { decodeHTMLStrict } from 'entities/decode';

/** PHP trim default charlist, deliberately not JS/Unicode whitespace. */
export function trimLegacyHomeText(text: string): string {
  return text.replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/gu, '');
}

/** PHP html_entity_decode(ENT_QUOTES | ENT_HTML5, 'UTF-8'), not a browser
 * decoder. Named decoding uses pinned entities' public strict API only.
 * Numeric controls/noncharacters remain literal instead of browser replacement
 * or Windows-1252 remapping. Semicolons are mandatory; decoding is one pass.
 * Verified against the task-local PHP 8.4.24 oracle; not an HTML sanitizer. */
export function decodeLegacyHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#[xX](?:0[xX])?[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/gu,
    (entity) => {
      if (entity[1] !== '#') return decodeHTMLStrict(entity);
      const hex = entity[2] === 'x' || entity[2] === 'X';
      const codepoint = Number.parseInt(
        entity.slice(hex ? 3 : 2, -1),
        hex ? 16 : 10,
      );
      if (
        !Number.isSafeInteger(codepoint) ||
        codepoint > 0x10ffff ||
        (codepoint < 0x20 && ![0x09, 0x0a, 0x0c].includes(codepoint)) ||
        (codepoint >= 0x7f && codepoint <= 0x9f) ||
        (codepoint >= 0xd800 && codepoint <= 0xdfff) ||
        (codepoint >= 0xfdd0 && codepoint <= 0xfdef) ||
        (codepoint & 0xffff) >= 0xfffe
      )
        return entity;
      return String.fromCodePoint(codepoint);
    },
  );
}
