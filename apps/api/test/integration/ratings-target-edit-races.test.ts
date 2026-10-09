import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import type { Pool, PoolClient } from 'pg';
import {
  ratingEditFixture,
  ratingEditPrefix,
} from '../support/rating-edit-fixture.js';
import {
  appendIdentitySelection,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import { approveRating } from '../support/rating-runtime-fixture.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import { RatingsRepository } from '../../src/ratings/repository.js';
import { RatingTargetEditRepository } from '../../src/ratings/management/target-edit/repository.js';
import { RatingTargetOwnerDeletionRepository } from '../../src/ratings/management/target-deletion/repository.js';
import { RatingCompletePoolRepository } from '../../src/ratings/random/complete-pool.repository.js';

type Fixture = Awaited<ReturnType<typeof ratingEditFixture>>;
type Actor = Awaited<ReturnType<Fixture['actor']>>;
type Target = Awaited<ReturnType<Fixture['catalog']>>['targets'][number];
const deletionPrefix = '/v1/ratings/management/owner-deletion';
const exclusiveSafety =
  "pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1'";
const sharedSafety =
  "pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1'";

function barrier() {
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reach, release, reached, held };
}
async function atBarrier(reached: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reached,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('Expected real M2B race barrier within five seconds'),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function tracked<T>(pending: Promise<unknown>[], operation: Promise<T>) {
  pending.push(operation);
  void operation.catch(() => undefined);
  return operation;
}
async function approved(
  f: Fixture,
  actor: Actor,
  target: Target,
  name: string,
) {
  const before = await f.editContext(actor, target.id);
  const input = f.editIntent(before, {
    name,
    description: `${name} description`,
  });
  const prepared = await f.prepareEdit(actor, input);
  const approval = await f.approveEdit(actor, input);
  return { before, input, prepared, approval };
}
const recover = (f: Fixture, actor: Actor, id: string) =>
  f.auth(request(f.http).get(`${ratingEditPrefix}/requests/${id}`), actor);
const remove = (
  f: Fixture,
  actor: Actor,
  target: Target,
  expectedTargetRevision = target.revision,
) =>
  f
    .auth(request(f.http).post(`${deletionPrefix}/targets/${target.id}`), actor)
    .send({ clientRequestId: randomUUID(), expectedTargetRevision });
async function current(f: Fixture, targetId: string) {
  return (
    await f.pool.query<{
      revision: string;
      active: boolean;
      content_version: number;
      definition_revision: string;
      name: string;
      description: string;
    }>(
      `SELECT t.revision,t.active,h.content_version,h.definition_revision,v.name,v.description
    FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id
    JOIN whaleu_ratings.target_definition_versions v ON v.target_id=h.target_id AND v.content_version=h.content_version AND v.definition_revision=h.definition_revision WHERE t.id=$1`,
      [targetId],
    )
  ).rows[0]!;
}
async function epochs(f: Fixture) {
  return (
    await f.pool.query<{
      pool: string;
      navigation: string;
      binding: string;
    }>(`SELECT (SELECT epoch::text FROM whaleu_ratings.random_pool_epoch) pool,
    (SELECT epoch::text FROM whaleu_ratings.navigation_epoch) navigation,
    (SELECT epoch::text FROM whaleu_community.rating_review_binding_epoch) binding`)
  ).rows[0]!;
}
async function commandSnapshot(
  f: Fixture,
  targetId: string,
  requestId: string,
) {
  const rows: Record<string, unknown> = {};
  for (const table of [
    'target_definition_versions',
    'target_definition_heads',
    'target_definition_lifecycles',
    'target_state_revisions',
    'target_edit_preparations',
    'target_edit_transitions',
    'target_edit_noops',
    'effect_events',
  ])
    rows[table] = (
      await f.pool.query(
        `SELECT to_jsonb(r) row FROM whaleu_ratings.${table} r WHERE target_id=$1 ORDER BY to_jsonb(r)::text`,
        [targetId],
      )
    ).rows;
  for (const table of ['requests', 'command_claims', 'target_edit_closures'])
    rows[table] = (
      await f.pool.query(
        `SELECT to_jsonb(r) row FROM whaleu_ratings.${table} r WHERE request_id=$1 ORDER BY to_jsonb(r)::text`,
        [requestId],
      )
    ).rows;
  rows['target'] = (
    await f.pool.query(
      'SELECT to_jsonb(t) row FROM whaleu_ratings.targets t WHERE id=$1',
      [targetId],
    )
  ).rows;
  rows['binding'] = (
    await f.pool.query(
      'SELECT to_jsonb(b) row FROM whaleu_community.rating_target_definition_bindings b WHERE target_id=$1 ORDER BY content_version',
      [targetId],
    )
  ).rows;
  rows['decisions'] = (
    await f.pool.query(
      "SELECT to_jsonb(d) row FROM whaleu_community.rating_approval_decisions d WHERE envelope->>'targetId'=$1 ORDER BY id",
      [targetId],
    )
  ).rows;
  rows['legacyBindings'] = (
    await f.pool.query(
      "SELECT to_jsonb(b) row FROM whaleu_community.rating_approval_bindings b WHERE envelope->>'targetId'=$1 ORDER BY kind,subject_id",
      [targetId],
    )
  ).rows;
  rows['originalReceipts'] = (
    await f.pool.query(
      "SELECT to_jsonb(q) row FROM whaleu_ratings.requests q WHERE receipt->>'targetId'=$1 ORDER BY account_id,request_id",
      [targetId],
    )
  ).rows;
  for (const [table, column] of [
    ['content_approval_policies', 'id'],
    ['rating_approval_events', 'decision_id'],
    ['rating_approval_heads', 'decision_id'],
  ] as const)
    rows[table] = (
      await f.pool.query(
        `SELECT to_jsonb(r) row FROM whaleu_community.${table} r WHERE ${column} IN
      (SELECT ${table === 'content_approval_policies' ? 'policy_revision_id' : 'id'} FROM whaleu_community.rating_approval_decisions WHERE envelope->>'targetId'=$1) ORDER BY to_jsonb(r)::text`,
        [targetId],
      )
    ).rows;
  rows['epochs'] = await epochs(f);
  return rows;
}

async function interactionHistory(tx: Pool | PoolClient, targetId: string) {
  const rows: Record<string, unknown> = {};
  for (const table of [
    'comments',
    'replies',
    'comment_transitions',
    'reply_transitions',
    'like_subjects',
    'like_transitions',
    'subscription_baselines',
    'subscription_states',
    'subscription_memberships',
    'subscription_transitions',
    'subscription_epochs',
    'effect_events',
  ])
    rows[table] = (
      await tx.query(
        `SELECT to_jsonb(r) row FROM whaleu_ratings.${table} r WHERE target_id=$1 ORDER BY to_jsonb(r)::text`,
        [targetId],
      )
    ).rows;
  for (const table of ['like_states', 'like_memberships'])
    rows[table] = (
      await tx.query(
        `SELECT to_jsonb(r) row FROM whaleu_ratings.${table} r JOIN whaleu_ratings.like_subjects s ON s.id=r.subject_id WHERE s.target_id=$1 ORDER BY to_jsonb(r)::text`,
        [targetId],
      )
    ).rows;
  rows['bindings'] = (
    await tx.query(
      "SELECT to_jsonb(b) row FROM whaleu_community.rating_approval_bindings b WHERE envelope->>'targetId'=$1 ORDER BY kind,subject_id",
      [targetId],
    )
  ).rows;
  rows['rewards'] = (
    await tx.query(
      'SELECT to_jsonb(r) row FROM whaleu_ratings.reward_units r JOIN whaleu_ratings.effect_events e ON e.id=r.event_id WHERE e.target_id=$1 ORDER BY r.id',
      [targetId],
    )
  ).rows;
  return rows;
}

async function hasTentativeEdit(
  tx: PoolClient,
  actor: Actor,
  input: ReturnType<Fixture['editIntent']>,
  prepared: Awaited<ReturnType<Fixture['prepareEdit']>>,
) {
  return (
    await tx.query<{ complete: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM whaleu_ratings.target_edit_transitions WHERE actor_account_id=$1 AND request_id=$2)
    AND EXISTS(SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 AND receipt->>'outcome'='applied')
    AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=$3 AND definition_revision=$4 AND content_version=$5)
    AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads WHERE target_id=$3 AND definition_revision=$4 AND content_version=$5)
    AND EXISTS(SELECT 1 FROM whaleu_ratings.targets WHERE id=$3 AND revision=$6 AND active)
    AND EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions WHERE target_id=$3 AND revision=$6 AND active)
    AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=$3 AND target_revision=$6 AND definition_revision=$4 AND content_version=$5)
    AND EXISTS(SELECT 1 FROM whaleu_community.rating_target_definition_bindings WHERE target_id=$3 AND definition_revision=$4 AND content_version=$5) complete`,
      [
        actor.accountId,
        input.clientRequestId,
        input.targetId,
        prepared.definitionRevision,
        prepared.contentVersion,
        prepared.revision,
      ],
    )
  ).rows[0]!.complete;
}

test(
  'M2B two exact prepared edits and M2A owner deletion serialize without losing immutable history',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingEditFixture();
    t.after(() => f.close());
    const owner = await f.actor();
    const catalog = await f.catalog(owner, { count: 3 });
    const editing = f.app.get(RatingTargetEditRepository);
    const deleting = f.app.get(RatingTargetOwnerDeletionRepository);

    await t.test(
      'two different keys prepared from the same tuple with independent exact v3 approvals yield one applied and one context-changed',
      async () => {
        const target = catalog.targets[0]!;
        const first = await approved(
          f,
          owner,
          target,
          'First concurrent definition',
        );
        const second = await approved(
          f,
          owner,
          target,
          'Second concurrent definition',
        );
        assert.equal(
          first.input.expectedTargetRevision,
          second.input.expectedTargetRevision,
        );
        assert.equal(
          first.input.expectedDefinitionRevision,
          second.input.expectedDefinitionRevision,
        );
        assert.equal(
          first.input.expectedContentVersion,
          second.input.expectedContentVersion,
        );
        assert.notEqual(first.prepared.revision, second.prepared.revision);
        assert.notEqual(
          first.prepared.definitionRevision,
          second.prepared.definitionRevision,
        );
        assert.notEqual(first.approval.decisionId, second.approval.decisionId);
        const attempts = [first, second];
        const results = await Promise.all(
          attempts.map((attempt) =>
            f.commitEdit(
              owner,
              attempt.input,
              attempt.prepared.contextRevision,
            ),
          ),
        );
        assert.ok(
          results.every((response) => response.status === 200),
          JSON.stringify(results.map((response) => response.body)),
        );
        assert.deepEqual(
          results.map((response) => response.body.outcome).sort(),
          ['applied', 'rejected'],
        );
        const winnerIndex = results.findIndex(
          (response) => response.body.outcome === 'applied',
        );
        const winner = attempts[winnerIndex]!,
          loser = results[1 - winnerIndex]!;
        assert.equal(
          loser.body.code,
          'RATING_EDIT_CONTEXT_CHANGED',
          JSON.stringify(loser.body),
        );
        const state = await current(f, target.id);
        assert.equal(state.content_version, 2);
        assert.equal(state.revision, winner.prepared.revision);
        assert.equal(
          state.definition_revision,
          winner.prepared.definitionRevision,
        );
        assert.equal(state.name, winner.input.name);
        for (const [index, attempt] of attempts.entries()) {
          assert.deepEqual(
            (await recover(f, owner, attempt.input.clientRequestId)).body,
            results[index]!.body,
          );
          assert.deepEqual(
            (
              await f.commitEdit(
                owner,
                attempt.input,
                attempt.prepared.contextRevision,
              )
            ).body,
            results[index]!.body,
          );
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.target_edit_transitions WHERE target_id=$1',
              [target.id],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=$1',
              [target.id],
            )
          ).rowCount,
          2,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.rating_target_definition_bindings WHERE target_id=$1',
              [target.id],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.target_edit_preparations WHERE target_id=$1',
              [target.id],
            )
          ).rowCount,
          2,
        );
      },
    );

    for (const editFirst of [true, false])
      await t.test(
        `${editFirst ? 'editing' : 'deletion'} wins the common gate before the competing lifecycle command`,
        async (sub) => {
          const target = catalog.targets[editFirst ? 1 : 2]!;
          const attempt = await approved(
            f,
            owner,
            target,
            editFirst ? 'Edited before deletion' : 'Must never resurrect',
          );
          const b = barrier(),
            pending: Promise<unknown>[] = [];
          const originalEdit = editing.identity.bind(editing);
          const originalDelete = deleting.metadata.bind(deleting);
          const hook = editFirst
            ? sub.mock.method(
                editing,
                'identity',
                async (...args: Parameters<typeof originalEdit>) => {
                  const row = await originalEdit(...args);
                  if (args[0] === target.id && args[3]) {
                    b.reach();
                    await b.held;
                  }
                  return row;
                },
              )
            : sub.mock.method(
                deleting,
                'metadata',
                async (...args: Parameters<typeof originalDelete>) => {
                  const row = await originalDelete(...args);
                  if (args[0] === target.id) {
                    b.reach();
                    await b.held;
                  }
                  return row;
                },
              );
          try {
            let edit: Promise<request.Response>,
              deletion: Promise<request.Response>;
            if (editFirst) {
              edit = tracked(
                pending,
                f
                  .commitEdit(
                    owner,
                    attempt.input,
                    attempt.prepared.contextRevision,
                  )
                  .then((response) => response),
              );
              await atBarrier(b.reached);
              deletion = tracked(
                pending,
                remove(f, owner, target).then((response) => response),
              );
            } else {
              deletion = tracked(
                pending,
                remove(f, owner, target).then((response) => response),
              );
              await atBarrier(b.reached);
              edit = tracked(
                pending,
                f
                  .commitEdit(
                    owner,
                    attempt.input,
                    attempt.prepared.contextRevision,
                  )
                  .then((response) => response),
              );
            }
            await f.waitForLock(exclusiveSafety);
            b.release();
            const [edited, deleted] = await Promise.all([edit, deletion]);
            assert.equal(edited.status, 200, JSON.stringify(edited.body));
            assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
            if (editFirst) {
              assert.equal(
                edited.body.outcome,
                'applied',
                JSON.stringify(edited.body),
              );
              assert.equal(
                deleted.body.code,
                'RATING_REVISION_CONFLICT',
                JSON.stringify(deleted.body),
              );
              assert.equal((await current(f, target.id)).active, true);
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=$1',
                    [target.id],
                  )
                ).rowCount,
                0,
              );
              const freshDelete = await remove(
                f,
                owner,
                target,
                edited.body.revision,
              );
              assert.equal(
                freshDelete.body.outcome,
                'applied',
                JSON.stringify(freshDelete.body),
              );
              const mapping = (
                await f.pool.query(
                  'SELECT content_version,definition_revision FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=$1 AND target_revision=$2',
                  [target.id, freshDelete.body.revision],
                )
              ).rows[0]!;
              assert.deepEqual(mapping, {
                content_version: 2,
                definition_revision: edited.body.definitionRevision,
              });
            } else {
              assert.equal(
                deleted.body.outcome,
                'applied',
                JSON.stringify(deleted.body),
              );
              assert.equal(
                edited.body.outcome,
                'rejected',
                JSON.stringify(edited.body),
              );
              assert.ok(
                ['RATING_NOT_FOUND', 'RATING_EDIT_CONTEXT_CHANGED'].includes(
                  edited.body.code,
                ),
                JSON.stringify(edited.body),
              );
              const state = await current(f, target.id);
              assert.equal(state.active, false);
              assert.equal(state.revision, deleted.body.revision);
              assert.equal(state.content_version, 1);
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_ratings.target_edit_transitions WHERE target_id=$1',
                    [target.id],
                  )
                ).rowCount,
                0,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_community.rating_target_definition_bindings WHERE target_id=$1',
                    [target.id],
                  )
                ).rowCount,
                0,
              );
              assert.deepEqual(
                (await recover(f, owner, attempt.input.clientRequestId)).body,
                edited.body,
              );
              assert.deepEqual(
                (
                  await f.commitEdit(
                    owner,
                    attempt.input,
                    attempt.prepared.contextRevision,
                  )
                ).body,
                edited.body,
              );
            }
            assert.equal((await current(f, target.id)).active, false);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.effect_events WHERE request_id=ANY($1::uuid[])',
                  [[attempt.input.clientRequestId, deleted.body.requestId]],
                )
              ).rowCount,
              0,
            );
          } finally {
            b.release();
            hook.mock.restore();
            await Promise.allSettled(pending);
          }
        },
      );
  },
);

test(
  'M2B scoring on either side of an edit observes the exact lifecycle CAS without rewriting the score',
  { timeout: 90000 },
  async (t) => {
    const f = await ratingEditFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      scorer = await f.actor();
    const catalog = await f.catalog(owner, { count: 2 });
    const records = f.app.get(RatingsRepository),
      edits = f.app.get(RatingTargetEditRepository);
    for (const editFirst of [false, true])
      await t.test(
        `score ${editFirst ? 'after' : 'before'} editing respects the frozen expected target revision`,
        async (sub) => {
          const target = catalog.targets[editFirst ? 1 : 0]!;
          const attempt = await approved(
            f,
            owner,
            target,
            `Score race ${editFirst ? 'after' : 'before'}`,
          );
          const scoreInput = {
            clientRequestId: randomUUID(),
            regionId: null,
            expectedTargetRevision: target.revision,
            expectedRevision: null,
            score: 5,
          };
          const score = (body = scoreInput) =>
            f
              .auth(
                request(f.http).put(
                  `/v1/ratings/targets/${target.id}/my-score`,
                ),
                scorer,
              )
              .send(body);
          const originalScore = records.setScore.bind(records),
            originalEdit = edits.identity.bind(edits);
          const b = barrier(),
            pending: Promise<unknown>[] = [];
          const hook = editFirst
            ? sub.mock.method(
                edits,
                'identity',
                async (...args: Parameters<typeof originalEdit>) => {
                  const row = await originalEdit(...args);
                  if (args[0] === target.id && args[3]) {
                    b.reach();
                    await b.held;
                  }
                  return row;
                },
              )
            : sub.mock.method(
                records,
                'setScore',
                async (...args: Parameters<typeof originalScore>) => {
                  const result = await originalScore(...args);
                  if (args[0] === target.id) {
                    b.reach();
                    await b.held;
                  }
                  return result;
                },
              );
          try {
            let edit: Promise<request.Response>,
              scoring: Promise<request.Response>;
            if (editFirst) {
              edit = tracked(
                pending,
                f
                  .commitEdit(
                    owner,
                    attempt.input,
                    attempt.prepared.contextRevision,
                  )
                  .then((response) => response),
              );
              await atBarrier(b.reached);
              scoring = tracked(
                pending,
                score().then((response) => response),
              );
              await f.waitForLock(sharedSafety);
            } else {
              scoring = tracked(
                pending,
                score().then((response) => response),
              );
              await atBarrier(b.reached);
              edit = tracked(
                pending,
                f
                  .commitEdit(
                    owner,
                    attempt.input,
                    attempt.prepared.contextRevision,
                  )
                  .then((response) => response),
              );
              await f.waitForLock(exclusiveSafety);
            }
            b.release();
            const [edited, scored] = await Promise.all([edit, scoring]);
            assert.equal(
              edited.body.outcome,
              'applied',
              JSON.stringify(edited.body),
            );
            if (editFirst) {
              assert.equal(
                scored.body.code,
                'RATING_REVISION_CONFLICT',
                JSON.stringify(scored.body),
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_ratings.scores WHERE target_id=$1',
                    [target.id],
                  )
                ).rowCount,
                0,
              );
              const fresh = await score({
                ...scoreInput,
                clientRequestId: randomUUID(),
                expectedTargetRevision: edited.body.revision,
              });
              assert.equal(
                fresh.body.outcome,
                'applied',
                JSON.stringify(fresh.body),
              );
            } else {
              assert.equal(
                scored.body.outcome,
                'applied',
                JSON.stringify(scored.body),
              );
              const stored = (
                await f.pool.query(
                  'SELECT score,revision,request_id FROM whaleu_ratings.scores WHERE target_id=$1 AND account_id=$2',
                  [target.id, scorer.accountId],
                )
              ).rows[0]!;
              assert.deepEqual(stored, {
                score: 5,
                revision: scored.body.revision,
                request_id: scoreInput.clientRequestId,
              });
              assert.deepEqual(
                (
                  await f.auth(
                    request(f.http).get(
                      `/v1/ratings/requests/${scoreInput.clientRequestId}`,
                    ),
                    scorer,
                  )
                ).body,
                scored.body,
              );
            }
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.score_transitions WHERE target_id=$1',
                  [target.id],
                )
              ).rowCount,
              1,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT count::text,sum::text FROM whaleu_ratings.score_summaries WHERE target_id=$1',
                  [target.id],
                )
              ).rows[0]!.sum,
              '5',
            );
            assert.equal(
              (await current(f, target.id)).name,
              attempt.input.name,
            );
          } finally {
            b.release();
            hook.mock.restore();
            await Promise.allSettled(pending);
          }
        },
      );
  },
);

test(
  'M2B comments, replies, both like subjects and subscriptions linearize on either side of editing with their real CAS contracts',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingEditFixture();
    t.after(() => f.close());
    for (const kind of [
      'comment',
      'reply',
      'comment_like',
      'reply_like',
      'subscription',
    ] as const)
      for (const editFirst of [false, true])
        await t.test(
          `${kind} ${editFirst ? 'after' : 'before'} the editor keeps old publication bindings and command history`,
          async () => {
            const owner = await f.actor(),
              actor = await f.actor();
            const catalog = await f.catalog(owner),
              target = catalog.targets[0]!;
            const root = await f.publish(owner, catalog, target);
            const reply = await f.publishReply(owner, catalog, target, root);
            const attempt = await approved(
              f,
              owner,
              target,
              `Definition around ${kind} ${editFirst}`,
            );
            const likeSubject = kind === 'reply_like' ? reply : root;
            const likePath = `/v1/ratings/${kind === 'reply_like' ? 'replies' : 'comments'}/${likeSubject.id}/like`;
            const subscriptionPath = `/v1/ratings/targets/${target.id}/subscription`;
            // These are independent actor-membership revisions, not definition revisions.
            const likeState = await f.auth(
              request(f.http).get(likePath),
              actor,
            );
            const subscriptionState = await f.auth(
              request(f.http).get(subscriptionPath),
              actor,
            );
            assert.equal(
              likeState.body.status,
              'known',
              JSON.stringify(likeState.body),
            );
            assert.equal(
              subscriptionState.body.status,
              'known',
              JSON.stringify(subscriptionState.body),
            );
            const prepareInteraction = async (targetRevision: string) => {
              const updated = {
                ...target,
                revision: targetRevision as typeof target.revision,
              };
              if (kind === 'comment') {
                const input = f.body(catalog, updated);
                await approveRating(
                  f.pool,
                  f.envelope(actor, catalog, updated, input),
                );
                return {
                  requestId: input.clientRequestId,
                  receiptPath: 'requests',
                  send: () =>
                    f
                      .auth(
                        request(f.http).post(
                          `/v1/ratings/targets/${target.id}/comments`,
                        ),
                        actor,
                      )
                      .send(input),
                };
              }
              if (kind === 'reply') {
                const input = f.replyBody(catalog, updated, root);
                await approveRating(
                  f.pool,
                  f.replyEnvelope(actor, catalog, updated, root, input),
                );
                return {
                  requestId: input.clientRequestId,
                  receiptPath: 'reply-requests',
                  send: () =>
                    f
                      .auth(
                        request(f.http).post(
                          `/v1/ratings/comments/${root.id}/replies`,
                        ),
                        actor,
                      )
                      .send(input),
                };
              }
              if (kind === 'subscription') {
                const input = {
                  clientRequestId: randomUUID(),
                  regionId: null,
                  expectedTargetRevision: targetRevision,
                  expectedSubscriptionRevision: subscriptionState.body.revision,
                  subscribed: true,
                };
                return {
                  requestId: input.clientRequestId,
                  receiptPath: 'subscription-requests',
                  send: () =>
                    f
                      .auth(request(f.http).put(subscriptionPath), actor)
                      .send(input),
                };
              }
              const input = {
                clientRequestId: randomUUID(),
                regionId: null,
                targetId: target.id,
                expectedTargetRevision: targetRevision,
                expectedRevision: likeSubject.revision,
                expectedLikeRevision: likeState.body.revision,
                liked: true,
                ...(kind === 'reply_like'
                  ? { rootId: root.id, expectedRootRevision: root.revision }
                  : {}),
              };
              return {
                requestId: input.clientRequestId,
                receiptPath: 'like-requests',
                send: () =>
                  f.auth(request(f.http).put(likePath), actor).send(input),
              };
            };
            const interaction = await prepareInteraction(target.revision);
            const originalHistory = await interactionHistory(f.pool, target.id);
            const observer = observeDirectoryQueries(f.app),
              b = barrier(),
              pending: Promise<unknown>[] = [];
            let historyAtGate: Record<string, unknown> | undefined;
            observer.setHook(async ({ sql }, tx) => {
              if (!/UPDATE whaleu_ratings\.requests SET receipt/.test(sql))
                return;
              observer.setHook(null);
              historyAtGate = await interactionHistory(tx, target.id);
              b.reach();
              await b.held;
            });
            try {
              let editing: Promise<request.Response>,
                interacting: Promise<request.Response>;
              if (editFirst) {
                editing = tracked(
                  pending,
                  f
                    .commitEdit(
                      owner,
                      attempt.input,
                      attempt.prepared.contextRevision,
                    )
                    .then((r) => r),
                );
                await atBarrier(b.reached);
                interacting = tracked(
                  pending,
                  interaction.send().then((r) => r),
                );
                await f.waitForLock(sharedSafety);
              } else {
                interacting = tracked(
                  pending,
                  interaction.send().then((r) => r),
                );
                await atBarrier(b.reached);
                editing = tracked(
                  pending,
                  f
                    .commitEdit(
                      owner,
                      attempt.input,
                      attempt.prepared.contextRevision,
                    )
                    .then((r) => r),
                );
                await f.waitForLock(exclusiveSafety);
              }
              b.release();
              const [edited, interacted] = await Promise.all([
                editing,
                interacting,
              ]);
              assert.equal(edited.status, 200, JSON.stringify(edited.body));
              assert.equal(
                edited.body.outcome,
                'applied',
                JSON.stringify(edited.body),
              );
              assert.equal(
                interacted.status,
                200,
                JSON.stringify(interacted.body),
              );
              assert.ok(
                historyAtGate,
                'The first command reached its genuine receipt-write result before the gate was released',
              );
              assert.deepEqual(
                await interactionHistory(f.pool, target.id),
                historyAtGate,
                'Editing cannot rewrite child bindings, memberships, captured effects or reward units',
              );
              if (editFirst) {
                assert.equal(
                  interacted.body.outcome,
                  'rejected',
                  JSON.stringify(interacted.body),
                );
                assert.equal(
                  interacted.body.code,
                  'RATING_REVISION_CONFLICT',
                  JSON.stringify(interacted.body),
                );
                assert.deepEqual(
                  historyAtGate,
                  originalHistory,
                  'The stale interaction must have no transition or effect',
                );
                // Only target CAS and request key change. Root/subject and actor-membership CAS remain exact.
                // Publications additionally receive a real new approval bound to the edited target revision.
                const fresh = await prepareInteraction(edited.body.revision);
                const retried = await fresh.send();
                assert.equal(
                  retried.body.outcome,
                  'applied',
                  JSON.stringify(retried.body),
                );
              } else
                assert.equal(
                  interacted.body.outcome,
                  'applied',
                  JSON.stringify(interacted.body),
                );
              const historic = await f.auth(
                request(f.http).get(
                  `/v1/ratings/${interaction.receiptPath}/${interaction.requestId}`,
                ),
                actor,
              );
              assert.equal(historic.status, 200, JSON.stringify(historic.body));
              assert.deepEqual(historic.body, interacted.body);
              assert.deepEqual(
                (await interaction.send()).body,
                interacted.body,
              );
              const afterHistory = await interactionHistory(f.pool, target.id);
              for (const table of [
                'comments',
                'replies',
                'comment_transitions',
                'reply_transitions',
                'like_subjects',
                'like_transitions',
                'subscription_baselines',
                'subscription_transitions',
                'subscription_epochs',
                'effect_events',
                'bindings',
                'rewards',
              ]) {
                const preserved = new Set(
                  (afterHistory[table] as unknown[]).map((row) =>
                    JSON.stringify(row),
                  ),
                );
                for (const row of originalHistory[table] as unknown[])
                  assert.ok(
                    preserved.has(JSON.stringify(row)),
                    `${table} original row remains byte-for-byte present`,
                  );
              }
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_ratings.effect_events WHERE request_id=$1',
                    [attempt.input.clientRequestId],
                  )
                ).rowCount,
                0,
              );
              assert.equal(
                (await current(f, target.id)).revision,
                edited.body.revision,
              );
              assert.equal(
                (await current(f, target.id)).name,
                attempt.input.name,
              );
            } finally {
              b.release();
              observer.restore();
              await Promise.allSettled(pending);
            }
          },
        );
  },
);

test(
  'M2B deferred finalization preserves original preparation and claim while rolling back every tentative edit artifact',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingEditFixture();
    t.after(() => f.close());
    for (const mode of [
      'phone',
      'safety',
      'negative_safety',
      'token',
      'review_consume',
      'preparation',
    ] as const)
      await t.test(
        `${mode} deadline cannot be crossed by a deferred SQL wait`,
        async () => {
          const actor = await f.actor(),
            catalog = await f.catalog(actor),
            target = catalog.targets[0]!;
          const context = await f.editContext(actor, target.id);
          const input = f.editIntent(context, {
            name: `Deferred ${mode} edit`,
            description: 'Must remain atomic across the final SQL wait',
          });
          let installed = false;
          const observer = observeDirectoryQueries(f.app);
          const statements: string[] = [];
          let tentativeChain = false;
          try {
            if (mode === 'preparation')
              await f.pool.query(
                "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '2 seconds' WHERE session_id=$1",
                [actor.sessionId],
              );
            const prepared = await f.prepareEdit(actor, input);
            if (mode === 'preparation')
              await f.pool.query(
                "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '10 minutes' WHERE session_id=$1",
                [actor.sessionId],
              );
            await f.approveEdit(
              actor,
              input,
              mode === 'review_consume'
                ? { consumeUntil: new Date(Date.now() + 2000) }
                : {},
            );
            await f.pool
              .query(`CREATE FUNCTION whaleu_ratings.synthetic_target_edit_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.4); RETURN NULL; END $$;
          CREATE CONSTRAINT TRIGGER synthetic_target_edit_wait AFTER INSERT ON whaleu_ratings.requests
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation='edit_target') EXECUTE FUNCTION whaleu_ratings.synthetic_target_edit_wait()`);
            installed = true;
            if (mode === 'phone')
              await f.certify(actor.accountId, {
                expiresAt: new Date(Date.now() + 2000),
              });
            else if (mode === 'token')
              await f.pool.query(
                "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '2 seconds' WHERE session_id=$1",
                [actor.sessionId],
              );
            else if (mode === 'safety' || mode === 'negative_safety')
              await withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  "UPDATE whaleu_safety.account_heads SET actions_allowed=$2,valid_until=clock_timestamp()+interval '2 seconds' WHERE account_id=$1",
                  [actor.accountId, mode !== 'negative_safety'],
                ),
              );
            const before = await commandSnapshot(
              f,
              target.id,
              input.clientRequestId,
            );
            observer.setHook(async ({ sql }, tx) => {
              statements.push(sql);
              if (
                mode !== 'negative_safety' &&
                /UPDATE whaleu_ratings\.requests SET receipt/.test(sql)
              ) {
                const row = (
                  await tx.query<{ complete: boolean }>(
                    `SELECT EXISTS(SELECT 1 FROM whaleu_ratings.target_edit_transitions WHERE actor_account_id=$1 AND request_id=$2)
              AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=$3 AND definition_revision=$4 AND content_version=$5)
              AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads WHERE target_id=$3 AND definition_revision=$4 AND content_version=$5)
              AND EXISTS(SELECT 1 FROM whaleu_ratings.targets WHERE id=$3 AND revision=$6 AND active)
              AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=$3 AND target_revision=$6 AND definition_revision=$4 AND content_version=$5)
              AND EXISTS(SELECT 1 FROM whaleu_community.rating_target_definition_bindings WHERE target_id=$3 AND definition_revision=$4 AND content_version=$5) complete`,
                    [
                      actor.accountId,
                      input.clientRequestId,
                      target.id,
                      prepared.definitionRevision,
                      prepared.contentVersion,
                      prepared.revision,
                    ],
                  )
                ).rows[0]!;
                tentativeChain = row.complete;
              }
            });
            const started = Date.now();
            const result = await f.commitEdit(
              actor,
              input,
              prepared.contextRevision,
            );
            assert.ok(
              Date.now() - started >= 2300,
              'An actual deferred SQL wait must run after the tentative result',
            );
            if (mode === 'review_consume' || mode === 'preparation') {
              assert.ok(result.status >= 400, JSON.stringify(result.body));
              assert.equal(
                result.body.outcome,
                undefined,
                'SQL or final-proof failure is not a durable business rejection',
              );
            } else {
              const code =
                mode === 'phone'
                  ? 'VERIFICATION_UNAVAILABLE'
                  : mode === 'token'
                    ? 'ACCESS_TOKEN_EXPIRED'
                    : 'SAFETY_UNAVAILABLE';
              assert.equal(
                result.body.error?.code,
                code,
                JSON.stringify(result.body),
              );
            }
            assert.ok(
              statements.some((sql) =>
                /UPDATE whaleu_ratings\.requests SET receipt/.test(sql),
              ),
            );
            if (mode === 'negative_safety') {
              assert.ok(
                statements.some((sql) =>
                  /INSERT INTO whaleu_ratings\.target_edit_closures/.test(sql),
                ),
              );
              assert.ok(
                statements.every(
                  (sql) =>
                    !/INSERT INTO whaleu_ratings\.target_edit_transitions/.test(
                      sql,
                    ),
                ),
              );
            } else
              assert.equal(
                tentativeChain,
                true,
                'Transition, version, head, lifecycle, binding and receipt existed together before finalization',
              );
            assert.deepEqual(
              await commandSnapshot(f, target.id, input.clientRequestId),
              before,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.target_edit_preparations WHERE account_id=$1 AND request_id=$2',
                  [actor.accountId, input.clientRequestId],
                )
              ).rowCount,
              1,
            );
            assert.equal(
              (
                await f.pool.query(
                  "SELECT 1 FROM whaleu_ratings.command_claims WHERE account_id=$1 AND request_id=$2 AND operation='edit_target'",
                  [actor.accountId, input.clientRequestId],
                )
              ).rowCount,
              1,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
                  [actor.accountId, input.clientRequestId],
                )
              ).rowCount,
              0,
            );
            observer.setHook(null);
            await f.pool.query(
              'DROP TRIGGER synthetic_target_edit_wait ON whaleu_ratings.requests; DROP FUNCTION whaleu_ratings.synthetic_target_edit_wait()',
            );
            installed = false;
            if (mode !== 'review_consume' && mode !== 'preparation') {
              await f.certify(actor.accountId);
              await withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  'UPDATE whaleu_safety.account_heads SET actions_allowed=true,valid_until=NULL WHERE account_id=$1',
                  [actor.accountId],
                ),
              );
              await f.pool.query(
                "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '10 minutes' WHERE session_id=$1",
                [actor.sessionId],
              );
              assert.deepEqual(
                await f.prepareEdit(actor, input),
                prepared,
                'Recovery must preserve the original prepared version and context',
              );
              const retry = await f.commitEdit(
                actor,
                input,
                prepared.contextRevision,
              );
              assert.equal(
                retry.body.outcome,
                'applied',
                JSON.stringify(retry.body),
              );
              assert.equal(retry.body.revision, prepared.revision);
              assert.equal(
                retry.body.definitionRevision,
                prepared.definitionRevision,
              );
              assert.equal(retry.body.contentVersion, prepared.contentVersion);
              assert.deepEqual(
                (await recover(f, actor, input.clientRequestId)).body,
                retry.body,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_ratings.target_edit_transitions WHERE target_id=$1',
                    [target.id],
                  )
                ).rowCount,
                1,
              );
            }
          } finally {
            observer.restore();
            if (installed)
              await f.pool.query(
                'DROP TRIGGER synthetic_target_edit_wait ON whaleu_ratings.requests; DROP FUNCTION whaleu_ratings.synthetic_target_edit_wait()',
              );
          }
        },
      );
  },
);

test(
  'M2B real predecessor Review, new visibility, catalog and ordinary affiliation deadlines survive neither deferred finalization nor partial rollback',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingEditFixture();
    t.after(() => f.close());
    for (const mode of [
      'before_v1_visibility',
      'before_v2_visibility',
      'before_v2_policy',
      'new_visibility',
      'catalog',
      'affiliation',
    ] as const)
      await t.test(
        `${mode} expires only after a complete tentative definition chain has existed`,
        async () => {
          const actor = await f.actor();
          const deadline = new Date(Date.now() + 3500);
          const catalog = await f.catalog(actor, {
            ...(mode === 'catalog' ? { validUntil: deadline } : {}),
            ...(mode === 'before_v1_visibility'
              ? { approvalOptions: { visibilityUntil: deadline } }
              : {}),
            ...(mode === 'affiliation'
              ? { regionId: f.scope.home.regionId }
              : {}),
          });
          const target = catalog.targets[0]!;
          let predecessorDecision = target.approval.decisionId;
          let precedingReceipt: unknown = null;
          if (mode === 'before_v2_visibility' || mode === 'before_v2_policy') {
            const first = f.editIntent(await f.editContext(actor, target.id), {
              name: `Real v2 predecessor ${mode}`,
            });
            const firstPrepared = await f.prepareEdit(actor, first);
            const firstApproval = await f.approveEdit(
              actor,
              first,
              mode === 'before_v2_visibility'
                ? { visibilityUntil: deadline }
                : { policyUntil: deadline },
            );
            predecessorDecision = firstApproval.decisionId;
            const response = await f.commitEdit(
              actor,
              first,
              firstPrepared.contextRevision,
            );
            assert.equal(
              response.body.outcome,
              'applied',
              JSON.stringify(response.body),
            );
            assert.equal(response.body.contentVersion, 2);
            precedingReceipt = response.body;
          }
          const beforeDefinition = await f.editContext(actor, target.id);
          const input = f.editIntent(beforeDefinition, {
            name: `Tentative successor ${mode}`,
            description:
              'This complete publication must roll back at its final boundary',
          });
          const prepared = await f.prepareEdit(actor, input);
          const newApproval = await f.approveEdit(
            actor,
            input,
            mode === 'new_visibility' ? { visibilityUntil: deadline } : {},
          );
          assert.notEqual(newApproval.decisionId, predecessorDecision);
          assert.equal(
            prepared.contentVersion,
            mode === 'before_v2_visibility' || mode === 'before_v2_policy'
              ? 3
              : 2,
          );
          if (mode === 'affiliation') {
            // Ordinary regional qualification uses this short affiliation assertion, with a
            // separate long-lived verified phone. No role grant may stand in for it.
            const affiliation = syntheticAssertion(
              actor.accountId,
              f.scope.institutionId,
              'affiliation',
              {
                origin_region_id: f.scope.home.regionId,
                expires_at: deadline,
              },
            );
            const phone = syntheticAssertion(
              actor.accountId,
              f.scope.institutionId,
              'phone',
            );
            assert.ok(phone.expires_at!.getTime() > deadline.getTime() + 60000);
            const snapshot = await setSyntheticSnapshot(
              f.pool,
              actor.accountId,
              [affiliation, phone],
            );
            await appendIdentitySelection(
              f.pool,
              actor.accountId,
              {
                assertionId: affiliation.id,
                snapshotId: snapshot.snapshotId,
                institutionId: f.scope.institutionId,
                originRegionId: f.scope.home.regionId,
                validUntil: deadline.getTime(),
              },
              f.scope,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_authorization.role_grants WHERE account_id=$1',
                  [actor.accountId],
                )
              ).rowCount,
              0,
            );
          }
          let installed = false,
            tentativeChain = false,
            beforeWasStillValid = false;
          const observer = observeDirectoryQueries(f.app);
          try {
            // Absolute-deadline sleep avoids paying another full delay for setup time.
            // The authority window is 3.5 seconds and the SQL wait stays inside the
            // existing five-second statement budget; production limits are untouched.
            await f.pool
              .query(`CREATE FUNCTION whaleu_ratings.synthetic_target_edit_boundary_wait() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_sleep(greatest(0,extract(epoch FROM TG_ARGV[0]::timestamptz-clock_timestamp()))+0.2); RETURN NULL; END $$;
          CREATE CONSTRAINT TRIGGER synthetic_target_edit_boundary_wait AFTER INSERT ON whaleu_ratings.requests
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation='edit_target')
          EXECUTE FUNCTION whaleu_ratings.synthetic_target_edit_boundary_wait('${deadline.toISOString()}')`);
            installed = true;
            const before = await commandSnapshot(
              f,
              target.id,
              input.clientRequestId,
            );
            observer.setHook(async ({ sql }, tx) => {
              if (!/UPDATE whaleu_ratings\.requests SET receipt/.test(sql))
                return;
              tentativeChain = await hasTentativeEdit(
                tx,
                actor,
                input,
                prepared,
              );
              beforeWasStillValid = (
                await tx.query<{ valid: boolean }>(
                  'SELECT clock_timestamp()<$1::timestamptz valid',
                  [deadline],
                )
              ).rows[0]!.valid;
              const predecessor = (
                await tx.query<{
                  content_version: number;
                  definition_revision: string;
                  decision_id: string;
                }>(
                  `SELECT v.content_version,v.definition_revision,
            CASE WHEN v.content_version=1 THEN legacy.decision_id ELSE edited.decision_id END decision_id
            FROM whaleu_ratings.target_definition_versions v
            LEFT JOIN whaleu_community.rating_approval_bindings legacy ON legacy.kind='target' AND legacy.subject_id=v.target_id AND legacy.content_version=1
            LEFT JOIN whaleu_community.rating_target_definition_bindings edited ON edited.target_id=v.target_id AND edited.content_version=v.content_version AND edited.definition_revision=v.definition_revision
            WHERE v.target_id=$1 AND v.content_version=$2`,
                  [target.id, beforeDefinition.contentVersion],
                )
              ).rows[0]!;
              assert.deepEqual(predecessor, {
                content_version: beforeDefinition.contentVersion,
                definition_revision: beforeDefinition.definitionRevision,
                decision_id: predecessorDecision,
              });
            });
            const result = await f.commitEdit(
              actor,
              input,
              prepared.contextRevision,
            );
            assert.equal(
              tentativeChain,
              true,
              'Real request, transition, version, head, lifecycle, lifecycle mapping and new Review binding all existed before finalization',
            );
            assert.equal(
              beforeWasStillValid,
              true,
              'The named authority must still be valid at the tentative receipt, not already rejected during preflight',
            );
            assert.equal(
              (
                await f.pool.query<{ expired: boolean }>(
                  'SELECT clock_timestamp()>$1::timestamptz expired',
                  [deadline],
                )
              ).rows[0]!.expired,
              true,
            );
            assert.ok(result.status >= 400, JSON.stringify(result.body));
            assert.equal(
              result.body.outcome,
              undefined,
              'Deferred SQL 23514 or final-proof unavailability must never become a terminal business receipt',
            );
            if (mode === 'affiliation')
              assert.equal(
                result.body.error?.code,
                'VERIFICATION_UNAVAILABLE',
                JSON.stringify(result.body),
              );
            assert.deepEqual(
              await commandSnapshot(f, target.id, input.clientRequestId),
              before,
              'The original Review, v2 history, preparation and claim survive; every tentative artifact and epoch increment rolls back',
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.target_edit_preparations WHERE account_id=$1 AND request_id=$2',
                  [actor.accountId, input.clientRequestId],
                )
              ).rowCount,
              1,
            );
            assert.equal(
              (
                await f.pool.query(
                  "SELECT 1 FROM whaleu_ratings.command_claims WHERE account_id=$1 AND request_id=$2 AND operation='edit_target'",
                  [actor.accountId, input.clientRequestId],
                )
              ).rowCount,
              1,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
                  [actor.accountId, input.clientRequestId],
                )
              ).rowCount,
              0,
            );
            observer.setHook(null);
            const missing = await recover(f, actor, input.clientRequestId);
            assert.equal(
              missing.body.error?.code,
              'REQUEST_NOT_FOUND',
              JSON.stringify(missing.body),
            );
            if (precedingReceipt !== null) {
              const old = precedingReceipt as { requestId: string };
              assert.deepEqual(
                (await recover(f, actor, old.requestId)).body,
                precedingReceipt,
                'An expired old Review cannot erase a previously committed v2 receipt',
              );
            }
            await f.pool.query(
              'DROP TRIGGER synthetic_target_edit_boundary_wait ON whaleu_ratings.requests; DROP FUNCTION whaleu_ratings.synthetic_target_edit_boundary_wait()',
            );
            installed = false;
            if (mode === 'affiliation') {
              await f.certify(actor.accountId);
              assert.deepEqual(await f.prepareEdit(actor, input), prepared);
              const retried = await f.commitEdit(
                actor,
                input,
                prepared.contextRevision,
              );
              assert.equal(
                retried.body.outcome,
                'applied',
                JSON.stringify(retried.body),
              );
              assert.equal(
                retried.body.definitionRevision,
                prepared.definitionRevision,
              );
              assert.equal(
                retried.body.contentVersion,
                prepared.contentVersion,
              );
              assert.deepEqual(
                (await recover(f, actor, input.clientRequestId)).body,
                retried.body,
              );
            }
            // Immutable expired Review/catalog sources are retained rather than patched
            // into a false allow solely to manufacture same-key recovery.
          } finally {
            observer.restore();
            if (installed)
              await f.pool.query(
                'DROP TRIGGER synthetic_target_edit_boundary_wait ON whaleu_ratings.requests; DROP FUNCTION whaleu_ratings.synthetic_target_edit_boundary_wait()',
              );
          }
        },
      );
  },
);

test(
  'M2B definition writers honor complete-pool ordering, new current text and pending epoch fences',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingEditFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      catalog = await f.catalog(actor),
      target = catalog.targets[0]!;
    const attempt = await approved(
      f,
      actor,
      target,
      'Current definition after queued edit',
    );
    const pool = f.app.get(RatingCompletePoolRepository);
    const sample = () =>
      f
        .auth(request(f.http).get('/v1/ratings/random-target'), actor)
        .query({ categoryId: catalog.categoryId });
    await t.test(
      'an authorized old pool read finishes before the queued exclusive editor; the next read uses the new definition',
      async (sub) => {
        const b = barrier(),
          pending: Promise<unknown>[] = [],
          before = await epochs(f);
        const original = pool.complete.bind(pool);
        const hook = sub.mock.method(
          pool,
          'complete',
          async (...args: Parameters<typeof original>) => {
            await original(...args);
            b.reach();
            await b.held;
          },
        );
        try {
          const reading = tracked(
            pending,
            sample().then((response) => response),
          );
          await atBarrier(b.reached);
          const editing = tracked(
            pending,
            f
              .commitEdit(
                actor,
                attempt.input,
                attempt.prepared.contextRevision,
              )
              .then((response) => response),
          );
          await f.waitForLock(exclusiveSafety);
          const waiting = (
            await f.pool.query<{ pid: number }>(
              "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock(hashtextextended(%' AND query LIKE '%whaleu:named-block-policy:v1%' ORDER BY pid",
            )
          ).rows;
          assert.ok(waiting.length > 0);
          for (const { pid } of waiting)
            assert.equal(
              (
                await f.pool.query(
                  "SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='whaleu_ratings.random_pool_epoch'::regclass AND granted AND mode='RowExclusiveLock'",
                  [pid],
                )
              ).rowCount,
              0,
              'An editor cannot hold the pool writer fence while waiting for Safety',
            );
          assert.deepEqual(await epochs(f), before);
          b.release();
          const [read, edited] = await Promise.all([reading, editing]);
          assert.equal(read.status, 200, JSON.stringify(read.body));
          assert.equal(read.body.candidateCount, 1);
          assert.equal(read.body.item.target.name, attempt.before.name);
          assert.equal(read.body.item.target.revision, attempt.before.revision);
          assert.equal(
            edited.body.outcome,
            'applied',
            JSON.stringify(edited.body),
          );
        } finally {
          b.release();
          hook.mock.restore();
          await Promise.allSettled(pending);
        }
        const after = await epochs(f);
        assert.ok(BigInt(after.pool) > BigInt(before.pool));
        assert.ok(BigInt(after.navigation) > BigInt(before.navigation));
        assert.ok(BigInt(after.binding) > BigInt(before.binding));
        const fresh = await sample();
        assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
        assert.equal(fresh.body.candidateCount, 1);
        assert.equal(fresh.body.item.target.id, target.id);
        assert.equal(fresh.body.item.target.name, attempt.input.name);
        assert.equal(
          fresh.body.item.target.description,
          attempt.input.description,
        );
        assert.equal(
          fresh.body.item.target.revision,
          attempt.prepared.revision,
        );
      },
    );

    for (const table of [
      'target_definition_versions',
      'target_definition_heads',
      'target_definition_lifecycles',
      'rating_target_definition_bindings',
    ] as const)
      await t.test(
        `zero-row ${table} writes remain visible to pending fences without inventing definition rows`,
        async () => {
          const binding = table === 'rating_target_definition_bindings';
          const schema = binding ? 'whaleu_community' : 'whaleu_ratings';
          const triggerNames = (
            await f.pool.query<{ tgname: string }>(
              `SELECT tgname FROM pg_trigger WHERE tgrelid=$1::regclass
        AND NOT tgisinternal AND (tgtype & 1)=0 AND (tgtype & 2)=2 AND (tgtype & 16)=16 ORDER BY tgname`,
              [`${schema}.${table}`],
            )
          ).rows.map((row) => row.tgname);
          assert.deepEqual(
            triggerNames.slice(0, binding ? 2 : 3),
            binding
              ? [
                  'a0_rating_edit_binding_writer',
                  'a1_rating_target_definition_binding_epoch',
                ]
              : [
                  'a0_rating_edit_writer',
                  'a1_rating_edit_pool',
                  'a2_rating_edit_navigation',
                ],
          );
          const holder = await f.pool.connect(),
            reader = await f.pool.connect();
          const before = await epochs(f),
            beforeState = await current(f, target.id);
          try {
            await holder.query('BEGIN');
            await holder.query(
              `UPDATE ${schema}.${table} SET ${binding ? 'digest=digest' : 'content_version=content_version'} WHERE false`,
            );
            const pending = (
              await holder.query<{
                pool: string;
                navigation: string;
                binding: string;
              }>(`SELECT (SELECT epoch::text FROM whaleu_ratings.random_pool_epoch) pool,
          (SELECT epoch::text FROM whaleu_ratings.navigation_epoch) navigation,(SELECT epoch::text FROM whaleu_community.rating_review_binding_epoch) binding`)
            ).rows[0]!;
            assert.equal(
              BigInt(pending.pool),
              BigInt(before.pool) + (binding ? 0n : 1n),
            );
            assert.equal(
              BigInt(pending.navigation),
              BigInt(before.navigation) + (binding ? 0n : 1n),
            );
            assert.equal(
              BigInt(pending.binding),
              BigInt(before.binding) + (binding ? 1n : 0n),
            );
            assert.deepEqual(
              await epochs(f),
              before,
              'A public snapshot cannot see an uncommitted epoch as committed',
            );
            const fences = [
              'whaleu_ratings.random_pool_epoch',
              'whaleu_ratings.navigation_epoch',
              ...(binding
                ? ['whaleu_community.rating_review_binding_epoch']
                : []),
            ];
            for (const fence of fences) {
              await reader.query('BEGIN');
              await assert.rejects(
                reader.query(`LOCK TABLE ${fence} IN SHARE MODE NOWAIT`),
                (error: unknown) =>
                  typeof error === 'object' &&
                  error !== null &&
                  'code' in error &&
                  error.code === '55P03',
              );
              await reader.query('ROLLBACK');
            }
            await holder.query('COMMIT');
            assert.deepEqual(await epochs(f), pending);
            assert.deepEqual(await current(f, target.id), beforeState);
          } finally {
            await reader.query('ROLLBACK');
            await holder.query('ROLLBACK');
            reader.release();
            holder.release();
          }
          const fresh = await sample();
          assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
          assert.equal(fresh.body.candidateCount, 1);
          assert.equal(fresh.body.item.target.name, attempt.input.name);
        },
      );
  },
);
