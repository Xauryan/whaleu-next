import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  adminDeleteErrandSchema,
  restrictErrandAccepterSchema,
  issueErrandRestrictionSchema,
  releaseErrandRestrictionSchema,
  errandRestrictionDurationSchema,
  errandAdminReceiptSchema,
  errandRestrictionReceiptSchema,
  errandRestrictionViewSchema,
} from '../src/errands/admin-command-contracts.js';
import { errandNoticeSchema } from '../src/notifications/errand-contracts.js';
const command = () => ({
  clientRequestId: randomUUID(),
  expectedRevision: randomUUID(),
});
const duration = { kind: 'finite' as const, unit: 'days' as const, value: 7 };
test('administrative fresh reasons use code points, exact optional restriction and no silent defaults', () => {
  const c = command();
  assert.deepEqual(adminDeleteErrandSchema.parse(c), {
    ...c,
    deleteReason: '',
    publisherRestriction: null,
  });
  assert.equal(
    adminDeleteErrandSchema.parse({ ...c, deleteReason: '🐋'.repeat(500) })
      .deleteReason.length,
    1000,
  );
  for (const reason of ['', '🐋'.repeat(256)])
    assert.equal(
      adminDeleteErrandSchema.safeParse({
        ...c,
        deleteReason: reason,
        publisherRestriction: duration,
      }).success,
      false,
    );
  assert.equal(
    adminDeleteErrandSchema.safeParse({
      ...c,
      deleteReason: '🐋'.repeat(255),
      publisherRestriction: duration,
    }).success,
    true,
  );
  assert.equal(
    adminDeleteErrandSchema.safeParse({ ...c, deleteReason: 'x'.repeat(501) })
      .success,
    false,
  );
  for (const extra of [
    { subjectId: randomUUID() },
    { regionId: randomUUID() },
    { actorId: randomUUID() },
  ])
    assert.equal(
      adminDeleteErrandSchema.safeParse({ ...c, ...extra }).success,
      false,
    );
  for (const reason of ['', 'x'.repeat(256), 'bad\u0000']) {
    assert.equal(
      restrictErrandAccepterSchema.safeParse({ ...c, reason, duration })
        .success,
      false,
    );
    assert.equal(
      releaseErrandRestrictionSchema.safeParse({
        clientRequestId: c.clientRequestId,
        reason,
      }).success,
      false,
    );
  }
  assert.equal(
    restrictErrandAccepterSchema.parse({
      ...c,
      reason: '  valid\r\nreason ',
      duration,
    }).reason,
    'valid\nreason',
  );
});

test('duration is a single explicit bounded discriminant without a365-day ceiling', () => {
  for (const value of [1, 7, 366, 100000])
    assert.equal(
      errandRestrictionDurationSchema.safeParse({
        kind: 'finite',
        unit: 'days',
        value,
      }).success,
      true,
    );
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(
      errandRestrictionDurationSchema.safeParse({
        kind: 'finite',
        unit: 'hours',
        value,
      }).success,
      false,
    );
  for (const bad of [
    { kind: 'permanent', value: 1 },
    { kind: 'finite', unit: 'weeks', value: 1 },
    { kind: 'finite', unit: 'days' },
    {},
  ])
    assert.equal(errandRestrictionDurationSchema.safeParse(bad).success, false);
  assert.deepEqual(
    errandRestrictionDurationSchema.parse({ kind: 'permanent' }),
    { kind: 'permanent' },
  );
  assert.equal(
    issueErrandRestrictionSchema.safeParse({
      clientRequestId: randomUUID(),
      targetProfileId: randomUUID(),
      action: 'all',
      reason: 'valid',
      duration,
    }).success,
    true,
  );
});
test('minimal receipts cannot carry private bodies or cross-domain operation fields', () => {
  const base = {
    requestId: randomUUID(),
    operation: 'restrict_accepter',
    outcome: 'applied',
    orderId: randomUUID(),
    revision: randomUUID(),
    occurredAt: '2026-10-08T12:00:00.123456Z',
  };
  assert.equal(errandAdminReceiptSchema.safeParse(base).success, true);
  assert.equal(
    errandAdminReceiptSchema.safeParse({ ...base, reason: 'secret' }).success,
    false,
  );
  assert.equal(
    errandAdminReceiptSchema.safeParse({ ...base, operation: 'issue' }).success,
    false,
  );
  assert.equal(
    errandRestrictionReceiptSchema.safeParse({ ...base, operation: 'release' })
      .success,
    false,
  );
  assert.equal(
    errandRestrictionReceiptSchema.safeParse({
      requestId: randomUUID(),
      operation: 'release',
      outcome: 'applied',
      restrictionId: randomUUID(),
      eventId: randomUUID(),
      occurredAt: base.occurredAt,
    }).success,
    true,
  );
});
test('baseline release remains a known historical time without invented event or reason', () => {
  const row = {
    restrictionId: randomUUID(),
    subject: { status: 'unavailable' },
    action: 'all',
    reason: '  original\r\n ',
    startsAt: '2026-01-01T00:00:00Z',
    endsAt: null,
    state: 'released',
    origin: 'baseline',
    recordedAt: '2026-10-08T12:00:00.000001Z',
    operator: { status: 'unknown' },
    source: { kind: 'unknown' },
    terminal: {
      kind: 'baseline_released',
      effectiveAt: '2026-01-02T00:00:00Z',
    },
  };
  assert.deepEqual(errandRestrictionViewSchema.parse(row), row);
  assert.equal(
    errandRestrictionViewSchema.safeParse({
      ...row,
      terminal: { ...row.terminal, eventId: null },
    }).success,
    false,
  );
});
test('five owner-local notice variants stay strict and no fake order is required for Safety', () => {
  const base = {
    noticeId: randomUUID(),
    createdAt: '2026-10-08T12:00:00.123456Z',
    readAt: null,
  };
  for (const kind of ['accepted', 'completed'])
    assert.equal(
      errandNoticeSchema.safeParse({ ...base, kind, orderId: randomUUID() })
        .success,
      true,
    );
  assert.equal(
    errandNoticeSchema.safeParse({
      ...base,
      kind: 'admin_deleted',
      orderId: randomUUID(),
      deletionReason: { status: 'not_provided' },
    }).success,
    true,
  );
  const feature = {
    ...base,
    kind: 'feature_restricted',
    restrictionId: randomUUID(),
    eventId: randomUUID(),
    action: 'all',
    reason: 'why',
    startsAt: base.createdAt,
    endsAt: null,
  };
  assert.equal(errandNoticeSchema.safeParse(feature).success, true);
  assert.equal(
    errandNoticeSchema.safeParse({ ...feature, orderId: randomUUID() }).success,
    false,
  );
  assert.equal(
    errandNoticeSchema.safeParse({
      ...base,
      kind: 'feature_released',
      restrictionId: feature.restrictionId,
      eventId: randomUUID(),
      action: 'all',
      reason: 'released',
      releasedAt: base.createdAt,
    }).success,
    true,
  );
});
