/** M1a source syntax only. This is NOT a publication, Review or access proof. */
export type TextSourceDescriptor =
  | Readonly<{ version: 1; format: 'plain'; readingFormatting: 'auto' | 'off' }>
  | Readonly<{ version: 1; format: 'markdown' }>;
export type TextSourceKind = 'post' | 'comment' | 'reply';
export const TEXT_SOURCE_HASH_DOMAIN = 'whaleu-community-text-source:v1\n';
export const TEXT_SOURCE_MAXIMUM = Object.freeze({
  post: 2500,
  comment: 500,
  reply: 500,
});
export const TEXT_SOURCE_READING_THRESHOLD = Object.freeze({
  post: 300,
  comment: 200,
  reply: 200,
});

/** Explicit-only: missing descriptors never select or alter a legacy path. */
export function decodeTextSourceDescriptor(
  value: unknown,
): TextSourceDescriptor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  // Reject non-JSON keys, accessors and hidden properties, not just extra enumerable keys.
  if (
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !descriptors[key]?.enumerable ||
        !('value' in descriptors[key]!),
    )
  )
    return null;
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1) return null;
  if (
    record['format'] === 'markdown' &&
    keys.length === 2 &&
    keys.includes('version') &&
    keys.includes('format')
  ) {
    return Object.freeze({ version: 1, format: 'markdown' });
  }
  if (
    record['format'] === 'plain' &&
    keys.length === 3 &&
    keys.includes('version') &&
    keys.includes('format') &&
    keys.includes('readingFormatting') &&
    (record['readingFormatting'] === 'auto' ||
      record['readingFormatting'] === 'off')
  ) {
    return Object.freeze({
      version: 1,
      format: 'plain',
      readingFormatting: record['readingFormatting'],
    });
  }
  return null;
}
export function isTextSourceKind(value: unknown): value is TextSourceKind {
  return value === 'post' || value === 'comment' || value === 'reply';
}
