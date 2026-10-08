import { CommunityViewEnrollment } from '../../src/community/view-component/enrollment.js';
import { CommunityCommentEnrollment } from '../../src/community/comment-component/enrollment.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

const constraint = (e: unknown) =>
  Boolean(
    e &&
    typeof e === 'object' &&
    'code' in e &&
    ['23514', '23503', '23505'].includes(String(e.code)),
  );
test(
  'like SQL actual-transition provenance, independent fresh baseline and exact causal closure',
  { timeout: 120000 },
  async (t) => {
    const url = process.env['TEST_DATABASE_URL'];
    assert.ok(
      url,
      'Requires disposable TEST_DATABASE_URL; never silently skipped',
    );
    const parsed = new URL(url);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname));
    assert.equal(parsed.pathname, '/whaleu_test');
    const pool = new Pool({ connectionString: url, ssl: false });
    const suite = await pool.connect();
    const locked = (
      await suite.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1,$2) locked',
        [MIGRATION_LOCK[0], 2],
      )
    ).rows[0]!.locked;
    let owns = false;
    let currentViewSchema = false;
    const views = new CommunityViewEnrollment();
    const comments = new CommunityCommentEnrollment();
    const owner = randomUUID(),
      actor = randomUUID(),
      other = randomUUID(),
      space = randomUUID();
    const rejects = async (fn: (tx: PoolClient) => Promise<unknown>) =>
      assert.rejects(inTransaction(pool, fn), constraint);
    const native = async (
      tx: PoolClient,
      likes: boolean,
      change: {
        wrongOwner?: boolean;
        wrongRequest?: boolean;
        omitState?: boolean;
        priorLike?: boolean;
      } = {},
    ) => {
      await lockSafetyPolicy(tx);
      const post = randomUUID(),
        request = randomUUID();
      await tx.query(
        "INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,payload_hash,operation,receipt) VALUES($1,$2,$3,'publish_post',$4)",
        [
          owner,
          request,
          'a'.repeat(64),
          {
            requestId: request,
            operation: 'publish_post',
            outcome: 'created',
            resourceId: post,
            createdAt: new Date().toISOString(),
          },
        ],
      );
      await tx.query(
        "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','SQL like proof','named','open')",
        [post, space, owner],
      );
      await tx.query(
        "INSERT INTO whaleu_community.report_origins(kind,target_id,owner_account_id,source_request_id,provenance) VALUES('post',$1,$2,$3,'native_publication')",
        [post, owner, request],
      );
      await tx.query(
        'INSERT INTO whaleu_post_hotness.subscription_baselines(post_id,owner_id,source_request_id) VALUES($1,$2,$3)',
        [post, owner, request],
      );
      await tx.query(
        'INSERT INTO whaleu_post_hotness.subscription_states(post_id) VALUES($1)',
        [post],
      );
      // Satisfy only the newly independent view hook for current fresh origins;
      // keep the pre-0027 historical publication genuinely view-unknown.
      if (currentViewSchema)
        await views.enrollPublishedPost(
          { postId: post, ownerId: owner, publicationRequestId: request },
          tx,
        );
      // Only current-schema fresh publications enroll the independent comment
      // component; the historical native publication stays comment-unknown.
      if (currentViewSchema)
        await comments.enrollPublishedPost(
          { postId: post, ownerId: owner, publicationRequestId: request },
          tx,
        );
      if (change.priorLike)
        await tx.query(
          'INSERT INTO whaleu_community.post_likes(account_id,post_id) VALUES($1,$2)',
          [actor, post],
        );
      if (likes) {
        await tx.query(
          'INSERT INTO whaleu_post_hotness.like_baselines(post_id,owner_id,source_request_id) VALUES($1,$2,$3)',
          [
            post,
            change.wrongOwner ? other : owner,
            change.wrongRequest ? randomUUID() : request,
          ],
        );
        if (!change.omitState)
          await tx.query(
            'INSERT INTO whaleu_post_hotness.like_states(post_id) VALUES($1)',
            [post],
          );
      }
      return { post, request };
    };
    type Source = {
      id: string;
      post_id: string;
      actor_id: string;
      like_id: string;
      transition: string;
      delta: number;
      source_sequence: string;
      source_transaction: string;
      positive_source_id: string | null;
    };
    const sources = async (post: string) =>
      (
        await pool.query<Source>(
          'SELECT * FROM whaleu_post_hotness.like_sources WHERE post_id=$1 ORDER BY source_sequence',
          [post],
        )
      ).rows;
    const insert = async (post: string, who = actor, likeId = randomUUID()) =>
      inTransaction(pool, async (tx) => {
        await tx.query(
          'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
          [post],
        );
        await tx.query(
          'INSERT INTO whaleu_community.post_likes(account_id,post_id,like_id) VALUES($1,$2,$3)',
          [who, post, likeId],
        );
        return likeId;
      });
    const apply = async (
      tx: PoolClient,
      s: Source,
      options: {
        omit?: 'state' | 'member' | 'both';
        badCount?: boolean;
        wrongActor?: boolean;
        wrongEpoch?: boolean;
        wrongPrestate?: boolean;
      } = {},
    ) => {
      await tx.query(
        'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
        [s.post_id],
      );
      const st = (
        await tx.query(
          'SELECT * FROM whaleu_post_hotness.like_states WHERE post_id=$1',
          [s.post_id],
        )
      ).rows[0]!;
      const member = (
        await tx.query(
          'SELECT * FROM whaleu_post_hotness.like_memberships WHERE post_id=$1 AND actor_id=$2',
          [s.post_id, s.actor_id],
        )
      ).rows[0];
      const after = (
        BigInt(st.count) +
        BigInt(s.delta) +
        (options.badCount ? 1n : 0n)
      ).toString();
      await tx.query(
        'INSERT INTO whaleu_post_hotness.like_receipts(source_id,post_id,actor_id,like_id,transition,source_sequence,delta,before_count,after_count,previous_state_sequence,previous_membership_sequence,previous_active_like_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          s.id,
          s.post_id,
          options.wrongActor ? owner : s.actor_id,
          options.wrongEpoch ? randomUUID() : s.like_id,
          s.transition,
          s.source_sequence,
          s.delta,
          st.count,
          after,
          st.last_sequence,
          options.wrongPrestate ? '999' : (member?.last_sequence ?? '0'),
          member?.active_like_id ?? null,
        ],
      );
      if (options.omit !== 'state' && options.omit !== 'both')
        await tx.query(
          'UPDATE whaleu_post_hotness.like_states SET count=$2,last_sequence=$3,last_receipt_id=$4 WHERE post_id=$1',
          [s.post_id, after, s.source_sequence, s.id],
        );
      if (options.omit !== 'member' && options.omit !== 'both') {
        const active = s.transition === 'liked' ? s.like_id : null;
        if (member)
          await tx.query(
            'UPDATE whaleu_post_hotness.like_memberships SET active_like_id=$3,last_sequence=$4,last_receipt_id=$5 WHERE post_id=$1 AND actor_id=$2',
            [s.post_id, s.actor_id, active, s.source_sequence, s.id],
          );
        else
          await tx.query(
            'INSERT INTO whaleu_post_hotness.like_memberships(post_id,actor_id,active_like_id,last_sequence,last_receipt_id) VALUES($1,$2,$3,$4,$5)',
            [s.post_id, s.actor_id, active, s.source_sequence, s.id],
          );
      }
    };
    try {
      assert.ok(locked, 'Serial exclusive PostgreSQL fixture required');
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rowCount,
        0,
        'Refuse preexisting schemas',
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      await runMigrations(
        pool,
        migrations.filter((m) => m.name < '0027'),
        { mode: 'up' },
      );
      for (const id of [owner, actor, other])
        await pool.query(
          'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
          [id],
        );
      await withCommunityScopeWriter(pool, (tx) =>
        tx.query(
          "INSERT INTO whaleu_community.spaces(id,kind,name) VALUES($1,'global','Like SQL proof')",
          [space],
        ),
      );
      const historical = await inTransaction(pool, (tx) => native(tx, false));
      await insert(historical.post);
      await runMigrations(pool, migrations, { mode: 'up' });
      currentViewSchema = true;
      await t.test(
        'pre-slice subscription-known native post remains like-unknown, including later real deletion',
        async () => {
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_post_hotness.subscription_baselines WHERE post_id=$1',
                [historical.post],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_post_hotness.like_baselines',
              )
            ).rowCount,
            0,
          );
          await rejects((tx) =>
            tx.query(
              'INSERT INTO whaleu_post_hotness.like_baselines(post_id,owner_id,source_request_id) VALUES($1,$2,$3)',
              [historical.post, owner, historical.request],
            ),
          );
          await pool.query(
            'DELETE FROM whaleu_community.post_likes WHERE post_id=$1',
            [historical.post],
          );
          assert.equal((await sources(historical.post)).length, 0);
        },
      );
      for (const [name, change] of Object.entries({
        wrongOwner: { wrongOwner: true },
        wrongRequest: { wrongRequest: true },
        missingState: { omitState: true },
        priorLike: { priorLike: true },
      }))
        await t.test(`baseline rejects ${name}`, () =>
          rejects((tx) => native(tx, true, change)),
        );
      await t.test(
        'deferred fresh publication requires independent like hook',
        () => rejects((tx) => native(tx, false)),
      );
      for (const isolation of ['READ COMMITTED', 'REPEATABLE READ'])
        await t.test(
          `uncommitted native parent fails before child locks at ${isolation}`,
          async () => {
            const publisher = await pool.connect(),
              writer = await pool.connect();
            try {
              await publisher.query('BEGIN');
              const newborn = await native(publisher, true);
              await writer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
              await writer.query("SET LOCAL statement_timeout='2s'");
              await assert.rejects(
                writer.query(
                  'INSERT INTO whaleu_community.post_likes(account_id,post_id) VALUES($1,$2)',
                  [actor, newborn.post],
                ),
                constraint,
              );
              await writer.query('ROLLBACK');
              // Publisher may insert the exact same tuple without waiting for the
              // rejected writer; no tuple/parent inversion or uncaptured commit.
              await publisher.query("SET LOCAL statement_timeout='2s'");
              await publisher.query(
                'INSERT INTO whaleu_community.post_likes(account_id,post_id) VALUES($1,$2)',
                [actor, newborn.post],
              );
              await publisher.query('COMMIT');
              assert.equal((await sources(newborn.post)).length, 1);
            } finally {
              await publisher.query('ROLLBACK');
              await writer.query('ROLLBACK');
              publisher.release();
              writer.release();
            }
          },
        );
      const fresh = await inTransaction(pool, (tx) => native(tx, true));
      await t.test(
        'fresh independent baseline and zero state share publication transaction',
        async () => {
          const row = (
            await pool.query(
              'SELECT b.creation_xid::text,p.local_creation_transaction::text,s.count,s.last_sequence FROM whaleu_post_hotness.like_baselines b JOIN whaleu_post_hotness.like_states s USING(post_id) JOIN whaleu_community.posts p ON p.id=b.post_id WHERE b.post_id=$1',
              [fresh.post],
            )
          ).rows[0]!;
          assert.equal(row.creation_xid, row.local_creation_transaction);
          assert.equal(row.count, '0');
          assert.equal(row.last_sequence, '0');
        },
      );
      const firstId = await insert(fresh.post);
      const positive = (await sources(fresh.post))[0]!;
      await t.test(
        'desired-state no-op inserts and zero-row deletes emit no source',
        async () => {
          await pool.query(
            'INSERT INTO whaleu_community.post_likes(account_id,post_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [actor, fresh.post],
          );
          await pool.query(
            'DELETE FROM whaleu_community.post_likes WHERE post_id=$1 AND account_id=$2',
            [fresh.post, other],
          );
          assert.equal((await sources(fresh.post)).length, 1);
        },
      );
      await t.test('existing live identity update guard remains active', () =>
        rejects((tx) =>
          tx.query(
            'UPDATE whaleu_community.post_likes SET like_id=$2 WHERE like_id=$1',
            [firstId, randomUUID()],
          ),
        ),
      );
      const deletionXid = await inTransaction(pool, async (tx) => {
        const xid = (await tx.query('SELECT pg_current_xact_id()::text xid'))
          .rows[0]!.xid;
        await tx.query(
          'DELETE FROM whaleu_community.post_likes WHERE like_id=$1',
          [firstId],
        );
        return xid;
      });
      const negative = (await sources(fresh.post))[1]!;
      await t.test(
        'actual delete after old insert retains epoch and uses its own xid',
        async () => {
          assert.notEqual(
            positive.source_transaction,
            negative.source_transaction,
          );
          assert.equal(negative.source_transaction, deletionXid);
          assert.equal(negative.positive_source_id, positive.id);
          assert.equal(negative.like_id, firstId);
          assert.ok(
            BigInt(negative.source_sequence) > BigInt(positive.source_sequence),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.post_likes WHERE like_id=$1',
                [firstId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test('ended like_id cannot be reused', () =>
        assert.rejects(insert(fresh.post, actor, firstId), constraint),
      );
      const secondId = await insert(fresh.post);
      const relike = (await sources(fresh.post))[2]!;
      await insert(fresh.post, other);
      const laterActor = (await sources(fresh.post))[3]!;
      for (const transition of ['liked', 'unliked'])
        await t.test(
          `direct ${transition} source forgery cannot use supplied xid or retained positive proof`,
          () =>
            rejects((tx) =>
              tx.query(
                'INSERT INTO whaleu_post_hotness.like_sources(post_id,actor_id,like_id,transition,delta,source_sequence,source_transaction,positive_source_id) VALUES($1,$2,$3,$4,$5,999999,pg_current_xact_id(),$6)',
                [
                  fresh.post,
                  actor,
                  randomUUID(),
                  transition,
                  transition === 'liked' ? 1 : -1,
                  transition === 'liked' ? null : positive.id,
                ],
              ),
            ),
        );
      await t.test('source retained positive link cannot be rewritten', () =>
        rejects((tx) =>
          tx.query(
            'UPDATE whaleu_post_hotness.like_sources SET positive_source_id=$2 WHERE id=$1',
            [negative.id, relike.id],
          ),
        ),
      );
      for (const s of [negative, relike, laterActor])
        await t.test(
          `source ${s.transition}/${s.actor_id} cannot bypass earliest unresolved source`,
          () => rejects((tx) => apply(tx, s)),
        );
      for (const omit of ['state', 'member', 'both'] as const)
        await t.test(
          `receipt missing ${omit} effects rolls back atomically`,
          async () => {
            await rejects((tx) => apply(tx, positive, { omit }));
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_post_hotness.like_receipts',
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT count FROM whaleu_post_hotness.like_states WHERE post_id=$1',
                  [fresh.post],
                )
              ).rows[0]!.count,
              '0',
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_post_hotness.like_memberships',
                )
              ).rowCount,
              0,
            );
          },
        );
      for (const options of [
        { badCount: true },
        { wrongActor: true },
        { wrongEpoch: true },
        { wrongPrestate: true },
      ])
        await t.test(
          `receipt rejects forged exact prestate ${JSON.stringify(options)}`,
          () => rejects((tx) => apply(tx, positive, options)),
        );
      await t.test('effect without receipt rejected', () =>
        rejects((tx) =>
          tx.query(
            'UPDATE whaleu_post_hotness.like_states SET count=1 WHERE post_id=$1',
            [fresh.post],
          ),
        ),
      );
      await t.test('one post cannot apply two sources in one transaction', () =>
        rejects(async (tx) => {
          await apply(tx, positive);
          await apply(tx, negative);
        }),
      );
      await inTransaction(pool, (tx) => apply(tx, positive));
      assert.equal(
        (
          await pool.query(
            'SELECT count FROM whaleu_post_hotness.like_states WHERE post_id=$1',
            [fresh.post],
          )
        ).rows[0]!.count,
        '1',
      );
      await inTransaction(pool, (tx) => apply(tx, negative));
      await t.test(
        'negative retains inactive membership and reaches zero without clamp',
        async () => {
          const row = (
            await pool.query(
              'SELECT s.count,m.active_like_id,m.last_receipt_id FROM whaleu_post_hotness.like_states s JOIN whaleu_post_hotness.like_memberships m USING(post_id) WHERE s.post_id=$1',
              [fresh.post],
            )
          ).rows[0]!;
          assert.equal(row.count, '0');
          assert.equal(row.active_like_id, null);
          assert.equal(row.last_receipt_id, negative.id);
        },
      );
      await inTransaction(pool, (tx) => apply(tx, relike));
      await inTransaction(pool, (tx) => apply(tx, laterActor));
      await t.test(
        'old positive and negative cannot rewrite new epoch or count',
        async () => {
          await rejects((tx) => apply(tx, positive));
          await rejects((tx) => apply(tx, negative));
          assert.equal(
            (
              await pool.query(
                'SELECT active_like_id FROM whaleu_post_hotness.like_memberships WHERE post_id=$1 AND actor_id=$2',
                [fresh.post, actor],
              )
            ).rows[0]!.active_like_id,
            secondId,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count FROM whaleu_post_hotness.like_states WHERE post_id=$1',
                [fresh.post],
              )
            ).rows[0]!.count,
            '2',
          );
        },
      );
      for (const table of [
        'like_baselines',
        'like_sources',
        'like_receipts',
        'like_states',
        'like_memberships',
      ]) {
        await t.test(`${table} cannot delete retained proof`, () =>
          rejects((tx) =>
            tx.query(
              `DELETE FROM whaleu_post_hotness.${table} WHERE post_id=$1`,
              [fresh.post],
            ),
          ),
        );
        await t.test(`${table} cannot TRUNCATE CASCADE away proof`, () =>
          rejects((tx) =>
            tx.query(`TRUNCATE whaleu_post_hotness.${table} CASCADE`),
          ),
        );
      }
      await t.test(
        'live source table cannot bypass capture with TRUNCATE',
        () =>
          rejects((tx) =>
            tx.query('TRUNCATE whaleu_community.post_likes CASCADE'),
          ),
      );
      await t.test(
        'self-like is counted; unrelated subscription and rewards are untouched',
        async () => {
          await insert(fresh.post, owner);
          const self = (await sources(fresh.post)).at(-1)!;
          await inTransaction(pool, (tx) => apply(tx, self));
          assert.equal(
            (
              await pool.query(
                'SELECT count FROM whaleu_post_hotness.like_states WHERE post_id=$1',
                [fresh.post],
              )
            ).rows[0]!.count,
            '3',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count FROM whaleu_post_hotness.subscription_states WHERE post_id=$1',
                [fresh.post],
              )
            ).rows[0]!.count,
            '0',
          );
          for (const table of [
            'reward_source_groups',
            'saved_obligations',
            'outbox',
          ])
            assert.equal(
              (await pool.query(`SELECT 1 FROM whaleu_community.${table}`))
                .rowCount,
              0,
            );
        },
      );
    } finally {
      if (owns)
        for (const schema of ['whaleu_post_hotness', ...migrationSchemaNames])
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (locked)
        await suite.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite.release();
      await pool.end();
    }
  },
);
