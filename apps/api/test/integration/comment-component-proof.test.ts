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
import { CommunitySubscriptionEnrollment } from '../../src/community/subscription-component/enrollment.js';
import { CommunityLikeEnrollment } from '../../src/community/like-component/enrollment.js';
import { CommunityViewEnrollment } from '../../src/community/view-component/enrollment.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import type { CommentSource } from '../support/comment-component-fixture.js';
const constraint = (e: unknown) =>
  !!e &&
  typeof e === 'object' &&
  'code' in e &&
  ['23514', '23503', '23505'].includes(String(e.code));

test(
  'comment SQL: independent fresh proof, invisible parents, retained identity and exact deferred causal closure',
  { timeout: 120000 },
  async (t) => {
    const url = process.env['TEST_DATABASE_URL'];
    assert.ok(
      url,
      'Requires disposable TEST_DATABASE_URL; never silently skipped',
    );
    const parsed = new URL(url);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
    assert.equal(parsed.pathname, '/whaleu_test');
    const pool = new Pool({ connectionString: url, ssl: false }),
      suite = await pool.connect();
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
    const subscriptions = new CommunitySubscriptionEnrollment(),
      likes = new CommunityLikeEnrollment(),
      views = new CommunityViewEnrollment();
    const rejects = (fn: (tx: PoolClient) => Promise<unknown>) =>
      assert.rejects(inTransaction(pool, fn), constraint);
    const rawRoot = async (
      tx: PoolClient,
      post: string,
      id = randomUUID(),
      account = actor,
      tombstone = false,
    ) => {
      await tx.query(
        "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode,deleted_at) VALUES($1,$2,$3,'Synthetic comment SQL proof','named',$4)",
        [id, post, account, tombstone ? new Date() : null],
      );
      return id;
    };
    const rawReply = async (
      tx: PoolClient,
      post: string,
      root: string,
      id = randomUUID(),
      account = actor,
      tombstone = false,
    ) => {
      await tx.query(
        "INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,account_id,text,author_mode,deleted_at) VALUES($1,$2,$3,$4,'Synthetic reply SQL proof','named',$5)",
        [id, post, root, account, tombstone ? new Date() : null],
      );
      return id;
    };
    const native = async (
      tx: PoolClient,
      comments: boolean,
      patch: {
        wrongOwner?: boolean;
        wrongRequest?: boolean;
        wrongReceipt?: boolean;
        omitState?: boolean;
        nonzero?: boolean;
        priorRoot?: boolean;
        priorReply?: boolean;
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
            resourceId: patch.wrongReceipt ? randomUUID() : post,
            createdAt: new Date().toISOString(),
          },
        ],
      );
      await tx.query(
        "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic comment SQL baseline','named','open')",
        [post, space, owner],
      );
      await tx.query(
        "INSERT INTO whaleu_community.report_origins(kind,target_id,owner_account_id,source_request_id,provenance) VALUES('post',$1,$2,$3,'native_publication')",
        [post, owner, request],
      );
      const canonical = {
        postId: post,
        ownerId: owner,
        publicationRequestId: request,
      };
      await subscriptions.enrollPublishedPost(canonical, tx);
      await likes.enrollPublishedPost(canonical, tx);
      await views.enrollPublishedPost(canonical, tx);
      if (patch.priorRoot || patch.priorReply) {
        const root = await rawRoot(tx, post);
        if (patch.priorReply) await rawReply(tx, post, root);
      }
      if (comments) {
        await tx.query(
          'INSERT INTO whaleu_post_hotness.comment_baselines(post_id,owner_id,source_request_id,opening_root_count) VALUES($1,$2,$3,$4)',
          [
            post,
            patch.wrongOwner ? other : owner,
            patch.wrongRequest ? randomUUID() : request,
            patch.nonzero ? 1 : 0,
          ],
        );
        if (!patch.omitState)
          await tx.query(
            'INSERT INTO whaleu_post_hotness.comment_states(post_id) VALUES($1)',
            [post],
          );
      }
      return { post, request };
    };
    const sources = async (post: string) =>
      (
        await pool.query<CommentSource>(
          'SELECT * FROM whaleu_post_hotness.comment_sources WHERE post_id=$1 ORDER BY source_sequence',
          [post],
        )
      ).rows;
    const addRoot = async (post: string, who = actor) =>
      inTransaction(pool, async (tx) => {
        await tx.query(
          'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
          [post],
        );
        return rawRoot(tx, post, randomUUID(), who);
      });
    const state = async (post: string) =>
      (
        await pool.query(
          'SELECT * FROM whaleu_post_hotness.comment_states WHERE post_id=$1',
          [post],
        )
      ).rows[0]!;
    const apply = async (
      tx: PoolClient,
      s: CommentSource,
      options: {
        omit?: 'state' | 'contribution' | 'member';
        patch?: Record<string, unknown>;
      } = {},
    ) => {
      await tx.query(
        'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
        [s.post_id],
      );
      const st = (
        await tx.query(
          'SELECT * FROM whaleu_post_hotness.comment_states WHERE post_id=$1',
          [s.post_id],
        )
      ).rows[0]!;
      const content = (
        await tx.query(
          'SELECT * FROM whaleu_post_hotness.comment_contributions WHERE post_id=$1 AND kind=$2 AND content_id=$3',
          [s.post_id, s.kind, s.content_id],
        )
      ).rows[0];
      const member = (
        await tx.query(
          'SELECT * FROM whaleu_post_hotness.comment_memberships WHERE post_id=$1 AND actor_id=$2',
          [s.post_id, s.actor_id],
        )
      ).rows[0];
      const eligible = s.actor_id !== owner,
        beforeActor = BigInt(member?.active_count ?? '0'),
        afterActor = beforeActor + BigInt(s.delta);
      const after = {
        root_count: (
          BigInt(st.root_count) + (s.kind === 'root' ? BigInt(s.delta) : 0n)
        ).toString(),
        reply_count: (
          BigInt(st.reply_count) + (s.kind === 'reply' ? BigInt(s.delta) : 0n)
        ).toString(),
        eligible_count: (
          BigInt(st.eligible_count) + (eligible ? BigInt(s.delta) : 0n)
        ).toString(),
        unique_actor_count: (
          BigInt(st.unique_actor_count) +
          (eligible
            ? beforeActor === 0n
              ? 1n
              : afterActor === 0n
                ? -1n
                : 0n
            : 0n)
        ).toString(),
      };
      const receipt: Record<string, unknown> = {
        source_id: s.id,
        post_id: s.post_id,
        actor_id: s.actor_id,
        kind: s.kind,
        content_id: s.content_id,
        root_id: s.root_id,
        transition: s.transition,
        source_sequence: s.source_sequence,
        positive_source_id: s.positive_source_id,
        eligible,
        delta: s.delta,
        before_root_count: st.root_count,
        after_root_count: after.root_count,
        before_reply_count: st.reply_count,
        after_reply_count: after.reply_count,
        before_eligible_count: st.eligible_count,
        after_eligible_count: after.eligible_count,
        before_unique_actor_count: st.unique_actor_count,
        after_unique_actor_count: after.unique_actor_count,
        before_actor_count: beforeActor.toString(),
        after_actor_count: afterActor.toString(),
        previous_state_sequence: st.last_sequence,
        previous_contribution_sequence: content?.last_sequence ?? '0',
        previous_contribution_active: content?.active ?? null,
        previous_membership_sequence: member?.last_sequence ?? '0',
        ...options.patch,
      };
      await tx.query(
        `INSERT INTO whaleu_post_hotness.comment_receipts(${Object.keys(receipt).join(',')}) VALUES(${Object.keys(
          receipt,
        )
          .map((_, i) => `$${i + 1}`)
          .join(',')})`,
        Object.values(receipt),
      );
      if (options.omit !== 'state')
        await tx.query(
          'UPDATE whaleu_post_hotness.comment_states SET root_count=$2,reply_count=$3,eligible_count=$4,unique_actor_count=$5,last_sequence=$6,last_receipt_id=$7 WHERE post_id=$1',
          [
            s.post_id,
            after.root_count,
            after.reply_count,
            after.eligible_count,
            after.unique_actor_count,
            s.source_sequence,
            s.id,
          ],
        );
      if (options.omit !== 'contribution') {
        if (content)
          await tx.query(
            'UPDATE whaleu_post_hotness.comment_contributions SET active=false,last_sequence=$4,last_receipt_id=$5 WHERE post_id=$1 AND kind=$2 AND content_id=$3',
            [s.post_id, s.kind, s.content_id, s.source_sequence, s.id],
          );
        else
          await tx.query(
            'INSERT INTO whaleu_post_hotness.comment_contributions(post_id,kind,content_id,root_id,actor_id,eligible,active,positive_source_id,last_sequence,last_receipt_id) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$7)',
            [
              s.post_id,
              s.kind,
              s.content_id,
              s.root_id,
              s.actor_id,
              eligible,
              s.id,
              s.source_sequence,
            ],
          );
      }
      if (options.omit !== 'member') {
        if (member)
          await tx.query(
            'UPDATE whaleu_post_hotness.comment_memberships SET active_count=$3,last_sequence=$4,last_receipt_id=$5 WHERE post_id=$1 AND actor_id=$2',
            [
              s.post_id,
              s.actor_id,
              afterActor.toString(),
              s.source_sequence,
              s.id,
            ],
          );
        else
          await tx.query(
            'INSERT INTO whaleu_post_hotness.comment_memberships(post_id,actor_id,active_count,last_sequence,last_receipt_id) VALUES($1,$2,$3,$4,$5)',
            [
              s.post_id,
              s.actor_id,
              afterActor.toString(),
              s.source_sequence,
              s.id,
            ],
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
        migrations.filter((m) => m.name < '0031'),
        { mode: 'up' },
      );
      for (const id of [owner, actor, other])
        await pool.query(
          'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
          [id],
        );
      await withCommunityScopeWriter(pool, (tx) =>
        tx.query(
          "INSERT INTO whaleu_community.spaces(id,kind,name) VALUES($1,'global','Synthetic comment SQL proof')",
          [space],
        ),
      );
      const historical = await inTransaction(pool, (tx) => native(tx, false)),
        historicalRoot = await addRoot(historical.post);
      await runMigrations(pool, migrations, { mode: 'up' });
      await t.test(
        'pre-slice view/like/subscription-known native post stays comment-unknown through later root/reply creation and deletion',
        async () => {
          for (const component of ['subscription', 'like', 'view'])
            assert.equal(
              (
                await pool.query(
                  `SELECT 1 FROM whaleu_post_hotness.${component}_baselines WHERE post_id=$1`,
                  [historical.post],
                )
              ).rowCount,
              1,
            );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_post_hotness.comment_baselines',
              )
            ).rowCount,
            0,
          );
          await rejects((tx) =>
            tx.query(
              'INSERT INTO whaleu_post_hotness.comment_baselines(post_id,owner_id,source_request_id) VALUES($1,$2,$3)',
              [historical.post, owner, historical.request],
            ),
          );
          await inTransaction(pool, async (tx) => {
            await rawReply(tx, historical.post, historicalRoot);
            await tx.query(
              'UPDATE whaleu_community.root_comments SET deleted_at=clock_timestamp() WHERE id=$1',
              [historicalRoot],
            );
          });
          assert.deepEqual(await sources(historical.post), []);
        },
      );
      for (const [name, patch] of Object.entries({
        wrongOwner: { wrongOwner: true },
        wrongRequest: { wrongRequest: true },
        wrongReceipt: { wrongReceipt: true },
        missingState: { omitState: true },
        nonzero: { nonzero: true },
        priorRoot: { priorRoot: true },
        priorReply: { priorReply: true },
      }))
        await t.test(`fresh independent baseline rejects ${name}`, () =>
          rejects((tx) => native(tx, true, patch)),
        );
      await t.test(
        'deferred fresh publication refuses missing comment enrollment',
        () => rejects((tx) => native(tx, false)),
      );
      for (const isolation of ['READ COMMITTED', 'REPEATABLE READ'])
        for (const kind of ['root', 'reply'])
          await t.test(
            `invisible newborn parent rejects raw ${kind} before saved-order/FK wait at ${isolation}`,
            async () => {
              const publisher = await pool.connect(),
                writer = await pool.connect();
              try {
                await publisher.query('BEGIN');
                const newborn = await native(publisher, true),
                  root = randomUUID(),
                  child = randomUUID();
                if (kind === 'reply')
                  await rawRoot(publisher, newborn.post, root);
                await writer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
                await writer.query("SET LOCAL statement_timeout='2s'");
                await assert.rejects(
                  kind === 'root'
                    ? rawRoot(writer, newborn.post, child)
                    : rawReply(writer, newborn.post, root, child),
                  constraint,
                );
                await writer.query('ROLLBACK');
                await publisher.query("SET LOCAL statement_timeout='2s'");
                if (kind === 'root')
                  await rawRoot(publisher, newborn.post, child);
                else await rawReply(publisher, newborn.post, root, child);
                await publisher.query('COMMIT');
                assert.equal(
                  (await sources(newborn.post)).length,
                  kind === 'root' ? 1 : 2,
                );
              } finally {
                await publisher.query('ROLLBACK');
                await writer.query('ROLLBACK');
                publisher.release();
                writer.release();
              }
            },
          );
      const fresh = await inTransaction(pool, (tx) => native(tx, true)),
        first = await addRoot(fresh.post),
        positive = (await sources(fresh.post))[0]!;
      await t.test(
        'source capture BEFORE order precedes saved order, AFTER sees final creation stamp',
        async () => {
          for (const table of ['root_comments', 'replies']) {
            const triggers = (
              await pool.query(
                'SELECT tgname FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal AND tgtype::integer & 2=2 AND tgtype::integer & 4=4 ORDER BY tgname',
                [`whaleu_community.${table}`],
              )
            ).rows.map((row) => row.tgname);
            assert.ok(
              triggers.indexOf('a_comment_content_guard') <
                triggers.indexOf('saved_discussion_order'),
            );
          }
          const stored = (
            await pool.query(
              'SELECT local_creation_transaction::text FROM whaleu_community.root_comments WHERE id=$1',
              [first],
            )
          ).rows[0]!;
          assert.equal(
            positive.source_transaction,
            stored.local_creation_transaction,
          );
        },
      );
      await inTransaction(pool, async (tx) => {
        await tx.query(
          'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
          [fresh.post],
        );
        await tx.query(
          'UPDATE whaleu_community.root_comments SET deleted_at=clock_timestamp() WHERE id=$1',
          [first],
        );
      });
      const negative = (await sources(fresh.post))[1]!;
      await t.test(
        'negative uses exact retained positive and actual later deletion xid; same tombstone is source-free',
        async () => {
          assert.equal(negative.positive_source_id, positive.id);
          assert.notEqual(
            negative.source_transaction,
            positive.source_transaction,
          );
          const stored = (
            await pool.query(
              'SELECT local_deletion_transaction::text FROM whaleu_community.root_comments WHERE id=$1',
              [first],
            )
          ).rows[0]!;
          assert.equal(
            negative.source_transaction,
            stored.local_deletion_transaction,
          );
          await pool.query(
            'UPDATE whaleu_community.root_comments SET deleted_at=deleted_at WHERE id=$1',
            [first],
          );
          assert.equal((await sources(fresh.post)).length, 2);
        },
      );
      const second = await addRoot(fresh.post),
        third = await addRoot(fresh.post, other),
        rows = await sources(fresh.post);
      for (const source of rows.slice(1))
        await t.test(
          `later ${source.transition} cannot bypass unresolved first source`,
          () => rejects((tx) => apply(tx, source)),
        );
      for (const omit of ['state', 'contribution', 'member'] as const)
        await t.test(
          `deferred closure rejects missing ${omit} effect and rolls back all`,
          async () => {
            await rejects((tx) => apply(tx, positive, { omit }));
            assert.equal((await state(fresh.post)).root_count, '0');
            for (const table of [
              'comment_receipts',
              'comment_contributions',
              'comment_memberships',
            ])
              assert.equal(
                (
                  await pool.query(
                    `SELECT 1 FROM whaleu_post_hotness.${table} WHERE post_id=$1`,
                    [fresh.post],
                  )
                ).rowCount,
                0,
              );
          },
        );
      for (const patch of [
        { actor_id: other },
        { post_id: historical.post },
        { kind: 'reply', root_id: first },
        { content_id: second },
        { delta: -1 },
        { source_sequence: '999999999' },
        { positive_source_id: positive.id },
        { eligible: false },
        { before_root_count: '1', after_root_count: '2' },
        { after_root_count: '2' },
        { before_actor_count: '1', after_actor_count: '2' },
        { previous_contribution_sequence: '1' },
        { previous_contribution_active: false },
        { previous_membership_sequence: '1' },
      ])
        await t.test(
          `receipt rejects forged exact proof ${Object.keys(patch).join(',')}`,
          () => rejects((tx) => apply(tx, positive, { patch })),
        );
      for (const transition of ['created', 'deleted'])
        await t.test(
          `direct ${transition} source cannot forge transaction, sequence or positive proof`,
          () =>
            rejects((tx) =>
              tx.query(
                "INSERT INTO whaleu_post_hotness.comment_sources(post_id,actor_id,kind,content_id,transition,delta,source_sequence,source_transaction,positive_source_id) VALUES($1,$2,'root',$3,$4,$5,999999,pg_current_xact_id(),$6)",
                [
                  fresh.post,
                  actor,
                  third,
                  transition,
                  transition === 'created' ? 1 : -1,
                  transition === 'created' ? null : positive.id,
                ],
              ),
            ),
        );
      await t.test(
        'state without receipt and two effects for one post/transaction reject',
        async () => {
          await rejects((tx) =>
            tx.query(
              'UPDATE whaleu_post_hotness.comment_states SET root_count=1 WHERE post_id=$1',
              [fresh.post],
            ),
          );
          await rejects(async (tx) => {
            await apply(tx, positive);
            await apply(tx, negative);
          });
        },
      );
      for (const [source, expected] of [
        [positive, ['1', '1', '1']],
        [negative, ['0', '0', '0']],
        [rows[2]!, ['1', '1', '1']],
        [rows[3]!, ['2', '2', '2']],
      ] as const) {
        if (source.id === negative.id)
          await t.test(
            'deletion receipt cannot substitute another live contribution positive source',
            () =>
              rejects((tx) =>
                apply(tx, negative, {
                  patch: { positive_source_id: rows[2]!.id },
                }),
              ),
          );
        await inTransaction(pool, (tx) => apply(tx, source));
        const st = await state(fresh.post);
        assert.deepEqual(
          [st.root_count, st.eligible_count, st.unique_actor_count],
          expected,
        );
      }
      await t.test(
        'derived cardinality, content eligibility and retained source cannot be directly rewritten',
        async () => {
          await rejects((tx) =>
            tx.query(
              'UPDATE whaleu_post_hotness.comment_memberships SET active_count=active_count+1 WHERE post_id=$1 AND actor_id=$2',
              [fresh.post, actor],
            ),
          );
          await rejects((tx) =>
            tx.query(
              'UPDATE whaleu_post_hotness.comment_contributions SET eligible=false WHERE post_id=$1 AND content_id=$2',
              [fresh.post, second],
            ),
          );
          await rejects((tx) =>
            tx.query(
              'UPDATE whaleu_post_hotness.comment_sources SET source_transaction=pg_current_xact_id() WHERE id=$1',
              [positive.id],
            ),
          );
          await rejects((tx) =>
            tx.query(
              'UPDATE whaleu_post_hotness.comment_receipts SET after_actor_count=3 WHERE source_id=$1',
              [positive.id],
            ),
          );
        },
      );
      await t.test(
        'old negative cannot consume newer content of the same actor',
        async () => {
          await rejects((tx) => apply(tx, negative));
          assert.equal((await state(fresh.post)).root_count, '2');
          assert.equal(
            (
              await pool.query(
                'SELECT active FROM whaleu_post_hotness.comment_contributions WHERE post_id=$1 AND content_id=$2',
                [fresh.post, second],
              )
            ).rows[0]!.active,
            true,
          );
        },
      );
      const reply = await inTransaction(pool, async (tx) => {
        await tx.query(
          'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
          [fresh.post],
        );
        return rawReply(tx, fresh.post, second);
      });
      for (const kind of ['root', 'reply'] as const) {
        const table = kind === 'root' ? 'root_comments' : 'replies',
          id = kind === 'root' ? second : reply;
        await t.test(
          `${kind} identity, hard delete, predeleted insert and truncation reject`,
          async () => {
            await rejects((tx) =>
              tx.query(
                `UPDATE whaleu_community.${table} SET account_id=$2 WHERE id=$1`,
                [id, other],
              ),
            );
            await rejects((tx) =>
              tx.query(`DELETE FROM whaleu_community.${table} WHERE id=$1`, [
                id,
              ]),
            );
            await rejects((tx) =>
              kind === 'root'
                ? rawRoot(tx, fresh.post, randomUUID(), actor, true)
                : rawReply(tx, fresh.post, second, randomUUID(), actor, true),
            );
            await rejects((tx) =>
              tx.query(`TRUNCATE whaleu_community.${table} CASCADE`),
            );
          },
        );
        await inTransaction(pool, async (tx) => {
          await tx.query(
            'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
            [fresh.post],
          );
          await tx.query(
            `UPDATE whaleu_community.${table} SET deleted_at=clock_timestamp() WHERE id=$1`,
            [id],
          );
        });
        await t.test(
          `${kind} resurrection or changed tombstone reject; same-value remains source-free`,
          async () => {
            const before = (await sources(fresh.post)).length;
            await rejects((tx) =>
              tx.query(
                `UPDATE whaleu_community.${table} SET deleted_at=NULL WHERE id=$1`,
                [id],
              ),
            );
            await rejects((tx) =>
              tx.query(
                `UPDATE whaleu_community.${table} SET deleted_at=deleted_at+interval '1 second' WHERE id=$1`,
                [id],
              ),
            );
            await pool.query(
              `UPDATE whaleu_community.${table} SET deleted_at=deleted_at WHERE id=$1`,
              [id],
            );
            assert.equal((await sources(fresh.post)).length, before);
          },
        );
      }
      await t.test('baseline owner drift fails closed', () =>
        rejects((tx) =>
          tx.query(
            'UPDATE whaleu_community.posts SET account_id=$2 WHERE id=$1',
            [fresh.post, other],
          ),
        ),
      );
      for (const table of [
        'comment_baselines',
        'comment_sources',
        'comment_receipts',
        'comment_states',
        'comment_contributions',
        'comment_memberships',
      ]) {
        await t.test(
          `${table} retains deletion and truncation proof`,
          async () => {
            await rejects((tx) =>
              tx.query(
                `DELETE FROM whaleu_post_hotness.${table} WHERE post_id=$1`,
                [fresh.post],
              ),
            );
            await rejects((tx) =>
              tx.query(`TRUNCATE whaleu_post_hotness.${table} CASCADE`),
            );
          },
        );
      }
    } finally {
      if (owns)
        for (const schema of migrationSchemaNames)
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
