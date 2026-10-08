import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { inTransaction } from '../../src/database/database.js';
import {
  validateHotScoreSnapshot,
  type HotScoreSnapshot,
  type HotScoreBaseline,
  type HotScoreAsyncState,
} from '../../src/community/hot-score/contracts.js';
import {
  assertComputed,
  components,
  hotScoreFixture,
  scoreInTransaction,
} from '../support/hot-score-fixture.js';

const constraint = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  ['23514', '23503'].includes(String(error.code));

test(
  'internal score composition: independent coverage, immutable settlement proofs and exact component semantics',
  { timeout: 180000 },
  async (t) => {
    const f = await hotScoreFixture();
    try {
      const author = await f.actor(),
        a = await f.actor(),
        b = await f.actor();
      await t.test(
        'fresh known zero, unknown old post and missing post remain distinct with no mutation',
        async () => {
          const post = await f.publish(author),
            old = await f.rawUnknown(author),
            missing = randomUUID();
          const before = await f.snapshot();
          for (const mode of ['dry-run', 'compute'] as const) {
            const result = await f.service.inspect(post.id, mode);
            assertComputed(result);
            assert.equal(result.score, '0.0000');
            assert.equal(result.advisory, mode === 'dry-run');
            assert.equal(result.sourceFormulaVersion, 6);
            assert.equal(result.numericProfile, 'pg18-numeric40-round4-v1');
            assert.equal(result.numericProfileVersion, 1);
            assert.match(result.formulaFingerprint, /^[0-9a-f]{64}$/);
            assert.match(result.expressionFingerprint, /^[0-9a-f]{64}$/);
            assert.equal(result.viewCoverage, 'synchronous_accepted_aggregate');
            assert.equal(
              result.viewIntegrity,
              'trusted_reporting_owner_and_access_controls',
            );
            for (const component of components) {
              const baseline: HotScoreBaseline =
                result.snapshot.baselines[component]!;
              assert.equal(baseline.componentVersion, 1);
              assert.equal(baseline.postId, post.id);
              assert.equal(baseline.ownerId, author.accountId);
              assert.equal(baseline.sourceRequestId, post.body.clientRequestId);
              assert.equal(baseline.creationXid, result.snapshot.creationXid);
            }
            for (const component of [
              'subscription',
              'like',
              'comment',
            ] as const) {
              const state: HotScoreAsyncState =
                result.snapshot.states[component]!;
              assert.equal(state.processedHead, '0');
              assert.equal(state.capturedHead, '0');
              assert.equal(state.lastReceiptId, null);
              assert.equal(state.unresolvedSequence, null);
              assert.equal(state.terminalReceiptValid, true);
            }
            assert.equal(
              (await f.service.inspect(old, mode)).status,
              'blockedCoverage',
            );
            assert.equal(
              (await f.service.inspect(missing, mode)).status,
              'missing',
            );
          }
          assert.deepEqual(
            await f.snapshot(),
            before,
            'Read-only dry-run and lock-taking compute change no tables or sequences, and never enroll unknown posts',
          );
        },
      );
      await t.test(
        'each independent missing baseline blocks and each known baseline without a state fails closed',
        async () => {
          for (const component of components)
            for (const stateOnly of [false, true]) {
              const tx = await f.pool.connect();
              try {
                await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
                const post = await f.partialNative(
                  tx,
                  author.accountId,
                  component,
                  stateOnly,
                );
                const result = await scoreInTransaction(f, tx).inspect(
                  post,
                  'compute',
                );
                assert.equal(
                  result.status,
                  stateOnly ? 'unavailable' : 'blockedCoverage',
                  `${component} ${stateOnly ? 'state' : 'baseline'}`,
                );
                assert.ok(!('score' in result));
              } finally {
                await tx.query('ROLLBACK');
                tx.release();
              }
            }
        },
      );
      await t.test(
        'captured like/save/comment changes returning live counts to zero remain independently blocked until settled',
        async () => {
          for (const component of [
            'subscription',
            'like',
            'comment',
          ] as const) {
            const post = await f.publish(author);
            if (component === 'subscription') {
              await f.save(a, post.id);
              await f.save(a, post.id, false);
            }
            if (component === 'like') {
              await f.like(a, post.id);
              await f.like(a, post.id, false);
            }
            if (component === 'comment') {
              const root = await f.root(a, post.id);
              await f.deleteContent(a, 'root', root.id).expect(204);
            }
            const before = await f.snapshot();
            for (const mode of ['dry-run', 'compute'] as const) {
              const result = await f.service.inspect(post.id, mode);
              assert.equal(result.status, 'blockedFreshness', component);
              assert.ok(!('score' in result));
            }
            assert.deepEqual(
              await f.snapshot(),
              before,
              'Inspection cannot complete obligations or process backlog',
            );
            await f.settle(component, post.id);
            const settled = await f.service.inspect(post.id, 'compute');
            assertComputed(settled);
            assert.equal(settled.score, '0.0000');
            assert.deepEqual(
              settled.snapshot.states[component]!.counts,
              component === 'comment' ? ['0', '0', '0', '0'] : ['0'],
            );
            const after = await f.snapshot();
            await f.settle(component, post.id); // Replays after the later negative receipt.
            assert.deepEqual(await f.snapshot(), after);
          }
        },
      );
      await t.test(
        'account identity, author exclusion, aggregate cap, self interactions and retained replies compose faithfully',
        async () => {
          const post = await f.publish(author);
          for (let n = 0; n < 10; n++)
            await f.root(a, post.id, n % 2 ? 'anonymous' : 'named');
          await f.root(b, post.id);
          await f.root(author, post.id);
          await f.root(author, post.id, 'anonymous');
          await f.save(author, post.id);
          await f.like(author, post.id);
          await f.view(author, [post.id]);
          await f.settleAll(post.id);
          const result = await f.service.inspect(post.id, 'compute');
          assertComputed(result);
          assert.deepEqual(result.snapshot.states.comment!.counts, [
            '13',
            '0',
            '11',
            '2',
          ]);
          assert.deepEqual(result.snapshot.states.like!.counts, ['1']);
          assert.deepEqual(result.snapshot.states.subscription!.counts, ['1']);
          assert.equal(result.snapshot.states.view!.count, '1');
          const tx = await f.pool.connect();
          try {
            const common = {
              views: '1',
              postLikes: '1',
              subscriptions: '1',
              rawRootComments: '13',
              rawReplies: '0',
              uniqueEligibleAccounts: '2',
            };
            assert.equal(
              result.score,
              await f.evaluator.evaluate(
                { ...common, eligibleComments: '6' },
                tx,
              ),
            );
            assert.notEqual(
              result.score,
              await f.evaluator.evaluate(
                { ...common, eligibleComments: '4' },
                tx,
              ),
            );
          } finally {
            tx.release();
          }
          const retained = await f.publish(author),
            root = await f.root(author, retained.id),
            first = await f.reply(a, retained.id, root.id),
            second = await f.reply(
              b,
              retained.id,
              root.id,
              'anonymous',
              first.id,
            );
          await f.deleteContent(a, 'reply', first.id).expect(204);
          await f.deleteContent(author, 'root', root.id).expect(204);
          await f.like(author, retained.id);
          await f.settleAll(retained.id);
          const survivor = await f.service.inspect(retained.id, 'compute');
          assertComputed(survivor);
          assert.deepEqual(survivor.snapshot.states.comment!.counts, [
            '0',
            '1',
            '1',
            '1',
          ]);
          assert.equal(
            (
              await f.pool.query(
                'SELECT deleted_at FROM whaleu_community.replies WHERE id=$1',
                [second.id],
              )
            ).rows[0]!.deleted_at,
            null,
          );
          await f.deletePost(author, retained.id);
          assert.equal(
            (await f.service.inspect(retained.id, 'compute')).status,
            'computed',
            'Internal arithmetic does not establish public post eligibility',
          );
        },
      );
      await t.test(
        'independent bigint heads beyond Number.MAX_SAFE_INTEGER and numerical gaps are not a shared watermark',
        async () => {
          const post = await f.publish(author);
          const sequences = [
            ['whaleu_community.discussion_sequence', '9007199254741093'],
            ['whaleu_post_hotness.like_source_sequence', '9007199254742093'],
            ['whaleu_post_hotness.comment_source_sequence', '9007199254743093'],
          ];
          for (const [name, value] of sequences)
            await f.pool.query('SELECT setval($1::regclass,$2::bigint,false)', [
              name,
              value,
            ]);
          await f.save(a, post.id);
          await f.like(a, post.id);
          await f.root(a, post.id);
          for (const [name] of sequences)
            await f.pool.query(
              'SELECT nextval($1::regclass) FROM generate_series(1,7)',
              [name],
            );
          await f.save(a, post.id, false);
          await f.like(a, post.id, false);
          const root = await f.root(b, post.id);
          assert.ok(root.id);
          await f.settleAll(post.id);
          const result = await f.service.inspect(post.id, 'compute');
          assertComputed(result);
          const heads: string[] = [];
          for (const component of [
            'subscription',
            'like',
            'comment',
          ] as const) {
            const state: HotScoreAsyncState =
              result.snapshot.states[component]!;
            assert.equal(state.processedHead, state.capturedHead);
            assert.ok(BigInt(state.processedHead) > 9007199254740991n);
            assert.equal(state.unresolvedSequence, null);
            heads.push(state.processedHead);
          }
          assert.equal(new Set(heads).size, 3);
        },
      );
      await t.test(
        'database rejects stale/historical proof tampering; malformed snapshot metadata never produces a score',
        async () => {
          const post = await f.publish(author);
          await f.save(a, post.id);
          await f.save(a, post.id, false);
          await f.like(a, post.id);
          await f.like(a, post.id, false);
          const root = await f.root(a, post.id);
          await f.deleteContent(a, 'root', root.id).expect(204);
          const pending = (await f.obligations(post.id))[0]!;
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              await tx.query(
                "UPDATE whaleu_community.saved_obligations SET status='completed' WHERE id=$1",
                [pending.id],
              );
            }),
            constraint,
            'Mutable completed status without its exact receipt is not settlement',
          );
          await f.settleAll(post.id);
          for (const component of [
            'subscription',
            'like',
            'comment',
          ] as const) {
            const key =
              component === 'subscription' ? 'obligation_id' : 'source_id';
            for (const id of await f.ids(component, post.id)) {
              await assert.rejects(
                inTransaction(f.pool, (tx) =>
                  tx.query(
                    `UPDATE whaleu_post_hotness.${component}_receipts SET actor_id=$2 WHERE ${key}=$1`,
                    [id, b.accountId],
                  ),
                ),
                constraint,
                `${component} nonterminal and terminal receipts are immutable`,
              );
            }
            await assert.rejects(
              inTransaction(f.pool, (tx) =>
                tx.query(
                  `UPDATE whaleu_post_hotness.${component}_states SET last_sequence=last_sequence+1 WHERE post_id=$1`,
                  [post.id],
                ),
              ),
              constraint,
            );
          }
          const good = await f.service.inspect(post.id, 'compute');
          assertComputed(good);
          const bad = (change: (snapshot: HotScoreSnapshot) => void) => {
            const copy = structuredClone(good.snapshot);
            change(copy);
            assert.doesNotThrow(() =>
              assert.equal(
                validateHotScoreSnapshot(copy).status,
                'unavailable',
              ),
            );
          };
          for (const component of components) {
            bad((s) => {
              s.baselines[component]!.componentVersion = 2 as 1;
            });
            bad((s) => {
              s.baselines[component]!.ownerId = randomUUID();
            });
            bad((s) => {
              s.baselines[component]!.sourceRequestId = randomUUID();
            });
            for (const value of ['bad', '1.5', '', 'Infinity', '-1', '01'])
              bad((s) => {
                s.baselines[component]!.creationXid = value;
              });
          }
          for (const component of [
            'subscription',
            'like',
            'comment',
          ] as const) {
            bad((s) => {
              s.states[component]!.terminalReceiptValid = false;
            });
            bad((s) => {
              s.states[component]!.invalidReceipt = true;
            });
            bad((s) => {
              s.states[component]!.lastReceiptId = null;
            });
            for (const value of ['bad', '1.5', '', 'Infinity', '-1', '01']) {
              bad((s) => {
                s.states[component]!.processedHead = value;
              });
              bad((s) => {
                s.states[component]!.counts[0] = value;
              });
            }
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
