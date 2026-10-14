/** Test-only observations of the real worker. No clock, permit, owner, result,
 * or transaction is replaced. Recovery is limited to one proved unsent expiry. */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { DatabaseService } from '../../src/database/database.js';
import type { ErrandGroupRepository } from '../../src/notifications/errand-group/repository.js';
import type { ErrandGroupWorker } from '../../src/notifications/errand-group/worker.js';
import type { ErrandGroupSource } from '../../src/errands/group-source.js';
import { groupWindow } from '../../src/notifications/errand-group/contracts.js';
import type {
  GroupPublication,
  GroupStage,
  GroupPermit,
  PublicGroupPayload,
} from '../../src/notifications/errand-group/contracts.js';
import type { DurableSyntheticGroupSender } from './errand-group-runtime.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../src/database/transaction-deadlines.js';

export interface PreparationTrace {
  claimed: boolean;
  sourceReads: number;
  finalProofs: number;
  dispatches: number;
  acknowledgements: number;
  reconciliations: number;
  committed: boolean;
  observedAt: number;
  leaseUntil: number;
  windowEligible: boolean;
  publication?: GroupPublication;
  stage?: GroupStage;
  prepared?: { key: string; destinationId: string; expiresAt: number };
  permit?: GroupPermit;
  payload?: PublicGroupPayload;
}
export function observeGroupPreparation(context: {
  db: DatabaseService;
  records: ErrandGroupRepository;
  source: ErrandGroupSource;
  sender: DurableSyntheticGroupSender;
  runtime: { now(): number };
}) {
  const { db, records, source, sender } = context;
  const active = new AsyncLocalStorage<PreparationTrace>();
  const transaction = db.transaction.bind(db),
    current = records.current.bind(records),
    sourceCurrent = source.current.bind(source),
    prepare = sender.prepare.bind(sender),
    confirmed = records.confirmed.bind(records),
    reconcile = sender.reconcile.bind(sender);
  db.transaction = async (operation, options) => {
    const trace = active.getStore();
    const result = await transaction(async (tx) => {
      const value = await operation(tx);
      if (
        trace &&
        value &&
        typeof value === 'object' &&
        'attemptId' in value &&
        'fence' in value &&
        'destination' in value &&
        'key' in value &&
        'payload' in value &&
        'expiresAt' in value
      )
        trace.permit = value as GroupPermit;
      return value;
    }, options);
    if (trace?.permit && result === trace.permit) trace.committed = true;
    return result;
  };
  records.current = async (...args) => {
    const trace = active.getStore();
    if (trace) trace.leaseUntil = args[0].lease_until.getTime();
    return current(...args);
  };
  source.current = async (...args) => {
    const payload = await sourceCurrent(...args);
    const trace = active.getStore();
    if (trace) {
      trace.sourceReads++;
      trace.payload = payload;
      trace.publication = { ...args[0] };
      trace.stage = args[1];
      const proof: RequiredTransactionProof<string> = {
        maximumFacts: 1,
        failureCode: 'ERRAND_UNAVAILABLE',
        validate: async () => {
          trace.finalProofs++;
        },
      };
      enableRequiredTransactionProof(args[2], proof);
      registerRequiredTransactionFact(
        args[2],
        proof,
        'observed-preparation',
        'observed-preparation',
      );
    }
    return payload;
  };
  sender.prepare = async (...args) => {
    const value = await prepare(...args),
      trace = active.getStore();
    if (!trace) return value;
    trace.prepared = {
      key: value.key,
      destinationId: value.destinationId,
      expiresAt: value.expiresAt,
    };
    return {
      ...value,
      dispatch: (permit) => {
        trace.dispatches++;
        return value.dispatch(permit);
      },
    };
  };
  records.confirmed = async (...args) => {
    const trace = active.getStore();
    if (trace) trace.acknowledgements++;
    return confirmed(...args);
  };
  sender.reconcile = async (...args) => {
    const trace = active.getStore();
    if (trace) trace.reconciliations++;
    return reconcile(...args);
  };
  return {
    async run(worker: ErrandGroupWorker): Promise<PreparationTrace> {
      const trace: PreparationTrace = {
        claimed: false,
        sourceReads: 0,
        finalProofs: 0,
        dispatches: 0,
        acknowledgements: 0,
        reconciliations: 0,
        committed: false,
        observedAt: 0,
        leaseUntil: 0,
        windowEligible: false,
      };
      return active.run(trace, async () => {
        trace.claimed = await worker.runOne();
        trace.observedAt = performance.now();
        trace.windowEligible =
          !!trace.publication &&
          !!trace.stage &&
          groupWindow(trace.publication, trace.stage, context.runtime.now()) ===
            'eligible';
        return trace;
      });
    },
    restore() {
      db.transaction = transaction;
      records.current = current;
      source.current = sourceCurrent;
      sender.prepare = prepare;
      records.confirmed = confirmed;
      sender.reconcile = reconcile;
    },
  };
}
export interface PreparationRow {
  id: string;
  event_id: string;
  stage: string;
  destination_id: string;
  idempotency_key: string;
  status: string;
  reason: string | null;
  attempts: number;
  fence: string;
  reconciliations: number;
  attempt_id: string | null;
  lease_until: Date | null;
  next_attempt_at: Date;
  receipts: number;
}
export async function preparationRows(pool: Pool): Promise<PreparationRow[]> {
  return (
    await pool.query<PreparationRow>(`SELECT d.*,
    (SELECT count(*)::integer FROM whaleu_notifications.errand_group_receipts r WHERE r.delivery_id=d.id) receipts
    FROM whaleu_notifications.errand_group_deliveries d ORDER BY d.stage,d.destination_id,d.id`)
  ).rows;
}
export function assertUnsentPreparationExpiry(
  row: PreparationRow,
  trace: PreparationTrace,
  directory: string,
  senderAttempts: readonly { key: string }[],
  baseline?: GroupPermit,
) {
  const message = `Unsent preparation expiry: ${JSON.stringify({ row, trace })}`;
  assert.equal(row.status, 'retryable', message);
  assert.equal(row.reason, 'permit_expired', message);
  assert.ok(row.attempts >= 1 && row.attempts < 8, message);
  assert.equal(row.attempt_id, null, message);
  assert.equal(row.lease_until, null, message);
  assert.equal(row.receipts, 0, message);
  assert.equal(
    senderAttempts.filter((p) => p.key === row.idempotency_key).length,
    0,
    message,
  );
  assert.equal(
    existsSync(join(directory, `${row.idempotency_key}.json`)),
    false,
    message,
  );
  assert.ok(trace.claimed && trace.committed, message);
  assert.equal(trace.sourceReads, 1, message);
  assert.equal(trace.finalProofs, 1, message);
  assert.equal(trace.dispatches, 0, message);
  assert.equal(trace.acknowledgements, 0, message);
  assert.equal(trace.reconciliations, 0, message);
  const permit = trace.permit,
    prepared = trace.prepared;
  assert.ok(permit && prepared, message);
  assert.equal(permit.key, row.idempotency_key, message);
  assert.equal(permit.destination.id, row.destination_id, message);
  assert.equal(permit.destination.stage, row.stage, message);
  assert.equal(permit.fence, row.fence, message);
  assert.equal(prepared.key, permit.key, message);
  assert.equal(prepared.destinationId, permit.destination.id, message);
  assert.ok(
    Number.isFinite(permit.expiresAt) && Number.isFinite(prepared.expiresAt),
    message,
  );
  assert.ok(
    trace.observedAt >= Math.min(permit.expiresAt, prepared.expiresAt),
    message,
  );
  assert.ok(trace.leaseUntil > Date.now(), message);
  assert.equal(trace.windowEligible, true, message);
  assert.deepEqual(trace.payload, permit.payload, message);
  if (baseline) {
    assert.equal(permit.key, baseline.key, message);
    assert.deepEqual(permit.destination, baseline.destination, message);
    assert.deepEqual(permit.payload, baseline.payload, message);
  }
  return permit;
}
/** At most one extra normal owner run. Other ready fixture rows are locked only
 * to select the exact target through the production SKIP LOCKED claim query. */
export async function recoverUnsentPreparation(input: {
  pool: Pool;
  directory: string;
  row: PreparationRow;
  trace: PreparationTrace;
  senderAttempts: readonly { key: string }[];
  latestBusinessTime: number;
  setTime(now: number): void;
  run(): Promise<{
    trace: PreparationTrace;
    senderAttempts: readonly { key: string }[];
  }>;
  diagnostic(message: string): void;
}) {
  const initialSenderAttempts = structuredClone(input.senderAttempts);
  const baseline = assertUnsentPreparationExpiry(
    input.row,
    input.trace,
    input.directory,
    initialSenderAttempts,
  );
  const before = await preparationRows(input.pool);
  assert.deepEqual(
    before.find((r) => r.id === input.row.id),
    input.row,
  );
  const ledger = async () =>
    (
      await input.pool.query(
        'SELECT * FROM whaleu_notifications.errand_group_attempts ORDER BY delivery_id,fence',
      )
    ).rows;
  const initialLedger = await ledger();
  const original = initialLedger.filter((r) => r.delivery_id === input.row.id);
  assert.equal(original.length, input.row.attempts);
  assert.equal(original.at(-1)?.id, baseline.attemptId);
  assert.equal(original.at(-1)?.fence, baseline.fence);
  assert.equal(original.at(-1)?.operation, 'send');
  assert.ok(original.every((r) => r.idempotency_key === baseline.key));
  const tx = await input.pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL lock_timeout='100ms'");
    await tx.query(
      'SELECT id FROM whaleu_notifications.errand_group_deliveries WHERE id=ANY($1::uuid[]) FOR UPDATE',
      [before.filter((r) => r.id !== input.row.id).map((r) => r.id)],
    );
    const due = input.row.next_attempt_at.getTime();
    assert.ok(Number.isFinite(due) && due <= input.latestBusinessTime);
    input.setTime(due);
    const result = await input.run();
    const after = await preparationRows(input.pool),
      next = after.find((r) => r.id === input.row.id)!;
    const afterLedger = await ledger();
    input.diagnostic(
      JSON.stringify({
        phase: 'one-unsent-preparation-recovery',
        before: input.row,
        after: next,
        originalTrace: input.trace,
        retryTrace: result.trace,
      }),
    );
    assert.deepEqual(
      after.filter((r) => r.id !== input.row.id),
      before.filter((r) => r.id !== input.row.id),
    );
    assert.deepEqual(
      afterLedger.filter((r) => r.delivery_id !== input.row.id),
      initialLedger.filter((r) => r.delivery_id !== input.row.id),
    );
    const nextLedger = afterLedger.filter(
      (r) => r.delivery_id === input.row.id,
    );
    assert.deepEqual(nextLedger.slice(0, -1), original);
    assert.equal(nextLedger.length, original.length + 1);
    assert.equal(nextLedger.at(-1)?.operation, 'send');
    assert.equal(nextLedger.at(-1)?.idempotency_key, baseline.key);
    assert.equal(
      nextLedger.at(-1)?.fence,
      (BigInt(input.row.fence) + 1n).toString(),
    );
    for (const field of [
      'id',
      'event_id',
      'stage',
      'destination_id',
      'idempotency_key',
      'reconciliations',
    ] as const)
      assert.equal(next[field], input.row[field]);
    assert.equal(next.attempts, input.row.attempts + 1);
    assert.equal(next.fence, nextLedger.at(-1)?.fence);
    assert.equal(
      next.status,
      'confirmed',
      'A second expiry or any other outcome fails immediately',
    );
    assert.equal(next.reason, null);
    assert.equal(next.receipts, 1);
    assert.equal(next.attempt_id, null);
    assert.equal(next.lease_until, null);
    const trace = result.trace;
    assert.ok(trace.claimed && trace.committed);
    assert.equal(trace.sourceReads, 1);
    assert.equal(trace.finalProofs, 1);
    assert.equal(trace.dispatches, 1);
    assert.equal(trace.acknowledgements, 1);
    assert.equal(trace.reconciliations, 0);
    assert.equal(trace.permit?.key, baseline.key);
    assert.equal(trace.permit?.attemptId, nextLedger.at(-1)?.id);
    assert.equal(trace.permit?.fence, nextLedger.at(-1)?.fence);
    assert.equal(trace.prepared?.key, baseline.key);
    assert.equal(trace.prepared?.destinationId, baseline.destination.id);
    assert.ok(Number.isFinite(trace.prepared?.expiresAt));
    assert.deepEqual(trace.permit?.payload, baseline.payload);
    assert.deepEqual(trace.payload, baseline.payload);
    assert.deepEqual(trace.permit?.destination, baseline.destination);
    assert.deepEqual(trace.publication, input.trace.publication);
    assert.equal(trace.windowEligible, true);
    assert.equal(
      result.senderAttempts.filter((p) => p.key === baseline.key).length,
      1,
    );
    assert.deepEqual(
      result.senderAttempts.filter((p) => p.key !== baseline.key),
      initialSenderAttempts.filter((p) => p.key !== baseline.key),
    );
    const receipt = JSON.parse(
      readFileSync(join(input.directory, `${baseline.key}.json`), 'utf8'),
    );
    assert.equal(receipt.status, 'confirmed');
    assert.equal(receipt.key, baseline.key);
    assert.equal(receipt.destinationId, baseline.destination.id);
    assert.equal(receipt.confirmedAt, due);
    return result;
  } finally {
    try {
      await tx.query('ROLLBACK');
    } finally {
      tx.release();
    }
  }
}
