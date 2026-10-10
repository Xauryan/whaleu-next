import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  ratingScopedCommandFixture,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import {
  ratingScopedIntentSchema,
  type RatingScopedIntent,
} from '../../src/ratings/scoped/contracts.js';
import {
  ratingScopedCommandHash,
  ratingScopedOperations,
} from '../../src/ratings/scoped/protocol-registry.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import { DatabaseService } from '../../src/database/database.js';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { RatingsSubscriptionUpdatesSourceFacade } from '../../src/ratings/updates-source/subscription-facade.js';
import { RatingSubscriptionUpdatesProjectionFacade } from '../../src/ratings/updates-source/subscription-projection.js';
import { RatingSubscriptionUpdatesRepository } from '../../src/notifications/ratings/subscription-repository.js';
import { RatingSubscriptionUpdatesWorker } from '../../src/notifications/ratings/subscription-worker.js';

// Each operation crosses ordinary authenticated HTTP, real AppModule owners,
// immutable preparation/Review, deferred PostgreSQL guards, and shared kernels.
test(
  'M3B eight real scoped commands retain domain baselines, exact receipts, effects and old cleanup',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingScopedCommandFixture();
    t.after(() => f.close());
    const owner = f.creator,
      author = await f.actor(),
      reader = await f.actor();
    type Actor = typeof owner;
    const recorded: Array<{
      actor: Actor;
      input: RatingScopedIntent;
      receipt: unknown;
      proof?: string;
    }> = [];
    const remember = (
      actor: Actor,
      done: Awaited<ReturnType<typeof f.executeCommand>>,
    ) => {
      recorded.push({
        actor,
        input: done.input,
        receipt: done.receipt,
        ...(done.prepared ? { proof: done.prepared.contextRevision } : {}),
      });
      assert.equal(
        done.receipt.intentHash,
        ratingScopedCommandHash(done.input),
      );
      assert.equal(done.response.headers['cache-control'], 'no-store');
      assert.equal(done.response.headers['vary'], 'Authorization');
      assert.doesNotMatch(
        JSON.stringify(done.receipt),
        /"(?:body|name|description|accountId|sessionId|envelope|authorMode|contextToken)"/,
      );
    };
    let target!: Awaited<ReturnType<typeof f.createScopedTarget>>;
    let root!: { id: string; revision: string; approval: string };
    let reply!: { id: string; revision: string; approval: string };
    const targetPayload = () => ({
      targetId: target.id,
      expectedTargetRevision: target.revision,
    });
    const run = async (
      actor: Actor,
      operation: RatingScopedIntent['operation'],
      payload: Record<string, unknown>,
      outcome: 'applied' | 'noop' = 'applied',
    ) => {
      const input = await f.commandIntent(actor, operation, payload);
      const done = await f.executeCommand(actor, input);
      remember(actor, done);
      return { ...done, receipt: scopedSuccess(done.receipt, outcome) };
    };

    await t.test(
      'create_target_scoped has one initial definition, fresh-zero score, subscription baseline and complete release',
      async () => {
        const effects = await f.scopedEffects();
        target = await f.createScopedTarget(owner);
        remember(owner, target);
        assert.deepEqual(
          await f.scopedEffects(),
          effects,
          'Definition publication grants no content reward',
        );
        const row = (
          await f.pool.query(
            `SELECT t.id,t.revision,h.content_version,h.definition_revision,
      v.applied_target_revision,v.envelope->>'version' review_version,b.kind baseline,
      (SELECT count(*)::int FROM whaleu_ratings.target_definition_versions WHERE target_id=t.id) definitions,
      (SELECT count(*)::int FROM whaleu_community.rating_scoped_target_definition_bindings WHERE target_id=t.id) bindings,
      (SELECT count(*)::int FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=t.id) lifecycles,
      (SELECT count(*)::int FROM whaleu_ratings.target_scope_placements WHERE target_id=t.id) placements,
      (SELECT count(*)::int FROM whaleu_ratings.subscription_baselines WHERE target_id=t.id) subscriptions
      FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id
      JOIN whaleu_ratings.target_definition_versions v ON (v.target_id,v.content_version)=(h.target_id,h.content_version)
      JOIN whaleu_ratings.score_baselines b ON b.target_id=t.id WHERE t.id=$1`,
            [target.id],
          )
        ).rows[0]!;
        assert.equal(row.review_version, '5');
        assert.equal(row.content_version, 1);
        assert.equal(row.definition_revision, target.revision);
        assert.equal(row.applied_target_revision, target.revision);
        for (const field of [
          'definitions',
          'bindings',
          'lifecycles',
          'placements',
          'subscriptions',
        ])
          assert.equal(row[field], 1, field);
        assert.equal(row.baseline, 'fresh_zero');
        const summary = await f.scopedRead(
          reader,
          `/v2/ratings/targets/${target.id}/score-summary`,
        );
        assert.equal(summary.status, 'known');
        assert.equal(summary.count, 0);
        assert.equal(summary.sum, 0);
        assert.equal(summary.average, null);
        assert.equal(
          (
            await f.scopedRead(
              reader,
              `/v2/ratings/targets/${target.id}/subscription`,
            )
          ).count,
          0,
        );
      },
    );

    await t.test(
      'set_score_scoped applied/noop/stale CAS use the existing score chain',
      async () => {
        const first = await run(reader, 'set_score_scoped', {
          ...targetPayload(),
          expectedRevision: null,
          score: 4,
        });
        const before = await f.scopedEffects();
        const noop = await run(
          reader,
          'set_score_scoped',
          {
            ...targetPayload(),
            expectedRevision: first.receipt.result['revision'],
            score: 4,
          },
          'noop',
        );
        assert.equal(
          noop.receipt.result['revision'],
          first.receipt.result['revision'],
        );
        assert.deepEqual(await f.scopedEffects(), before);
        const stale = await f.commandIntent(reader, 'set_score_scoped', {
          ...targetPayload(),
          expectedRevision: null,
          score: 2,
        });
        const denied = await f.executeCommand(reader, stale);
        assert.equal(denied.receipt.outcome, 'closed');
        if (denied.receipt.outcome !== 'closed') assert.fail();
        assert.equal(denied.receipt.code, 'RATING_REVISION_CONFLICT');
        remember(reader, denied);
        assert.deepEqual(await f.scopedEffects(), before);
        const summary = await f.scopedRead(
          reader,
          `/v2/ratings/targets/${target.id}/score-summary`,
        );
        assert.equal(summary.count, 1);
        assert.equal(summary.sum, 4);
        assert.equal(summary.distribution['4'], 1);
      },
    );

    await t.test(
      'set_target_subscription_scoped applied/noop/rejected shares one exact baseline and stream',
      async () => {
        const state = await f.scopedRead(
          reader,
          `/v2/ratings/targets/${target.id}/subscription`,
        );
        assert.equal(state.status, 'known');
        assert.equal(state.subscribed, false);
        const first = await run(reader, 'set_target_subscription_scoped', {
          ...targetPayload(),
          expectedSubscriptionRevision: state.revision,
          subscribed: true,
        });
        const before = await f.scopedEffects();
        await run(
          reader,
          'set_target_subscription_scoped',
          {
            ...targetPayload(),
            expectedSubscriptionRevision: first.receipt.result['revision'],
            subscribed: true,
          },
          'noop',
        );
        const stale = await f.commandIntent(
          reader,
          'set_target_subscription_scoped',
          {
            ...targetPayload(),
            expectedSubscriptionRevision: state.revision,
            subscribed: false,
          },
        );
        const denied = await f.executeCommand(reader, stale);
        assert.equal(denied.receipt.outcome, 'closed');
        if (denied.receipt.outcome !== 'closed') assert.fail();
        assert.equal(denied.receipt.code, 'RATING_REVISION_CONFLICT');
        remember(reader, denied);
        assert.deepEqual(await f.scopedEffects(), before);
        const current = await f.scopedRead(
          reader,
          `/v2/ratings/targets/${target.id}/subscription`,
        );
        assert.equal(current.subscribed, true);
        assert.equal(current.count, 1);
        const membership = await f.pool.query(
          'SELECT * FROM whaleu_ratings.subscription_memberships WHERE target_id=$1 AND account_id=$2',
          [target.id, reader.accountId],
        );
        assert.equal(membership.rowCount, 1);
      },
    );

    await t.test(
      'create_comment_scoped and create_reply_scoped publish exact v5 body, ancestry and native like baselines',
      async () => {
        const comment = await run(author, 'create_comment_scoped', {
          ...targetPayload(),
          authorMode: 'named',
          body: 'Scoped root 🌊',
          assetIds: [],
        });
        assert.ok(comment.approved);
        root = {
          id: String(comment.receipt.result['subjectId']),
          revision: String(comment.receipt.result['revision']),
          approval: comment.approved.decisionId,
        };
        const response = await run(owner, 'create_reply_scoped', {
          ...targetPayload(),
          rootId: root.id,
          expectedRootRevision: root.revision,
          replyTo: null,
          authorMode: 'named',
          body: 'Scoped reply',
          assetIds: [],
        });
        assert.ok(response.approved);
        reply = {
          id: String(response.receipt.result['replyId']),
          revision: String(response.receipt.result['revision']),
          approval: response.approved.decisionId,
        };
        const nested = await run(author, 'create_reply_scoped', {
          ...targetPayload(),
          rootId: root.id,
          expectedRootRevision: root.revision,
          replyTo: { replyId: reply.id, expectedRevision: reply.revision },
          authorMode: 'named',
          body: 'Nested reply',
          assetIds: [],
        });
        for (const [kind, content] of [
          ['comments', root],
          ['replies', reply],
        ] as const) {
          const publicContent = await f.scopedRead(
            reader,
            `/v2/ratings/${kind}/${content.id}`,
          );
          assert.equal(publicContent.id, content.id);
          const state = await f.scopedRead(
            reader,
            `/v2/ratings/${kind}/${content.id}/like`,
          );
          assert.equal(state.status, 'known');
          assert.equal(state.count, 0);
          assert.equal(state.liked, false);
        }
        const stored = (
          await f.pool.query(
            'SELECT envelope,reply_to_id FROM whaleu_ratings.replies WHERE id=$1',
            [nested.receipt.result['replyId']],
          )
        ).rows[0]!;
        assert.deepEqual(stored.envelope.replyTo, {
          replyId: reply.id,
          revision: reply.revision,
        });
        assert.equal(stored.reply_to_id, reply.id);
        assert.equal(stored.envelope.version, 5);
        assert.equal(stored.envelope.body, 'Nested reply');
        const fanout = await f.pool.query(
          `SELECT s.* FROM whaleu_ratings.subscription_fanout_sources s
      JOIN whaleu_ratings.effect_events e ON e.id=s.event_id WHERE e.request_id=$1 AND e.actor_account_id=$2`,
          [comment.input.payload.clientRequestId, author.accountId],
        );
        assert.equal(
          fanout.rowCount,
          1,
          'Scoped root uses the existing subscription fanout source',
        );
        assert.equal(fanout.rows[0]!.captured_coverage, 'complete');
        const worker = new RatingSubscriptionUpdatesWorker(
          f.app.get(DatabaseService),
          {
            ...f.app.get<RuntimeConfig>(APP_CONFIG),
            RATINGS_UPDATES_PROCESSING: 'manual',
          },
          f.app.get(RatingsSubscriptionUpdatesSourceFacade),
          f.app.get(RatingSubscriptionUpdatesProjectionFacade),
          f.app.get(RatingSubscriptionUpdatesRepository),
        );
        const eventId = fanout.rows[0]!.event_id as string;
        const materialized = await worker.run({
          mode: 'apply',
          eventIds: [eventId],
        });
        assert.equal(materialized.failed, 0, JSON.stringify(materialized));
        assert.equal(
          materialized.materialized,
          1,
          JSON.stringify(materialized),
        );
        const notices = (
          await f.pool.query(
            'SELECT * FROM whaleu_notifications.rating_subscription_notices WHERE event_id=$1 ORDER BY recipient_account_id',
            [eventId],
          )
        ).rows;
        assert.equal(notices.length, 1);
        assert.equal(notices[0]!.recipient_account_id, reader.accountId);
        const repeated = await worker.run({
          mode: 'apply',
          eventIds: [eventId],
        });
        assert.equal(repeated.alreadyProcessed, 1, JSON.stringify(repeated));
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_notifications.rating_subscription_notices WHERE event_id=$1 ORDER BY recipient_account_id',
              [eventId],
            )
          ).rows,
          notices,
        );
      },
    );

    for (const operation of [
      'set_comment_like_scoped',
      'set_reply_like_scoped',
    ] as const)
      await t.test(
        `${operation} applied/noop/stale CAS and unlike preserve ordinary like state and effects`,
        async () => {
          const content =
            operation === 'set_comment_like_scoped' ? root : reply;
          const path = `/v2/ratings/${operation === 'set_comment_like_scoped' ? 'comments' : 'replies'}/${content.id}/like`;
          const state = await f.scopedRead(reader, path);
          const payload = {
            ...targetPayload(),
            rootId: root.id,
            expectedRevision: content.revision,
            ...(operation === 'set_reply_like_scoped'
              ? { replyId: reply.id, expectedRootRevision: root.revision }
              : {}),
          };
          const first = await run(reader, operation, {
            ...payload,
            expectedLikeRevision: state.revision,
            liked: true,
          });
          const before = await f.scopedEffects();
          await run(
            reader,
            operation,
            {
              ...payload,
              expectedLikeRevision: first.receipt.result['revision'],
              liked: true,
            },
            'noop',
          );
          const stale = await f.commandIntent(reader, operation, {
            ...payload,
            expectedLikeRevision: state.revision,
            liked: false,
          });
          const denied = await f.executeCommand(reader, stale);
          assert.equal(denied.receipt.outcome, 'closed');
          if (denied.receipt.outcome !== 'closed') assert.fail();
          assert.equal(denied.receipt.code, 'RATING_REVISION_CONFLICT');
          remember(reader, denied);
          assert.deepEqual(await f.scopedEffects(), before);
          assert.equal((await f.scopedRead(reader, path)).count, 1);
          const unlike = await run(reader, operation, {
            ...payload,
            expectedLikeRevision: first.receipt.result['revision'],
            liked: false,
          });
          assert.equal(unlike.receipt.result['liked'], false);
          assert.equal((await f.scopedRead(reader, path)).count, 0);
          const exactEvents = (
            await f.pool.query(
              `SELECT e.request_id,e.event_kind,e.source_version,e.rule_version,e.expected_experience_units,e.expected_direct_notice_obligations,
              t.request_id transition_request,t.delta,t.id transition_id,e.like_transition_id
             FROM whaleu_ratings.effect_events e JOIN whaleu_ratings.like_transitions t ON t.id=e.like_transition_id
             WHERE e.actor_account_id=$1 AND e.request_id=ANY($2::uuid[]) ORDER BY t.delta DESC`,
              [
                reader.accountId,
                [
                  first.input.payload.clientRequestId,
                  unlike.input.payload.clientRequestId,
                ],
              ],
            )
          ).rows;
          assert.equal(
            exactEvents.length,
            2,
            'One event per actual membership direction, including the zero-reward unlike',
          );
          for (const [index, event] of exactEvents.entries()) {
            assert.equal(event.source_version, 2);
            assert.equal(event.rule_version, 'rating-likes-v1');
            assert.equal(
              event.event_kind,
              index === 0 ? 'content_liked' : 'content_unliked',
            );
            assert.equal(
              event.request_id,
              index === 0
                ? first.input.payload.clientRequestId
                : unlike.input.payload.clientRequestId,
            );
            assert.equal(event.request_id, event.transition_request);
            assert.equal(event.like_transition_id, event.transition_id);
            assert.equal(event.delta, index === 0 ? 1 : -1);
            if (index === 1) {
              assert.equal(event.expected_experience_units, 0);
              assert.equal(event.expected_direct_notice_obligations, 0);
            }
          }
          const positive = await f.pool.query(
            `SELECT count(*)::int n FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=ANY($2::uuid[]) AND expected_experience_units>0`,
            [
              reader.accountId,
              [
                first.input.payload.clientRequestId,
                unlike.input.payload.clientRequestId,
              ],
            ],
          );
          assert.equal(
            positive.rows[0]!.n,
            1,
            'Unlike does not mint a second positive reward',
          );
        },
      );

    await t.test(
      'Review reject is terminal; missing Review stays retriable with no fabricated closure',
      async () => {
        for (const operation of [
          'create_comment_scoped',
          'create_reply_scoped',
        ] as const) {
          const payload = {
            ...targetPayload(),
            authorMode: 'named',
            body: `Rejected ${operation}`,
            assetIds: [],
            ...(operation === 'create_reply_scoped'
              ? {
                  rootId: root.id,
                  expectedRootRevision: root.revision,
                  replyTo: null,
                }
              : {}),
          };
          const input = await f.commandIntent(author, operation, payload);
          await f.prepareCommand(author, input);
          const before = await f.scopedEffects();
          const missing = await f.sendCommand(author, input);
          assert.notEqual(missing.status, 200);
          assert.equal(missing.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
                [author.accountId, input.payload.clientRequestId],
              )
            ).rowCount,
            0,
          );
          await f.approveCommand(author, input, { result: 'reject' });
          const response = await f.sendCommand(author, input);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.body.outcome, 'closed');
          assert.equal(response.body.code, 'CONTENT_REJECTED');
          recorded.push({ actor: author, input, receipt: response.body });
          assert.deepEqual(await f.scopedEffects(), before);
        }
      },
    );

    await t.test(
      'edit_target_scoped advances one shared definition and exact lifecycle; unchanged edit is a real noop',
      async () => {
        const before = await f.scopedEffects();
        const input = await f.scopedEditIntent(owner, target.id, {
          name: 'Scoped target edited once',
        });
        const edit = await f.executeCommand(owner, input);
        remember(owner, edit);
        const result = scopedSuccess(edit.receipt).result;
        target.revision = String(result['revision']);
        assert.equal(result['contentVersion'], 2);
        const next = await f.scopedEditIntent(owner, target.id, {
          description: 'Scoped target edited twice',
        });
        const second = await f.executeCommand(owner, next);
        remember(owner, second);
        target.revision = String(
          scopedSuccess(second.receipt).result['revision'],
        );
        assert.equal(scopedSuccess(second.receipt).result['contentVersion'], 3);
        const noopInput = await f.scopedEditIntent(owner, target.id);
        const noop = await f.executeCommand(owner, noopInput, false);
        remember(owner, noop);
        const retained = scopedSuccess(noop.receipt, 'noop');
        assert.equal(retained.result['revision'], target.revision);
        assert.equal(retained.result['contentVersion'], 3);
        assert.deepEqual(await f.scopedEffects(), before);
        const rows = (
          await f.pool.query(
            `SELECT v.content_version,v.definition_revision,v.applied_target_revision,b.decision_id,l.target_revision lifecycle_revision
      FROM whaleu_ratings.target_definition_versions v JOIN whaleu_community.rating_scoped_target_definition_bindings b
      ON (b.target_id,b.content_version,b.definition_revision)=(v.target_id,v.content_version,v.definition_revision)
      JOIN whaleu_ratings.target_definition_lifecycles l ON l.target_id=v.target_id AND l.definition_revision=v.definition_revision
      WHERE v.target_id=$1 ORDER BY v.content_version`,
            [target.id],
          )
        ).rows;
        assert.deepEqual(
          rows.map((r) => r.content_version),
          [1, 2, 3],
        );
        for (const row of rows)
          assert.equal(row.lifecycle_revision, row.applied_target_revision);
      },
    );

    await t.test(
      'create/edit rejection and cancellation never leak tentative definition or release artifacts',
      async () => {
        const candidates = [
          await f.commandIntent(owner, 'create_target_scoped', {
            name: 'Rejected definition',
            description: '',
            assetIds: [],
          }),
          await f.scopedEditIntent(owner, target.id, { name: 'Rejected edit' }),
        ];
        for (const input of candidates) {
          const prepared = await f.prepareCommand(owner, input);
          await f.approveCommand(owner, input, { result: 'reject' });
          const response = await f.sendCommand(
            owner,
            input,
            prepared.contextRevision,
          );
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.body.outcome, 'closed');
          assert.equal(response.body.code, 'CONTENT_REJECTED');
          recorded.push({
            actor: owner,
            input,
            receipt: response.body,
            proof: prepared.contextRevision,
          });
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=$1 AND request_id=$2',
                [owner.accountId, input.payload.clientRequestId],
              )
            ).rowCount,
            0,
          );
        }
        for (const original of candidates) {
          const input = ratingScopedIntentSchema.parse({
            ...original,
            payload: { ...original.payload, clientRequestId: randomUUID() },
          });
          const path =
            input.operation === 'create_target_scoped'
              ? '/v2/ratings/management/cancel'
              : '/v2/ratings/management/owner-edit/cancel';
          const cancelled = await f
            .auth(request(f.http).post(path), owner)
            .send(input);
          assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
          assert.equal(cancelled.body.outcome, 'closed');
          assert.equal(
            cancelled.body.code,
            input.operation === 'create_target_scoped'
              ? 'RATING_CREATION_CANCELLED'
              : 'RATING_EDIT_CANCELLED',
          );
          const late = await f.sendCommand(owner, input, 'x'.repeat(43));
          assert.deepEqual(late.body, cancelled.body);
          recorded.push({
            actor: owner,
            input,
            receipt: cancelled.body,
            proof: 'x'.repeat(43),
          });
        }
      },
    );

    await t.test(
      'all eight historical operations replay before current context and recover under a new same-account session',
      async () => {
        assert.deepEqual(
          [...new Set(recorded.map((r) => r.input.operation))].sort(),
          [...ratingScopedOperations].sort(),
        );
        const before = await f.scopedEffects();
        const sessions = new Map<string, Actor>();
        for (const actor of [owner, author, reader])
          sessions.set(actor.accountId, await f.freshSession(actor));
        for (const row of recorded) {
          const actor = sessions.get(row.actor.accountId)!;
          const status = await f.auth(
            request(f.http).get(
              `/v2/ratings/requests/${row.input.payload.clientRequestId}`,
            ),
            actor,
          );
          assert.equal(status.status, 200, JSON.stringify(status.body));
          assert.deepEqual(status.body, row.receipt);
          const retry = await f.sendCommand(actor, row.input, row.proof);
          assert.equal(retry.status, 200, JSON.stringify(retry.body));
          assert.deepEqual(retry.body, row.receipt);
          const foreign = await f.auth(
            request(f.http).get(
              `/v2/ratings/requests/${row.input.payload.clientRequestId}`,
            ),
            row.actor.accountId === reader.accountId ? owner : reader,
          );
          assert.equal(foreign.body.error.code, 'REQUEST_NOT_FOUND');
        }
        assert.deepEqual(
          await f.scopedEffects(),
          before,
          'Replay cannot duplicate score, reward, fanout, like, or subscription mutations',
        );
        const units = (
          await f.pool.query<{ id: string }>(
            'SELECT id FROM whaleu_ratings.reward_units ORDER BY id',
          )
        ).rows;
        assert.ok(
          units.length > 0,
          'Ordinary effect capture must create reward work',
        );
        const worker = f.app.get(ExperienceWorker);
        const first = await worker.run({
          mode: 'apply',
          unitIds: units.map((u) => u.id),
        });
        assert.equal(first.failed, 0, JSON.stringify(first));
        assert.equal(first.sourceUnavailable, 0, JSON.stringify(first));
        const ledger = (
          await f.pool.query(
            'SELECT * FROM whaleu_experience.settlements WHERE unit_id=ANY($1::uuid[]) ORDER BY unit_id',
            [units.map((u) => u.id)],
          )
        ).rows;
        assert.equal(
          ledger.length,
          units.length,
          'Every captured reward reaches the existing settlement ledger',
        );
        const second = await worker.run({
          mode: 'apply',
          unitIds: units.map((u) => u.id),
        });
        assert.equal(second.failed, 0, JSON.stringify(second));
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_experience.settlements WHERE unit_id=ANY($1::uuid[]) ORDER BY unit_id',
              [units.map((u) => u.id)],
            )
          ).rows,
          ledger,
        );
      },
    );

    await t.test(
      'withdrawn scoped Review still allows author cleanup and owner tombstone on retained v1 routes',
      async () => {
        assert.ok(target.approved);
        await setRatingReviewState(f.pool, root.approval, 'revoked');
        await setRatingReviewState(f.pool, reply.approval, 'revoked');
        // Revoke the current definition, rather than only its historical v1 ancestor.
        const current = (
          await f.pool.query(
            `SELECT b.decision_id FROM whaleu_community.rating_scoped_target_definition_bindings b
      JOIN whaleu_ratings.target_definition_heads h ON (h.target_id,h.content_version)=(b.target_id,b.content_version) WHERE b.target_id=$1`,
            [target.id],
          )
        ).rows[0]!;
        await setRatingReviewState(f.pool, current.decision_id, 'revoked');
        const effects = await f.scopedEffects();
        const context = await f.auth(
          request(f.http).get(
            `/v1/ratings/comments/${root.id}/deletion-context`,
          ),
          author,
        );
        assert.equal(context.status, 200, JSON.stringify(context.body));
        assert.doesNotMatch(
          JSON.stringify(context.body),
          /Scoped root|accountId|authorMode/,
        );
        const body = {
          clientRequestId: randomUUID(),
          regionId: null,
          targetId: target.id,
          expectedTargetRevision: target.revision,
          expectedRevision: root.revision,
        };
        const removed = await f
          .auth(
            request(f.http).delete(`/v1/ratings/comments/${root.id}`),
            author,
          )
          .send(body);
        assert.equal(removed.status, 200, JSON.stringify(removed.body));
        assert.equal(removed.body.outcome, 'applied');
        assert.deepEqual(
          (
            await f
              .auth(
                request(f.http).delete(`/v1/ratings/comments/${root.id}`),
                author,
              )
              .send(body)
          ).body,
          removed.body,
        );
        root.revision = removed.body.revision;
        const replyBody = {
          clientRequestId: randomUUID(),
          regionId: null,
          targetId: target.id,
          rootId: root.id,
          expectedTargetRevision: target.revision,
          expectedRootRevision: root.revision,
          expectedRevision: reply.revision,
        };
        const removedReply = await f
          .auth(
            request(f.http).delete(`/v1/ratings/replies/${reply.id}`),
            owner,
          )
          .send(replyBody);
        assert.equal(
          removedReply.body.outcome,
          'applied',
          JSON.stringify(removedReply.body),
        );
        const prefix = '/v1/ratings/management/owner-deletion';
        const metadata = await f.auth(
          request(f.http).get(`${prefix}/targets/${target.id}/context`),
          owner,
        );
        assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
        const deleted = await f
          .auth(request(f.http).post(`${prefix}/targets/${target.id}`), owner)
          .send({
            clientRequestId: randomUUID(),
            expectedTargetRevision: metadata.body.revision,
          });
        assert.equal(
          deleted.body.outcome,
          'applied',
          JSON.stringify(deleted.body),
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=$1',
              [target.id],
            )
          ).rowCount,
          1,
        );
        const after = await f.scopedEffects();
        assert.equal(
          after['events'],
          effects['events'] + 2,
          'Original cleanup retains both zero-reward deletion events',
        );
        assert.equal(
          (
            await f.pool.query(
              `SELECT count(*)::int n FROM whaleu_ratings.effect_events e
                 LEFT JOIN whaleu_ratings.comment_transitions c ON c.id=e.comment_transition_id
                 LEFT JOIN whaleu_ratings.reply_transitions r ON r.id=e.reply_transition_id
                 WHERE e.target_id=$1 AND e.request_id=ANY($2::uuid[]) AND e.source_version=1 AND e.rule_version='rating-effects-v1'
                 AND ((e.event_kind='root_deleted' AND c.operation='delete_comment' AND c.request_id=e.request_id AND c.comment_id=e.root_id)
                   OR (e.event_kind='reply_deleted' AND r.operation='delete_reply' AND r.request_id=e.request_id AND r.reply_id=e.reply_id))
                 AND e.expected_experience_units=0 AND e.expected_direct_notice_obligations=0`,
              [target.id, [body.clientRequestId, replyBody.clientRequestId]],
            )
          ).rows[0]!.n,
          2,
        );
        for (const key of [
          'groups',
          'units',
          'obligations',
          'likeTransitions',
          'subscriptionTransitions',
        ])
          assert.equal(after[key], effects[key], key);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.target_definition_versions WHERE target_id=$1',
              [target.id],
            )
          ).rows[0]!.n,
          3,
        );
        for (const row of recorded)
          assert.deepEqual(
            (
              await f.auth(
                request(f.http).get(
                  `/v2/ratings/requests/${row.input.payload.clientRequestId}`,
                ),
                row.actor,
              )
            ).body,
            row.receipt,
          );
      },
    );
  },
);
