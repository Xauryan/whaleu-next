import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import {
  syntheticRatingDiscussionFixture,
  issueSyntheticDiscussionCapabilities,
  writeSyntheticDiscussionApproval,
  discussionHttpOk,
} from '../support/media/ratings-discussion-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { RatingScopedRepository } from '../../src/ratings/scoped/repository.js';
import { checkTransactionDeadlines } from '../../src/database/transaction-deadlines.js';
import { sha256 } from '../../src/media/processing/protocol.js';
async function reviewEvent(
  tx: PoolClient,
  decisionId: string,
  state: 'allow' | 'held' | 'revoked',
) {
  const id = randomUUID();
  await tx.query(
    "INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,$3,'complete','accepted','synthetic-discussion-boundary','synthetic-discussion-boundary',clock_timestamp())",
    [id, decisionId, state],
  );
  await tx.query(
    'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
    [decisionId, id],
  );
}
const bindingZero =
  'UPDATE whaleu_community.rating_discussion_media_bindings SET digest=digest WHERE false';
const capabilityZero =
  'UPDATE whaleu_ratings.discussion_media_capability_sources SET adoption_digest=adoption_digest WHERE false';
/** Real SQL authority changes. Hooks only choose a boundary in the real owner;
 * they never replace Review, current content, receipts or required proof. */
test(
  'Review7 held/revoked after prepare is never an attachment publication',
  { timeout: 180000 },
  async (t) => {
    const sharp = (await import('sharp')).default,
      bytes = await sharp({
        create: { width: 24, height: 24, channels: 3, background: '#374e69' },
      })
        .png()
        .toBuffer();
    const f = await syntheticRatingDiscussionFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    for (const state of ['held', 'revoked'] as const)
      await t.test(state, async () => {
        const actor = await f.actor(),
          upload = await f.ready(actor, await f.draft(actor), [bytes]),
          prepared = await f.prepare(actor, upload.intent),
          approval = await writeSyntheticDiscussionApproval(
            f.pool,
            prepared.envelope,
          );
        await withCommunityScopeWriter(f.pool, (tx) =>
          reviewEvent(tx, approval.decisionId, state),
        );
        const response = await f.commit(
          actor,
          upload.intent,
          prepared.prepared.contextRevision,
        );
        if (state === 'revoked') {
          discussionHttpOk(response);
          assert.equal(response.body.outcome, 'closed');
          assert.equal(response.body.code, 'CONTENT_REJECTED');
        } else
          assert.notEqual(
            response.status,
            200,
            'held is unknown at consumption, not an approval',
          );
        const result = (
          await f.pool.query<{
            subjects: number;
            bindings: number;
            reviews: number;
            state: string;
          }>(
            `SELECT
     (SELECT count(*)::int FROM whaleu_ratings.comments WHERE account_id=$1 AND request_id=$2) subjects,
     (SELECT count(*)::int FROM whaleu_media.bindings WHERE resource_id=$3) bindings,
     (SELECT count(*)::int FROM whaleu_community.rating_discussion_media_bindings WHERE subject_id=$3) reviews,
     (SELECT state FROM whaleu_media.ratings_discussion_batches WHERE id=$4) state`,
            [
              actor.accountId,
              upload.intent.payload.clientRequestId,
              prepared.envelope.subjectId,
              upload.batch.batchId,
            ],
          )
        ).rows[0]!;
        assert.deepEqual(result, {
          subjects: 0,
          bindings: 0,
          reviews: 0,
          state: 'sealed',
        });
      });
  },
);

test(
  'real Review7 and capability mutations after full publication flush roll back every owner',
  { timeout: 240000 },
  async (t) => {
    const sharp = (await import('sharp')).default,
      bytes = await sharp({
        create: { width: 24, height: 24, channels: 3, background: '#493e75' },
      })
        .png()
        .toBuffer();
    const f = await syntheticRatingDiscussionFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    for (const mutation of [
      'held',
      'revoked',
      'review-aba',
      'capability-zero',
      'binding-zero',
    ] as const)
      await t.test(mutation, async () => {
        const actor = await f.actor(),
          upload = await f.ready(actor, await f.draft(actor), [bytes]),
          prepared = await f.prepare(actor, upload.intent),
          approval = await writeSyntheticDiscussionApproval(
            f.pool,
            prepared.envelope,
          );
        const finish = f.media.assets.finish;
        let injected = false;
        f.media.assets.finish = async function (
          ...args: Parameters<typeof finish>
        ) {
          await finish.apply(this, args);
          injected = true;
          if (mutation === 'capability-zero' || mutation === 'binding-zero')
            assert.equal(
              (
                await args[1].query(
                  mutation === 'capability-zero' ? capabilityZero : bindingZero,
                )
              ).rowCount,
              0,
            );
          else {
            await reviewEvent(
              args[1],
              approval.decisionId,
              mutation === 'review-aba' ? 'held' : mutation,
            );
            if (mutation === 'review-aba')
              await reviewEvent(args[1], approval.decisionId, 'allow');
          }
        };
        try {
          const response = await f.commit(
            actor,
            upload.intent,
            prepared.prepared.contextRevision,
          );
          assert.equal(injected, true);
          assert.notEqual(response.status, 200);
        } finally {
          f.media.assets.finish = finish;
        }
        const count = (
          await f.pool.query<{ n: number }>(
            `SELECT ((SELECT count(*) FROM whaleu_ratings.comments WHERE account_id=$1 AND request_id=$2)
      +(SELECT count(*) FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2)
      +(SELECT count(*) FROM whaleu_community.rating_discussion_media_bindings WHERE subject_id=$3)
      +(SELECT count(*) FROM whaleu_media.bindings WHERE resource_id=$3)
      +(SELECT count(*) FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2))::int n`,
            [
              actor.accountId,
              upload.intent.payload.clientRequestId,
              prepared.envelope.subjectId,
            ],
          )
        ).rows[0]!.n;
        assert.equal(count, 0);
        assert.equal(
          (
            await f.pool.query<{ state: string }>(
              'SELECT state FROM whaleu_media.ratings_discussion_batches WHERE id=$1',
              [upload.batch.batchId],
            )
          ).rows[0]!.state,
          'sealed',
        );
        discussionHttpOk(
          await f.commit(
            actor,
            upload.intent,
            prepared.prepared.contextRevision,
          ),
        );
      });
  },
);

test(
  'actual Review7 reads retain zero-row and ABA facts and fence a held writer before output',
  { timeout: 240000 },
  async (t) => {
    const sharp = (await import('sharp')).default,
      bytes = await sharp({
        create: { width: 24, height: 24, channels: 3, background: '#657343' },
      })
        .png()
        .toBuffer();
    const f = await syntheticRatingDiscussionFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actor = f.creator,
      upload = await f.ready(actor, await f.draft(actor), [bytes]),
      done = await f.execute(actor, upload.intent);
    assert.equal(done.receipt.operation, 'create_comment_scoped');
    const id = done.envelope.subjectId,
      repository = f.app.get(RatingScopedRepository),
      retainAfter = repository.retainAfter;
    await t.test(
      'persisted Review7 held and revoked hide the complete published set',
      async () => {
        for (const state of ['held', 'revoked'] as const) {
          await withCommunityScopeWriter(f.pool, (tx) =>
            reviewEvent(tx, done.approved.decisionId, state),
          );
          const context = await f.context(actor, 'read'),
            response = await f
              .auth(
                request(f.http).get(`/v4/ratings/discussion/comments/${id}`),
                actor,
              )
              .query({ contextId: context.id, contextToken: context.token });
          assert.notEqual(response.status, 200);
          assert.equal(response.body.images, undefined);
          assert.equal(response.body.body, undefined);
          await withCommunityScopeWriter(f.pool, (tx) =>
            reviewEvent(tx, done.approved.decisionId, 'allow'),
          );
        }
      },
    );
    await t.test(
      'the new capability epoch cannot be directly reset or zero-row rewritten',
      async () => {
        for (const sql of [
          'UPDATE whaleu_ratings.discussion_media_capability_epoch SET epoch=epoch-1',
          'UPDATE whaleu_ratings.discussion_media_capability_epoch SET epoch=epoch WHERE false',
        ])
          await assert.rejects(
            withCommunityScopeWriter(f.pool, (tx) => tx.query(sql)),
            (error: unknown) =>
              Boolean(
                error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === '23514',
              ),
          );
      },
    );
    for (const mutation of [
      'binding-zero',
      'capability-zero',
      'held',
      'revoked',
      'review-aba',
      'held-writer',
      'after-final-proof',
    ] as const)
      await t.test(mutation, async () => {
        const context = await f.context(actor, 'read'),
          holder =
            mutation === 'held-writer' || mutation === 'after-final-proof'
              ? await f.pool.connect()
              : null;
        if (holder) await holder.query('BEGIN');
        const holderPid = holder
          ? (await holder.query<{ pid: number }>('SELECT pg_backend_pid() pid'))
              .rows[0]!.pid
          : null;
        let injected = false,
          writer: Promise<number | null> | undefined;
        repository.retainAfter = async function (
          ...args: Parameters<typeof retainAfter>
        ) {
          await retainAfter.apply(this, args);
          if (injected) return;
          injected = true;
          const tx = args[1];
          if (mutation === 'binding-zero')
            assert.equal((await tx.query(bindingZero)).rowCount, 0);
          else if (mutation === 'capability-zero')
            assert.equal((await tx.query(capabilityZero)).rowCount, 0);
          else if (
            mutation === 'held' ||
            mutation === 'revoked' ||
            mutation === 'review-aba'
          ) {
            await reviewEvent(
              tx,
              done.approved.decisionId,
              mutation === 'review-aba' ? 'held' : mutation,
            );
            if (mutation === 'review-aba')
              await reviewEvent(tx, done.approved.decisionId, 'allow');
          } else {
            if (mutation === 'after-final-proof')
              await checkTransactionDeadlines(tx);
            writer = holder!.query(bindingZero).then((value) => value.rowCount);
            void writer.catch(() => undefined);
            const deadline = Date.now() + 2000;
            for (;;) {
              const lock = (
                await f.pool.query<{ granted: boolean; blocked: boolean }>(
                  `SELECT
          EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='relation' AND relation='whaleu_community.rating_discussion_media_bindings'::regclass AND mode='RowExclusiveLock' AND granted) granted,
          EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0) blocked`,
                  [holderPid],
                )
              ).rows[0]!;
              if (lock.blocked && lock.granted === (mutation === 'held-writer'))
                break;
              if (Date.now() >= deadline)
                assert.fail(
                  'Real Review7 writer did not reach the expected final-proof lock boundary',
                );
              await sleep(5);
            }
          }
        };
        try {
          const response = await f
            .auth(
              request(f.http).get(`/v4/ratings/discussion/comments/${id}`),
              actor,
            )
            .query({ contextId: context.id, contextToken: context.token })
            .timeout({ deadline: 5000 });
          assert.equal(injected, true);
          if (mutation === 'after-final-proof') {
            discussionHttpOk(response);
            assert.equal(response.body.images.length, 1);
          } else {
            assert.equal(
              response.status,
              mutation === 'capability-zero' ? 403 : 503,
              JSON.stringify(response.body),
            );
            if (mutation === 'capability-zero')
              assert.equal(
                response.body.error.code,
                'RATING_SCOPE_UNAVAILABLE',
              );
            assert.equal(response.body.images, undefined);
            assert.equal(response.body.body, undefined);
          }
        } finally {
          repository.retainAfter = retainAfter;
          if (holder) {
            try {
              if (writer) assert.equal(await writer, 0);
            } finally {
              await holder.query('ROLLBACK');
              holder.release();
            }
          }
        }
        const clean = await f.context(actor, 'read');
        discussionHttpOk(
          await f
            .auth(
              request(f.http).get(`/v4/ratings/discussion/comments/${id}`),
              actor,
            )
            .query({ contextId: clean.id, contextToken: clean.token }),
        );
      });
  },
);

test(
  'real independently adopted capability expiry closes prepare-to-commit and current read authority',
  { timeout: 120000 },
  async (t) => {
    const f = await syntheticRatingDiscussionFixture([], {
      registerCapabilities: false,
    });
    t.after(() => f.close());
    await issueSyntheticDiscussionCapabilities(f.pool, 8000);
    const actor = f.creator,
      published = await f.execute(actor, await f.draft(actor)),
      pending = await f.draft(actor),
      prepared = await f.prepare(actor, pending);
    await writeSyntheticDiscussionApproval(f.pool, prepared.envelope);
    const context = await f.context(actor, 'read'),
      expires = Date.parse(context.discussionMedia.validUntil);
    assert.ok(
      Date.now() < expires,
      'fixture preparation must finish before the real SQL capability deadline',
    );
    const repository = f.app.get(RatingScopedRepository),
      retainAfter = repository.retainAfter;
    let reached = false;
    repository.retainAfter = async function (
      ...args: Parameters<typeof retainAfter>
    ) {
      await retainAfter.apply(this, args);
      reached = true;
      await args[1].query(
        "SET LOCAL idle_in_transaction_session_timeout='15s'",
      );
      await sleep(Math.max(0, expires - Date.now() + 25));
    };
    try {
      const crossing = await f
        .auth(
          request(f.http).get(
            `/v4/ratings/discussion/comments/${published.envelope.subjectId}`,
          ),
          actor,
        )
        .query({ contextId: context.id, contextToken: context.token })
        .timeout({ deadline: 15000 });
      assert.equal(reached, true);
      assert.equal(crossing.status, 403, JSON.stringify(crossing.body));
      assert.equal(crossing.body.error.code, 'RATING_SCOPE_UNAVAILABLE');
      assert.equal(crossing.body.body, undefined);
    } finally {
      repository.retainAfter = retainAfter;
    }
    const commit = await f.commit(
      actor,
      pending,
      prepared.prepared.contextRevision,
    );
    assert.ok(commit.status !== 200 || commit.body.outcome === 'closed');
    const read = await f
      .auth(
        request(f.http).get(
          `/v4/ratings/discussion/comments/${published.envelope.subjectId}`,
        ),
        actor,
      )
      .query({ contextId: context.id, contextToken: context.token });
    assert.notEqual(read.status, 200);
    const fresh = await f
      .auth(request(f.http).post('/v4/ratings/discussion/contexts'), actor)
      .send({ purpose: 'read', selector: { kind: 'global' }, mode: 'public' });
    assert.notEqual(fresh.status, 200);
    assert.equal(
      (
        await f.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM whaleu_ratings.comments WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, pending.payload.clientRequestId],
        )
      ).rows[0]!.n,
      0,
    );
  },
);
