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
  'subscription SQL provenance, unknown history, causal state and atomic completion proofs',
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
    const owner = randomUUID(),
      actor = randomUUID(),
      other = randomUUID(),
      space = randomUUID();
    const native = async (
      tx: PoolClient,
      enroll: boolean,
      change: {
        wrongOwner?: boolean;
        wrongRequest?: boolean;
        omitState?: boolean;
        priorSave?: boolean;
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
        "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','SQL native publication proof','named','open')",
        [post, space, owner],
      );
      await tx.query(
        "INSERT INTO whaleu_community.report_origins(kind,target_id,owner_account_id,source_request_id,provenance) VALUES('post',$1,$2,$3,'native_publication')",
        [post, owner, request],
      );
      if (change.priorSave) await save(tx, post);
      if (enroll) {
        await tx.query(
          'INSERT INTO whaleu_post_hotness.subscription_baselines(post_id,owner_id,source_request_id) VALUES($1,$2,$3)',
          [
            post,
            change.wrongOwner ? other : owner,
            change.wrongRequest ? randomUUID() : request,
          ],
        );
        if (!change.omitState)
          await tx.query(
            'INSERT INTO whaleu_post_hotness.subscription_states(post_id) VALUES($1)',
            [post],
          );
      }
      return { post, request };
    };
    const save = async (
      tx: PoolClient,
      post: string,
      opts: {
        noObligation?: boolean;
        wrongRecipient?: boolean;
        bornEnded?: boolean;
        saver?: string;
      } = {},
    ) => {
      await tx.query(
        'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
        [post],
      );
      const saver = opts.saver ?? actor;
      const epoch = randomUUID(),
        obligation = randomUUID();
      const seq = (
        await tx.query<{ n: string }>(
          "SELECT nextval('whaleu_community.discussion_sequence') n",
        )
      ).rows[0]!.n;
      await tx.query(
        'INSERT INTO whaleu_community.saved_posts(account_id,post_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [saver, post],
      );
      await tx.query(
        `INSERT INTO whaleu_community.saved_epochs(id,account_id,post_id,started_at,started_sequence,ended_at,ended_sequence) VALUES($1,$2,$3,now(),$4,${opts.bornEnded ? 'now()' : 'NULL'},${opts.bornEnded ? '$4::bigint+1' : 'NULL'})`,
        [epoch, saver, post, seq],
      );
      if (!opts.bornEnded)
        await tx.query(
          'UPDATE whaleu_community.saved_posts SET epoch_id=$3,saved_at=now(),revision=$4 WHERE account_id=$1 AND post_id=$2',
          [saver, post, epoch, seq],
        );
      if (!opts.noObligation)
        await tx.query(
          "INSERT INTO whaleu_community.saved_obligations(id,epoch_id,transition,action,recipient_account_id,delta) VALUES($1,$2,'saved','save_ranking',$3,1)",
          [obligation, epoch, opts.wrongRecipient ? other : owner],
        );
      return { epoch, obligation, post, seq, saver };
    };
    type Source = Awaited<ReturnType<typeof save>>;
    const end = async (tx: PoolClient, s: Source, noObligation = false) => {
      await tx.query(
        'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
        [s.post],
      );
      const seq = (
        await tx.query<{ n: string }>(
          "SELECT nextval('whaleu_community.discussion_sequence') n",
        )
      ).rows[0]!.n;
      await tx.query(
        'UPDATE whaleu_community.saved_epochs SET ended_at=now(),ended_sequence=$2 WHERE id=$1',
        [s.epoch, seq],
      );
      await tx.query(
        'UPDATE whaleu_community.saved_posts SET epoch_id=NULL,saved_at=NULL,revision=$3 WHERE account_id=$1 AND post_id=$2',
        [s.saver, s.post, seq],
      );
      const obligation = randomUUID();
      if (!noObligation)
        await tx.query(
          "INSERT INTO whaleu_community.saved_obligations(id,epoch_id,transition,action,recipient_account_id,delta) VALUES($1,$2,'unsaved','save_ranking',$3,-1)",
          [obligation, s.epoch, owner],
        );
      return { ...s, seq, obligation };
    };
    const apply = async (
      tx: PoolClient,
      s: Source,
      negative = false,
      omit?: 'state' | 'member' | 'ack',
      badCount = false,
    ) => {
      const state = (
        await tx.query(
          'SELECT * FROM whaleu_post_hotness.subscription_states WHERE post_id=$1',
          [s.post],
        )
      ).rows[0]!;
      const member = (
        await tx.query(
          'SELECT * FROM whaleu_post_hotness.subscription_memberships WHERE post_id=$1 AND actor_id=$2',
          [s.post, s.saver],
        )
      ).rows[0];
      const after = (
        BigInt(state.count) +
        (negative ? -1n : 1n) +
        (badCount ? 1n : 0n)
      ).toString();
      await tx.query(
        `INSERT INTO whaleu_post_hotness.subscription_receipts(obligation_id,epoch_id,transition,post_id,actor_id,source_sequence,delta,before_count,after_count,previous_state_sequence,previous_membership_sequence,previous_membership_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          s.obligation,
          s.epoch,
          negative ? 'unsaved' : 'saved',
          s.post,
          s.saver,
          s.seq,
          negative ? -1 : 1,
          state.count,
          after,
          state.last_sequence,
          member?.last_sequence ?? '0',
          member?.active_epoch_id ?? null,
        ],
      );
      if (omit !== 'state')
        await tx.query(
          'UPDATE whaleu_post_hotness.subscription_states SET count=$2,last_sequence=$3,last_receipt_id=$4 WHERE post_id=$1',
          [s.post, after, s.seq, s.obligation],
        );
      if (omit !== 'member') {
        if (member)
          await tx.query(
            'UPDATE whaleu_post_hotness.subscription_memberships SET active_epoch_id=$3,last_sequence=$4,last_receipt_id=$5 WHERE post_id=$1 AND actor_id=$2',
            [s.post, s.saver, negative ? null : s.epoch, s.seq, s.obligation],
          );
        else
          await tx.query(
            'INSERT INTO whaleu_post_hotness.subscription_memberships(post_id,actor_id,active_epoch_id,last_sequence,last_receipt_id) VALUES($1,$2,$3,$4,$5)',
            [s.post, s.saver, s.epoch, s.seq, s.obligation],
          );
      }
      if (omit !== 'ack')
        await tx.query(
          "UPDATE whaleu_community.saved_obligations SET status='completed' WHERE id=$1",
          [s.obligation],
        );
    };
    const rejects = async (fn: (tx: PoolClient) => Promise<unknown>) =>
      assert.rejects(inTransaction(pool, fn), constraint);
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
        migrations.filter((m) => m.name < '0026'),
        { mode: 'up' },
      );
      for (const id of [owner, actor, other])
        await pool.query(
          'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
          [id],
        );
      await withCommunityScopeWriter(pool, (tx) =>
        tx.query(
          "INSERT INTO whaleu_community.spaces(id,kind,name) VALUES($1,'global','SQL proof')",
          [space],
        ),
      );
      const historical = await inTransaction(pool, (tx) => native(tx, false));
      const historicalSave = await inTransaction(pool, (tx) =>
        save(tx, historical.post),
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      await t.test(
        'genuine old native post and historical obligation remain unknown',
        async () => {
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_post_hotness.subscription_baselines',
              )
            ).rowCount,
            0,
          );
          await rejects((tx) =>
            tx.query(
              'INSERT INTO whaleu_post_hotness.subscription_baselines(post_id,owner_id,source_request_id) VALUES($1,$2,$3)',
              [historical.post, owner, historical.request],
            ),
          );
          await rejects((tx) =>
            tx.query(
              "UPDATE whaleu_community.saved_obligations SET status='completed' WHERE id=$1",
              [historicalSave.obligation],
            ),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT status FROM whaleu_community.saved_obligations WHERE id=$1',
                [historicalSave.obligation],
              )
            ).rows[0]!.status,
            'pending',
          );
        },
      );
      for (const [name, change] of Object.entries({
        wrongOwner: { wrongOwner: true },
        wrongRequest: { wrongRequest: true },
        missingState: { omitState: true },
        priorSave: { priorSave: true },
      }))
        await t.test(`baseline rejects ${name}`, () =>
          rejects((tx) => native(tx, true, change)),
        );
      await t.test('deferred native origin guard rejects hook bypass', () =>
        rejects((tx) => native(tx, false)),
      );
      const fresh = await inTransaction(pool, (tx) => native(tx, true));
      for (const [name, opts] of Object.entries({
        missingObligation: { noObligation: true },
        wrongRecipient: { wrongRecipient: true },
        bornEnded: { bornEnded: true },
      }))
        await t.test(`actual source rejects ${name}`, () =>
          rejects((tx) => save(tx, fresh.post, opts)),
        );
      const positive = await inTransaction(pool, (tx) => save(tx, fresh.post));
      await t.test(
        'actual unsave cannot commit without matching ranking obligation',
        () => rejects((tx) => end(tx, positive, true)),
      );
      await t.test(
        'negative obligation cannot be fabricated before actual ending',
        () =>
          rejects((tx) =>
            tx.query(
              "INSERT INTO whaleu_community.saved_obligations(id,epoch_id,transition,action,recipient_account_id,delta) VALUES($1,$2,'unsaved','save_ranking',$3,-1)",
              [randomUUID(), positive.epoch, owner],
            ),
          ),
      );
      const negative = await inTransaction(pool, (tx) => end(tx, positive));
      const laterPositive = await inTransaction(pool, (tx) =>
        save(tx, fresh.post, { saver: other }),
      );
      await t.test(
        'later positive cannot bypass earlier unresolved source',
        () => rejects((tx) => apply(tx, laterPositive)),
      );
      await t.test(
        'negative transition has actual ending transaction, not epoch creation stamp',
        async () => {
          const rows = (
            await pool.query(
              'SELECT s.transition,s.source_transaction::text,e.local_creation_transaction::text FROM whaleu_post_hotness.subscription_sources s JOIN whaleu_community.saved_epochs e ON e.id=s.epoch_id WHERE s.epoch_id=$1 ORDER BY s.source_sequence',
              [positive.epoch],
            )
          ).rows;
          assert.equal(rows.length, 2);
          assert.equal(
            rows[0]!.source_transaction,
            rows[0]!.local_creation_transaction,
          );
          assert.notEqual(
            rows[1]!.source_transaction,
            rows[1]!.local_creation_transaction,
          );
        },
      );
      await t.test('direct fabricated source rejected', () =>
        rejects((tx) =>
          tx.query(
            "INSERT INTO whaleu_post_hotness.subscription_sources(epoch_id,transition,post_id,actor_id,source_sequence) VALUES($1,'saved',$2,$3,999999)",
            [positive.epoch, fresh.post, actor],
          ),
        ),
      );
      await t.test('negative cannot jump unresolved positive', () =>
        rejects((tx) => apply(tx, negative, true)),
      );
      for (const status of ['completed', 'suppressed', 'failed'])
        await t.test(`ack-only ${status} rejected`, () =>
          rejects((tx) =>
            tx.query(
              'UPDATE whaleu_community.saved_obligations SET status=$2 WHERE id=$1',
              [positive.obligation, status],
            ),
          ),
        );
      for (const omitted of ['state', 'member', 'ack'] as const)
        await t.test(
          `missing ${omitted} rolls receipt and all effects back`,
          async () => {
            await rejects((tx) => apply(tx, positive, false, omitted));
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_post_hotness.subscription_receipts',
                )
              ).rowCount,
              0,
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
          },
        );
      await t.test('invented count rejected', () =>
        rejects((tx) => apply(tx, positive, false, undefined, true)),
      );
      await t.test('effect-only rejected', () =>
        rejects((tx) =>
          tx.query(
            'UPDATE whaleu_post_hotness.subscription_states SET count=1 WHERE post_id=$1',
            [fresh.post],
          ),
        ),
      );
      await inTransaction(pool, (tx) => apply(tx, positive));
      await t.test(
        'ended epoch positive still applies before negative',
        async () => {
          assert.equal(
            (
              await pool.query(
                'SELECT count FROM whaleu_post_hotness.subscription_states WHERE post_id=$1',
                [fresh.post],
              )
            ).rows[0]!.count,
            '1',
          );
          await inTransaction(pool, (tx) => apply(tx, negative, true));
          assert.equal(
            (
              await pool.query(
                'SELECT count FROM whaleu_post_hotness.subscription_states WHERE post_id=$1',
                [fresh.post],
              )
            ).rows[0]!.count,
            '0',
          );
        },
      );
      await t.test(
        'receipt, baseline and membership retained/immutable',
        async () => {
          await rejects((tx) =>
            tx.query(
              'DELETE FROM whaleu_post_hotness.subscription_receipts WHERE obligation_id=$1',
              [positive.obligation],
            ),
          );
          await rejects((tx) =>
            tx.query(
              'UPDATE whaleu_post_hotness.subscription_baselines SET opening_count=0 WHERE post_id=$1',
              [fresh.post],
            ),
          );
          await rejects((tx) =>
            tx.query(
              'DELETE FROM whaleu_post_hotness.subscription_memberships WHERE post_id=$1',
              [fresh.post],
            ),
          );
          await rejects((tx) =>
            tx.query(
              "UPDATE whaleu_community.saved_obligations SET status='pending' WHERE id=$1",
              [positive.obligation],
            ),
          );
        },
      );
      await inTransaction(pool, (tx) => apply(tx, laterPositive));
      const resave = await inTransaction(pool, (tx) => save(tx, fresh.post));
      await inTransaction(pool, (tx) => apply(tx, resave));
      await t.test(
        'retained membership advances to the next epoch',
        async () => {
          assert.equal(
            (
              await pool.query(
                'SELECT active_epoch_id FROM whaleu_post_hotness.subscription_memberships WHERE post_id=$1',
                [fresh.post],
              )
            ).rows[0]!.active_epoch_id,
            resave.epoch,
          );
        },
      );
      await t.test(
        'unrelated author interaction actions preserve prior completion contract',
        async () => {
          const id = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_community.saved_obligations(id,epoch_id,transition,action,recipient_account_id,delta) VALUES($1,$2,'saved','author_interactions',$3,1)",
            [id, resave.epoch, owner],
          );
          await pool.query(
            "UPDATE whaleu_community.saved_obligations SET status='completed' WHERE id=$1",
            [id],
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
