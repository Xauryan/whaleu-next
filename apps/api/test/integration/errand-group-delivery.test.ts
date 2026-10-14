import {
  observeGroupPreparation,
  preparationRows,
  recoverUnsentPreparation,
} from '../support/errand-group-preparation.js';
import { ErrandGroupEnrollment } from '../../src/notifications/errand-group/enrollment.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../src/database/transaction-deadlines.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import {
  errandGroupFixture,
  DurableSyntheticGroupSender,
} from '../support/errand-group-runtime.js';
import {
  approveErrand,
  revokeErrandReview,
} from '../support/errand-review-fixtures.js';
import { ErrandAccessService } from '../../src/errands/access.js';
import { publishErrandSchema } from '../../src/errands/contracts.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { ErrandGroupWorker } from '../../src/notifications/errand-group/worker.js';
import type {
  GroupPermit,
  SyntheticAck,
} from '../../src/notifications/errand-group/contracts.js';
import {
  seedErrandFeature,
  syntheticErrandRestriction,
} from '../support/errand-runtime-fixture.js';
import {
  withCommunityScopeWriter,
  appendTopologyRevision,
} from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import {
  errandMediaFixture,
  createErrandMediaDraft,
  readyErrandImage,
  publishErrandImages,
} from '../support/media/errand-runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import sharp from 'sharp';

type Fixture = Awaited<ReturnType<typeof errandGroupFixture>>;
async function publish(
  f: Fixture,
  patch: Record<string, unknown> = {},
  reviewOptions: Parameters<typeof approveErrand>[2] = {},
) {
  const actor = await f.actor();
  const body = publishErrandSchema.parse({
    clientRequestId: randomUUID(),
    targetRegionId: f.scope.related.regionId,
    title: 'Synthetic group order',
    publicText: 'Never transmit public body',
    privateText: 'SECRET private instructions',
    expectedTimeText: 'Tomorrow',
    reward: '12.34567890123456789',
    publisherContacts: { wechat: 'SECRET_contact', phone: '12345678901' },
    publicAssetIds: [],
    privateAssetIds: [],
    ...patch,
  });
  const scope = await f.db.transaction(
    async (tx) => {
      await lockSafetyPolicy(tx);
      return f.app
        .get(ErrandAccessService)
        .scope(actor.accountId, body.targetRegionId, tx);
    },
    { isolationLevel: 'read committed' },
  );
  const approval = await approveErrand(
    f.pool,
    {
      version: 1,
      accountId: actor.accountId,
      purpose: 'publish_errand',
      title: body.title,
      publicText: body.publicText,
      privateText: body.privateText,
      expectedTimeText: body.expectedTimeText,
      reward: body.reward,
      publisherContacts: body.publisherContacts,
      publicAssetIds: [],
      privateAssetIds: [],
      scope,
    },
    reviewOptions,
  );
  const response = await request(f.app.getHttpServer())
    .post('/v1/errands')
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.outcome, 'applied', JSON.stringify(response.body));
  const row = (
    await f.pool.query(
      'SELECT * FROM whaleu_notifications.errand_group_publications WHERE order_id=$1',
      [response.body.orderId],
    )
  ).rows[0];
  assert.ok(row);
  f.setTime(row.published_at.getTime());
  return {
    actor,
    body,
    approval,
    id: response.body.orderId as string,
    revision: response.body.revision as string,
    publishedAt: row.published_at.getTime() as number,
  };
}
function destinations(f: Fixture) {
  return {
    one: f.authority.add(f.scope.related.regionId, 'errand', 'errand:one'),
    two: f.authority.add(f.scope.related.regionId, 'errand', 'errand:two'),
    forum: f.authority.add(f.scope.related.regionId, 'forum', 'forum:one'),
  };
}

/** A claim need not send: the 100ms permit can expire before dispatch or at
 * the sender boundary. Unknown work may only reconcile its original key; a
 * fresh send needs proven nonacceptance. Unresolved outcomes still fail. */
async function confirmDiscoveredGroups(
  f: Fixture,
  count: number,
  worker = f.groups,
) {
  const initial = (await f.rows()).rows;
  assert.equal(initial.length, count);
  const identities = (rows: typeof initial) =>
    rows.map((r) => [
      r.id,
      r.event_id,
      r.stage,
      r.destination_id,
      r.idempotency_key,
    ]);
  const provenNegativeAttempts = new Map<string, number>();
  // The repository suppresses retryable deliveries at attempt eight. This is
  // the existing delivery budget, not an open-ended retry-until-green loop.
  for (let round = 0; round <= 8; round++) {
    const rows = (await f.rows()).rows;
    assert.deepEqual(identities(rows), identities(initial));
    const remaining = rows.filter((r) => r.status !== 'confirmed');
    if (!remaining.length) {
      assert.equal(await worker.runOne(), false);
      const receipts = await f.pool.query(
        'SELECT delivery_id,idempotency_key FROM whaleu_notifications.errand_group_receipts ORDER BY delivery_id',
      );
      assert.deepEqual(
        receipts.rows,
        rows
          .map((r) => ({
            delivery_id: r.id,
            idempotency_key: r.idempotency_key,
          }))
          .sort((a, b) => a.delivery_id.localeCompare(b.delivery_id)),
      );
      return;
    }
    assert.ok(round < 8, `Delivery budget exhausted: ${JSON.stringify(rows)}`);
    for (const row of remaining) {
      assert.ok(
        (row.status === 'pending' &&
          row.reason === null &&
          row.attempts === 0) ||
          (row.status === 'retryable' && row.reason === 'permit_expired') ||
          (row.status === 'unknown' &&
            row.reason === 'unknown' &&
            row.reconciliations < 8) ||
          (row.status === 'retryable' &&
            row.reason === 'not_accepted' &&
            provenNegativeAttempts.get(row.id) === row.attempts),
        JSON.stringify(row),
      );
      assert.ok(row.attempts < 8, JSON.stringify(row));
      assert.equal(row.lease_until, null);
    }
    const unknown = remaining.filter((r) => r.status === 'unknown');
    const reconciledBefore = f.sender.reconciled.length;
    const dispatchesBefore = new Map(
      unknown.map((r) => [
        r.id,
        f.sender.attempts.filter((p) => p.key === r.idempotency_key).length,
      ]),
    );
    // Advance only the synthetic business scheduler to persisted due times.
    // Real authorization, lease and process-local permit clocks stay intact.
    f.setTime(
      Math.max(
        f.runtime.now(),
        ...remaining.map((r) => r.next_attempt_at.getTime()),
      ),
    );
    for (let n = 0; n < remaining.length; n++)
      assert.equal(await worker.runOne(), true);
    assert.equal(await worker.runOne(), false);
    assert.deepEqual(
      f.sender.reconciled.slice(reconciledBefore).sort(),
      unknown.map((r) => r.idempotency_key).sort(),
      'unknown work only reconciles each original key once in this due batch',
    );
    const after = (await f.rows()).rows;
    for (const row of unknown) {
      const settled = after.find((r) => r.id === row.id)!;
      assert.equal(
        f.sender.attempts.filter((p) => p.key === row.idempotency_key).length,
        dispatchesBefore.get(row.id),
        'reconciliation cannot dispatch',
      );
      assert.equal(settled.attempts, row.attempts + 1);
      assert.equal(settled.reconciliations, row.reconciliations + 1);
      // These durable fields are written only after acknowledge() validates the
      // provider's exact-key/destination not_accepted response. Still-unknown
      // evidence must fail here, never become permission for a fresh send.
      assert.equal(settled.status, 'retryable', JSON.stringify(settled));
      assert.equal(settled.reason, 'not_accepted', JSON.stringify(settled));
      provenNegativeAttempts.set(row.id, settled.attempts);
    }
  }
}

interface ForumProgress {
  status: string;
  reason: string | null;
  attempts: number;
  identityUnchanged: boolean;
  preparationsValid: boolean;
  sourceReads: number;
  finalProofs: number;
  sourceUnchanged: boolean;
  leaseValid: boolean;
  leaseEmpty: boolean;
  windowValid: boolean;
  reconciliations: number;
  dispatches: number;
  senderAttempts: number;
  acknowledgements: number;
  receipts: number;
  providerReceipt: boolean;
}
function forumComplete(
  p: ForumProgress,
  previousAttempts = 0,
  phase = 'Forum',
) {
  const diagnostic = `${phase} dispatch precondition: ${JSON.stringify(p)}`;
  assert.ok(
    p.identityUnchanged &&
      p.preparationsValid &&
      p.sourceUnchanged &&
      p.leaseValid &&
      p.leaseEmpty &&
      p.windowValid &&
      p.attempts > previousAttempts &&
      p.attempts <= 8 &&
      p.sourceReads === p.attempts - previousAttempts &&
      p.finalProofs === p.attempts - previousAttempts &&
      p.reconciliations === 0,
    diagnostic,
  );
  if (p.status === 'confirmed') {
    assert.ok(
      p.reason === null &&
        p.dispatches === 1 &&
        p.senderAttempts === 1 &&
        p.acknowledgements === 1 &&
        p.receipts === 1 &&
        p.providerReceipt,
      diagnostic,
    );
    return true;
  }
  assert.ok(
    p.status === 'retryable' &&
      p.reason === 'permit_expired' &&
      p.attempts < 8 &&
      p.dispatches === 0 &&
      p.senderAttempts === 0 &&
      p.acknowledgements === 0 &&
      p.receipts === 0 &&
      !p.providerReceipt,
    diagnostic,
  );
  return false;
}
/** Only the forum dispatch precondition may retry, never uncertain acceptance.
 * This uses the restarted sender and the original durable eight-attempt budget. */
async function confirmForum(
  f: Fixture,
  worker: ErrandGroupWorker,
  sender: DurableSyntheticGroupSender,
  firstAck: number,
) {
  const read = async () =>
    (
      await f.pool.query(
        `SELECT d.*,p.first_confirmed_at,p.first_confirmed_delivery_id,p.published_at,p.order_id,p.target_region_id,
      (SELECT count(*)::integer FROM whaleu_notifications.errand_group_receipts r WHERE r.delivery_id=d.id) receipts
     FROM whaleu_notifications.errand_group_deliveries d JOIN whaleu_notifications.errand_group_publications p USING(event_id)
     WHERE d.stage='forum'`,
      )
    ).rows;
  const initial = await read();
  assert.equal(initial.length, 1);
  const first = initial[0];
  assert.equal(first.status, 'pending');
  assert.equal(first.reason, null);
  assert.equal(first.attempts, 0);
  assert.equal(f.runtime.now(), firstAck + 900000);
  const identity = (r: typeof first) =>
    JSON.stringify([
      r.id,
      r.event_id,
      r.stage,
      r.destination_id,
      r.idempotency_key,
      r.first_confirmed_at,
      r.first_confirmed_delivery_id,
      r.published_at,
      r.order_id,
      r.target_region_id,
    ]);
  const prepare = sender.prepare.bind(sender),
    source = f.source.current.bind(f.source),
    confirmed = f.records.confirmed.bind(f.records),
    current = f.records.current.bind(f.records);
  const senderBefore = sender.attempts.length,
    reconciledBefore = sender.reconciled.length;
  const sources: string[] = [];
  let preparations = 0,
    preparationsValid = true,
    finalProofs = 0,
    dispatches = 0,
    acknowledgements = 0,
    leaseUntil = 0;
  const proof: RequiredTransactionProof<string> = {
    maximumFacts: 1,
    failureCode: 'ERRAND_UNAVAILABLE',
    validate: async () => {
      finalProofs++;
    },
  };
  f.records.current = async (...args) => {
    leaseUntil = args[0].lease_until.getTime();
    return current(...args);
  };
  f.source.current = async (...args) => {
    const payload = await source(...args);
    sources.push(JSON.stringify([args[0], args[1], payload]));
    enableRequiredTransactionProof(args[2], proof);
    registerRequiredTransactionFact(args[2], proof, 'forum', 'forum');
    return payload;
  };
  sender.prepare = async (key, destination) => {
    const prepared = await prepare(key, destination);
    preparations++;
    preparationsValid &&=
      key === first.idempotency_key &&
      destination.id === first.destination_id &&
      destination.stage === 'forum' &&
      prepared.key === key &&
      prepared.destinationId === destination.id &&
      Number.isFinite(prepared.expiresAt);
    return {
      ...prepared,
      dispatch: (permit) => {
        dispatches++;
        return prepared.dispatch(permit);
      },
    };
  };
  f.records.confirmed = async (...args) => {
    acknowledgements++;
    assert.equal(args[0].id, first.id);
    return confirmed(...args);
  };
  try {
    for (let attempt = 1; attempt <= 8; attempt++) {
      assert.equal(await worker.runOne(), true);
      const rows = await read();
      assert.equal(rows.length, 1);
      const row = rows[0];
      const attempts = (
        await f.pool.query(
          'SELECT id,fence,idempotency_key,operation FROM whaleu_notifications.errand_group_attempts WHERE delivery_id=$1 ORDER BY fence',
          [first.id],
        )
      ).rows;
      const progress: ForumProgress = {
        status: row.status,
        reason: row.reason,
        attempts: row.attempts,
        identityUnchanged:
          identity(row) === identity(first) &&
          row.attempts === attempt &&
          BigInt(row.fence) === BigInt(first.fence) + BigInt(attempt) &&
          attempts.length === attempt &&
          attempts.every(
            (a, i) =>
              a.operation === 'send' &&
              a.idempotency_key === first.idempotency_key &&
              BigInt(a.fence) === BigInt(first.fence) + BigInt(i + 1),
          ),
        preparationsValid: preparationsValid && preparations === attempt,
        sourceReads: sources.length,
        finalProofs,
        sourceUnchanged: sources.every((s) => s === sources[0]),
        leaseValid: leaseUntil > Date.now(),
        leaseEmpty: row.attempt_id === null && row.lease_until === null,
        windowValid:
          row.first_confirmed_at.getTime() === firstAck &&
          f.runtime.now() >= firstAck + 900000 &&
          f.runtime.now() <= firstAck + 1800000,
        reconciliations:
          row.reconciliations + sender.reconciled.length - reconciledBefore,
        dispatches,
        senderAttempts: sender.attempts.length - senderBefore,
        acknowledgements,
        receipts: row.receipts,
        providerReceipt: existsSync(
          join(sender.directory, `${first.idempotency_key}.json`),
        ),
      };
      if (forumComplete(progress)) {
        const permit = sender.attempts.at(-1)!;
        assert.equal(permit.key, first.idempotency_key);
        assert.equal(permit.destination.id, first.destination_id);
        assert.equal(permit.attemptId, attempts.at(-1)!.id);
        assert.equal(permit.fence, row.fence);
        assert.equal(await worker.runOne(), false);
        return progress;
      }
      assert.equal(
        row.next_attempt_at.getTime(),
        f.runtime.now() + Math.min(60000, 1000 * 2 ** Math.min(attempt - 1, 6)),
        JSON.stringify(progress),
      );
      assert.ok(
        row.next_attempt_at.getTime() <= firstAck + 1800000,
        JSON.stringify(progress),
      );
      // Persisted due time only; real authorization/permit clocks remain intact.
      f.setTime(row.next_attempt_at.getTime());
    }
    assert.fail('Forum dispatch budget exhausted');
  } finally {
    sender.prepare = prepare;
    f.source.current = source;
    f.records.confirmed = confirmed;
    f.records.current = current;
  }
}

/** The ordinary destination already used one attempt for a proven negative ACK.
 * Only an observed, committed pre-dispatch expiry may consume its remaining
 * original budget. This is not reconciliation or a retry of arbitrary failures. */
async function confirmRestartedErrand(
  f: Fixture,
  worker: ErrandGroupWorker,
  sender: DurableSyntheticGroupSender,
  firstAck: number,
  destinationId: string,
  diagnostic: (message: string) => void,
) {
  const read = async () =>
    (
      await f.pool
        .query(`SELECT d.*,p.first_confirmed_at,p.first_confirmed_delivery_id,p.published_at,p.order_id,p.target_region_id,
      (SELECT count(*)::integer FROM whaleu_notifications.errand_group_receipts r WHERE r.delivery_id=d.id) receipts
      FROM whaleu_notifications.errand_group_deliveries d JOIN whaleu_notifications.errand_group_publications p USING(event_id)
      ORDER BY d.stage,d.destination_id`)
    ).rows;
  const initial = await read();
  assert.equal(initial.length, 2);
  const first = initial.find((r) => r.destination_id === destinationId)!;
  assert.ok(first);
  assert.equal(first.stage, 'errand');
  assert.equal(first.status, 'retryable');
  assert.equal(first.reason, 'not_accepted');
  assert.equal(first.attempts, 1);
  assert.equal(first.reconciliations, 0);
  assert.equal(first.receipts, 0);
  assert.equal(first.attempt_id, null);
  assert.equal(first.lease_until, null);
  assert.equal(first.first_confirmed_at.getTime(), firstAck);
  assert.equal(f.runtime.now(), first.published_at.getTime() + 1000);
  assert.equal(first.next_attempt_at.getTime(), f.runtime.now());
  const original = f.sender.attempts.filter(
    (p) => p.key === first.idempotency_key,
  );
  assert.equal(original.length, 1);
  assert.equal(original[0]!.destination.id, destinationId);
  assert.equal(original[0]!.destination.stage, 'errand');
  assert.equal(
    existsSync(join(sender.directory, `${first.idempotency_key}.json`)),
    false,
  );
  assert.equal(sender.attempts.length, 0);
  assert.equal(sender.reconciled.length, 0);
  const identity = (r: typeof first) => [
    r.id,
    r.event_id,
    r.stage,
    r.destination_id,
    r.idempotency_key,
    r.first_confirmed_at,
    r.first_confirmed_delivery_id,
    r.published_at,
    r.order_id,
    r.target_region_id,
  ];
  const ledger = async () =>
    (
      await f.pool.query(
        'SELECT id,fence,idempotency_key,operation FROM whaleu_notifications.errand_group_attempts WHERE delivery_id=$1 ORDER BY fence',
        [first.id],
      )
    ).rows;
  const initialLedger = await ledger();
  assert.equal(initialLedger.length, 1);
  assert.equal(initialLedger[0].operation, 'send');
  assert.equal(initialLedger[0].id, original[0]!.attemptId);
  assert.equal(initialLedger[0].idempotency_key, first.idempotency_key);
  assert.equal(initialLedger[0].fence, original[0]!.fence);
  const prepare = sender.prepare.bind(sender),
    source = f.source.current.bind(f.source),
    confirmed = f.records.confirmed.bind(f.records),
    current = f.records.current.bind(f.records),
    transaction = f.db.transaction.bind(f.db);
  let preparations = 0,
    preparationsValid = true,
    sourceReads = 0,
    sourceUnchanged = true,
    finalProofs = 0,
    dispatches = 0,
    acknowledgements = 0,
    leaseUntil = 0;
  const permits: GroupPermit[] = [];
  const expiries: number[] = [];
  const proof: RequiredTransactionProof<string> = {
    maximumFacts: 1,
    failureCode: 'ERRAND_UNAVAILABLE',
    validate: async () => {
      finalProofs++;
    },
  };
  // Observe actual return values, without replacing the transaction, proof,
  // commit, authorization, permit clock or application policy.
  f.db.transaction = async (operation, options) =>
    transaction(async (tx) => {
      const result = await operation(tx);
      if (
        result &&
        typeof result === 'object' &&
        'attemptId' in result &&
        'fence' in result &&
        'key' in result &&
        'destination' in result &&
        'expiresAt' in result &&
        'payload' in result
      )
        permits.push(result as GroupPermit);
      return result;
    }, options);
  f.records.current = async (...args) => {
    leaseUntil = args[0].lease_until.getTime();
    return current(...args);
  };
  f.source.current = async (...args) => {
    const payload = await source(...args);
    sourceReads++;
    sourceUnchanged &&=
      args[0].eventId === first.event_id &&
      args[0].orderId === first.order_id &&
      args[0].targetRegionId === first.target_region_id &&
      args[0].publishedAt === first.published_at.getTime() &&
      args[0].firstConfirmedAt === firstAck &&
      args[1] === 'errand' &&
      isDeepStrictEqual(payload, original[0]!.payload);
    enableRequiredTransactionProof(args[2], proof);
    registerRequiredTransactionFact(args[2], proof, 'restart', 'restart');
    return payload;
  };
  sender.prepare = async (key, destination) => {
    const prepared = await prepare(key, destination);
    preparations++;
    expiries.push(prepared.expiresAt);
    preparationsValid &&=
      key === first.idempotency_key &&
      isDeepStrictEqual(destination, original[0]!.destination) &&
      prepared.key === key &&
      prepared.destinationId === destinationId &&
      Number.isFinite(prepared.expiresAt);
    return {
      ...prepared,
      dispatch: (permit) => {
        dispatches++;
        return prepared.dispatch(permit);
      },
    };
  };
  f.records.confirmed = async (...args) => {
    acknowledgements++;
    assert.equal(args[0].id, first.id);
    return confirmed(...args);
  };
  try {
    for (let attempt = first.attempts + 1; attempt <= 8; attempt++) {
      assert.equal(await worker.runOne(), true);
      const rows = await read(),
        row = rows.find((r) => r.id === first.id)!;
      const attempts = await ledger();
      const count = attempt - first.attempts;
      const permit = permits.at(-1);
      const observedAt = performance.now();
      const progress: ForumProgress = {
        status: row.status,
        reason: row.reason,
        attempts: row.attempts,
        identityUnchanged:
          isDeepStrictEqual(identity(row), identity(first)) &&
          rows.length === initial.length &&
          isDeepStrictEqual(
            rows.filter((r) => r.id !== first.id),
            initial.filter((r) => r.id !== first.id),
          ) &&
          row.attempts === attempt &&
          BigInt(row.fence) === BigInt(first.fence) + BigInt(count) &&
          attempts.length === attempt &&
          isDeepStrictEqual(attempts.slice(0, first.attempts), initialLedger) &&
          attempts
            .slice(first.attempts)
            .every(
              (a, i) =>
                a.operation === 'send' &&
                a.idempotency_key === first.idempotency_key &&
                BigInt(a.fence) === BigInt(first.fence) + BigInt(i + 1),
            ),
        preparationsValid:
          preparationsValid &&
          preparations === count &&
          permits.length === count &&
          permits.every(
            (p, i) =>
              p.key === first.idempotency_key &&
              isDeepStrictEqual(p.destination, original[0]!.destination) &&
              p.attemptId === attempts[first.attempts + i].id &&
              p.fence === attempts[first.attempts + i].fence &&
              Number.isFinite(p.expiresAt),
          ),
        sourceReads,
        finalProofs,
        sourceUnchanged:
          sourceUnchanged &&
          permits.every((p) =>
            isDeepStrictEqual(p.payload, original[0]!.payload),
          ) &&
          sender.attempts.every((p) =>
            isDeepStrictEqual(p.payload, original[0]!.payload),
          ),
        leaseValid: leaseUntil > Date.now(),
        leaseEmpty: row.attempt_id === null && row.lease_until === null,
        windowValid:
          row.first_confirmed_at.getTime() === firstAck &&
          f.runtime.now() >= first.published_at.getTime() &&
          f.runtime.now() <= first.published_at.getTime() + 960000 &&
          f.runtime.now() < firstAck + 900000,
        reconciliations: row.reconciliations + sender.reconciled.length,
        dispatches,
        senderAttempts: sender.attempts.length,
        acknowledgements,
        receipts: row.receipts,
        providerReceipt: existsSync(
          join(sender.directory, `${first.idempotency_key}.json`),
        ),
      };
      diagnostic(
        JSON.stringify({
          phase: 'restarted-errand',
          ...progress,
          row,
          permits,
          preparedExpiries: expiries,
          observedAt,
          leaseUntil,
        }),
      );
      if (forumComplete(progress, first.attempts, 'Restarted errand')) {
        assert.deepEqual(sender.attempts[0], permit);
        const providerAck = JSON.parse(
          readFileSync(
            join(sender.directory, `${first.idempotency_key}.json`),
            'utf8',
          ),
        );
        assert.equal(providerAck.status, 'confirmed');
        assert.equal(providerAck.key, first.idempotency_key);
        assert.equal(providerAck.destinationId, destinationId);
        assert.equal(providerAck.confirmedAt, f.runtime.now());
        assert.equal(await worker.runOne(), false);
        return progress;
      }
      assert.ok(
        permit && observedAt >= Math.min(permit.expiresAt, expiries.at(-1)!),
        'Restarted errand dispatch precondition: expiry must be observed',
      );
      assert.equal(
        row.next_attempt_at.getTime(),
        f.runtime.now() + Math.min(60000, 1000 * 2 ** Math.min(attempt - 1, 6)),
      );
      assert.ok(
        row.next_attempt_at.getTime() <=
          first.published_at.getTime() + 960000 &&
          row.next_attempt_at.getTime() < firstAck + 900000,
      );
      f.setTime(row.next_attempt_at.getTime());
    }
    assert.fail('Restarted errand dispatch budget exhausted');
  } finally {
    sender.prepare = prepare;
    f.source.current = source;
    f.records.confirmed = confirmed;
    f.records.current = current;
    f.db.transaction = transaction;
  }
}

test('forum precondition rejects uncertain outcomes, changed identity and any side effects', () => {
  const retry: ForumProgress = {
    status: 'retryable',
    reason: 'permit_expired',
    attempts: 1,
    identityUnchanged: true,
    preparationsValid: true,
    sourceReads: 1,
    finalProofs: 1,
    sourceUnchanged: true,
    leaseValid: true,
    leaseEmpty: true,
    windowValid: true,
    reconciliations: 0,
    dispatches: 0,
    senderAttempts: 0,
    acknowledgements: 0,
    receipts: 0,
    providerReceipt: false,
  };
  assert.equal(forumComplete(retry), false);
  const complete = {
    ...retry,
    status: 'confirmed',
    reason: null,
    dispatches: 1,
    senderAttempts: 1,
    acknowledgements: 1,
    receipts: 1,
    providerReceipt: true,
  };
  assert.equal(forumComplete(complete), true);
  assert.equal(
    forumComplete({ ...retry, attempts: 2 }, 1, 'Restarted errand'),
    false,
  );
  assert.equal(
    forumComplete(
      { ...complete, attempts: 8, sourceReads: 7, finalProofs: 7 },
      1,
      'Restarted errand',
    ),
    true,
  );
  assert.throws(
    () =>
      forumComplete(
        { ...retry, attempts: 8, sourceReads: 7, finalProofs: 7 },
        1,
        'Restarted errand',
      ),
    /Restarted errand dispatch precondition:/,
  );
  assert.throws(
    () => forumComplete(retry, 1, 'Restarted errand'),
    /Restarted errand dispatch precondition:/,
  );

  for (const patch of [
    { reason: 'unavailable' },
    { reason: 'not_accepted' },
    { status: 'unknown', reason: 'unknown' },
    { attempts: 8, sourceReads: 8, finalProofs: 8 },
    { identityUnchanged: false },
    { preparationsValid: false },
    { sourceUnchanged: false },
    { sourceReads: 0 },
    { finalProofs: 0 },
    { leaseValid: false },
    { leaseEmpty: false },
    { windowValid: false },
    { reconciliations: 1 },
    { dispatches: 1 },
    { senderAttempts: 1 },
    { acknowledgements: 1 },
    { receipts: 1 },
    { providerReceipt: true },
  ])
    assert.throws(
      () => forumComplete({ ...retry, ...patch }),
      /Forum dispatch precondition:/,
    );
  for (const patch of [
    { dispatches: 0 },
    { senderAttempts: 0 },
    { acknowledgements: 0 },
    { receipts: 0 },
    { providerReceipt: false },
    { reason: 'unknown' },
  ])
    assert.throws(
      () => forumComplete({ ...complete, ...patch }),
      /Forum dispatch precondition:/,
    );
});

interface MalformedAckProgress {
  variant: string;
  delivery?: {
    id: string;
    eventId: string;
    key: string;
    destination: string;
    fence: string;
    businessNow: number;
    dueAt: Date;
    originalAckAt: string;
    mutatedAckAt: string;
  };
  status: string;
  reason: string | null;
  attempts: number;
  identityUnchanged: boolean;
  sourceUnchanged: boolean;
  sourceReads: number;
  finalProofs: number;
  dispatchCalls: number;
  senderAttempts: number;
  mutations: number;
  mutationValid: boolean;
  acknowledgementCalls: number;
  malformedRejections: number;
  receipts: number;
  anchorEmpty: boolean;
  leaseEmpty: boolean;
  reconciliations: number;
}
/** This is only the malformed-ACK fixture precondition, never an unknown-work
 * recovery driver. In particular, a cap/exception-produced unknown is not an ACK. */
function malformedAckComplete(progress: MalformedAckProgress) {
  const diagnostic = `Malformed ACK precondition: ${JSON.stringify(progress)}`;
  assert.ok(
    progress.identityUnchanged &&
      progress.sourceUnchanged &&
      progress.attempts >= 1 &&
      progress.attempts <= 8 &&
      progress.sourceReads === progress.attempts &&
      progress.finalProofs === progress.attempts &&
      progress.receipts === 0 &&
      progress.anchorEmpty &&
      progress.leaseEmpty &&
      progress.reconciliations === 0,
    diagnostic,
  );
  if (progress.mutations === 1) {
    assert.ok(
      progress.dispatchCalls === 1 &&
        progress.senderAttempts === 1 &&
        progress.mutationValid &&
        progress.acknowledgementCalls === 1 &&
        progress.malformedRejections === 1 &&
        progress.status === 'unknown' &&
        progress.reason === 'unknown',
      diagnostic,
    );
    return true;
  }
  assert.ok(
    progress.mutations === 0 &&
      progress.dispatchCalls === 0 &&
      progress.senderAttempts === 0 &&
      progress.acknowledgementCalls === 0 &&
      progress.malformedRejections === 0 &&
      progress.status === 'retryable' &&
      progress.reason === 'permit_expired' &&
      progress.attempts < 8,
    diagnostic,
  );
  return false;
}

async function returnMalformedAck(
  f: Fixture,
  publication: Awaited<ReturnType<typeof publish>>,
  variant: number | 'wrong-key' | 'wrong-destination',
) {
  const read = async () =>
    (
      await f.pool.query(
        `SELECT d.*,p.order_id,p.target_region_id,p.published_at,p.first_confirmed_at,p.first_confirmed_delivery_id,
        (SELECT count(*)::integer FROM whaleu_notifications.errand_group_receipts r WHERE r.delivery_id=d.id) receipts
       FROM whaleu_notifications.errand_group_deliveries d
       JOIN whaleu_notifications.errand_group_publications p ON p.event_id=d.event_id WHERE p.order_id=$1`,
        [publication.id],
      )
    ).rows;
  const initial = await read();
  assert.equal(initial.length, 1);
  const first = initial[0];
  assert.equal(first.stage, 'errand');
  assert.equal(first.status, 'pending');
  assert.equal(first.reason, null);
  assert.equal(first.attempts, 0);
  assert.equal(first.published_at.getTime(), publication.publishedAt);
  const identity = (row: typeof first) =>
    JSON.stringify([
      row.id,
      row.event_id,
      row.stage,
      row.destination_id,
      row.idempotency_key,
      row.order_id,
      row.target_region_id,
      row.published_at,
    ]);
  const prepare = f.sender.prepare.bind(f.sender);
  const source = f.source.current.bind(f.source);
  const confirmed = f.records.confirmed.bind(f.records);
  const attemptsBefore = f.sender.attempts.length;
  const reconciledBefore = f.sender.reconciled.length;
  const sources: string[] = [];
  const preparations: string[] = [];
  let finalProofs = 0,
    dispatchCalls = 0;
  const mutations: {
    original: Extract<SyntheticAck, { status: 'confirmed' }>;
    changed: Extract<SyntheticAck, { status: 'confirmed' }>;
    now: number;
    attemptId: string;
    fence: string;
  }[] = [];
  let acknowledgementCalls = 0,
    malformedRejections = 0;
  f.records.confirmed = async (...args) => {
    acknowledgementCalls++;
    try {
      return await confirmed(...args);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Unproven synthetic ACK' &&
        args[1] === mutations[0]?.changed &&
        args[2] === mutations[0]?.now
      )
        malformedRejections++;
      throw error;
    }
  };
  const proof: RequiredTransactionProof<string> = {
    maximumFacts: 1,
    failureCode: 'ERRAND_UNAVAILABLE',
    validate: async () => {
      finalProofs++;
    },
  };
  f.source.current = async (...args) => {
    const payload = await source(...args);
    sources.push(JSON.stringify([args[0], args[1], payload]));
    enableRequiredTransactionProof(args[2], proof);
    registerRequiredTransactionFact(
      args[2],
      proof,
      'malformed-ack',
      'malformed-ack',
    );
    return payload;
  };
  f.sender.prepare = async (key, destination) => {
    const prepared = await prepare(key, destination);
    preparations.push(
      JSON.stringify([
        key,
        destination.id,
        prepared.key,
        prepared.destinationId,
      ]),
    );
    return {
      ...prepared,
      dispatch: (permit) => {
        dispatchCalls++;
        const original = prepared.dispatch(permit);
        if (original.status !== 'confirmed') return original;
        const now = f.runtime.now();
        const changed = {
          ...original,
          confirmedAt:
            variant === 1
              ? now + 1
              : typeof variant === 'number'
                ? publication.publishedAt + variant
                : original.confirmedAt,
          key: variant === 'wrong-key' ? '0'.repeat(64) : original.key,
          destinationId:
            variant === 'wrong-destination'
              ? 'synthetic:wrong'
              : original.destinationId,
        };
        // Record the actual returned confirmed ACK before assertions, which must
        // live outside dispatch: the worker catches errors thrown by this callback.
        mutations.push({
          original,
          changed,
          now,
          attemptId: permit.attemptId,
          fence: permit.fence,
        });
        return changed;
      },
    };
  };
  try {
    let before = first;
    for (let attempt = 1; attempt <= 8; attempt++) {
      assert.equal(await f.groups.runOne(), true);
      const rows = await read();
      assert.equal(rows.length, 1);
      const row = rows[0];
      const mutation = mutations[0];
      const attempts = (
        await f.pool.query(
          'SELECT id,fence,idempotency_key,operation FROM whaleu_notifications.errand_group_attempts WHERE delivery_id=$1 ORDER BY fence',
          [first.id],
        )
      ).rows;
      const sameKeyAttempts = f.sender.attempts
        .slice(attemptsBefore)
        .filter((p) => p.key === first.idempotency_key);
      const progress: MalformedAckProgress = {
        variant: String(variant),
        delivery: {
          id: row.id,
          eventId: row.event_id,
          key: row.idempotency_key,
          destination: row.destination_id,
          fence: row.fence,
          businessNow: f.runtime.now(),
          dueAt: row.next_attempt_at,
          originalAckAt: String(mutation?.original.confirmedAt),
          mutatedAckAt: String(mutation?.changed.confirmedAt),
        },
        status: row.status,
        reason: row.reason,
        attempts: row.attempts,
        identityUnchanged:
          identity(row) === identity(first) &&
          preparations.length === attempt &&
          preparations.every(
            (p) =>
              p ===
              JSON.stringify([
                first.idempotency_key,
                first.destination_id,
                first.idempotency_key,
                first.destination_id,
              ]),
          ) &&
          row.attempts === attempt &&
          BigInt(row.fence) === BigInt(first.fence) + BigInt(attempt) &&
          attempts.length === attempt &&
          attempts.every(
            (a, i) =>
              a.operation === 'send' &&
              a.idempotency_key === first.idempotency_key &&
              BigInt(a.fence) === BigInt(first.fence) + BigInt(i + 1),
          ),
        sourceUnchanged: sources.every((s) => s === sources[0]),
        sourceReads: sources.length,
        finalProofs,
        dispatchCalls,
        senderAttempts: sameKeyAttempts.length,
        mutations: mutations.length,
        acknowledgementCalls,
        malformedRejections,
        mutationValid:
          !!mutation &&
          mutation.original.key === first.idempotency_key &&
          mutation.original.destinationId === first.destination_id &&
          mutation.original.confirmedAt === mutation.now &&
          mutation.now >= publication.publishedAt &&
          mutation.now <= publication.publishedAt + 960000 &&
          /^synthetic:[a-zA-Z0-9:_-]{1,120}$/.test(
            mutation.original.receiptId,
          ) &&
          mutation.changed.receiptId === mutation.original.receiptId &&
          mutation.changed.key ===
            (variant === 'wrong-key'
              ? '0'.repeat(64)
              : first.idempotency_key) &&
          mutation.changed.destinationId ===
            (variant === 'wrong-destination'
              ? 'synthetic:wrong'
              : first.destination_id) &&
          Object.is(
            mutation.changed.confirmedAt,
            variant === 1
              ? mutation.now + 1
              : typeof variant === 'number'
                ? publication.publishedAt + variant
                : mutation.now,
          ) &&
          mutation.attemptId === attempts.at(-1)?.id &&
          mutation.fence === row.fence &&
          f.sender.attempts.length === attemptsBefore + 1 &&
          (variant !== 1 ||
            (mutation.changed.confirmedAt > f.runtime.now() &&
              mutation.now > publication.publishedAt)),
        receipts: row.receipts,
        anchorEmpty:
          row.first_confirmed_at === null &&
          row.first_confirmed_delivery_id === null,
        leaseEmpty: row.attempt_id === null && row.lease_until === null,
        reconciliations:
          row.reconciliations + f.sender.reconciled.length - reconciledBefore,
      };
      if (malformedAckComplete(progress)) return { row, progress };
      assert.equal(
        f.sender.attempts.length,
        attemptsBefore,
        JSON.stringify(progress),
      );
      assert.equal(
        row.next_attempt_at.getTime(),
        f.runtime.now() + Math.min(60000, 1000 * 2 ** Math.min(attempt - 1, 6)),
        JSON.stringify(progress),
      );
      assert.ok(
        row.next_attempt_at.getTime() > before.next_attempt_at.getTime(),
        JSON.stringify(progress),
      );
      // Only business scheduling moves. Each claim gets a new source proof,
      // preparation and original 100ms permit; unknown work is never reconciled.
      f.setTime(row.next_attempt_at.getTime());
      before = row;
    }
    assert.fail(
      'Malformed ACK was never returned within the original eight attempts',
    );
  } finally {
    f.sender.prepare = prepare;
    f.source.current = source;
    f.records.confirmed = confirmed;
  }
}

test('malformed ACK precondition rejects unproven outcomes and preserves the eight-attempt cap', () => {
  const retry: MalformedAckProgress = {
    variant: 'future',
    status: 'retryable',
    reason: 'permit_expired',
    attempts: 1,
    identityUnchanged: true,
    sourceUnchanged: true,
    sourceReads: 1,
    finalProofs: 1,
    dispatchCalls: 0,
    senderAttempts: 0,
    mutations: 0,
    mutationValid: false,
    acknowledgementCalls: 0,
    malformedRejections: 0,
    receipts: 0,
    anchorEmpty: true,
    leaseEmpty: true,
    reconciliations: 0,
  };
  assert.equal(malformedAckComplete(retry), false);
  const completed = {
    ...retry,
    status: 'unknown',
    reason: 'unknown',
    dispatchCalls: 1,
    senderAttempts: 1,
    mutations: 1,
    mutationValid: true,
    acknowledgementCalls: 1,
    malformedRejections: 1,
  };
  assert.equal(malformedAckComplete(completed), true);
  assert.equal(
    malformedAckComplete({
      ...completed,
      attempts: 8,
      sourceReads: 8,
      finalProofs: 8,
    }),
    true,
  );
  for (const patch of [
    { status: 'unknown', reason: 'unknown' },
    { reason: 'unavailable' },
    { reason: 'not_accepted' },
    { status: 'suppressed', reason: 'source_or_authority' },
    {
      status: 'suppressed',
      reason: 'budget',
      attempts: 8,
      sourceReads: 8,
      finalProofs: 8,
    },
    {
      status: 'unknown',
      reason: 'unknown',
      attempts: 8,
      sourceReads: 8,
      finalProofs: 8,
    },
    { attempts: 8, sourceReads: 8, finalProofs: 8 },
    { dispatchCalls: 1 },
    { senderAttempts: 1 },
    { mutations: 1 },
    { identityUnchanged: false },
    { sourceUnchanged: false },
    { sourceReads: 0 },
    { finalProofs: 0 },
    { acknowledgementCalls: 1 },
    { malformedRejections: 1 },
    { receipts: 1 },
    { anchorEmpty: false },
    { leaseEmpty: false },
    { reconciliations: 1 },
  ])
    assert.throws(
      () => malformedAckComplete({ ...retry, ...patch }),
      /Malformed ACK precondition:/,
    );
  for (const patch of [
    { mutationValid: false },
    { acknowledgementCalls: 0 },
    { malformedRejections: 0 },
    { mutations: 2 },
    { dispatchCalls: 2 },
    { senderAttempts: 0 },
    { reason: 'budget' },
    { status: 'confirmed' },
  ])
    assert.throws(
      () => malformedAckComplete({ ...completed, ...patch }),
      /Malformed ACK precondition:/,
    );
});

for (const scenario of [
  'normal',
  'initial-expired',
  'expired',
  'wrong-key',
  'wrong-destination',
  'unavailable',
  'lost-ack',
  'changed-source',
  'restart-expired',
  'restart-wrong-key',
  'restart-wrong-destination',
  'restart-unavailable',
  'restart-unknown-ack',
  'restart-lost-ack',
  'restart-not-accepted',
  'restart-changed-source',
  'restart-changed-payload',
])
  test(
    scenario === 'initial-expired'
      ? 'E4 initial concurrent preparation recovers only the exact unsent destination'
      : scenario === 'normal'
        ? 'E4 partial destination failure, durable restart, exact first ACK forum windows and private allowlist'
        : scenario.startsWith('restart-')
          ? `E4 restarted errand precondition operational fixture: ${scenario.slice(8)}`
          : `E4 forum precondition operational fixture: ${scenario}`,
    { timeout: 120000 },
    async (t) => {
      const f = await errandGroupFixture();
      t.after(() => f.close());
      const d = destinations(f),
        p = await publish(f);
      const http = f.app.getHttpServer(),
        auth = `Bearer ${p.actor.accessToken}`;
      const profile = await request(http)
        .get('/v1/me/profile')
        .set('Authorization', auth);
      const preference = await request(http)
        .patch('/v1/me/preferences')
        .set('Authorization', auth)
        .send({
          expectedRevision: profile.body.revision,
          preferences: { showErrandGroupNotice: false },
        });
      assert.equal(preference.status, 200, JSON.stringify(preference.body));
      const browse = await request(http)
        .put('/v1/me/campus')
        .set('Authorization', auth)
        .send({
          expectedRevision: preference.body.revision,
          campusId: f.scope.foreign.campusId,
        });
      assert.equal(browse.status, 200, JSON.stringify(browse.body));
      f.sender.actions.set(d.two.id, ['not_accepted']);
      await f.groups.discover();
      const originalPreparation = f.sender.prepare.bind(f.sender);
      let initialExpiries = 0;
      if (scenario === 'initial-expired')
        f.sender.prepare = async (...args) => {
          const prepared = await originalPreparation(...args);
          if (args[1].id === d.one.id && initialExpiries++ === 0)
            return { ...prepared, expiresAt: performance.now() - 1 };
          return prepared;
        };
      const preparation = observeGroupPreparation(f);
      try {
        const concurrentTraces = await Promise.all([
          preparation.run(f.groups),
          preparation.run(f.restart()),
          preparation.run(f.restart()),
        ]);
        assert.equal(
          concurrentTraces.filter((trace) => trace.claimed).length,
          2,
          'exactly two distinct rows are claimed; worker arrival order is immaterial',
        );
        const row = (await preparationRows(f.pool)).find(
          (r) => r.destination_id === d.one.id,
        )!;
        if (row.status !== 'confirmed') {
          const trace = concurrentTraces.find(
            (value) => value.permit?.key === row.idempotency_key,
          );
          assert.ok(trace, JSON.stringify({ row, concurrentTraces }));
          await recoverUnsentPreparation({
            pool: f.pool,
            directory: f.directory,
            row,
            trace,
            senderAttempts: [...f.sender.attempts],
            latestBusinessTime: p.publishedAt + 1000,
            setTime: f.setTime,
            run: async () => ({
              trace: await preparation.run(f.restart()),
              senderAttempts: [...f.sender.attempts],
            }),
            diagnostic: (message) => t.diagnostic(message),
          });
        }
      } finally {
        preparation.restore();
        f.sender.prepare = originalPreparation;
      }
      if (scenario === 'initial-expired') assert.equal(initialExpiries, 2);
      let rows = (await f.rows()).rows;
      t.diagnostic(
        JSON.stringify({
          phase: 'initial-concurrent-claims',
          scenario,
          rows,
          senderAttempts: f.sender.attempts,
        }),
      );
      assert.deepEqual(
        rows.map((r) => r.status),
        ['confirmed', 'retryable'],
      );
      const ack = (
        await f.pool.query(
          'SELECT first_confirmed_at FROM whaleu_notifications.errand_group_publications',
        )
      ).rows[0].first_confirmed_at.getTime();
      f.authority.groups.set(d.one.id, { ...d.one, revision: 'r2' });
      f.setTime(p.publishedAt + 1000);
      const restartedSender = new DurableSyntheticGroupSender(
          f.directory,
          f.runtime.now,
        ),
        restarted = f.restart({ ...f.runtime, sender: restartedSender });
      await restarted.discover();
      const restartScenario = scenario.startsWith('restart-')
        ? scenario.slice(8)
        : 'normal';
      const restartPrepare = restartedSender.prepare.bind(restartedSender);
      const restartSource = f.source.current.bind(f.source);
      let restartInjected = 0;
      restartedSender.prepare = async (...args) => {
        if (restartScenario === 'unavailable') {
          restartInjected++;
          throw Error('Injected restart readiness failure');
        }
        const prepared = await restartPrepare(...args);
        if (restartScenario === 'wrong-key') {
          restartInjected++;
          return { ...prepared, key: '0'.repeat(64) };
        }
        if (restartScenario === 'wrong-destination') {
          restartInjected++;
          return { ...prepared, destinationId: 'synthetic:wrong' };
        }
        if (restartScenario === 'changed-payload')
          return {
            ...prepared,
            dispatch: (permit) => {
              restartInjected++;
              return prepared.dispatch({
                ...permit,
                payload: { ...permit.payload, title: 'Changed payload' },
              });
            },
          };
        if (
          (restartScenario === 'expired' ||
            restartScenario === 'changed-source') &&
          restartInjected++ === 0
        )
          return { ...prepared, expiresAt: performance.now() - 1 };
        return prepared;
      };
      if (restartScenario === 'changed-source')
        f.source.current = async (...args) => ({
          ...(await restartSource(...args)),
          title: 'Changed source',
        });
      if (restartScenario === 'unknown-ack')
        restartedSender.actions.set(d.two.id, ['unknown']);
      if (restartScenario === 'lost-ack')
        restartedSender.actions.set(d.two.id, ['lose_ack']);
      if (restartScenario === 'not-accepted')
        restartedSender.actions.set(d.two.id, ['not_accepted']);
      const restartDiagnostics: string[] = [];
      const reportRestart = (message: string) => {
        restartDiagnostics.push(message);
        t.diagnostic(message);
      };
      if (restartScenario !== 'normal' && restartScenario !== 'expired') {
        await assert.rejects(
          confirmRestartedErrand(
            f,
            restarted,
            restartedSender,
            ack,
            d.two.id,
            reportRestart,
          ),
          /Restarted errand dispatch precondition:/,
        );
        const row = (await f.rows()).rows.find(
          (r) => r.destination_id === d.two.id,
        )!;
        assert.equal(restartedSender.reconciled.length, 0);
        assert.equal(
          (await f.rows()).rows.some((r) => r.stage === 'forum'),
          false,
          'restart guard must reject before forum enrollment/injection',
        );
        const last = JSON.parse(restartDiagnostics.at(-1)!);
        assert.equal(last.identityUnchanged, true);
        assert.equal(last.leaseValid, restartScenario !== 'unavailable');
        if (restartScenario === 'unavailable') {
          assert.equal(last.sourceReads, 0);
          assert.equal(last.finalProofs, 0);
          assert.deepEqual(last.permits, []);
          assert.deepEqual(last.preparedExpiries, []);
          assert.equal(
            last.leaseUntil,
            0,
            'readiness fails before the source/lease observation',
          );
        }
        assert.equal(last.leaseEmpty, true);
        assert.equal(last.windowValid, true);
        assert.equal(
          last.sourceUnchanged,
          !['changed-source', 'changed-payload'].includes(restartScenario),
        );
        assert.equal(
          last.preparationsValid,
          !['wrong-key', 'wrong-destination', 'unavailable'].includes(
            restartScenario,
          ),
        );
        if (last.providerReceipt) {
          const providerAck = JSON.parse(
            readFileSync(
              join(f.directory, `${row.idempotency_key}.json`),
              'utf8',
            ),
          );
          assert.equal(providerAck.status, 'confirmed');
          assert.equal(providerAck.key, row.idempotency_key);
          assert.equal(providerAck.destinationId, d.two.id);
        }
        if (
          [
            'wrong-key',
            'wrong-destination',
            'changed-source',
            'unavailable',
          ].includes(restartScenario)
        ) {
          assert.equal(row.attempts, 2, 'forbidden state must not retry');
          assert.equal(restartedSender.attempts.length, 0);
          assert.equal(last.dispatches, 0);
          assert.equal(last.receipts, 0);
          assert.equal(last.providerReceipt, false);
          assert.equal(
            row.reason,
            restartScenario === 'unavailable'
              ? 'unavailable'
              : 'permit_expired',
          );
          assert.equal(restartInjected, 1);
        } else {
          assert.ok(row.attempts >= 2 && row.attempts <= 8);
          assert.equal(restartedSender.attempts.length, 1);
          assert.equal(last.dispatches, 1);
          for (const prefix of restartDiagnostics.slice(0, -1)) {
            const p = JSON.parse(prefix);
            assert.equal(p.reason, 'permit_expired');
            assert.equal(p.dispatches, 0);
            assert.equal(p.providerReceipt, false);
          }
          if (restartScenario === 'changed-payload') {
            assert.equal(row.status, 'confirmed');
            assert.equal(last.sourceUnchanged, false);
            assert.equal(restartInjected, 1);
            assert.equal(last.receipts, 1);
          } else {
            assert.equal(
              row.status,
              restartScenario === 'not-accepted' ? 'retryable' : 'unknown',
            );
            assert.equal(
              row.reason,
              restartScenario === 'not-accepted' ? 'not_accepted' : 'unknown',
            );
            assert.equal(last.receipts, 0);
          }
          assert.equal(
            last.providerReceipt,
            restartScenario === 'lost-ack' ||
              restartScenario === 'changed-payload',
          );
        }
        return;
      }
      const restartProgress = await confirmRestartedErrand(
        f,
        restarted,
        restartedSender,
        ack,
        d.two.id,
        reportRestart,
      );
      if (restartScenario === 'expired') {
        assert.ok(restartProgress.attempts >= 3);
        const forced = JSON.parse(restartDiagnostics[0]!);
        assert.equal(forced.reason, 'permit_expired');
        assert.equal(forced.dispatches, 0);
        assert.equal(forced.providerReceipt, false);
        assert.ok(forced.observedAt >= forced.preparedExpiries[0]);
      }
      restartedSender.prepare = restartPrepare;
      f.source.current = restartSource;
      assert.equal(restartedSender.attempts.length, 1);
      assert.equal(restartedSender.attempts[0]!.destination.id, d.two.id);
      const forumScenario =
        restartScenario === 'expired' || scenario === 'initial-expired'
          ? 'normal'
          : scenario;
      f.setTime(ack + 900000 - 1);
      await restarted.discover();
      assert.equal(await restarted.runOne(), false);
      f.setTime(ack + 900000);
      await restarted.discover();
      if (forumScenario !== 'normal') {
        const prepare = restartedSender.prepare.bind(restartedSender);
        let first = true;
        restartedSender.prepare = async (...args) => {
          if (forumScenario === 'unavailable')
            throw Error('Injected readiness failure');
          const prepared = await prepare(...args);
          if (forumScenario === 'wrong-key')
            return { ...prepared, key: '0'.repeat(64) };
          if (forumScenario === 'wrong-destination')
            return { ...prepared, destinationId: 'synthetic:wrong' };
          if (
            !first ||
            (forumScenario !== 'expired' && forumScenario !== 'changed-source')
          )
            return prepared;
          first = false;
          return { ...prepared, expiresAt: performance.now() - 1 };
        };
      }
      if (forumScenario === 'lost-ack')
        restartedSender.actions.set(d.forum.id, ['lose_ack']);
      if (forumScenario === 'changed-source') {
        const source = f.source.current.bind(f.source);
        let reads = 0;
        f.source.current = async (...args) => {
          const payload = await source(...args);
          return ++reads === 1
            ? payload
            : { ...payload, title: 'Changed source' };
        };
      }
      if (forumScenario !== 'normal' && forumScenario !== 'expired') {
        await assert.rejects(
          confirmForum(f, restarted, restartedSender, ack),
          /Forum dispatch precondition:/,
        );
        const row = (await f.rows()).rows.find((r) => r.stage === 'forum');
        if (
          forumScenario === 'wrong-key' ||
          forumScenario === 'wrong-destination'
        ) {
          assert.equal(row.reason, 'permit_expired');
          assert.equal(row.attempts, 1, 'identity mismatch must not retry');
          assert.equal(
            restartedSender.attempts.length,
            1,
            'only prior errand dispatch',
          );
        }
        if (forumScenario === 'lost-ack') {
          assert.equal(row.status, 'unknown');
          assert.ok(row.attempts >= 1 && row.attempts <= 8);
          assert.equal(restartedSender.reconciled.length, 0);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_notifications.errand_group_receipts WHERE delivery_id=$1',
                [row.id],
              )
            ).rowCount,
            0,
          );
          const providerAck = JSON.parse(
            readFileSync(
              join(f.directory, `${row.idempotency_key}.json`),
              'utf8',
            ),
          );
          assert.equal(providerAck.status, 'confirmed');
          assert.equal(providerAck.key, row.idempotency_key);
          assert.equal(providerAck.destinationId, row.destination_id);
          assert.equal(restartedSender.attempts.length, 2);
          assert.equal(
            existsSync(join(f.directory, `${row.idempotency_key}.json`)),
            true,
          );
        }
        return;
      }
      const forum = await confirmForum(f, restarted, restartedSender, ack);
      if (forumScenario === 'expired') assert.ok(forum.attempts >= 2);
      rows = (await f.rows()).rows;
      assert.deepEqual(
        rows.map((r) => r.status),
        ['confirmed', 'confirmed', 'confirmed'],
      );
      const payloads = [...f.sender.attempts, ...restartedSender.attempts].map(
        (p) => p.payload,
      );
      assert.equal(payloads[0]!.reward, '12.35');
      assert.equal(payloads[0]!.sourceLabel?.startsWith('跨地区：'), true);
      assert.equal(payloads.at(-1)!.expectedTime, undefined);
      const serialized = JSON.stringify(payloads);
      for (const secret of [
        'SECRET',
        'Never transmit',
        '12345678901',
        'publicText',
        'privateText',
        'publisherContacts',
        'publicMedia',
        'privateMedia',
      ])
        assert.equal(serialized.includes(secret), false, secret);
      const reader = await f.actor();
      const native = payloads[0]!.locator;
      assert.equal(native, `pages/errand-detail/errand-detail?orderId=${p.id}`);
      const detail = await request(f.app.getHttpServer())
        .get(`/v1/errands/${p.id}`)
        .set('Authorization', `Bearer ${reader.accessToken}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.privateText, undefined);
      assert.equal(detail.body.oppositeContact, undefined);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_notifications.errand_group_receipts',
          )
        ).rowCount,
        3,
      );
    },
  );

test(
  'ACK loss and lost receipt transaction remain unknown; same-key reconciliation does not resend',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const d = f.authority.add(f.scope.related.regionId, 'errand', 'ack:one'),
      p = await publish(f);
    f.sender.actions.set(d.id, ['lose_ack']);
    await f.groups.discover();
    await f.groups.runOne();
    assert.equal((await f.rows()).rows[0].status, 'unknown');
    assert.equal(
      (
        await f.pool.query(
          'SELECT first_confirmed_at FROM whaleu_notifications.errand_group_publications',
        )
      ).rows[0].first_confirmed_at,
      null,
    );
    // Reconcile a proven earlier ACK even after 16 minutes, using its original time.
    f.setTime(p.publishedAt + 960001);
    const nextSender = new DurableSyntheticGroupSender(
        f.directory,
        f.runtime.now,
      ),
      next = f.restart({ ...f.runtime, sender: nextSender });
    assert.equal(await next.runOne(), true);
    assert.equal(nextSender.attempts.length, 0);
    assert.equal(nextSender.reconciled.length, 1);
    assert.equal((await f.rows()).rows[0].status, 'confirmed');
    assert.equal(
      (
        await f.pool.query(
          'SELECT first_confirmed_at FROM whaleu_notifications.errand_group_publications',
        )
      ).rows[0].first_confirmed_at.getTime(),
      p.publishedAt,
    );

    const p2 = await publish(f);
    await f.groups.discover();
    const original = f.records.confirmed.bind(f.records);
    let lost = false;
    f.records.confirmed = async (...args) => {
      await original(...args);
      if (!lost) {
        lost = true;
        throw Error('Synthetic receipt transaction lost before commit');
      }
    };
    await f.groups.runOne();
    f.records.confirmed = original;
    assert.equal(
      (await f.rows()).rows.find((r) => r.status === 'unknown')?.status,
      'unknown',
    );
    f.setTime(p2.publishedAt + 1000);
    await f.restart().runOne();
    assert.equal(
      (await f.rows()).rows.every((r) => r.status === 'confirmed'),
      true,
    );
    assert.equal(
      f.sender.attempts.length,
      2,
      'no resend after accepted provider receipt',
    );
  },
);

test(
  'unknown is never blindly resent, even beyond window; known not accepted must reauthorize',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const d = f.authority.add(
        f.scope.related.regionId,
        'errand',
        'unknown:one',
      ),
      p = await publish(f);
    f.sender.actions.set(d.id, ['unknown']);
    await f.groups.discover();
    await f.groups.runOne();
    f.setTime(p.publishedAt + 1000);
    await f.restart().runOne();
    assert.equal(f.sender.attempts.length, 1);
    assert.equal((await f.rows()).rows[0].status, 'unknown');
    f.sender.unresolved = false;
    const reconcile = f.sender.reconcile.bind(f.sender);
    f.sender.reconcile = async (_key, destinationId) => ({
      status: 'not_accepted',
      key: '0'.repeat(64),
      destinationId,
    });
    f.setTime(p.publishedAt + 4000);
    await f.restart().runOne();
    assert.equal(
      (await f.rows()).rows[0].status,
      'unknown',
      'nonacceptance for another key cannot authorize resend',
    );
    f.sender.reconcile = reconcile;
    f.setTime(p.publishedAt + 12000);
    await f.restart().runOne();
    assert.equal((await f.rows()).rows[0].status, 'retryable');
    await revokeErrandReview(f.pool, p.approval.decisionId);
    f.setTime(p.publishedAt + 24000);
    await f.restart().runOne();
    assert.equal((await f.rows()).rows[0].status, 'suppressed');
    assert.equal(f.sender.attempts.length, 1);
  },
);

test(
  'readiness waits cannot preserve stale source, Review, Safety, region or destination authority',
  { timeout: 180000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const d = f.authority.add(f.scope.related.regionId, 'errand', 'gate:one');
    const mutations: [
      string,
      (p: Awaited<ReturnType<typeof publish>>) => Promise<void>,
    ][] = [
      [
        'Review revoke',
        async (p) => {
          await revokeErrandReview(f.pool, p.approval.decisionId);
        },
      ],
      [
        'Safety feature',
        async (p) => {
          await seedErrandFeature(f.pool, p.actor.accountId, [
            syntheticErrandRestriction('publish'),
          ]);
        },
      ],
      [
        'phone proof',
        async (p) => {
          await f.certify(p.actor.accountId, { phone: 'unverified' });
        },
      ],
      [
        'account lifecycle',
        async (p) => {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
              [p.actor.accountId],
            ),
          );
        },
      ],
      [
        'destination revoke',
        async () => {
          f.authority.groups.delete(d.id);
        },
      ],
      [
        'destination revision',
        async () => {
          f.authority.groups.set(d.id, { ...d, revision: 'changed' });
        },
      ],
      [
        'region inactive',
        async () => {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
              [f.scope.related.regionId],
            ),
          );
        },
      ],
      [
        'cancel',
        async (p) => {
          const r = await request(f.app.getHttpServer())
            .post(`/v1/errands/${p.id}/cancel`)
            .set('Authorization', `Bearer ${p.actor.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              expectedRevision: p.revision,
            });
          assert.equal(r.body.outcome, 'applied');
        },
      ],
      [
        'delete',
        async (p) => {
          const r = await request(f.app.getHttpServer())
            .post(`/v1/errands/${p.id}/delete`)
            .set('Authorization', `Bearer ${p.actor.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              expectedRevision: p.revision,
            });
          assert.equal(r.body.outcome, 'applied');
        },
      ],
      [
        'accept',
        async (p) => {
          const a = await f.actor();
          const r = await request(f.app.getHttpServer())
            .post(`/v1/errands/${p.id}/accept`)
            .set('Authorization', `Bearer ${a.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              expectedRevision: p.revision,
              contacts: { wechat: 'synthetic_runner', phone: '' },
            });
          assert.equal(r.body.outcome, 'applied');
        },
      ],
    ];
    for (const [label, mutate] of mutations) {
      f.authority.groups.set(d.id, d);
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_campus.operating_regions SET is_active=true WHERE id=$1',
          [f.scope.related.regionId],
        ),
      );
      const p = await publish(f);
      await f.groups.discover();
      f.sender.beforeReady = () => mutate(p);
      assert.equal(await f.groups.runOne(), true, label);
      f.sender.beforeReady = null;
      const rows = (await f.rows()).rows;
      assert.equal(
        rows.find((r) => r.event_id === rows.at(-1)?.event_id)?.status !==
          'confirmed',
        true,
        label,
      );
      assert.equal(f.sender.attempts.length, 0, label);
    }
  },
);

test(
  'default AppModule has no enrollment, no worker egress, and old events cannot be adopted',
  { timeout: 120000 },
  async (t) => {
    const f = await errandMediaFixture([
      { sha256: '0'.repeat(64), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const groups = f.app.get(ErrandGroupWorker);
    assert.deepEqual(await groups.inspect(), {
      enabled: false,
      deliveries: [],
    });
    assert.equal(await groups.discover(), 0);
    assert.equal(await groups.runOne(), false);
    const actor = await f.actor(),
      draft = await createErrandMediaDraft(f, actor),
      p = await publishErrandImages(f, actor, draft, []);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_publications',
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      inTransaction(f.pool, async (tx) => {
        await tx.query(
          `INSERT INTO whaleu_notifications.errand_group_publications(event_id,order_id,target_region_id,published_at) SELECT t.id,o.id,o.target_region_id,o.created_at FROM whaleu_errands.transitions t JOIN whaleu_errands.orders o ON o.id=t.order_id WHERE o.id=$1 AND t.operation='publish'`,
          [p.id],
        );
      }),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_publications',
        )
      ).rowCount,
      0,
    );
  },
);

test(
  'text-only group payload still applies E3 whole private image-set gate after readiness',
  { timeout: 120000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 48, height: 48, channels: 3, background: '#354f80' },
    })
      .png()
      .toBuffer();
    const f = await errandGroupFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    f.authority.add(f.scope.home.regionId, 'errand', 'media:one');
    const a = await f.actor(),
      draft = await createErrandMediaDraft(f, a),
      image = await readyErrandImage(f, a, draft, 'private0', bytes),
      p = await publishErrandImages(f, a, draft, [image.fact]);
    f.setTime(
      (
        await f.pool.query(
          'SELECT created_at FROM whaleu_errands.orders WHERE id=$1',
          [p.id],
        )
      ).rows[0].created_at.getTime(),
    );
    await f.groups.discover();
    f.sender.beforeReady = async () => {
      await withCommunityScopeWriter(f.pool, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) SELECT $1::uuid,a.id,h.revision+1,'revoked',a.manifest_digest,a.policy_revision,'errand-group-test',$1::text,'{}'::jsonb,clock_timestamp(),clock_timestamp()+interval '30 minutes' FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$2`,
          [id, image.fact.assetId],
        );
        await tx.query(
          'UPDATE whaleu_media.asset_safety_heads SET revision=revision+1,event_id=$2 WHERE asset_id=$1',
          [image.fact.assetId, id],
        );
      });
    };
    await f.groups.runOne();
    assert.equal(f.sender.attempts.length, 0);
    assert.equal((await f.rows()).rows[0].status, 'suppressed');
  },
);

test(
  'lease fencing survives restart while old readiness is paused; old prepared send cannot escape',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    f.authority.add(f.scope.related.regionId, 'errand', 'lease:one');
    const p = await publish(f);
    await f.groups.discover();
    let arrived!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => (arrived = r)),
      resume = new Promise<void>((r) => (release = r));
    f.sender.beforeReady = async () => {
      arrived();
      await resume;
    };
    const old = f.groups.runOne();
    await waiting;
    await f.pool.query(
      "UPDATE whaleu_notifications.errand_group_deliveries SET lease_until=clock_timestamp()-interval '1 second'",
    );
    assert.equal(
      await f.restart().runOne(),
      true,
      'restart reconciles the abandoned durable unknown key',
    );
    assert.equal((await f.rows()).rows[0].status, 'retryable');
    release();
    await old;
    f.sender.beforeReady = null;
    assert.equal(
      f.sender.attempts.length,
      0,
      'lost fence prevents stale prepared egress',
    );
    f.setTime(p.publishedAt + 4000);
    const restartStarted = performance.now();
    const preparation = observeGroupPreparation(f);
    let preparationRetries = 0;
    let restartClaimed: boolean;
    try {
      const trace = await preparation.run(f.restart());
      restartClaimed = trace.claimed;
      const row = (await preparationRows(f.pool))[0]!;
      if (row.status !== 'confirmed') {
        await recoverUnsentPreparation({
          pool: f.pool,
          directory: f.directory,
          row,
          trace,
          senderAttempts: [...f.sender.attempts],
          latestBusinessTime: p.publishedAt + 960000,
          setTime: f.setTime,
          run: async () => ({
            trace: await preparation.run(f.restart()),
            senderAttempts: [...f.sender.attempts],
          }),
          diagnostic: (message) => t.diagnostic(message),
        });
        preparationRetries++;
      }
    } finally {
      preparation.restore();
    }
    const restartElapsedMs = performance.now() - restartStarted;
    t.diagnostic(
      JSON.stringify({
        phase: 'lease-fencing-restart-final-send',
        claimed: restartClaimed,
        elapsedMs: restartElapsedMs,
        businessNow: f.runtime.now(),
        rows: (await f.rows()).rows,
        attempts: (
          await f.pool.query(
            'SELECT * FROM whaleu_notifications.errand_group_attempts ORDER BY fence',
          )
        ).rows,
        senderAttempts: f.sender.attempts,
      }),
    );
    assert.equal(f.sender.attempts.length, 1);
    assert.equal((await f.rows()).rows[0].status, 'confirmed');
    const attempts = (
      await f.pool.query(
        'SELECT * FROM whaleu_notifications.errand_group_attempts ORDER BY fence',
      )
    ).rows;
    assert.deepEqual(
      attempts.map((r) => r.operation),
      [
        'send',
        'reconcile',
        'send',
        ...Array<string>(preparationRetries).fill('send'),
      ],
    );
    assert.equal(new Set(attempts.map((r) => r.idempotency_key)).size, 1);
  },
);

test(
  'optional shortlink failures use native locator; readiness uses real authorization deadlines and closed permits',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    f.authority.add(f.scope.related.regionId, 'errand', 'link:one');
    const p = await publish(f);
    await f.groups.discover();
    const shortlinkWorker = f.restart({
      ...f.runtime,
      shortlinks: {
        resolve: async (nativeLocator) => ({
          nativeLocator,
          locator: 'https://unverified.invalid/?token=secret',
        }),
      },
    });
    await shortlinkWorker.runOne();
    assert.equal(
      f.sender.attempts[0]!.payload.locator,
      `pages/errand-detail/errand-detail?orderId=${p.id}`,
    );
    const p2 = await publish(f);
    await f.groups.discover();
    f.sender.beforeReady = async () => {
      await seedErrandFeature(f.pool, p2.actor.accountId, [], {
        validUntil: new Date(Date.now() + 100),
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    };
    await f.groups.runOne();
    f.sender.beforeReady = null;
    assert.equal(
      f.sender.attempts.length,
      1,
      'real PG expiry cannot be extended by synthetic business clock',
    );
    const p3 = await publish(f);
    await f.groups.discover();
    f.sender.preparedExpiresAt = performance.now() - 1;
    await f.groups.runOne();
    f.sender.preparedExpiresAt = null;
    const row = (await f.rows()).rows.find(
      (r) => r.reason === 'permit_expired',
    );
    assert.ok(row);
    assert.equal(row.status, 'retryable');
    assert.equal(f.sender.attempts.length, 1);
    f.setTime(p3.publishedAt + 1000);
    const beforeRecovery = await preparationRows(f.pool);
    const observation = observeGroupPreparation(f);
    let recoveryTrace;
    try {
      recoveryTrace = await observation.run(f.restart());
      assert.equal(recoveryTrace.claimed, true);
      assert.equal(
        recoveryTrace.publication?.orderId,
        p3.id,
        'Only the exact third publication may be recovered',
      );
      assert.equal(recoveryTrace.permit?.key, row.idempotency_key);
      if (Number(f.sender.attempts.length) !== 2) {
        const current = (await preparationRows(f.pool)).find(
          (r) => r.id === row.id,
        )!;
        await recoverUnsentPreparation({
          pool: f.pool,
          directory: f.directory,
          row: current,
          trace: recoveryTrace,
          senderAttempts: [...f.sender.attempts],
          latestBusinessTime: p3.publishedAt + 960000,
          setTime: f.setTime,
          run: async () => ({
            trace: await observation.run(f.restart()),
            senderAttempts: [...f.sender.attempts],
          }),
          diagnostic: (message) => t.diagnostic(message),
        });
      }
    } finally {
      observation.restore();
    }
    t.diagnostic(
      JSON.stringify({
        phase: 'shortlink-final-recovery',
        expectedOrder: p3.id,
        businessNow: f.runtime.now(),
        before: beforeRecovery,
        after: await preparationRows(f.pool),
        trace: recoveryTrace,
        senderAttempts: f.sender.attempts,
        ledger: (
          await f.pool.query(
            'SELECT * FROM whaleu_notifications.errand_group_attempts ORDER BY delivery_id,fence',
          )
        ).rows,
      }),
    );
    assert.equal(f.sender.attempts.length, 2);
  },
);

test(
  'missing destination coverage, inspection and outside-window claims never emit or backfill',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const p = await publish(f);
    await f.groups.discover();
    assert.equal(await f.groups.runOne(), false);
    f.authority.add(f.scope.related.regionId, 'errand', 'window:one');
    f.authority.unavailable = true;
    await f.groups.discover();
    assert.equal(await f.groups.runOne(), false);
    f.authority.unavailable = false;
    await f.groups.discover();
    const before = JSON.stringify((await f.rows()).rows);
    await f.groups.inspect();
    assert.equal(
      JSON.stringify((await f.rows()).rows),
      before,
      'inspection does not claim, write or send',
    );
    f.setTime(p.publishedAt + 960001);
    assert.equal(await f.groups.runOne(), true);
    assert.equal((await f.rows()).rows[0].status, 'expired');
    assert.equal(f.sender.attempts.length, 0);
    const p2 = await publish(f);
    await f.groups.discover();
    f.setTime(p2.publishedAt + 960000);
    await f.groups.runOne();
    assert.equal(
      f.sender.attempts.length,
      1,
      'inclusive sixteen minute boundary',
    );
    f.authority.add(f.scope.related.regionId, 'forum', 'window:forum');
    f.setTime(p2.publishedAt + 960000 + 1800000);
    await f.groups.discover();
    await f.groups.runOne();
    assert.equal(
      f.sender.attempts.length,
      2,
      'inclusive thirty minutes after first ACK',
    );
  },
);

test(
  'first durable ACK CAS freezes its acceptance time across inverse ACK order and late reconciliation',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const d = destinations(f),
      p = await publish(f);
    await f.groups.discover();
    // Force the original acceptance with lost ACK to happen before the second one.
    await f.pool.query(
      'UPDATE whaleu_notifications.errand_group_deliveries SET next_attempt_at=$2 WHERE destination_id=$1',
      [d.two.id, new Date(p.publishedAt + 60000)],
    );
    f.sender.actions.set(d.one.id, ['lose_ack']);
    await f.groups.runOne();
    await f.pool.query(
      'UPDATE whaleu_notifications.errand_group_deliveries SET next_attempt_at=$2 WHERE destination_id=$1',
      [d.one.id, new Date(p.publishedAt + 120000)],
    );
    f.setTime(p.publishedAt + 60000);
    await f.groups.runOne();
    const frozen = (
      await f.pool.query(
        'SELECT first_confirmed_at,first_confirmed_delivery_id FROM whaleu_notifications.errand_group_publications',
      )
    ).rows[0];
    assert.equal(frozen.first_confirmed_at.getTime(), p.publishedAt + 60000);
    const first = (await f.rows()).rows.find(
      (r) => r.id === frozen.first_confirmed_delivery_id,
    );
    assert.equal(first.destination_id, d.two.id);
    f.setTime(p.publishedAt + 120000);
    await f.restart().runOne();
    const after = (
      await f.pool.query(
        'SELECT first_confirmed_at,first_confirmed_delivery_id FROM whaleu_notifications.errand_group_publications',
      )
    ).rows[0];
    assert.deepEqual(
      after,
      frozen,
      'earlier external ACK does not move an already durable forum anchor',
    );
    const times = (
      await f.pool.query(
        'SELECT confirmed_at FROM whaleu_notifications.errand_group_receipts ORDER BY confirmed_at',
      )
    ).rows.map((r) => r.confirmed_at.getTime());
    assert.deepEqual(times, [p.publishedAt, p.publishedAt + 60000]);
    await assert.rejects(
      f.pool.query(
        'UPDATE whaleu_notifications.errand_group_publications SET first_confirmed_at=$1',
        [new Date(p.publishedAt)],
      ),
    );
    f.setTime(p.publishedAt + 900000);
    await f.groups.discover();
    assert.equal(
      await f.groups.runOne(),
      false,
      'mathematical earliest ACK must not trigger forum early',
    );
    f.setTime(p.publishedAt + 960000);
    await f.groups.discover();
    assert.equal(await f.groups.runOne(), true);
  },
);

test(
  'late first proven ACK records expired forum without backfill; future and impossible ACK timestamps stay unknown',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const one = f.authority.add(f.scope.related.regionId, 'errand', 'late:one');
    f.authority.add(f.scope.related.regionId, 'forum', 'late:forum');
    const p = await publish(f);
    await f.groups.discover();
    f.sender.actions.set(one.id, ['lose_ack']);
    await f.groups.runOne();
    f.setTime(p.publishedAt + 31 * 60000);
    await f.restart().runOne();
    await f.groups.discover();
    const expired = (await f.rows()).rows.find((r) => r.stage === 'forum');
    assert.equal(expired.status, 'expired');
    assert.equal(await f.groups.runOne(), false);
    assert.equal(f.sender.attempts.length, 1);
    // Existing controlled monotonic-clock pattern: expire the original permit
    // in its final proof, without freezing/rewinding time or extending a budget.
    const monotonicNow = performance.now.bind(performance);
    let elapsed = 0,
      expireNext = false;
    t.mock.method(performance, 'now', () => monotonicNow() + elapsed);
    const originalSource = f.source.current.bind(f.source);
    const expirePermit: RequiredTransactionProof<string> = {
      maximumFacts: 1,
      failureCode: 'ERRAND_UNAVAILABLE',
      validate: async () => {
        if (expireNext) {
          elapsed += 101;
          expireNext = false;
        }
      },
    };
    t.mock.method(
      f.source,
      'current',
      async (...args: Parameters<typeof originalSource>) => {
        const payload = await originalSource(...args);
        enableRequiredTransactionProof(args[2], expirePermit);
        registerRequiredTransactionFact(
          args[2],
          expirePermit,
          'expire-malformed-ack',
          'expire-malformed-ack',
        );
        return payload;
      },
    );
    for (const offset of [
      1,
      -1,
      Number.NaN,
      'wrong-key',
      'wrong-destination',
    ] as const) {
      const next = await publish(f);
      await f.groups.discover();
      expireNext = true;
      const { progress } = await returnMalformedAck(f, next, offset);
      assert.ok(progress.attempts >= 2, JSON.stringify(progress));
      t.diagnostic(JSON.stringify(progress));
      const enrolled = (
        await f.pool.query(
          'SELECT * FROM whaleu_notifications.errand_group_publications WHERE order_id=$1',
          [next.id],
        )
      ).rows[0];
      assert.equal(enrolled.first_confirmed_at, null);
      assert.equal(
        (
          await f.pool.query(
            'SELECT status FROM whaleu_notifications.errand_group_deliveries WHERE event_id=$1',
            [enrolled.event_id],
          )
        ).rows[0].status,
        'unknown',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_notifications.errand_group_receipts r JOIN whaleu_notifications.errand_group_deliveries d ON d.id=r.delivery_id WHERE d.event_id=$1',
            [enrolled.event_id],
          )
        ).rowCount,
        0,
      );
      // Keep unresolved cases outside later test scheduling; no blind send occurs.
      await f.pool.query(
        "UPDATE whaleu_notifications.errand_group_deliveries SET next_attempt_at='infinity' WHERE event_id=$1",
        [enrolled.event_id],
      );
    }
  },
);

test(
  'actual Review and Safety deadlines are checked after final waits before any synthetic dispatch',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    f.authority.add(f.scope.related.regionId, 'errand', 'deadline:one');
    const source = f.source.current.bind(f.source);
    const until = new Date(Date.now() + 2500);
    await publish(f, {}, { visibilityUntil: until });
    await f.groups.discover();
    f.source.current = async (...args) => {
      const payload = await source(...args);
      await args[2].query(
        'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)',
        [until],
      );
      return payload;
    };
    await f.groups.runOne();
    f.source.current = source;
    assert.equal(
      f.sender.attempts.length,
      0,
      'ordinary transaction callback result is not itself permission to send',
    );
    const p = await publish(f);
    await f.groups.discover();
    f.sender.beforeReady = async () => {
      await seedErrandFeature(f.pool, p.actor.accountId, [], {
        validUntil: new Date(Date.now() + 500),
      });
    };
    f.source.current = async (...args) => {
      const payload = await source(...args);
      await args[2].query('SELECT pg_sleep(0.6)');
      return payload;
    };
    await f.groups.runOne();
    f.source.current = source;
    f.sender.beforeReady = null;
    assert.equal(f.sender.attempts.length, 0);
    assert.equal(
      (await f.rows()).rows.every((r) => r.status === 'suppressed'),
      true,
    );
  },
);

test(
  'publication replay and rollback cannot duplicate or orphan group enrollment',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const p = await publish(f);
    const replay = await request(f.app.getHttpServer())
      .post('/v1/errands')
      .set('Authorization', `Bearer ${p.actor.accessToken}`)
      .send(p.body);
    assert.equal(replay.body.orderId, p.id);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_publications',
        )
      ).rowCount,
      1,
    );
    const enrollment = f.app.get(ErrandGroupEnrollment),
      original = enrollment.record.bind(enrollment);
    enrollment.record = async (...args) => {
      await original(...args);
      throw Error('Synthetic failure after enrollment');
    };
    await assert.rejects(publish(f));
    enrollment.record = original;
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_publications',
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (await f.pool.query('SELECT 1 FROM whaleu_errands.orders')).rowCount,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM whaleu_errands.transitions WHERE operation='publish'",
        )
      ).rowCount,
      1,
    );
  },
);

test(
  'slow final proof expires process-local permit and bounded preparation cannot emit after timeout',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    f.authority.add(f.scope.related.regionId, 'errand', 'bounded:one');
    const p = await publish(f);
    await f.groups.discover();
    const original = f.source.current.bind(f.source);
    const proof: RequiredTransactionProof<string> = {
      maximumFacts: 1,
      failureCode: 'ERRAND_UNAVAILABLE',
      validate: async () => {
        await new Promise((r) => setTimeout(r, 150));
      },
    };
    f.source.current = async (...args) => {
      const payload = await original(...args);
      enableRequiredTransactionProof(args[2], proof);
      registerRequiredTransactionFact(
        args[2],
        proof,
        'slow-final-proof',
        'slow-final-proof',
      );
      return payload;
    };
    await f.groups.runOne();
    f.source.current = original;
    assert.equal((await f.rows()).rows[0].reason, 'permit_expired');
    assert.equal(f.sender.attempts.length, 0);
    f.setTime(p.publishedAt + 1000);
    let release!: () => void;
    f.sender.beforeReady = () => new Promise<void>((r) => (release = r));
    await f.groups.runOne();
    assert.equal((await f.rows()).rows[0].status, 'retryable');
    assert.equal(f.sender.attempts.length, 0);
    release();
    f.sender.beforeReady = null;
    f.setTime(p.publishedAt + 4000);
    await f.restart().runOne();
    assert.equal(f.sender.attempts.length, 1);
    assert.equal((await f.rows()).rows[0].status, 'confirmed');
  },
);

test(
  'discovery commits bounded per-publication proof budgets: nine regions × sixteen destinations and one unknown scope',
  { timeout: 180000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const extra = Array.from({ length: 7 }, () => randomUUID());
    await withCommunityScopeWriter(f.pool, async (tx) => {
      for (const id of extra)
        await tx.query(
          'INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,$2,true)',
          [id, 'Synthetic delivery region ' + id.slice(0, 8)],
        );
    });
    const topology = {
      ...f.scope.topology,
      regions: [
        ...f.scope.topology.regions,
        ...extra.map((regionId) => ({
          regionId,
          institutionId: f.scope.institutionId,
          groupId: f.scope.topology.regions[0]!.groupId,
          coverage: 'complete' as const,
          isActive: true,
        })),
      ],
    };
    f.scope.topologySnapshotId = await appendTopologyRevision(f.pool, topology);
    f.scope.topology = topology;
    const regions = [
        f.scope.home.regionId,
        f.scope.related.regionId,
        f.scope.foreign.regionId,
        ...extra,
      ],
      unknown = regions[0]!;
    assert.equal(regions.length, 10);
    for (const [r, region] of regions.entries()) {
      for (let n = 0; n < 16; n++)
        f.authority.add(region, 'errand', `batch:${r}:${n}`);
      await publish(f, { targetRegionId: region });
    }
    const resolve = f.authority.destinations.bind(f.authority);
    f.authority.destinations = async (...args) => {
      if (args[0] === unknown)
        throw Error('Synthetic authority coverage unknown');
      return resolve(...args);
    };
    assert.equal(
      await f.groups.discover(),
      144,
      'one unknown scope cannot roll back nine complete sources',
    );
    assert.equal((await f.rows()).rows.length, 144);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_publications WHERE last_scanned_at IS NOT NULL',
        )
      ).rowCount,
      10,
    );
    // Deterministically reproduce the old false assumption that 144 claims
    // imply 144 sends. Advance the monotonic clock only in the last registered
    // final proof, after source checks but before COMMIT/dispatch.
    const monotonicNow = performance.now.bind(performance);
    let elapsed = 0;
    const clock = t.mock.method(
      performance,
      'now',
      () => monotonicNow() + elapsed,
    );
    const original = f.source.current.bind(f.source);
    const expirePermit: RequiredTransactionProof<string> = {
      maximumFacts: 1,
      failureCode: 'ERRAND_UNAVAILABLE',
      validate: async () => {
        elapsed += 101;
      },
    };
    const source = t.mock.method(
      f.source,
      'current',
      async (...args: Parameters<typeof original>) => {
        const payload = await original(...args);
        enableRequiredTransactionProof(args[2], expirePermit);
        registerRequiredTransactionFact(
          args[2],
          expirePermit,
          'expire',
          'expire',
        );
        return payload;
      },
    );
    for (let n = 0; n < 2; n++) assert.equal(await f.groups.runOne(), true);
    source.mock.restore();
    // Retain the monotonic offset until this test ends; never rewind a permit.
    t.after(() => clock.mock.restore());
    const expired = (await f.rows()).rows.filter((r) => r.status !== 'pending');
    assert.equal(expired.length, 2);
    assert.equal(
      f.sender.attempts.length,
      0,
      'expired permits cannot dispatch',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_receipts',
        )
      ).rowCount,
      0,
    );
    for (const row of expired) {
      assert.equal(row.status, 'retryable');
      assert.equal(row.reason, 'permit_expired');
      assert.equal(row.attempts, 1);
      assert.equal(row.next_attempt_at.getTime(), f.runtime.now() + 1000);
    }
    const prepare = f.sender.prepare.bind(f.sender);
    let boundaryKey: string | null = null;
    const sender = t.mock.method(
      f.sender,
      'prepare',
      async (...args: Parameters<typeof prepare>) => {
        const prepared = await prepare(...args);
        return {
          ...prepared,
          dispatch(permit: Parameters<typeof prepared.dispatch>[0]) {
            if (boundaryKey === null) {
              boundaryKey = permit.key;
              // The worker has passed its clock check, but the sender can still
              // observe expiry before acceptance. Preserve that unknown result.
              elapsed += Math.max(0, permit.expiresAt - performance.now());
            }
            return prepared.dispatch(permit);
          },
        };
      },
    );
    for (let n = 2; n < 144; n++) assert.equal(await f.groups.runOne(), true);
    sender.mock.restore();
    assert.equal(await f.groups.runOne(), false);
    // The frozen business clock cannot claim either scheduled retry yet.
    const firstPass = (await f.rows()).rows;
    assert.ok(boundaryKey);
    const boundary = firstPass.find((r) => r.idempotency_key === boundaryKey)!;
    assert.equal(boundary.status, 'unknown');
    assert.equal(boundary.attempts, 1);
    assert.equal(boundary.reconciliations, 0);
    assert.equal(firstPass.filter((r) => r.status === 'pending').length, 0);
    assert.equal(
      f.sender.attempts.length,
      firstPass.filter((r) => r.status === 'confirmed').length,
    );
    for (const row of expired) {
      const current = firstPass.find((r) => r.id === row.id)!;
      assert.equal(current.status, 'retryable');
      assert.equal(current.attempts, 1);
    }
    await confirmDiscoveredGroups(f, 144);
    assert.equal(f.sender.attempts.length, 144);
    assert.equal(new Set(f.sender.attempts.map((p) => p.key)).size, 144);
    assert.equal(
      new Set(f.sender.attempts.map((p) => p.destination.id)).size,
      144,
    );
    assert.deepEqual(
      f.sender.attempts.map((p) => p.destination.id).sort(),
      [...f.authority.groups.values()]
        .filter((d) => d.targetRegionId !== unknown)
        .map((d) => d.id)
        .sort(),
    );
    assert.equal(
      (await f.rows()).rows.every((r) => r.status === 'confirmed'),
      true,
    );
    assert.equal(
      new Set(f.sender.attempts.map((p) => p.destination.targetRegionId)).size,
      9,
    );
    assert.equal(
      f.sender.attempts.some((p) => p.destination.targetRegionId === unknown),
      false,
    );
    f.authority.destinations = resolve;
    await f.groups.discover();
    assert.equal(
      (await f.rows()).rows.length,
      160,
      'recovered exact scope is neither truncated nor duplicated',
    );
    await confirmDiscoveredGroups(f, 160, f.restart());
    assert.equal(f.sender.attempts.length, 160);
    assert.equal(new Set(f.sender.attempts.map((p) => p.key)).size, 160);
    assert.equal(
      new Set(f.sender.attempts.map((p) => p.destination.id)).size,
      160,
    );
    assert.deepEqual(
      f.sender.attempts.map((p) => p.destination.id).sort(),
      [...f.authority.groups.keys()].sort(),
    );
    assert.equal(
      (await f.rows()).rows.every((r) => r.status === 'confirmed'),
      true,
    );
  },
);

test(
  'sender permit boundary after the worker check stays unknown until same-key reconciliation proves no acceptance',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    f.authority.add(
      f.scope.related.regionId,
      'errand',
      'dispatch-boundary:one',
    );
    await publish(f);
    await f.groups.discover();
    let monotonic = 1000;
    t.mock.method(performance, 'now', () => monotonic);
    const prepare = f.sender.prepare.bind(f.sender);
    let expiryInjected = false;
    t.mock.method(
      f.sender,
      'prepare',
      async (...args: Parameters<typeof prepare>) => {
        const prepared = await prepare(...args);
        return {
          ...prepared,
          dispatch(permit: Parameters<typeof prepared.dispatch>[0]) {
            assert.equal(permit.key, prepared.key);
            assert.equal(permit.destination.id, prepared.destinationId);
            if (!expiryInjected) {
              assert.ok(
                monotonic < permit.expiresAt,
                'worker passed a live permit',
              );
              monotonic = permit.expiresAt;
              expiryInjected = true;
            }
            return prepared.dispatch(permit);
          },
        };
      },
    );
    const current = f.source.current.bind(f.source);
    let sourceReads = 0;
    t.mock.method(
      f.source,
      'current',
      async (...args: Parameters<typeof current>) => {
        sourceReads++;
        return current(...args);
      },
    );
    assert.equal(await f.groups.runOne(), true);
    let row = (await f.rows()).rows[0]!;
    assert.equal(expiryInjected, true);
    assert.equal(row.status, 'unknown');
    assert.equal(row.reason, 'unknown');
    assert.equal(row.attempts, 1);
    assert.equal(row.reconciliations, 0);
    assert.equal(f.sender.attempts.length, 0);
    assert.equal(sourceReads, 1);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_receipts',
        )
      ).rowCount,
      0,
    );
    t.diagnostic(
      JSON.stringify({
        phase: 'post-dispatch-boundary',
        row,
        dispatches: f.sender.attempts.length,
        sourceReads,
      }),
    );
    f.sender.unresolved = true;
    await assert.rejects(confirmDiscoveredGroups(f, 1), /unknown/);
    row = (await f.rows()).rows[0]!;
    assert.equal(row.status, 'unknown');
    assert.equal(row.reconciliations, 1);
    assert.equal(f.sender.attempts.length, 0);
    assert.equal(
      sourceReads,
      1,
      'unresolved outcome cannot fresh-authorize a resend',
    );
    f.sender.unresolved = false;
    await confirmDiscoveredGroups(f, 1, f.restart());
    row = (await f.rows()).rows[0]!;
    assert.equal(row.status, 'confirmed');
    assert.equal(row.attempts, 4);
    assert.equal(row.reconciliations, 2);
    assert.deepEqual(f.sender.reconciled, [
      row.idempotency_key,
      row.idempotency_key,
    ]);
    assert.equal(
      sourceReads,
      2,
      'confirmed negative evidence permits only a fresh source authorization',
    );
    assert.equal(f.sender.attempts.length, 1);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_notifications.errand_group_receipts',
        )
      ).rowCount,
      1,
    );
    t.diagnostic(
      JSON.stringify({
        phase: 'confirmed-after-proven-negative',
        row,
        dispatches: f.sender.attempts.length,
        sourceReads,
      }),
    );
  },
);

test(
  'preparation recovery proves one unsent expiry and rejects actual unknown/not-accepted sends',
  { timeout: 120000 },
  async (t) => {
    const f = await errandGroupFixture();
    t.after(() => f.close());
    const destination = f.authority.add(
      f.scope.related.regionId,
      'errand',
      'preparation:expired',
    );
    const p = await publish(f);
    await f.groups.discover();
    const source = f.source.current.bind(f.source);
    let delayOnce = true;
    const slowProof: RequiredTransactionProof<string> = {
      maximumFacts: 1,
      failureCode: 'ERRAND_UNAVAILABLE',
      validate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      },
    };
    f.source.current = async (...args) => {
      const payload = await source(...args);
      if (delayOnce) {
        delayOnce = false;
        enableRequiredTransactionProof(args[2], slowProof);
        registerRequiredTransactionFact(
          args[2],
          slowProof,
          'controlled-expiry',
          'controlled-expiry',
        );
      }
      return payload;
    };
    const observation = observeGroupPreparation(f);
    try {
      const trace = await observation.run(f.groups);
      const row = (await preparationRows(f.pool))[0]!;
      assert.equal(row.destination_id, destination.id);
      assert.equal(row.reason, 'permit_expired');
      assert.equal(f.sender.attempts.length, 0);
      await recoverUnsentPreparation({
        pool: f.pool,
        directory: f.directory,
        row,
        trace,
        senderAttempts: [...f.sender.attempts],
        latestBusinessTime: p.publishedAt + 960000,
        setTime: f.setTime,
        run: async () => ({
          trace: await observation.run(f.restart()),
          senderAttempts: [...f.sender.attempts],
        }),
        diagnostic: (message) => t.diagnostic(message),
      });
      assert.equal(f.sender.attempts.length, 1);
      for (const action of ['not_accepted', 'unknown'] as const) {
        const denied = f.authority.add(
          f.scope.related.regionId,
          'errand',
          `preparation:${action}`,
        );
        f.sender.actions.set(denied.id, [action]);
        await f.groups.discover();
        const deniedTrace = await observation.run(f.groups);
        const deniedRow = (await preparationRows(f.pool)).find(
          (r) => r.destination_id === denied.id,
        )!;
        assert.equal(deniedRow.reason, action);
        assert.equal(deniedTrace.dispatches, 1);
        let reran = false;
        const before = await preparationRows(f.pool);
        await assert.rejects(
          recoverUnsentPreparation({
            pool: f.pool,
            directory: f.directory,
            row: deniedRow,
            trace: deniedTrace,
            senderAttempts: [...f.sender.attempts],
            latestBusinessTime: p.publishedAt + 960000,
            setTime: f.setTime,
            run: async () => {
              reran = true;
              throw Error('Forbidden recovery');
            },
            diagnostic: (message) => t.diagnostic(message),
          }),
          /Unsent preparation expiry/,
        );
        assert.equal(reran, false);
        assert.deepEqual(await preparationRows(f.pool), before);
        assert.equal(
          f.sender.attempts.filter(
            (value) => value.key === deniedRow.idempotency_key,
          ).length,
          1,
        );
      }
    } finally {
      observation.restore();
      f.source.current = source;
    }
  },
);
