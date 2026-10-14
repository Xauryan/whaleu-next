import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { assertUnsentPreparationExpiry } from './support/errand-group-preparation.js';
import type {
  PreparationRow,
  PreparationTrace,
} from './support/errand-group-preparation.js';

function state() {
  const key = 'a'.repeat(64);
  const row: PreparationRow = {
    id: randomUUID(),
    event_id: randomUUID(),
    stage: 'errand',
    destination_id: 'synthetic:expiry',
    idempotency_key: key,
    status: 'retryable',
    reason: 'permit_expired',
    attempts: 1,
    fence: '1',
    reconciliations: 0,
    attempt_id: null,
    lease_until: null,
    next_attempt_at: new Date(),
    receipts: 0,
  };
  const payload = {
    title: 'Synthetic',
    reward: '1.00',
    expectedTime: 'Today',
    sourceLabel: null,
    locator: `pages/errand-detail/errand-detail?orderId=${randomUUID()}`,
  };
  const trace: PreparationTrace = {
    claimed: true,
    sourceReads: 1,
    finalProofs: 1,
    dispatches: 0,
    acknowledgements: 0,
    reconciliations: 0,
    committed: true,
    observedAt: 101,
    leaseUntil: Date.now() + 30000,
    windowEligible: true,
    prepared: { key, destinationId: row.destination_id, expiresAt: 5000 },
    permit: {
      attemptId: randomUUID(),
      fence: '1',
      key,
      destination: {
        id: row.destination_id,
        revision: 'r1',
        targetRegionId: randomUUID(),
        stage: 'errand',
      },
      payload,
      expiresAt: 100,
    },
    payload,
  };
  return { row, trace, directory: `/tmp/nonexistent-${randomUUID()}` };
}
test('unsent preparation guard accepts only exact committed unsent expiry', () => {
  const { row, trace, directory } = state();
  assert.equal(
    assertUnsentPreparationExpiry(row, trace, directory, []),
    trace.permit,
  );
});
test('unsent preparation guard rejects effects, missing proofs, changed identity and other reasons', () => {
  for (const change of [
    (r: PreparationRow, _t: PreparationTrace) => {
      r.reason = 'not_accepted';
    },
    (r: PreparationRow, _t: PreparationTrace) => {
      r.status = 'unknown';
      r.reason = 'unknown';
    },
    (r: PreparationRow, _t: PreparationTrace) => {
      r.reason = 'unavailable';
    },
    (r: PreparationRow, _t: PreparationTrace) => {
      r.receipts = 1;
    },
    (r: PreparationRow, _t: PreparationTrace) => {
      r.attempts = 8;
    },
    (_r: PreparationRow, t: PreparationTrace) => {
      t.dispatches = 1;
    },
    (_r: PreparationRow, t: PreparationTrace) => {
      t.acknowledgements = 1;
    },
    (_r: PreparationRow, t: PreparationTrace) => {
      t.reconciliations = 1;
    },
    (_r: PreparationRow, t: PreparationTrace) => {
      t.sourceReads = 0;
    },
    (_r: PreparationRow, t: PreparationTrace) => {
      t.finalProofs = 0;
    },
    (_r: PreparationRow, t: PreparationTrace) => {
      t.committed = false;
    },
    (_r: PreparationRow, t: PreparationTrace) => {
      t.observedAt = 99;
    },
    (_r: PreparationRow, t: PreparationTrace) => {
      t.leaseUntil = 0;
    },
    (_r: PreparationRow, t: PreparationTrace) => {
      t.windowEligible = false;
    },
    (_r: PreparationRow, t: PreparationTrace) => {
      t.prepared!.key = 'b'.repeat(64);
    },
    (_r: PreparationRow, t: PreparationTrace) => {
      t.permit = { ...t.permit!, fence: '2' };
    },
    (_r: PreparationRow, t: PreparationTrace) => {
      t.payload = { ...t.payload!, title: 'Changed' };
    },
  ]) {
    const { row, trace, directory } = state();
    change(row, trace);
    assert.throws(
      () => assertUnsentPreparationExpiry(row, trace, directory, []),
      /Unsent preparation expiry/,
    );
  }
  const { row, trace, directory } = state();
  assert.throws(
    () =>
      assertUnsentPreparationExpiry(row, trace, directory, [
        { key: row.idempotency_key },
      ]),
    /Unsent preparation expiry/,
  );
  assert.throws(
    () =>
      assertUnsentPreparationExpiry(row, trace, directory, [], {
        ...trace.permit!,
        payload: { ...trace.permit!.payload, title: 'Changed baseline' },
      }),
    /Unsent preparation expiry/,
  );
});
