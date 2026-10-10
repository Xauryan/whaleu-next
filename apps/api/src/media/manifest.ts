import { createHash } from 'node:crypto';
import { mediaManifestSchema } from './contracts.js';
import type { MediaManifest } from './contracts.js';

/** Explicit key sorting is part of the v1 digest contract; array order is exact.
 * This is deliberately not a generic arbitrary-JSON canonicalizer. The strict
 * schema excludes nonfinite values, optional fields, secrets and unknown keys. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function canonicalManifest(input: unknown): string {
  return canonical(mediaManifestSchema.parse(input));
}
export function sealManifest(input: unknown): {
  readonly manifest: MediaManifest;
  readonly canonical: string;
  readonly digest: string;
} {
  const manifest = freeze(mediaManifestSchema.parse(input));
  const encoded = canonical(manifest);
  return Object.freeze({
    manifest,
    canonical: encoded,
    digest: createHash('sha256')
      .update('whaleu-media-manifest:v1\n')
      .update(encoded)
      .digest('hex'),
  });
}
