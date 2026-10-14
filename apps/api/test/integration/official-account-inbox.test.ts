import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { inTransaction } from '../../src/database/database.js';
import { boundHotTransaction } from '../../src/community/hot-score/transaction.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { ExperienceClock } from '../../src/experience/repository.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import {
  captureOfficialRoots,
  OfficialDraftCoverageMaintainer,
} from '../../src/official-account-operations/coverage.js';
import { drainOfficialCauses } from '../../src/official-account-operations/inbox.js';
import { hotFeedFixture } from '../support/hot-feed-fixture.js';
import { officialAccountFixture } from '../support/official-account-fixture.js';
import { vacuumFixtureRelations } from '../support/vacuum-fixture-relations.js';

const sqlCode = (code: string) => (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;

type OfficialFixture = Awaited<ReturnType<typeof officialAccountFixture>>;

/** Every producer keeps its real transaction open through the barrier. Failed
 * connects/queries settle before cleanup; no rejected Promise leaves a writer
 * holding a lock while the fixture tries to drop its schemas. */
async function withWriters<T>(
  work: (connect: () => Promise<PoolClient>) => Promise<T>,
): Promise<T> {
  const writers = new Pool({
    connectionString: process.env['TEST_DATABASE_URL'],
    max: 70,
    connectionTimeoutMillis: 3000,
    statement_timeout: 3000,
    idle_in_transaction_session_timeout: 10000,
  });
  const clients: PoolClient[] = [],
    errors: Error[] = [];
  writers.on('error', (error) => errors.push(error));
  try {
    const result = await work(async () => {
      const client = await writers.connect();
      clients.push(client);
      client.on('error', (error) => errors.push(error));
      return client;
    });
    assert.deepEqual(errors, [], 'No producer connection may expire or fail');
    return result;
  } finally {
    await Promise.allSettled(
      clients.map(async (client) => {
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release(true);
        }
      }),
    );
    await writers.end();
  }
}

async function allSucceeded<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results.map((result) => {
    assert.equal(result.status, 'fulfilled');
    return (result as PromiseFulfilledResult<T>).value;
  });
}

async function officialInventory(pool: Pool, exclude: string[] = []) {
  const tables = (
    await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='whaleu_official' ORDER BY tablename",
    )
  ).rows;
  const inventory: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    if (exclude.includes(tablename)) continue;
    assert.match(tablename, /^[a-z_]+$/);
    inventory[tablename] = (
      await pool.query<{ rows: unknown }>(
        `SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) rows FROM whaleu_official.${tablename} r`,
      )
    ).rows[0]!.rows;
  }
  return inventory;
}

const insertPost = (
  tx: Pick<PoolClient, 'query'>,
  postId: string,
  spaceId: string,
  accountId: string,
) =>
  tx.query(
    `INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy)
     VALUES($1,$2,$3,'discussion','Official writer barrier','named','open')`,
    [postId, spaceId, accountId],
  );

async function sourceWriters(
  pool: Pool,
  spaceId: string,
  accountId: string,
  enrolled: boolean,
) {
  const before = await officialInventory(pool, ['pending_causes']);
  const ids = Array.from({ length: 65 }, () => randomUUID());
  await withWriters(async (connect) => {
    const clients = await allSucceeded(
      ids.map(async (id) => {
        const client = await connect();
        await client.query('BEGIN');
        await insertPost(client, id, spaceId, accountId);
        const pending = (
          await client.query<{ n: number }>(
            "SELECT count(*)::integer n FROM whaleu_official.pending_causes WHERE kind='source' AND space_id=$1 AND post_id=$2 AND source_xid=pg_current_xact_id()",
            [spaceId, id],
          )
        ).rows[0]!.n;
        assert.equal(pending, enrolled ? 1 : 0);
        return client;
      }),
    );
    assert.equal(clients.length, 65);
    assert.equal(
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::integer n FROM whaleu_community.posts WHERE id=ANY($1::uuid[])',
          [ids],
        )
      ).rows[0]!.n,
      0,
      'All 65 actual INSERTs finish before the first transaction commits',
    );
    await allSucceeded(clients.map((client) => client.query('COMMIT')));
  });
  assert.equal(
    (
      await pool.query<{ n: number }>(
        'SELECT count(*)::integer n FROM whaleu_community.posts WHERE id=ANY($1::uuid[])',
        [ids],
      )
    ).rows[0]!.n,
    65,
  );
  assert.deepEqual(await officialInventory(pool, ['pending_causes']), before);
  const pending = (
    await pool.query<{ post_id: string; source_xid: string }>(
      "SELECT post_id,source_xid::text FROM whaleu_official.pending_causes WHERE kind='source' AND post_id=ANY($1::uuid[]) ORDER BY post_id",
      [ids],
    )
  ).rows;
  assert.deepEqual(
    pending.map((row) => row.post_id),
    enrolled ? [...ids].sort() : [],
  );
  assert.equal(
    new Set(pending.map((row) => row.source_xid)).size,
    pending.length,
  );
}

const readyRoots = (f: OfficialFixture) =>
  f.database.transaction(
    async (tx) => {
      await boundHotTransaction(tx);
      return captureOfficialRoots([f.world.scope.home.spaceId], tx, true);
    },
    { isolationLevel: 'read committed' },
  );

async function drain(f: OfficialFixture) {
  return f.database.transaction(
    async (tx) => {
      await boundHotTransaction(tx);
      assert.equal(
        (
          await tx.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtextextended('official:coverage-maintenance:v1',0)) locked",
          )
        ).rows[0]!.locked,
        true,
      );
      return drainOfficialCauses(tx, [f.world.scope.home.spaceId]);
    },
    { isolationLevel: 'read committed' },
  );
}

async function assertSourceConversion(f: OfficialFixture, id: string) {
  const rows = (
    await f.pool.query<{ sequence: string; source_xid: string }>(
      `SELECT c.sequence::text,c.source_xid::text FROM whaleu_official.cause_conversions c
       JOIN whaleu_official.source_events e ON (e.space_id,e.sequence,e.post_id,e.owner_table,e.source_xid)=(c.space_id,c.sequence,c.post_id,c.owner_table,c.source_xid)
       WHERE c.id=$1 AND c.kind='source' AND NOT EXISTS(SELECT 1 FROM whaleu_official.pending_causes p WHERE p.id=c.id)`,
      [id],
    )
  ).rows;
  assert.equal(
    rows.length,
    1,
    `Cause ${id} must have its exact retained event`,
  );
  return rows[0]!;
}

test(
  '65 simultaneous source writers in an unenrolled space leave all official inventory unchanged',
  { timeout: 180000 },
  async () => {
    const f = await hotFeedFixture();
    try {
      const actor = await f.actor();
      const before = await officialInventory(f.pool);
      await sourceWriters(f.pool, f.scope.home.spaceId, actor.accountId, false);
      assert.deepEqual(await officialInventory(f.pool), before);
    } finally {
      await f.close();
    }
  },
);

test(
  '65 simultaneous source writers in one enrolled space append without touching shared official roots',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      await sourceWriters(
        f.pool,
        f.world.scope.home.spaceId,
        f.world.author.accountId,
        true,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'Saved settlement and a fresh like retain the real Experience owner barrier in an enrolled official space',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const post = await f.publish('Enrolled Saved and like lock ordering');
      await f.ready(32);
      await f.save(f.world.reader, post.id);
      const units = (
        await f.pool.query<{ id: string; saved_obligation_id: string }>(
          `SELECT u.id,u.saved_obligation_id FROM whaleu_community.reward_source_units u
           JOIN whaleu_community.reward_source_groups g ON g.id=u.group_id
           WHERE g.post_id=$1 AND g.event_type='post_saved' AND u.beneficiary_id=$2`,
          [post.id, f.world.reader.accountId],
        )
      ).rows;
      assert.equal(units.length, 1);
      const unit = units[0]!,
        clock = f.app.get(ExperienceClock),
        worker = f.app.get(ExperienceWorker),
        originalNow = clock.now.bind(clock);
      let reached!: () => void,
        release!: () => void,
        workerPid = 0;
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const errors: unknown[] = [];
      let processing: Promise<{ settled: number } | null> | undefined,
        writing: Promise<{ outcome: unknown } | null> | undefined;
      clock.now = async (tx) => {
        workerPid = (
          await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
        ).rows[0]!.pid;
        reached();
        await held;
        return originalNow(tx);
      };
      try {
        // Attach rejection handlers immediately, including while the other
        // participant is paused. Cleanup always releases both real operations.
        processing = worker.run({ mode: 'apply', unitIds: [unit.id] }).then(
          (result) => result,
          (error: unknown) => {
            errors.push(error);
            return null;
          },
        );
        await Promise.race([
          started,
          sleep(5000).then(() => {
            throw new Error('Worker did not reach the owner-held clock');
          }),
        ]);
        writing = f.like(f.world.reader, post.id).then(
          (response) => ({ outcome: response.body.outcome as unknown }),
          (error: unknown) => {
            errors.push(error);
            return null;
          },
        );
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          waiting = !!(
            await f.pool.query(
              `SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
               AND wait_event_type='Lock' AND query LIKE '%whaleu_experience.owners%'
               AND $1::integer=ANY(pg_blocking_pids(pid))`,
              [workerPid],
            )
          ).rowCount;
          if (!waiting) await sleep(10);
        }
        assert.equal(
          waiting,
          true,
          'The new like retains its parent locks and waits on this worker owner',
        );
        release();
        const [processed, written] = await Promise.all([processing, writing]);
        assert.deepEqual(errors, []);
        assert.equal(processed?.settled, 1);
        assert.equal(written?.outcome, 'applied');
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT status FROM whaleu_community.saved_obligations WHERE id=$1',
              [unit.saved_obligation_id],
            )
          ).rows,
          [{ status: 'completed' }],
        );
      } finally {
        release();
        clock.now = originalNow;
        await Promise.allSettled(
          [processing, writing].filter((value) => value !== undefined),
        );
      }
      await f.settleAll(post.id);
      await f.materializer.refresh(post.id);
      await f.ready(32);
      await readyRoots(f);
    } finally {
      await f.close();
    }
  },
);

test(
  'an enrolled post blocker does not stall a second post writer inside the real Safety profile count hook',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const first = await f.publish('Enrolled profile source blocker'),
        second = await f.world.ready(
          { text: 'Independent enrolled profile source writer' },
          f.world.reader,
        );
      await f.eligibility(second.id);
      await f.ready(32);
      const getProfile = () =>
        request(f.app.getHttpServer())
          .get(`/v1/profiles/${f.world.author.profileId}`)
          .set('Authorization', `Bearer ${f.world.reader.accessToken}`);
      const knownCount = (response: request.Response) => {
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.status, 'available');
        assert.equal(response.body.postCountStatus, 'known');
        assert.equal(response.body.postCount, 1);
      };
      await vacuumFixtureRelations(f.pool);
      knownCount(await getProfile());
      await withWriters(async (connect) => {
        const blocker = await connect(),
          writer = await connect();
        let fired = false,
          secondCommitted = false;
        try {
          await blocker.query('BEGIN');
          const pid = (
            await blocker.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          await blocker.query(
            'UPDATE whaleu_community.posts SET visibility=visibility WHERE id=$1',
            [first.id],
          );
          f.observer.setHook(async (event) => {
            if (
              !fired &&
              /LIMIT\s+257/i.test(event.sql) &&
              event.values[0] === f.world.author.accountId
            ) {
              fired = true;
              await writer.query(
                'UPDATE whaleu_community.posts SET visibility=visibility WHERE id=$1',
                [second.id],
              );
              secondCommitted = true;
              assert.equal(
                (
                  await f.pool.query<{ held: boolean }>(
                    "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='whaleu_community.posts'::regclass AND mode='RowExclusiveLock' AND granted) held",
                    [pid],
                  )
                ).rows[0]!.held,
                true,
                'The first writer still holds its real post lock after the second commits',
              );
            }
          });
          const response = await getProfile();
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.body.status, 'available');
          assert.equal(response.body.postCount, null);
          assert.equal(response.body.postCountStatus, 'unavailable');
          assert.equal(fired, true);
          assert.equal(secondCommitted, true);
          assert.equal(
            (
              await f.pool.query<{ n: number }>(
                "SELECT count(*)::integer n FROM whaleu_official.pending_causes WHERE kind='source' AND post_id=$1 AND owner_table='whaleu_community.posts'",
                [second.id],
              )
            ).rows[0]!.n,
            1,
          );
        } finally {
          f.observer.setHook(null);
          await blocker.query('ROLLBACK');
        }
      });
      knownCount(await getProfile());
    } finally {
      f.observer.setHook(null);
      await f.close();
    }
  },
);

test(
  'enrollment fails behind an unenrolled writer, retries atomically, and rejects an old repeatable-read snapshot',
  { timeout: 180000 },
  async () => {
    const f = await hotFeedFixture();
    try {
      const actor = await f.actor(),
        accountRef = randomUUID(),
        programId = randomUUID(),
        lineageRef = randomUUID(),
        oldPost = randomUUID(),
        stalePost = randomUUID(),
        freshPost = randomUUID(),
        revision = 'a'.repeat(64);
      await f.pool.query(
        "INSERT INTO whaleu_official.accounts(id,label,destination_ref,revision,profile) VALUES($1,'Enrollment race',$2,$3,'synthetic-official-v1')",
        [accountRef, randomUUID(), revision],
      );
      const enroll = () =>
        f.pool.query(
          'INSERT INTO whaleu_official.programs(id,account_ref,institution_id,school_space_id,region_ids,lineage_ref,revision) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            programId,
            accountRef,
            f.scope.institutionId,
            f.scope.home.spaceId,
            [f.scope.home.regionId],
            lineageRef,
            revision,
          ],
        );
      const before = await officialInventory(f.pool);
      await withWriters(async (connect) => {
        const stale = await connect(),
          writer = await connect();
        await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const previous = (
          await stale.query<{ revision: string }>(
            'SELECT revision::text FROM whaleu_official.enrollment_gate WHERE singleton',
          )
        ).rows[0]!.revision;
        await writer.query('BEGIN');
        await insertPost(
          writer,
          oldPost,
          f.scope.home.spaceId,
          actor.accountId,
        );
        await assert.rejects(enroll, sqlCode('55P03'));
        assert.deepEqual(await officialInventory(f.pool), before);
        await writer.query('COMMIT');
        await enroll();
        const current = (
          await f.pool.query<{ revision: string }>(
            'SELECT revision::text FROM whaleu_official.enrollment_gate WHERE singleton',
          )
        ).rows[0]!.revision;
        assert.equal(BigInt(current), BigInt(previous) + 1n);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_official.enrolled_spaces WHERE space_id=$1',
              [f.scope.home.spaceId],
            )
          ).rowCount,
          1,
        );
        await assert.rejects(
          insertPost(stale, stalePost, f.scope.home.spaceId, actor.accountId),
          sqlCode('40001'),
        );
        await stale.query('ROLLBACK');
        await insertPost(
          f.pool,
          freshPost,
          f.scope.home.spaceId,
          actor.accountId,
        );
      });
      assert.deepEqual(
        (
          await f.pool.query<{ post_id: string }>(
            'SELECT post_id FROM whaleu_official.pending_causes ORDER BY post_id',
          )
        ).rows,
        [{ post_id: freshPost }],
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_community.posts WHERE id=$1',
            [stalePost],
          )
        ).rowCount,
        0,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT baseline_started,baseline_exhausted,ready FROM whaleu_official.source_roots WHERE space_id=$1',
            [f.scope.home.spaceId],
          )
        ).rows,
        [{ baseline_started: false, baseline_exhausted: false, ready: false }],
        'Enrollment must not seed a completed baseline over the prior writer',
      );
      await f.pool.query(
        'UPDATE whaleu_official.programs SET revoked_at=clock_timestamp() WHERE id=$1',
        [programId],
      );
      await f.pool.query(
        'UPDATE whaleu_community.posts SET text=text WHERE id=$1',
        [freshPost],
      );
      assert.equal(
        (
          await f.pool.query<{ n: number }>(
            'SELECT count(*)::integer n FROM whaleu_official.pending_causes WHERE post_id=$1',
            [freshPost],
          )
        ).rows[0]!.n,
        2,
        'Durable enrollment survives program revocation',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'a lower UUID committed after a bounded higher-UUID drain remains an exact obligation and cannot be ready',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const lowPost = await f.publish('Late lower-UUID cause'),
        highPost = await f.publish('Earlier committed higher-UUID cause'),
        low = '00000000-0000-4000-8000-000000000001',
        high = 'ffffffff-ffff-4fff-bfff-ffffffffffff',
        spaceId = f.world.scope.home.spaceId;
      await f.ready(32);
      const baseline = (
        await f.pool.query(
          'SELECT baseline_highwater,baseline_cursor FROM whaleu_official.source_roots WHERE space_id=$1',
          [spaceId],
        )
      ).rows;
      const change = async (
        tx: PoolClient,
        causeId: string,
        postId: string,
      ) => {
        // Preallocate the inbox UUID, then make the real source mutation in the
        // same transaction. Same-transaction trigger dedup retains that cause.
        await tx.query(
          "INSERT INTO whaleu_official.pending_causes(id,kind,space_id,post_id,owner_table) VALUES($1,'source',$2,$3,'whaleu_community.posts')",
          [causeId, spaceId, postId],
        );
        await tx.query(
          'UPDATE whaleu_community.posts SET text=text WHERE id=$1',
          [postId],
        );
      };
      await withWriters(async (connect) => {
        const writer = await connect();
        await writer.query('BEGIN');
        await change(writer, low, lowPost.id);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_official.pending_causes WHERE id=$1',
              [low],
            )
          ).rowCount,
          0,
        );
        await assert.rejects(
          () => readyRoots(f),
          sqlCode('OFFICIAL_SOURCE_UNAVAILABLE'),
        );
        await inTransaction(f.pool, (tx) => change(tx, high, highPost.id));
        assert.equal(await drain(f), 1);
        await assertSourceConversion(f, high);
        assert.notEqual(
          (await f.maintain.runCycle({ programId: f.programId })).state,
          'ready',
        );
        await writer.query('COMMIT');
      });
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT id FROM whaleu_official.pending_causes ORDER BY id',
          )
        ).rows,
        [{ id: low }],
        'A consumed high UUID is never a deletion watermark for later commits',
      );
      await assert.rejects(
        () => readyRoots(f),
        sqlCode('OFFICIAL_SOURCE_UNAVAILABLE'),
      );
      await f.ready(32);
      const earlier = await assertSourceConversion(f, high),
        later = await assertSourceConversion(f, low);
      assert.ok(BigInt(earlier.sequence) < BigInt(later.sequence));
      assert.notEqual(earlier.source_xid, later.source_xid);
      await readyRoots(f);
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT baseline_highwater,baseline_cursor FROM whaleu_official.source_roots WHERE space_id=$1',
            [spaceId],
          )
        ).rows,
        baseline,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'a low-xid dependency absent from the fixed bootstrap snapshot is inspected after its later commit',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const post = await f.publish(
          'Late dependency must revisit this native post',
        ),
        spaceId = f.world.scope.home.spaceId,
        low = '00000000-0000-4000-8000-000000000002',
        high = 'ffffffff-ffff-4fff-bfff-fffffffffffe';
      // Convert initial publication causes without starting or seeding a
      // baseline. The real maintainer below owns the first snapshot and ranks.
      for (let batch = 0; batch < 4; batch++) {
        const consumed = await drain(f);
        assert.ok(consumed <= 64);
        if (consumed === 0) break;
      }
      assert.equal(
        (await f.pool.query('SELECT 1 FROM whaleu_official.pending_causes'))
          .rowCount,
        0,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT baseline_started,baseline_snapshot IS NULL snapshot_missing,baseline_exhausted,ready FROM whaleu_official.source_roots WHERE space_id=$1',
            [spaceId],
          )
        ).rows,
        [
          {
            baseline_started: false,
            snapshot_missing: true,
            baseline_exhausted: false,
            ready: false,
          },
        ],
        'The real maintainer must establish bootstrap coverage without any ready seed',
      );
      const change = async (
        tx: PoolClient,
        causeId: string,
        accountId: string,
      ) => {
        const xid = (
          await tx.query<{ xid: string }>(
            'SELECT pg_current_xact_id()::text xid',
          )
        ).rows[0]!.xid;
        await tx.query(
          "INSERT INTO whaleu_official.pending_causes(id,kind,dependency_kind,target_id,owner_table) VALUES($1,'dependency','account',$2,'whaleu_identity.accounts')",
          [causeId, accountId],
        );
        await tx.query(
          'UPDATE whaleu_identity.accounts SET status=status WHERE id=$1',
          [accountId],
        );
        return xid;
      };
      const unavailable = new OfficialDraftCoverageMaintainer(f.database, {
        inspect: async () => {
          throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
        },
        project: f.source.project.bind(f.source),
      });
      let snapshot = '',
        lowXid = '',
        highSequence = '';
      await withWriters(async (connect) => {
        const writer = await connect();
        await writer.query('BEGIN');
        lowXid = await change(writer, low, f.world.author.accountId);
        const highXid = await inTransaction(f.pool, (tx) =>
          change(tx, high, f.world.reader.accountId),
        );
        assert.ok(BigInt(lowXid) < BigInt(highXid));
        const progress = await unavailable.runCycle({ programId: f.programId });
        assert.equal(progress.state, 'not_ready', JSON.stringify(progress));
        const root = (
          await f.pool.query<{
            baseline_snapshot: string;
            baseline_exhausted: boolean;
            ready: boolean;
          }>(
            'SELECT baseline_snapshot::text,baseline_exhausted,ready FROM whaleu_official.source_roots WHERE space_id=$1',
            [spaceId],
          )
        ).rows[0]!;
        assert.ok(root.baseline_snapshot);
        assert.equal(root.baseline_exhausted, true);
        assert.equal(root.ready, false);
        snapshot = root.baseline_snapshot;
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT pg_visible_in_snapshot($1::xid8,$3::pg_snapshot) low_visible,pg_visible_in_snapshot($2::xid8,$3::pg_snapshot) high_visible',
              [lowXid, highXid, snapshot],
            )
          ).rows,
          [{ low_visible: false, high_visible: true }],
        );
        const conversion = (
          await f.pool.query<{ sequence: string }>(
            'SELECT sequence::text FROM whaleu_official.cause_conversions WHERE id=$1',
            [high],
          )
        ).rows;
        assert.equal(conversion.length, 1);
        highSequence = conversion[0]!.sequence;
        await writer.query('COMMIT');
      });
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT id,source_xid::text,pg_visible_in_snapshot(source_xid,$2::pg_snapshot) visible FROM whaleu_official.pending_causes WHERE id=$1',
            [low, snapshot],
          )
        ).rows,
        [{ id: low, source_xid: lowXid, visible: false }],
      );
      const inspected: string[] = [];
      const tracked = new OfficialDraftCoverageMaintainer(f.database, {
        inspect: async (id, score, tx) => {
          inspected.push(id);
          return f.source.inspect(id, score, tx);
        },
        project: f.source.project.bind(f.source),
      });
      const completed = await tracked.runCycle({ programId: f.programId });
      assert.equal(completed.state, 'ready', JSON.stringify(completed));
      assert.ok(
        inspected.includes(post.id),
        'A lower allocated xid must not be skipped as a pre-bootstrap dependency',
      );
      const converted = (
        await f.pool.query<{ sequence: string; source_xid: string }>(
          `SELECT c.sequence::text,c.source_xid::text FROM whaleu_official.cause_conversions c
           JOIN whaleu_official.dependency_events e ON (e.sequence,e.kind,e.target_id,e.owner_table,e.source_xid)=(c.sequence,c.dependency_kind,c.target_id,c.owner_table,c.source_xid)
           WHERE c.id=$1 AND c.kind='dependency' AND NOT EXISTS(SELECT 1 FROM whaleu_official.pending_causes p WHERE p.id=c.id)`,
          [low],
        )
      ).rows;
      assert.equal(converted.length, 1);
      assert.equal(converted[0]!.source_xid, lowXid);
      assert.ok(BigInt(converted[0]!.sequence) > BigInt(highSequence));
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT baseline_snapshot::text,dependency_cursor::text FROM whaleu_official.source_roots WHERE space_id=$1',
            [spaceId],
          )
        ).rows,
        [
          {
            baseline_snapshot: snapshot,
            dependency_cursor: converted[0]!.sequence,
          },
        ],
      );
      await readyRoots(f);
    } finally {
      await f.close();
    }
  },
);

test(
  'rolled-back producers leave no phantom cause, separate same-post commits survive, and raw inbox resets reject',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const post = await f.publish('Exact per-transaction cause retention');
      await f.ready(32);
      const before = await officialInventory(f.pool);
      let rolledBack = '';
      await withWriters(async (connect) => {
        const writer = await connect();
        await writer.query('BEGIN');
        await writer.query(
          'UPDATE whaleu_community.posts SET text=text WHERE id=$1',
          [post.id],
        );
        const pending = (
          await writer.query<{ id: string }>(
            'SELECT id FROM whaleu_official.pending_causes WHERE source_xid=pg_current_xact_id()',
          )
        ).rows;
        assert.equal(pending.length, 1);
        rolledBack = pending[0]!.id;
        await assert.rejects(
          () => readyRoots(f),
          sqlCode('OFFICIAL_SOURCE_UNAVAILABLE'),
        );
        await writer.query('ROLLBACK');
      });
      assert.deepEqual(await officialInventory(f.pool), before);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_official.cause_conversions WHERE id=$1',
            [rolledBack],
          )
        ).rowCount,
        0,
      );
      await readyRoots(f);

      for (let mutation = 0; mutation < 3; mutation++)
        await f.pool.query(
          'UPDATE whaleu_community.posts SET text=text WHERE id=$1',
          [post.id],
        );
      const causes = (
        await f.pool.query<{ id: string; source_xid: string }>(
          "SELECT id,source_xid::text FROM whaleu_official.pending_causes WHERE kind='source' AND post_id=$1 ORDER BY id",
          [post.id],
        )
      ).rows;
      assert.equal(causes.length, 3);
      assert.equal(new Set(causes.map((cause) => cause.id)).size, 3);
      assert.equal(new Set(causes.map((cause) => cause.source_xid)).size, 3);
      const pendingBefore = await officialInventory(f.pool);
      for (const sql of [
        'DELETE FROM whaleu_official.pending_causes WHERE id=$1',
        'UPDATE whaleu_official.pending_causes SET owner_table=owner_table WHERE id=$1',
        `INSERT INTO whaleu_official.cause_conversions(id,kind,space_id,post_id,dependency_kind,target_id,owner_table,source_xid,sequence)
         SELECT id,kind,space_id,post_id,dependency_kind,target_id,owner_table,source_xid,9223372036854775807 FROM whaleu_official.pending_causes WHERE id=$1`,
      ])
        await assert.rejects(
          f.pool.query(sql, [causes[0]!.id]),
          sqlCode('23514'),
        );
      await assert.rejects(
        f.pool.query('TRUNCATE whaleu_official.pending_causes'),
        sqlCode('23514'),
      );
      assert.deepEqual(await officialInventory(f.pool), pendingBefore);
      await assert.rejects(
        () => readyRoots(f),
        sqlCode('OFFICIAL_SOURCE_UNAVAILABLE'),
      );
      await f.ready(32);
      for (const cause of causes)
        assert.equal(
          (await assertSourceConversion(f, cause.id)).source_xid,
          cause.source_xid,
        );
      for (const sql of [
        'DELETE FROM whaleu_official.cause_conversions WHERE id=$1',
        'UPDATE whaleu_official.cause_conversions SET sequence=sequence WHERE id=$1',
      ])
        await assert.rejects(
          f.pool.query(sql, [causes[0]!.id]),
          sqlCode('23514'),
        );
      await assert.rejects(
        f.pool.query('TRUNCATE whaleu_official.cause_conversions'),
        sqlCode('23514'),
      );
      await readyRoots(f);

      const dependencyHead = (
        await f.pool.query(
          'SELECT head::text FROM whaleu_official.dependency_root WHERE singleton',
        )
      ).rows;
      for (let mutation = 0; mutation < 2; mutation++)
        await f.pool.query(
          'UPDATE whaleu_identity.accounts SET status=status WHERE id=$1',
          [f.world.author.accountId],
        );
      const dependencies = (
        await f.pool.query<{ id: string; source_xid: string }>(
          "SELECT id,source_xid::text FROM whaleu_official.pending_causes WHERE kind='dependency' AND dependency_kind='account' AND target_id=$1 ORDER BY id",
          [f.world.author.accountId],
        )
      ).rows;
      assert.equal(dependencies.length, 2);
      assert.notEqual(dependencies[0]!.source_xid, dependencies[1]!.source_xid);
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT head::text FROM whaleu_official.dependency_root WHERE singleton',
          )
        ).rows,
        dependencyHead,
        'Ordinary dependency writers do not advance the global root',
      );
      await assert.rejects(
        () => readyRoots(f),
        sqlCode('OFFICIAL_SOURCE_UNAVAILABLE'),
      );
      assert.equal(await drain(f), 2);
      for (const dependency of dependencies)
        assert.deepEqual(
          (
            await f.pool.query<{ source_xid: string }>(
              `SELECT c.source_xid::text FROM whaleu_official.cause_conversions c
               JOIN whaleu_official.dependency_events e ON (e.sequence,e.kind,e.target_id,e.owner_table,e.source_xid)=(c.sequence,c.dependency_kind,c.target_id,c.owner_table,c.source_xid)
               WHERE c.id=$1 AND c.kind='dependency' AND NOT EXISTS(SELECT 1 FROM whaleu_official.pending_causes p WHERE p.id=c.id)`,
              [dependency.id],
            )
          ).rows,
          [{ source_xid: dependency.source_xid }],
        );
      await f.ready(32);
      await readyRoots(f);
    } finally {
      await f.close();
    }
  },
);

test(
  'durable alternating phases advance canonical coverage and both space queues under continuing causes',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const dual = randomUUID();
      await f.pool.query(
        `INSERT INTO whaleu_official.programs(id,account_ref,institution_id,school_space_id,city_space_id,region_ids,lineage_ref,revision)
         SELECT $2,account_ref,institution_id,$5,$3,region_ids,$4,revision
         FROM whaleu_official.programs WHERE id=$1`,
        [
          f.programId,
          dual,
          f.world.scope.global.spaceId,
          randomUUID(),
          f.world.scope.related.spaceId,
        ],
      );
      const spaces = [
        f.world.scope.related.spaceId,
        f.world.scope.global.spaceId,
      ];
      for (const space of spaces) {
        // Historical structural inventory remains unknown, never silently deny.
        // Its real INSERT causes still require bounded conversion and bootstrap.
        await f.pool.query(
          `INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,published_at)
           SELECT gen_random_uuid(),$1,$2,'discussion','Historical fairness inventory','named','open',clock_timestamp()-interval '48 hours'
           FROM generate_series(1,160)`,
          [space, f.world.author.accountId],
        );
        for (let i = 0; i < 96; i++)
          await f.pool.query(
            'UPDATE whaleu_community.spaces SET name=name WHERE id=$1',
            [space],
          );
      }
      const paused = new OfficialDraftCoverageMaintainer(f.database, f.source);
      let converted = false;
      f.observer.setHook(async ({ sql }) => {
        if (sql.startsWith('INSERT INTO whaleu_official.cause_conversions'))
          converted = true;
        if (converted && sql === 'COMMIT') paused.stopAdmission();
      });
      const interrupted = await paused.runCycle({ programId: dual });
      f.observer.setHook(null);
      assert.equal(interrupted.examined, 0);
      assert.equal(interrupted.state, 'not_ready');
      assert.equal(
        (
          await f.pool.query(
            'SELECT next_phase FROM whaleu_official.maintenance_claim',
          )
        ).rows[0].next_phase,
        'canonical',
      );
      let firstWork: string | null = null;
      f.observer.setHook(async ({ sql }) => {
        if (firstWork !== null) return;
        if (sql.startsWith('INSERT INTO whaleu_official.cause_conversions'))
          firstWork = 'drain';
        if (sql.startsWith('SELECT space_id,published_at'))
          firstWork = 'canonical';
      });
      let previousRanks = 0;
      const previousConversions = new Map<string, number>();
      let previousDependencies = 0;
      for (let round = 0; round < 2; round++) {
        const result = await f.maintain.runCycle({ programId: dual });
        assert.equal(result.state, 'not_ready');
        assert.ok(result.examined > 0 && result.examined <= 64);
        const ranks = Number(
          (
            await f.pool.query(
              'SELECT count(*) n FROM whaleu_official.source_ranks',
            )
          ).rows[0].n,
        );
        assert.ok(
          ranks > previousRanks,
          'canonical work advances while both queues stay nonempty',
        );
        previousRanks = ranks;
        for (const space of spaces) {
          const conversions = Number(
            (
              await f.pool.query(
                "SELECT count(*) n FROM whaleu_official.cause_conversions WHERE kind='source' AND space_id=$1",
                [space],
              )
            ).rows[0].n,
          );
          assert.ok(conversions > (previousConversions.get(space) ?? 0));
          previousConversions.set(space, conversions);
          await f.pool.query(
            'UPDATE whaleu_community.posts SET text=text WHERE id=(SELECT id FROM whaleu_community.posts WHERE space_id=$1 ORDER BY id LIMIT 1)',
            [space],
          );
          await f.pool.query(
            'UPDATE whaleu_community.spaces SET name=name WHERE id=$1',
            [space],
          );
        }
        const dependencies = Number(
          (
            await f.pool.query(
              "SELECT count(*) n FROM whaleu_official.cause_conversions WHERE kind='dependency'",
            )
          ).rows[0].n,
        );
        assert.ok(dependencies > previousDependencies);
        previousDependencies = dependencies;
      }
      f.observer.setHook(null);
      assert.equal(firstWork, 'canonical');
      let settled = false;
      for (let cycle = 0; cycle < 100; cycle++) {
        const result = await f.maintain.runCycle({ programId: dual });
        assert.notEqual(result.state, 'unavailable');
        assert.ok(result.examined <= 64);
        if (result.state === 'ready') {
          settled = true;
          break;
        }
      }
      assert.equal(settled, true);
      assert.equal(
        Number(
          (
            await f.pool.query(
              'SELECT count(*) n FROM whaleu_official.pending_causes',
            )
          ).rows[0].n,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await f.pool.query(
              "SELECT count(*) n FROM whaleu_official.source_ranks WHERE decision='unknown' AND NOT daily_active",
            )
          ).rows[0].n,
        ),
        320,
      );
    } finally {
      f.observer.setHook(null);
      await f.close();
    }
  },
);
