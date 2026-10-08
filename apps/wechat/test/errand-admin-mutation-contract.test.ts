import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeErrandAdminIntent,
  decodeErrandAdminReceipt,
  decodeErrandRestrictionDuration,
  matchErrandAdminReceipt,
} from '../src/errands/admin-command-contract';
import {
  decodeErrandRestriction,
  decodeErrandRestrictionEvent,
  decodeErrandRestrictionHistory,
  decodeErrandRestrictionPage,
  decodeErrandRestrictionQuery,
} from '../src/errands/restriction-contract';
import { PendingErrandAdminStore } from '../src/errands/admin-pending';
import { PendingErrandStore } from '../src/errands/pending';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  applied,
  deleteIntent,
  eventId,
  restriction,
  restrictionHistory,
  restrictionId,
  restrictionPage,
  scope,
} from './errand-admin-command-helpers';
import { adminTime, publicProfileId } from './errand-admin-helpers';
import { requestId } from './community-helpers';

test('strict command discriminants normalize bounded Unicode and never accept arbitrary target/account/scope/grant data', () => {
  const base = deleteIntent();
  assert.equal(decodeErrandAdminIntent(base).operation, 'admin_delete');
  for (const raw of [
    { ...base, operation: 'delete' },
    { ...base, accountId: publicProfileId },
    { ...base, regionId: publicProfileId },
    { ...base, payload: { ...base.payload, subjectId: publicProfileId } },
    { ...base, payload: { ...base.payload, deleteReason: 'x'.repeat(501) } },
    {
      ...base,
      payload: { ...base.payload, publisherRestriction: { kind: 'permanent' } },
    },
    {
      ...base,
      payload: {
        ...base.payload,
        deleteReason: 'x'.repeat(256),
        publisherRestriction: { kind: 'permanent' },
      },
    },
  ])
    assert.throws(() => decodeErrandAdminIntent(raw));
  const combined = decodeErrandAdminIntent({
    ...base,
    payload: {
      ...base.payload,
      deleteReason: ` \r\n${'鲸'.repeat(255)} `,
      publisherRestriction: { kind: 'permanent' },
    },
  });
  assert.equal(
    combined.operation === 'admin_delete' &&
      combined.payload.deleteReason.length,
    255,
  );
  for (const raw of [
    { kind: 'finite', unit: 'days', value: 0 },
    { kind: 'finite', unit: 'days', value: 1.5 },
    { kind: 'finite', unit: 'weeks', value: 1 },
    { kind: 'permanent', value: 7 },
    { kind: 'finite', unit: 'days', value: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(() => decodeErrandRestrictionDuration(raw));
  assert.deepEqual(
    decodeErrandRestrictionDuration({
      kind: 'finite',
      unit: 'days',
      value: 1000,
    }),
    { kind: 'finite', unit: 'days', value: 1000 },
  );
});
test('management receipts stay distinct from E1 and prove exact operation/request/order/restriction; accepter cannot fabricate revision', () => {
  const intent = deleteIntent(),
    good = applied(intent);
  assert.deepEqual(decodeErrandAdminReceipt(good), good);
  matchErrandAdminReceipt(intent, good);
  for (const raw of [
    { ...good, privateText: 'secret' },
    { ...good, operation: 'delete' },
    { requestId, operation: 'issue', outcome: 'rejected', code: 'FORBIDDEN' },
  ])
    assert.throws(() => decodeErrandAdminReceipt(raw));
  assert.throws(() =>
    matchErrandAdminReceipt(intent, { ...good, requestId: publicProfileId }),
  );
  const release = decodeErrandAdminIntent({
    operation: 'release',
    restrictionId,
    payload: { clientRequestId: requestId, reason: '合成解除' },
  });
  assert.throws(() =>
    matchErrandAdminReceipt(release, {
      requestId,
      operation: 'release',
      outcome: 'applied',
      restrictionId: publicProfileId,
      eventId,
      occurredAt: adminTime,
    }),
  );
});
test('recorded count is exact decimal while all-time coverage stays explicitly unknown; nested projection and causal events are closed', () => {
  assert.equal(
    decodeErrandRestrictionPage(
      restrictionPage({
        recordedTotal: { status: 'known', value: '9007199254740993' },
      }),
    ).recordedTotal.status,
    'known',
  );
  assert.equal(
    decodeErrandRestrictionPage(
      restrictionPage({ items: [], recordedTotal: { status: 'unavailable' } }),
    ).historyCoverage,
    'unknown_before_boundary',
  );
  for (const raw of [
    {
      ...restriction(),
      subject: { ...restriction().subject, accountId: publicProfileId },
    },
    {
      ...restriction(),
      source: {
        kind: 'order',
        orderId: publicProfileId,
        regionId: publicProfileId,
      },
    },
    {
      ...restriction(),
      operator: { status: 'unknown', profileId: publicProfileId },
    },
    { ...restriction(), state: 'released' },
    { ...restriction(), state: 'expired' },
    {
      ...restriction(),
      terminal: {
        kind: 'superseded',
        eventId,
        effectiveAt: adminTime,
        reason: null,
        replacementRestrictionId: restrictionId,
      },
    },
  ])
    assert.throws(() => decodeErrandRestriction(raw));
  assert.throws(() =>
    decodeErrandRestrictionPage({
      ...restrictionPage(),
      historyCoverage: 'complete',
    }),
  );
  assert.throws(() =>
    decodeErrandRestrictionHistory({
      ...restrictionHistory(),
      events: [...restrictionHistory().events, ...restrictionHistory().events],
    }),
  );
  assert.throws(() =>
    decodeErrandRestrictionQuery({ state: 'all', accountId: publicProfileId }),
  );
  const observed = {
    eventId,
    kind: 'observed_baseline',
    effectiveAt: adminTime,
    recordedAt: adminTime,
    reason: null,
    operator: { status: 'unknown' },
    replacementRestrictionId: null,
  };
  assert.equal(
    decodeErrandRestrictionEvent(observed).kind,
    'observed_baseline',
  );
  for (const raw of [
    { ...observed, reason: 'invented issuance' },
    { ...observed, operator: { status: 'unavailable' } },
    { ...observed, effectiveAt: '2019-01-01T00:00:00Z' },
  ])
    assert.throws(() => decodeErrandRestrictionEvent(raw));
});
test('administrative journal is immutable account+origin isolated and cannot be consumed by E1 or replaced on receipt404', () => {
  const storage = new MemoryStorage(),
    journal = new PendingErrandAdminStore(storage, 'origin-a'),
    accountId = wireCredentials().accountId;
  const pending = journal.freeze({
    version: 1,
    kind: 'errand_admin',
    accountId,
    authority: scope(),
    intent: deleteIntent(),
  });
  assert.equal(
    new PendingErrandAdminStore(storage, 'origin-b').load(accountId),
    null,
  );
  assert.equal(journal.load(publicProfileId), null);
  assert.equal(
    new PendingErrandStore(storage, 'origin-a').load(accountId),
    null,
  );
  assert.throws(() =>
    journal.freeze({
      ...pending,
      intent: decodeErrandAdminIntent({
        ...pending.intent,
        payload: {
          ...pending.intent.payload,
          clientRequestId: publicProfileId,
        },
      }),
    }),
  );
  assert.throws(() =>
    journal.settle(pending, { ...applied(), requestId: eventId }),
  );
  assert.deepEqual(journal.load(accountId), pending);
  journal.settle(pending, applied());
  assert.equal(journal.load(accountId), null);
});

test('finite restriction ends preserve strict submillisecond ordering', () => {
  const startsAt = '2026-10-08T12:00:00.000900Z';
  for (const endsAt of [startsAt, '2026-10-08T12:00:00.000100Z'])
    assert.throws(() =>
      decodeErrandRestriction(restriction({ startsAt, endsAt })),
    );
  assert.equal(
    decodeErrandRestriction(
      restriction({ startsAt, endsAt: '2026-10-08T12:00:00.000901Z' }),
    ).endsAt,
    '2026-10-08T12:00:00.000901Z',
  );
});

test('historical baseline reason preserves original whitespace and CRLF without fresh-input normalization', () => {
  const original = '  原有基线理由\r\n保留原值  ';
  assert.equal(
    decodeErrandRestriction(
      restriction({
        origin: 'baseline',
        operator: { status: 'unknown' },
        source: { kind: 'unknown' },
        reason: original,
      }),
    ).reason,
    original,
  );
  assert.throws(() =>
    decodeErrandRestriction(restriction({ reason: '\ud800' })),
  );
});

test('released baseline retains known end without fabricating a local release event or reason', () => {
  const baseline = restriction({
    origin: 'baseline',
    state: 'released',
    operator: { status: 'unknown' },
    source: { kind: 'unknown' },
    terminal: { kind: 'baseline_released', effectiveAt: adminTime },
  });
  assert.deepEqual(decodeErrandRestriction(baseline).terminal, {
    kind: 'baseline_released',
    effectiveAt: adminTime,
  });
  assert.equal(
    decodeErrandRestrictionHistory(
      restrictionHistory({ restriction: baseline, events: [] }),
    ).events.length,
    0,
  );
  for (const terminal of [
    { kind: 'baseline_released', effectiveAt: adminTime, eventId: null },
    { kind: 'baseline_released', effectiveAt: adminTime, reason: null },
    {
      kind: 'baseline_released',
      effectiveAt: adminTime,
      replacementRestrictionId: null,
    },
  ])
    assert.throws(() => decodeErrandRestriction({ ...baseline, terminal }));
  assert.throws(() =>
    decodeErrandRestriction({ ...baseline, origin: 'local' }),
  );
  assert.throws(() =>
    decodeErrandRestriction({ ...baseline, state: 'active' }),
  );
});
