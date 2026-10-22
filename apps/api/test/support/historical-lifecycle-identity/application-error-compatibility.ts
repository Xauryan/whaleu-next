import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ApplicationErrorCode } from '../../../src/http/application-error.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const historicalErrorProvenance = Object.freeze({
  acceptedCommit: 'da2784781db741e2fff5ad279fe3bc853bab0552',
  acceptedBlob: '4044097b65a40a24988b82e7aff0119fa2e822fe',
  acceptedSha256:
    'b8e891df9541f420b0739a79c804848b86ff5554c8977fbd6c8b2b0854050d84',
  preparationsSha256:
    'b6cef32d245eb7e04375618f243c5d0dfcdce522e4163b2a4c44b1075048df1e',
});
const addition = `  REAL_DELETION_UNAVAILABLE: {
    status: 503,
    message: 'Account deletion is unavailable.',
  },
  REAL_DELETION_SCOPE_UNAVAILABLE: {
    status: 404,
    message: 'Account deletion scope is unavailable.',
  },
  REAL_DELETION_INTENT_CONFLICT: {
    status: 409,
    message: 'Account deletion request conflicts.',
  },
`;
const anchor = 'const conditions = {\n';
const next = '  REFERENCE_NOT_FOUND: {\n';
function uniquePosition(source: string, exact: string): number {
  const position = source.indexOf(exact);
  assert.notEqual(position, -1, 'Missing exact reviewed error-table span');
  assert.equal(
    source.indexOf(exact, position + 1),
    -1,
    'Duplicated reviewed error-table span',
  );
  return position;
}
/** Remove only the reviewed preparations block, then prove complete bytes and replay. */
export function restoreAcceptedHistoricalErrors(bytes: Buffer): string {
  const current = bytes.toString('utf8');
  assert.equal(sha(current), historicalErrorProvenance.preparationsSha256);
  const position = uniquePosition(current, addition);
  assert.equal(position, uniquePosition(current, anchor) + anchor.length);
  assert.equal(uniquePosition(current, next), position + addition.length);
  const accepted =
    current.slice(0, position) + current.slice(position + addition.length);
  assert.equal(sha(accepted), historicalErrorProvenance.acceptedSha256);
  assert.equal(
    createHash('sha1')
      .update(`blob ${Buffer.byteLength(accepted)}\0`)
      .update(accepted)
      .digest('hex'),
    historicalErrorProvenance.acceptedBlob,
  );
  assert.equal(accepted.includes(addition), false);
  const insertion = uniquePosition(accepted, anchor) + anchor.length;
  assert.equal(uniquePosition(accepted, next), insertion);
  assert.equal(
    accepted.slice(0, insertion) + addition + accepted.slice(insertion),
    current,
  );
  return accepted;
}

// Read data only from the fully authenticated accepted source, never eval it.
// Every table byte must be consumed as a literal condition or whitespace.
export function acceptedHistoricalErrorConditions(bytes: Buffer) {
  const accepted = restoreAcceptedHistoricalErrors(bytes);
  const begin = uniquePosition(accepted, anchor) + anchor.length;
  const end = uniquePosition(accepted, '} as const;\n');
  const table = accepted.slice(begin, end);
  const literal =
    /^ {2}([A-Z][A-Z0-9_]*): \{\s+status: ([0-9]+),\s+message:\s+'([^'\\\r\n]*)',?\s*\},/gm;
  assert.equal(
    table.replace(literal, '').trim(),
    '',
    'No unparsed historical condition',
  );
  const entries = [...table.matchAll(literal)].map((match) => ({
    code: match[1] as ApplicationErrorCode,
    status: Number(match[2]),
    message: match[3],
  }));
  assert.equal(entries.length, 308);
  assert.equal(new Set(entries.map(({ code }) => code)).size, entries.length);
  return entries;
}

export const addedHistoricalErrorConditions = Object.freeze([
  {
    code: 'REAL_DELETION_UNAVAILABLE',
    status: 503,
    message: 'Account deletion is unavailable.',
  },
  {
    code: 'REAL_DELETION_SCOPE_UNAVAILABLE',
    status: 404,
    message: 'Account deletion scope is unavailable.',
  },
  {
    code: 'REAL_DELETION_INTENT_CONFLICT',
    status: 409,
    message: 'Account deletion request conflicts.',
  },
] as const);
