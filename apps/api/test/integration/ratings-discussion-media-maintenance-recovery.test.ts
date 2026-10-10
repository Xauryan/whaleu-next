import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import {
  syntheticRatingDiscussionFixture,
  discussionHttpOk,
} from '../support/media/ratings-discussion-runtime-fixture.js';
import { ratingsDiscussionMemberStatusSchema } from '../../src/media/contracts-ratings-discussion.js';
import { sha256 } from '../../src/media/processing/protocol.js';

test(
  'real maintenance-style epoch lock denies finalize without a ready claim; original uploaded identity then recovers exactly once',
  { timeout: 120000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 24, height: 24, channels: 3, background: '#715b39' },
    })
      .png()
      .toBuffer();
    const f = await syntheticRatingDiscussionFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actor = f.creator,
      intent = await f.draft(actor);
    let blockedMember: string | undefined, blockedIntent: string | undefined;
    const upload = await f.ready(
      actor,
      intent,
      [bytes],
      '',
      async (memberId) => {
        blockedMember = memberId;
        const snapshot = async () =>
          (
            await f.pool.query<{ state: unknown }>(
              `SELECT jsonb_build_object(
      'member',to_jsonb(m),'intent',to_jsonb(i),
      'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM whaleu_media.object_attempts a WHERE a.intent_id=i.id),
      'ingress',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.object_attempt_id) FROM whaleu_media.upload_ingress g WHERE g.intent_id=i.id),
      'jobs',(SELECT count(*) FROM whaleu_media.jobs j WHERE j.intent_id=i.id),
      'assets',(SELECT count(*) FROM whaleu_media.assets a WHERE a.intent_id=i.id),
      'requests',(SELECT count(*) FROM whaleu_ratings.requests r WHERE r.account_id=m.actor_id AND r.request_id=$2),
      'comments',(SELECT count(*) FROM whaleu_ratings.comments c WHERE c.account_id=m.actor_id AND c.request_id=$2)) state
      FROM whaleu_media.ratings_discussion_members m JOIN whaleu_media.upload_intents i ON i.id=m.intent_id WHERE m.member_id=$1`,
              [memberId, intent.payload.clientRequestId],
            )
          ).rows[0]!.state;
        const identity = (
          await f.pool.query<{
            intent_id: string;
            client_request_id: string;
            request_hash: string;
            state: string;
            generation: string;
          }>(
            `SELECT i.id intent_id,m.client_request_id,i.request_hash,i.state,i.generation::text FROM whaleu_media.ratings_discussion_members m JOIN whaleu_media.upload_intents i ON i.id=m.intent_id WHERE m.member_id=$1`,
            [memberId],
          )
        ).rows[0]!;
        blockedIntent = identity.intent_id;
        assert.equal(identity.state, 'prepared');
        const before = await snapshot();
        const holder = await f.pool.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(
            'LOCK TABLE whaleu_ratings.navigation_epoch IN SHARE UPDATE EXCLUSIVE MODE',
          );
          const denied = await f
            .auth(
              request(f.http).post(
                `/v3/media/ratings-discussion/members/${memberId}/finalize`,
              ),
              actor,
            )
            .send({});
          assert.equal(denied.status, 503);
          assert.equal(denied.body.error.code, 'RATING_UNAVAILABLE');
          assert.equal(denied.body.status, undefined);
          assert.deepEqual(
            await snapshot(),
            before,
            'every tentative lifecycle job/state rolls back; no business receipt or ready asset',
          );
          const recovered = await f.auth(
            request(f.http).get(
              `/v3/media/ratings-discussion/upload-requests/${identity.client_request_id}`,
            ),
            actor,
          );
          discussionHttpOk(recovered);
          assert.equal(recovered.body.state, 'recorded');
          assert.equal(recovered.body.requestHash, identity.request_hash);
          const status = ratingsDiscussionMemberStatusSchema.parse(
            recovered.body.status,
          );
          assert.equal(status.memberId, memberId);
          assert.equal(status.intentId, identity.intent_id);
          assert.equal(status.status, 'uploaded');
        } finally {
          await holder.query('ROLLBACK');
          holder.release();
        }
        // Returning continues f.ready's one original finalize, without choosing,
        // uploading, replacing keys, or silently retrying any other failure.
      },
    );
    assert.ok(blockedMember && blockedIntent);
    const result = await f.execute(actor, upload.intent);
    const repeat = await f.commit(
      actor,
      upload.intent,
      result.prepared.contextRevision,
    );
    discussionHttpOk(repeat);
    assert.deepEqual(repeat.body, result.receipt);
    const terminal = await f
      .auth(
        request(f.http).post(
          `/v3/media/ratings-discussion/members/${blockedMember}/finalize`,
        ),
        actor,
      )
      .send({});
    discussionHttpOk(terminal);
    assert.equal(terminal.body.status, 'bound_history');
    const counts = (
      await f.pool.query<{
        jobs: number;
        bindings: number;
        comments: number;
        requests: number;
      }>(
        `SELECT
    (SELECT count(*)::int FROM whaleu_media.jobs WHERE intent_id=$1 AND kind='seal') jobs,
    (SELECT count(*)::int FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE a.intent_id=$1) bindings,
    (SELECT count(*)::int FROM whaleu_ratings.comments WHERE account_id=$2 AND request_id=$3) comments,
    (SELECT count(*)::int FROM whaleu_ratings.requests WHERE account_id=$2 AND request_id=$3) requests`,
        [blockedIntent, actor.accountId, intent.payload.clientRequestId],
      )
    ).rows[0]!;
    assert.deepEqual(counts, {
      jobs: 1,
      bindings: 1,
      comments: 1,
      requests: 1,
    });
  },
);
