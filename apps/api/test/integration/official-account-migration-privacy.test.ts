import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { officialAccountFixture } from '../support/official-account-fixture.js';
import { restoreOfficialFixture } from '../support/official-account-restore.js';
import { OfficialDailyEnrollment } from '../../src/official-account-operations/schedule.js';
import { OfficialOperationWorker } from '../../src/official-account-operations/worker.js';
import type { OfficialSyntheticProvider } from '../../src/official-account-operations/provider.js';
import {
  OfficialCallbackBoundary,
  OfficialCallbackProjectionWorker,
  createSyntheticCallbackRuntimeForTest,
  registerSyntheticCallbackFixture,
} from '../../src/official-account-operations/callback-ledger.js';
import {
  canonicalCallbackBody,
  syntheticCallbackSignature,
} from '../../src/official-account-operations/callback-auth.js';
import type { SyntheticCallbackEnvelope } from '../../src/official-account-operations/callback-auth.js';
import type { Pool } from 'pg';
import { OfficialDraftCoverageMaintainer } from '../../src/official-account-operations/coverage.js';
import { OfficialSourceSelector } from '../../src/official-account-operations/selection.js';
import { boundHotTransaction } from '../../src/community/hot-score/transaction.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { observeExactQueries } from '../support/exact-discovery-counts.js';

type RestoredFixture = Awaited<ReturnType<typeof restoreOfficialFixture>>;
interface CapturedCause {
  id: string;
  kind: 'source' | 'dependency';
  space_id: string | null;
  post_id: string | null;
  dependency_kind: string | null;
  target_id: string | null;
  owner_table: string;
  source_xid: string;
  source_domain: string;
}
const causeColumns =
  'id,kind,space_id,post_id,dependency_kind,target_id,owner_table,source_xid::text,source_domain';
const pending = async (pool: Pool) =>
  (
    await pool.query<CapturedCause>(
      `SELECT ${causeColumns} FROM whaleu_official.pending_causes ORDER BY id`,
    )
  ).rows;
const captureDomain = async (pool: Pool) => {
  const row = (
    await pool.query<{ system: string; started: string; domain: string }>(
      `SELECT system_identifier::text system,extract(epoch FROM pg_postmaster_start_time())::text started,whaleu_official.current_capture_domain() domain FROM pg_control_system()`,
    )
  ).rows[0]!;
  assert.equal(row.domain, `${row.system}/${row.started}`);
  return row;
};
const baseline = async (pool: Pool, space: string) =>
  (
    await pool.query(
      'SELECT baseline_highwater,baseline_cursor,baseline_snapshot::text,baseline_capture_domain,baseline_started,baseline_exhausted FROM whaleu_official.source_roots WHERE space_id=$1',
      [space],
    )
  ).rows[0]!;

async function maintainToReady(restored: RestoredFixture, programId: string) {
  const maintainer = new OfficialDraftCoverageMaintainer(
    restored.database,
    restored.source,
  );
  for (let cycle = 0; cycle < 32; cycle++) {
    const result = await maintainer.runCycle({ programId });
    assert.ok(result.examined <= 128);
    assert.notEqual(result.state, 'unavailable', JSON.stringify(result));
    if (result.state === 'ready') return;
  }
  assert.fail('Restored/restarted real maintenance must converge');
}

/** Observe real owner reads and inbox fences, without relabelling stored xids,
 * seeding a snapshot, resetting coverage, or creating another large fixture. */
async function verifyChangedCaptureDomain(
  restored: RestoredFixture,
  original: Awaited<ReturnType<typeof officialAccountFixture>>,
  older: string,
  newer: string,
  oldPending: CapturedCause[],
) {
  const space = original.world.scope.home.spaceId,
    domain = (await captureDomain(restored.pool)).domain;
  assert.ok(oldPending.length > 0);
  assert.ok(oldPending.every((cause) => cause.source_domain !== domain));
  assert.deepEqual(await pending(restored.pool), oldPending);
  const fixedBaseline = await baseline(restored.pool, space);
  assert.equal(fixedBaseline.baseline_started, true);
  assert.notEqual(fixedBaseline.baseline_capture_domain, domain);
  const selector = new OfficialSourceSelector(restored.source);
  const select = (tx: Parameters<typeof selector.select>[1]) =>
    selector.select(
      {
        schoolSpaceId: space,
        citySpaceId: null,
        kind: 'manual_newest',
        limit: 1,
      },
      tx,
    );
  const manual = () =>
    restored.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        return select(tx);
      },
      { isolationLevel: 'read committed' },
    );
  assert.deepEqual(
    (await manual()).facts.map((fact) => fact.postId),
    [newer],
  );
  assert.deepEqual(
    await pending(restored.pool),
    oldPending,
    'Manual old-domain reads must not consume or relabel restored backlog',
  );

  // A newly committed cause in the current real domain must still invalidate an
  // already-captured manual snapshot, for both source and dependency writers.
  for (const kind of ['source', 'dependency'] as const) {
    const writer = await restored.pool.connect();
    let committed = false;
    try {
      await writer.query('BEGIN');
      const xid = (
        await writer.query<{ xid: string }>(
          'SELECT pg_current_xact_id()::text xid',
        )
      ).rows[0]!.xid;
      await writer.query(
        kind === 'source'
          ? 'UPDATE whaleu_community.posts SET visibility=visibility WHERE id=$1'
          : 'UPDATE whaleu_identity.accounts SET id=id WHERE id=$1',
        [kind === 'source' ? older : original.world.reader.accountId],
      );
      await assert.rejects(
        restored.database.transaction(
          async (tx) => {
            await boundHotTransaction(tx);
            assert.deepEqual(
              (await select(tx)).facts.map((fact) => fact.postId),
              [newer],
            );
            await writer.query('COMMIT');
            committed = true;
          },
          { isolationLevel: 'read committed' },
        ),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.code === 'OFFICIAL_SOURCE_UNAVAILABLE',
      );
      assert.equal(committed, true);
      assert.ok(
        (await pending(restored.pool)).some(
          (cause) =>
            cause.kind === kind &&
            cause.source_xid === xid &&
            cause.source_domain === domain,
        ),
      );
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  }
  assert.deepEqual(
    (await manual()).facts.map((fact) => fact.postId),
    [newer],
  );
  const expected = await pending(restored.pool);
  assert.ok(expected.some((cause) => cause.source_domain === domain));
  const observer = observeExactQueries(restored.app);
  let unsafeSnapshotQueries = 0;
  const dependencyTargets = new Set<string>();
  observer.setHook(async ({ sql, values }) => {
    if (
      sql.includes('pg_visible_in_snapshot') &&
      sql.includes('whaleu_official.dependency_events')
    )
      unsafeSnapshotQueries++;
    if (
      sql.includes(
        'SELECT id post_id FROM whaleu_community.posts WHERE space_id=$1 AND account_id=$3',
      )
    )
      dependencyTargets.add(String(values[2]));
  });
  try {
    await maintainToReady(restored, original.programId);
    assert.equal(
      unsafeSnapshotQueries,
      0,
      'An old-domain baseline must never classify current-cluster xids',
    );
    assert.ok(
      dependencyTargets.has(original.world.author.accountId),
      'Old-domain author dependencies must execute their real reverse lookup',
    );
  } finally {
    observer.restore();
  }
  assert.deepEqual(
    await baseline(restored.pool, space),
    fixedBaseline,
    'Restore/restart must not reset or relabel the durable finite baseline',
  );
  assert.deepEqual(await pending(restored.pool), []);
  const ids = expected.map((cause) => cause.id);
  assert.deepEqual(
    (
      await restored.pool.query<CapturedCause>(
        `SELECT ${causeColumns} FROM whaleu_official.cause_conversions WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [ids],
      )
    ).rows,
    expected,
    'Every old and new cause must retain its exact domain/xid identity',
  );
  const events = (
    await restored.pool.query<{ id: string; exact: boolean }>(
      `SELECT c.id,CASE WHEN c.kind='source' THEN EXISTS(SELECT 1 FROM whaleu_official.source_events e WHERE e.space_id=c.space_id AND e.sequence=c.sequence AND e.post_id=c.post_id AND e.owner_table=c.owner_table AND e.source_xid=c.source_xid AND e.source_domain=c.source_domain) ELSE EXISTS(SELECT 1 FROM whaleu_official.dependency_events e WHERE e.sequence=c.sequence AND e.kind=c.dependency_kind AND e.target_id=c.target_id AND e.owner_table=c.owner_table AND e.source_xid=c.source_xid AND e.source_domain=c.source_domain) END exact FROM whaleu_official.cause_conversions c WHERE c.id=ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  assert.equal(events.length, expected.length);
  assert.ok(events.every((event) => event.exact));
}

test(
  'preview allowlist omits identities and payload erasure retains immutable receipt/effect tombstones',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      await f.publish('A synthetic public excerpt.');
      const preview = await f.service.preview(
        f.world.author.accessToken,
        { programId: f.programId, expectedConfigRevision: f.revision },
        true,
      );
      assert.doesNotMatch(
        JSON.stringify(preview),
        /"(?:nickname|avatar|studentId|phone|unionSubject|officialSubject|ownerId|actorId|score|source_request_id)"/,
      );
      const intent = {
        requestId: randomUUID(),
        programId: f.programId,
        previewId: preview.previewId,
        manifestHash: preview.manifestHash,
        expectedConfigRevision: f.revision,
        acknowledgement: 'synthetic_draft_only',
      };
      const admitted = await f.service.createDraft(
        f.world.author.accessToken,
        intent,
        true,
      );
      await f.worker.runCycle();
      await f.database.transaction((tx) => f.runtime.payloads.purge(tx));
      const payloads = (
        await f.pool.query(
          'SELECT ciphertext,nonce,tag,purged_at FROM whaleu_official.payloads WHERE command_id=(SELECT id FROM whaleu_official.commands WHERE actor_ref=$1 AND request_id=$2)',
          [f.world.author.accountId, intent.requestId],
        )
      ).rows;
      assert.ok(payloads.length);
      assert.ok(
        payloads.every(
          (p) =>
            p.ciphertext === null &&
            p.nonce === null &&
            p.tag === null &&
            p.purged_at,
        ),
      );
      const recovered = await f.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (recovered.state !== 'recorded') throw Error('No receipt');
      assert.deepEqual(recovered.receipt, admitted.receipt);
      await assert.rejects(() =>
        f.pool.query(
          'DELETE FROM whaleu_official.commands WHERE actor_ref=$1 AND request_id=$2',
          [f.world.author.accountId, intent.requestId],
        ),
      );
      await assert.rejects(() =>
        f.pool.query('TRUNCATE whaleu_official.evidence'),
      );
      // New fresh publication confirmation reconstructs current readable literal
      // fields and frozen counts, rather than retaining old article plaintext.
      assert.ok(recovered.status.draftRef);
      const confirmation = await f.service.publishPreview(
        f.world.author.accessToken,
        { draftRef: recovered.status.draftRef },
      );
      assert.equal(confirmation.manifestHash, preview.manifestHash);
    } finally {
      await f.close();
    }
  },
);

test(
  'coherent isolated database and adapter restore retains original effects, slots and callback revocation',
  { timeout: 480000 },
  async () => {
    const f = await officialAccountFixture();
    let restored:
      Awaited<ReturnType<typeof restoreOfficialFixture>> | undefined;
    try {
      await f.ready();
      const due = new Date();
      due.setUTCHours(0, 0, 0, 0);
      const slot = await new OfficialDailyEnrollment(f.service, () =>
        due.getTime(),
      ).admitDueSlot(f.programId, due.toISOString());
      assert.equal(slot.state, 'no_eligible_content');
      const preview = await f.service.preview(f.world.author.accessToken, {
        programId: f.programId,
        kind: 'test',
        expectedConfigRevision: f.revision,
      });
      const intent = {
        requestId: randomUUID(),
        programId: f.programId,
        previewId: preview.previewId,
        manifestHash: preview.manifestHash,
        expectedConfigRevision: f.revision,
        acknowledgement: 'synthetic_draft_only',
      };
      const admitted = await f.service.createDraft(
        f.world.author.accessToken,
        intent,
      );
      const base = f.runtime.provider;
      const lost: OfficialSyntheticProvider = {
        profile: base.profile,
        arm: base.arm.bind(base),
        verify: base.verify.bind(base),
        reconcile: base.reconcile.bind(base),
        contentHash: base.contentHash.bind(base),
        prepare: async (...args) => {
          const prepared = await base.prepare(...args);
          return {
            ...prepared,
            dispatch: (permit) => {
              prepared.dispatch(permit);
              throw new Error(
                'Synthetic acceptance ACK lost before fixture snapshot',
              );
            },
          };
        },
      };
      Object.defineProperty(f.runtime, 'provider', { value: lost });
      await f.worker.runCycle();
      const before = await f.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (before.state !== 'recorded')
        throw new Error('Missing original receipt');
      assert.equal(before.status.state, 'dispatch_unknown');
      await f.service.cancel(f.world.author.accessToken, intent.requestId, {
        intent,
      });
      const callbackRuntime = createSyntheticCallbackRuntimeForTest(),
        registrationId = randomUUID();
      await registerSyntheticCallbackFixture(f.database, callbackRuntime, {
        accountRef: f.accountRef,
        registrationId,
        miniAppRef: randomUUID(),
        unionNamespace: randomUUID(),
        revision: 'a'.repeat(64),
        epochs: [
          {
            epoch: 1,
            validFrom: Date.now() - 10000,
            expiresAt: Date.now() + 600000,
          },
        ],
      });
      const event: SyntheticCallbackEnvelope = {
        profile: 'synthetic-official-v1',
        accountRef: f.accountRef,
        keyEpoch: 1,
        eventId: randomUUID(),
        officialSubject: `synthetic:official:${randomUUID()}`,
        kind: 'unsubscribe',
        sequence: 2,
        occurredAt: Date.now() - 1000,
        issuedAt: Date.now(),
      };
      const send = (boundary: OfficialCallbackBoundary) => {
        const current = { ...event, issuedAt: Date.now() },
          rawBody = canonicalCallbackBody(current);
        return boundary.receive(registrationId, {
          rawBody,
          contentType: 'application/json',
          signature: syntheticCallbackSignature(
            'POST',
            registrationId,
            rawBody,
            1,
          ),
        });
      };
      await send(new OfficialCallbackBoundary(f.database, callbackRuntime));
      await new OfficialCallbackProjectionWorker(
        f.database,
        callbackRuntime,
      ).runOnce();
      // Keep a tiny, committed source/dependency backlog across the real dump.
      // The original no-content slot and synthetic effect assertions stay intact.
      const older = await f.publish('Restored older source'),
        newer = await f.publish('Restored newest source'),
        space = f.world.scope.home.spaceId;
      await f.pool.query(
        'UPDATE whaleu_identity.accounts SET id=id WHERE id=$1',
        [f.world.author.accountId],
      );
      const originalDomain = await captureDomain(f.pool),
        originalBaseline = await baseline(f.pool, space),
        originalPending = await pending(f.pool);
      assert.equal(
        originalBaseline.baseline_capture_domain,
        originalDomain.domain,
      );
      assert.ok(originalPending.some((cause) => cause.kind === 'source'));
      assert.ok(originalPending.some((cause) => cause.kind === 'dependency'));
      assert.ok(
        originalPending.every(
          (cause) => cause.source_domain === originalDomain.domain,
        ),
      );
      // No writer/worker is running across the complete DB snapshot and adapter copy.
      restored = await restoreOfficialFixture(f);
      const restoredDomain = await captureDomain(restored.pool);
      assert.notEqual(restoredDomain.system, originalDomain.system);
      assert.notEqual(restoredDomain.domain, originalDomain.domain);
      assert.deepEqual(await baseline(restored.pool, space), originalBaseline);
      assert.deepEqual(await pending(restored.pool), originalPending);
      const recovered = await restored.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (recovered.state !== 'recorded')
        throw new Error('Restore lost original receipt');
      assert.deepEqual(recovered.receipt, admitted.receipt);
      assert.equal(recovered.status.state, 'dispatch_unknown');
      assert.equal(recovered.status.cancelRequested, true);
      assert.deepEqual(
        (await restored.service.createDraft(f.world.author.accessToken, intent))
          .receipt,
        admitted.receipt,
      );
      const restoredSlot = await new OfficialDailyEnrollment(
        restored.service,
        () => due.getTime(),
      ).admitDueSlot(f.programId, due.toISOString());
      assert.deepEqual(restoredSlot, slot);
      const newCallbackRuntime = createSyntheticCallbackRuntimeForTest();
      assert.equal(
        (
          await send(
            new OfficialCallbackBoundary(restored.database, newCallbackRuntime),
          )
        ).status,
        200,
      );
      assert.equal(
        await new OfficialCallbackProjectionWorker(
          restored.database,
          newCallbackRuntime,
        ).runOnce(),
        0,
      );
      const follow = (
        await restored.pool.query(
          'SELECT state FROM whaleu_official_callbacks.follow WHERE account_ref=$1 AND official_subject=$2',
          [f.accountRef, event.officialSubject],
        )
      ).rows[0]!;
      assert.equal(follow.state, 'unfollowed');
      assert.equal(
        (
          await restored.pool.query(
            'SELECT count(*)::int n FROM whaleu_official_callbacks.jobs',
          )
        ).rows[0]!.n,
        1,
      );
      await new Promise((resolve) => setTimeout(resolve, 5100));
      const result = await new OfficialOperationWorker(
        restored.service,
      ).runCycle();
      assert.equal(result.dispatched, 0);
      const confirmed = await restored.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (confirmed.state !== 'recorded')
        throw new Error('Reconcile lost original receipt');
      assert.equal(confirmed.status.state, 'draft_confirmed');
      assert.equal(
        (
          await restored.pool.query(
            'SELECT count(*)::int n FROM whaleu_official.attempts',
          )
        ).rows[0]!.n,
        1,
      );
      assert.equal(
        (
          await restored.pool.query(
            'SELECT count(*)::int n FROM whaleu_official.effects',
          )
        ).rows[0]!.n,
        1,
      );
      assert.equal(
        (
          await restored.pool.query(
            'SELECT count(*)::int n FROM whaleu_official.slots',
          )
        ).rows[0]!.n,
        1,
      );
      await verifyChangedCaptureDomain(
        restored,
        f,
        older.id,
        newer.id,
        originalPending,
      );
      // A new, actually enrolled empty space obtains its baseline in this
      // secondary cluster. The older restored baseline cannot prove a same-system
      // restart boundary, because it was already foreign before the restart.
      const restartProgram = randomUUID(),
        restartSpace = f.world.scope.related.spaceId;
      assert.equal(
        (
          await restored.pool.query(
            'SELECT count(*)::int n FROM whaleu_community.posts WHERE space_id=$1',
            [restartSpace],
          )
        ).rows[0]!.n,
        0,
      );
      assert.equal(
        (
          await restored.pool.query(
            'SELECT 1 FROM whaleu_official.enrolled_spaces WHERE space_id=$1',
            [restartSpace],
          )
        ).rowCount,
        0,
      );
      await restored.database.transaction(
        async (tx) => {
          await tx.query(
            'INSERT INTO whaleu_official.programs(id,account_ref,institution_id,school_space_id,region_ids,lineage_ref,revision) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              restartProgram,
              f.accountRef,
              f.world.scope.institutionId,
              restartSpace,
              [f.world.scope.related.regionId],
              randomUUID(),
              f.revision,
            ],
          );
        },
        { isolationLevel: 'read committed' },
      );
      assert.equal(
        (await baseline(restored.pool, restartSpace)).baseline_started,
        false,
      );
      await maintainToReady(restored, restartProgram);
      const restartBaseline = await baseline(restored.pool, restartSpace);
      assert.equal(
        restartBaseline.baseline_capture_domain,
        restoredDomain.domain,
      );
      assert.equal(restartBaseline.baseline_started, true);
      assert.equal(restartBaseline.baseline_exhausted, true);
      await restored.pool.query(
        'UPDATE whaleu_community.spaces SET name=name WHERE id=$1',
        [restartSpace],
      );
      await restored.pool.query(
        'UPDATE whaleu_community.posts SET visibility=visibility WHERE id=$1',
        [older.id],
      );
      await restored.pool.query(
        'UPDATE whaleu_identity.accounts SET id=id WHERE id=$1',
        [f.world.author.accountId],
      );
      const beforeRestart = await pending(restored.pool);
      assert.ok(
        beforeRestart.some(
          (cause) =>
            cause.kind === 'dependency' &&
            cause.dependency_kind === 'space' &&
            cause.target_id === restartSpace,
        ),
      );
      assert.ok(
        beforeRestart.every(
          (cause) => cause.source_domain === restoredDomain.domain,
        ),
      );
      await restored.restart();
      const restartedDomain = await captureDomain(restored.pool);
      assert.equal(restartedDomain.system, restoredDomain.system);
      assert.notEqual(restartedDomain.started, restoredDomain.started);
      assert.notEqual(restartedDomain.domain, restoredDomain.domain);
      assert.deepEqual(await baseline(restored.pool, space), originalBaseline);
      await verifyChangedCaptureDomain(
        restored,
        f,
        older.id,
        newer.id,
        beforeRestart,
      );
      assert.deepEqual(
        await baseline(restored.pool, restartSpace),
        restartBaseline,
      );
      assert.notEqual(
        restartBaseline.baseline_capture_domain,
        restartedDomain.domain,
      );
      const restartObserver = observeExactQueries(restored.app);
      let restartedSnapshotQueries = 0,
        emptySpaceLookups = 0;
      restartObserver.setHook(async ({ sql, values, rows }) => {
        if (
          sql.includes('pg_visible_in_snapshot') &&
          sql.includes('whaleu_official.dependency_events')
        )
          restartedSnapshotQueries++;
        if (
          sql.includes(
            'SELECT id post_id FROM whaleu_community.posts WHERE space_id=$1 AND $1::uuid=$3',
          ) &&
          values[0] === restartSpace &&
          values[2] === restartSpace
        ) {
          assert.equal(rows, 0);
          emptySpaceLookups++;
        }
      });
      try {
        await maintainToReady(restored, restartProgram);
        assert.equal(
          restartedSnapshotQueries,
          0,
          'The same system_identifier with a new postmaster must not reuse its pre-restart snapshot',
        );
        assert.ok(
          emptySpaceLookups > 0,
          'The retained space dependency must execute its real, empty reverse lookup',
        );
      } finally {
        restartObserver.restore();
      }
      assert.deepEqual(
        await baseline(restored.pool, restartSpace),
        restartBaseline,
      );
      assert.deepEqual(await baseline(restored.pool, space), originalBaseline);
      const afterRestart = await restored.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (afterRestart.state !== 'recorded')
        throw new Error('Restart lost original receipt');
      assert.deepEqual(afterRestart.receipt, admitted.receipt);
      assert.equal(afterRestart.status.state, 'draft_confirmed');
    } finally {
      try {
        await restored?.close();
      } finally {
        await f.close();
      }
    }
  },
);
