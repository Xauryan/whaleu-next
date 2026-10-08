import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  VIEW_LIMITS,
  viewEpochRequestSchema,
  viewReportSchema,
  viewReportingEpochSchema,
  viewReportReceiptSchema,
} from '../src/community/view-component/contracts.js';

const epochId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const batchId = 'bcdefabc-defa-4bcd-9efa-bcdefabcdefa';
const postId = 'cdefabcd-efab-1cde-afab-cdefabcdefab';
const intent = {
  version: 1,
  epochId,
  batchId,
  kind: 'list_exposure',
  postIds: [postId],
};

test('discriminated request schema preserves the original runtime acceptance and normalization', () => {
  // Frozen pre-OpenAPI decoder, retained only as the regression oracle.
  const previous = z
    .strictObject({
      version: z.literal(1),
      epochId: z.uuidv4().transform((id) => id.toLowerCase()),
      batchId: z.uuidv4().transform((id) => id.toLowerCase()),
      kind: z.enum(['list_exposure', 'detail_visit']),
      postIds: z
        .array(z.uuid().transform((id) => id.toLowerCase()))
        .min(1)
        .max(50),
    })
    .refine(
      (input) => input.kind !== 'detail_visit' || input.postIds.length === 1,
    );
  const corpus: unknown[] = [
    null,
    undefined,
    false,
    1,
    'request',
    [],
    {},
    { ...intent },
  ];
  for (const kind of [
    'list_exposure',
    'detail_visit',
    'other',
    undefined,
    null,
  ]) {
    for (const length of [0, 1, 2, 49, 50, 51]) {
      for (const id of [
        postId,
        postId.toUpperCase(),
        epochId,
        '00000000-0000-0000-0000-000000000000',
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
        'invalid',
        1,
      ]) {
        corpus.push({ ...intent, kind, postIds: Array(length).fill(id) });
      }
    }
  }
  for (const key of Object.keys(intent)) {
    const missing: Record<string, unknown> = { ...intent };
    delete missing[key];
    corpus.push(missing);
    for (const value of [undefined, null, false, 2, [], {}, 'wrong']) {
      corpus.push({ ...intent, [key]: value });
    }
  }
  for (const change of [
    { extra: true },
    { postIds: [postId, postId] },
    {
      epochId: epochId.toUpperCase(),
      batchId: batchId.toUpperCase(),
      postIds: [postId.toUpperCase()],
    },
    { epochId: postId },
    { batchId: postId },
  ])
    corpus.push({ ...intent, ...change });
  for (const value of corpus) {
    const old = previous.safeParse(value);
    const current = viewReportSchema.safeParse(value);
    assert.equal(current.success, old.success, JSON.stringify(value));
    if (current.success && old.success)
      assert.deepEqual(current.data, old.data);
  }
  assert.deepEqual(
    viewReportSchema.parse({
      ...intent,
      epochId: epochId.toUpperCase(),
      batchId: batchId.toUpperCase(),
      postIds: [postId.toUpperCase()],
    }),
    intent,
  );
  assert.deepEqual(viewEpochRequestSchema.parse({ version: 1 }), {
    version: 1,
  });
  for (const value of [
    undefined,
    null,
    {},
    { version: 2 },
    { version: 1, extra: true },
  ]) {
    assert.equal(viewEpochRequestSchema.safeParse(value).success, false);
  }
});

const epoch = {
  version: 1,
  epochId,
  issuedAt: '2026-10-01T00:00:00.000Z',
  collectionUntil: '2026-10-01T01:00:00.000Z',
  expiresAt: '2026-10-02T00:00:00.000Z',
  serverNow: '2026-10-01T00:00:00.000Z',
};
test('epoch output enforces canonical wire values and runtime date arithmetic', () => {
  assert.deepEqual(viewReportingEpochSchema.parse(epoch), epoch);
  assert.equal(
    Date.parse(epoch.collectionUntil) - Date.parse(epoch.issuedAt),
    VIEW_LIMITS.collectionMs,
  );
  assert.equal(
    Date.parse(epoch.expiresAt) - Date.parse(epoch.issuedAt),
    VIEW_LIMITS.lifetimeMs,
  );
  const changes = [
    { epochId: epochId.toUpperCase() },
    { epochId: postId },
    { extra: true },
    { version: 2 },
    { issuedAt: epoch.issuedAt.replace('.000', '') },
    { issuedAt: epoch.issuedAt.replace('.000', '.0000') },
    { issuedAt: epoch.issuedAt.replace('Z', '+00:00') },
    { issuedAt: '2026-02-30T00:00:00.000Z' },
    { issuedAt: '2026-10-01T24:00:00.000Z' },
    { collectionUntil: '2026-10-01T01:00:00.001Z' },
    { expiresAt: '2026-10-02T00:00:00.001Z' },
    { serverNow: '2026-09-30T23:59:59.999Z' },
    { serverNow: epoch.collectionUntil },
  ];
  for (const change of changes)
    assert.equal(
      viewReportingEpochSchema.safeParse({ ...epoch, ...change }).success,
      false,
      JSON.stringify(change),
    );
  assert.equal(
    viewReportingEpochSchema.safeParse({
      ...epoch,
      serverNow: '2026-10-01T00:59:59.999Z',
    }).success,
    true,
  );
});

test('receipt output is strict, canonical and bounded separately for each kind', () => {
  const receipt = {
    version: 1,
    epochId,
    batchId,
    kind: 'list_exposure',
    payloadFingerprint: 'abcdef12'.repeat(8),
    acceptedCount: 50,
  };
  assert.deepEqual(viewReportReceiptSchema.parse(receipt), receipt);
  for (const change of [
    { epochId: epochId.toUpperCase() },
    { batchId: batchId.toUpperCase() },
    { epochId: postId },
    { batchId: postId },
    { payloadFingerprint: receipt.payloadFingerprint.toUpperCase() },
    { payloadFingerprint: 'a'.repeat(63) },
    { acceptedCount: -1 },
    { acceptedCount: 51 },
    { acceptedCount: 0.5 },
    { acceptedCount: NaN },
    { acceptedCount: Infinity },
    { extra: true },
    { kind: 'detail_visit' },
  ])
    assert.equal(
      viewReportReceiptSchema.safeParse({ ...receipt, ...change }).success,
      false,
      JSON.stringify(change),
    );
  for (const kind of ['list_exposure', 'detail_visit']) {
    for (const acceptedCount of [0, 1])
      assert.equal(
        viewReportReceiptSchema.safeParse({ ...receipt, kind, acceptedCount })
          .success,
        true,
      );
  }
  assert.equal(
    viewReportReceiptSchema.safeParse({
      ...receipt,
      kind: 'detail_visit',
      acceptedCount: 2,
    }).success,
    false,
  );
});
