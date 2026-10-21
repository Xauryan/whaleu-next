/** Explicit immutable source syntax. Never an authorization or worker permit. */
import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
export type SourceKind = 'post' | 'comment' | 'reply';
export type TextSourceDescriptor =
  | Readonly<{ version: 1; format: 'plain'; readingFormatting: 'auto' | 'off' }>
  | Readonly<{ version: 1; format: 'markdown' }>;
export const DEFAULT_TEXT_SOURCE: TextSourceDescriptor = Object.freeze({
  version: 1,
  format: 'plain',
  readingFormatting: 'auto',
});
function invalid(): never {
  throw new ClientError('protocol', 'Invalid immutable text source');
}
function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid();
}
export function decodeTextSourceDescriptor(
  value: unknown,
): TextSourceDescriptor {
  if (!isRecord(value)) invalid();
  if (value.format === 'markdown') {
    exact(value, ['version', 'format']);
    if (value.version !== 1) invalid();
    return Object.freeze({ version: 1, format: 'markdown' });
  }
  exact(value, ['version', 'format', 'readingFormatting']);
  if (
    value.version !== 1 ||
    value.format !== 'plain' ||
    (value.readingFormatting !== 'auto' && value.readingFormatting !== 'off')
  )
    invalid();
  return Object.freeze({
    version: 1,
    format: 'plain',
    readingFormatting: value.readingFormatting,
  });
}
export function canonicalSourceText(raw: unknown, kind: SourceKind): string {
  const maximum = kind === 'post' ? 2500 : 500;
  if (typeof raw !== 'string' || raw.length > maximum * 2) invalid();
  const text = raw.replace(/\r\n/g, '\n');
  let count = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (
      ++count > maximum ||
      !(
        code === 9 ||
        code === 10 ||
        (code >= 32 &&
          !(code >= 127 && code <= 159) &&
          !(code >= 0xd800 && code <= 0xdfff))
      )
    )
      invalid();
  }
  return text;
}
export function textSourceHash(
  text: string,
  descriptor: TextSourceDescriptor,
): string {
  return sha256(
    'whaleu-community-text-source:v1\n' + descriptor.format + '\n' + text,
  );
}
export function textSourceIntentHash(
  operation: 'publish_post' | 'publish_comment' | 'publish_reply',
  intent: object,
): string {
  return sha256(
    'whaleu-community-text-source-intent:v1\n' +
      JSON.stringify({ operation, intent }),
  );
}
export function sourceEligible(
  text: string,
  descriptor: TextSourceDescriptor,
  kind: SourceKind,
): boolean {
  return (
    descriptor.format === 'plain' &&
    descriptor.readingFormatting === 'auto' &&
    [...text].length >= (kind === 'post' ? 300 : 200)
  );
}
/** Matches current server text-only Markdown coverage; no silent reference stripping. */
export function sourceTextAvailable(
  text: string,
  descriptor: TextSourceDescriptor,
): boolean {
  return (
    descriptor.format !== 'markdown' ||
    (!text.includes('whaleu-asset:') && !/#[0-9]/.test(text))
  );
}
export interface TextSourceCapability {
  readonly version: 1;
  readonly authorMode: 'named' | 'anonymous';
  readonly availability: 'available' | 'unavailable';
  readonly operations: readonly (
    'publish_post' | 'publish_comment' | 'publish_reply'
  )[];
  readonly formats: readonly ('plain' | 'markdown')[];
  readonly readingFormatting: readonly ('auto' | 'off')[];
  readonly media: 'unavailable';
  readonly markdownReferences: 'unavailable';
  readonly formatter: 'not_configured';
}
export function decodeTextSourceCapability(
  value: unknown,
): TextSourceCapability {
  exact(value, [
    'version',
    'authorMode',
    'availability',
    'operations',
    'formats',
    'readingFormatting',
    'media',
    'markdownReferences',
    'formatter',
  ]);
  if (
    value.version !== 1 ||
    !['named', 'anonymous'].includes(String(value.authorMode)) ||
    !['available', 'unavailable'].includes(String(value.availability)) ||
    value.media !== 'unavailable' ||
    value.markdownReferences !== 'unavailable' ||
    value.formatter !== 'not_configured'
  )
    invalid();
  const strings = (raw: unknown, allowed: readonly string[]): string[] => {
    if (
      !Array.isArray(raw) ||
      raw.some((v) => typeof v !== 'string' || !allowed.includes(v)) ||
      new Set(raw).size !== raw.length
    )
      invalid();
    return [...raw] as string[];
  };
  const operations = strings(value.operations, [
    'publish_post',
    'publish_comment',
    'publish_reply',
  ]);
  const formats = strings(value.formats, ['plain', 'markdown']);
  const readingFormatting = strings(value.readingFormatting, ['auto', 'off']);
  if (
    value.availability === 'available'
      ? !operations.length ||
        formats.join(',') !== 'plain,markdown' ||
        readingFormatting.join(',') !== 'auto,off'
      : operations.length + formats.length + readingFormatting.length !== 0
  )
    invalid();
  return Object.freeze({
    version: 1,
    authorMode: value.authorMode as TextSourceCapability['authorMode'],
    availability: value.availability as TextSourceCapability['availability'],
    operations: operations as TextSourceCapability['operations'],
    formats: formats as TextSourceCapability['formats'],
    readingFormatting:
      readingFormatting as TextSourceCapability['readingFormatting'],
    media: 'unavailable',
    markdownReferences: 'unavailable',
    formatter: 'not_configured',
  });
}
