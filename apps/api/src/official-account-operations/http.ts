import { ApplicationError } from '../http/application-error.js';
import { validLiteral, OFFICIAL_PROFILE } from './profile.js';
/** Reject duplicate member names at every depth before JSON.parse can erase them. */
export function decodeOfficialJson(raw: Buffer): unknown {
  if (raw.byteLength > OFFICIAL_PROFILE.requestBytes)
    throw new ApplicationError('OFFICIAL_REQUEST_INVALID');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new ApplicationError('OFFICIAL_REQUEST_INVALID');
  }
  let at = 0;
  const whitespace = () => {
    while (/\s/.test(text[at] ?? '') && at < text.length) at++;
  };
  const string = () => {
    const start = at++;
    let escaped = false;
    while (at < text.length) {
      const c = text[at++]!;
      if (!escaped && c === '"') {
        const value = JSON.parse(text.slice(start, at)) as string;
        if (!validLiteral(value)) throw new Error('Literal');
        return value;
      }
      if (!escaped && c === '\\') escaped = true;
      else escaped = false;
    }
    throw new Error('String');
  };
  const value = (depth: number): void => {
    if (depth > 8) throw new Error('Depth');
    whitespace();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === '{') {
      at++;
      whitespace();
      const keys = new Set<string>();
      if (text[at] === '}') {
        at++;
        return;
      }
      for (;;) {
        whitespace();
        if (text[at] !== '"') throw new Error('Key');
        const key = string();
        if (keys.has(key)) throw new Error('Duplicate');
        keys.add(key);
        whitespace();
        if (text[at++] !== ':') throw new Error('Colon');
        value(depth + 1);
        whitespace();
        const c = text[at++];
        if (c === '}') return;
        if (c !== ',') throw new Error('Comma');
      }
    }
    if (text[at] === '[') {
      at++;
      whitespace();
      if (text[at] === ']') {
        at++;
        return;
      }
      for (;;) {
        value(depth + 1);
        whitespace();
        const c = text[at++];
        if (c === ']') return;
        if (c !== ',') throw new Error('Comma');
      }
    }
    const match =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(at),
      );
    if (!match) throw new Error('Value');
    at += match[0].length;
  };
  try {
    value(0);
    whitespace();
    if (at !== text.length) throw new Error('Trailing');
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApplicationError('OFFICIAL_REQUEST_INVALID');
  }
}
