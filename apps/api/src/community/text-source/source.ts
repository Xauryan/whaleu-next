import { createHash } from 'node:crypto';
import {
  decodeTextSourceDescriptor,
  isTextSourceKind,
  TEXT_SOURCE_HASH_DOMAIN,
  TEXT_SOURCE_MAXIMUM,
  TEXT_SOURCE_READING_THRESHOLD,
} from './contracts.js';
import type { TextSourceDescriptor, TextSourceKind } from './contracts.js';

export type SourceValidation =
  | Readonly<{ ok: true; canonicalText: string; scalarCount: number }>
  | Readonly<{
      ok: false;
      reason: 'invalid_kind' | 'invalid_source' | 'source_too_long';
    }>;
export interface PreparedTextSource {
  /** Editable draft only; never serialize preview nodes back into this string. */
  readonly rawText: string;
  readonly canonicalText: string;
  readonly descriptor: TextSourceDescriptor;
  readonly scalarCount: number;
  readonly sourceHash: string;
  readonly readingFormattingEligible: boolean;
}

/** Exactly the historical text transformation and scalar/control limits. No trim or NFC. */
export function validateTextSource(
  rawText: unknown,
  kind: unknown,
): SourceValidation {
  if (!isTextSourceKind(kind)) return { ok: false, reason: 'invalid_kind' };
  if (typeof rawText !== 'string')
    return { ok: false, reason: 'invalid_source' };
  const maximum = TEXT_SOURCE_MAXIMUM[kind];
  // Each accepted scalar occupies at most two UTF-16 units, including raw CRLF.
  if (rawText.length > maximum * 2)
    return { ok: false, reason: 'source_too_long' };
  const canonicalText = rawText.replace(/\r\n/g, '\n');
  let scalarCount = 0;
  for (const character of canonicalText) {
    const code = character.codePointAt(0)!;
    if (!(
      code === 9 ||
      code === 10 ||
      (code >= 32 &&
        !(code >= 127 && code <= 159) &&
        !(code >= 0xd800 && code <= 0xdfff))
    ))
      return { ok: false, reason: 'invalid_source' };
    scalarCount++;
    if (scalarCount > maximum) return { ok: false, reason: 'source_too_long' };
  }
  return { ok: true, canonicalText, scalarCount };
}

/** Separate source digest domain. Never replace any legacy request/intent/Review hash. */
export function prepareTextSource(
  rawText: unknown,
  descriptorValue: unknown,
  kind: TextSourceKind,
): PreparedTextSource | null {
  const descriptor = decodeTextSourceDescriptor(descriptorValue);
  const checked = validateTextSource(rawText, kind);
  if (descriptor === null || !checked.ok || typeof rawText !== 'string')
    return null;
  const preimage =
    TEXT_SOURCE_HASH_DOMAIN + descriptor.format + '\n' + checked.canonicalText;
  return Object.freeze({
    rawText,
    canonicalText: checked.canonicalText,
    descriptor,
    scalarCount: checked.scalarCount,
    sourceHash: createHash('sha256').update(preimage, 'utf8').digest('hex'),
    readingFormattingEligible:
      descriptor.format === 'plain' &&
      descriptor.readingFormatting === 'auto' &&
      checked.scalarCount >= TEXT_SOURCE_READING_THRESHOLD[kind],
  });
}
