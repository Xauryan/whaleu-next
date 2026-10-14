import type { PoolClient } from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingTargetLinkFixture } from '../support/rating-target-link-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { DatabaseService } from '../../src/database/database.js';
import { CommunityUpdatesFacade } from '../../src/community/updates.facade.js';
import { CommunityProfileDiscoveryFacade } from '../../src/community/profile-discovery.facade.js';
import { LocalApprovedContentVisibility } from '../../src/community/content-review/local-approved-content-visibility.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

const code = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
test(
  'linked card descendant, notification, saved/liked/profile consumers preserve three-state source ownership',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingTargetLinkFixture();
    t.after(() => f.close());
    const category = await f.createLinkCategory('course'),
      target = await f.createLinkTarget(category),
      reader = await f.actor(),
      foreign = await f.actor({ campusId: f.campusB }),
      body = await f.card(target.id),
      published = await f.publishCard(body),
      postId = published.resourceId;
    const get = (path: string, actor = reader) =>
      f.auth(request(f.http).get(path), actor);
    const child = {
      clientRequestId: randomUUID(),
      text: 'Retained child preview text',
      authorMode: 'named',
      imageAssetIds: [],
    };
    assert.equal(
      (
        await f.linkCall(
          reader,
          `/v1/community/reviews/posts/${postId}/comments`,
          child,
        )
      ).status,
      200,
    );
    await f.approveLinkCommunity(reader, child.clientRequestId);
    const comment = await f.linkCall(
      reader,
      `/v1/community/posts/${postId}/comments`,
      child,
    );
    assert.equal(comment.status, 201, JSON.stringify(comment.body));
    const commentId = String(comment.body.resourceId);
    assert.equal(
      (
        await f
          .auth(
            request(f.http).put(`/v1/community/posts/${postId}/save`),
            reader,
          )
          .send({ clientRequestId: randomUUID() })
      ).status,
      200,
    );
    assert.equal(
      (
        await f
          .auth(
            request(f.http).put(`/v1/community/posts/${postId}/like`),
            reader,
          )
          .send({ requestId: randomUUID(), liked: true })
      ).status,
      200,
    );
    const db = f.app.get(DatabaseService);
    const notification = () =>
      db.transaction((tx) =>
        f.app.get(CommunityUpdatesFacade).eligible(
          { postId, commentId, replyId: null },
          {
            accountId: f.creator.accountId,
            reason: 'direct',
            saveEpochId: null,
          },
          tx,
        ),
      );
    const profile = () =>
      db.transaction((tx) =>
        f.app
          .get(CommunityProfileDiscoveryFacade)
          .page(
            f.creator.accountId,
            reader.accountId,
            'posts',
            { limit: 20 },
            `rating-card:${reader.accountId}`,
            tx,
            async () => {},
          ),
      );
    const purposes = [
      'list_projection',
      'direct_post',
      'detail_projection',
      'named_interaction',
    ] as const;
    const matrix = async (expected: 'allow' | 'deny' | 'unavailable') => {
      for (const purpose of purposes)
        for (const [contentKind, contentId, namedAccountId] of [
          ['post', postId, f.creator.accountId],
          ['comment', commentId, reader.accountId],
        ] as const) {
          const decision = await db.transaction((tx) =>
            f.app.get(LocalApprovedContentVisibility).check(
              reader.accountId,
              {
                contentKind,
                contentId,
                contentVersion: 1,
                authorMode: 'named',
                namedAccountId,
              },
              tx,
              purpose,
            ),
          );
          assert.equal(decision.kind, expected, `${purpose}:${contentKind}`);
        }
    };
    await matrix('allow');
    assert.equal((await notification()).outcome, 'eligible');
    assert.ok((await profile()).items.some((post) => post.id === postId));
    assert.match(
      JSON.stringify((await get('/v1/me/community/saved')).body),
      new RegExp(postId),
    );
    assert.match(
      JSON.stringify((await get('/v1/me/community/liked')).body),
      new RegExp(postId),
    );
    assert.equal(
      (await get(`/v1/community/posts/${postId}`, foreign)).status,
      404,
    );
    const guest = await request(f.http)
      .get('/v1/community/posts')
      .query({ spaceId: f.scope.home.spaceId });
    assert.doesNotMatch(
      JSON.stringify(guest.body),
      new RegExp(`${postId}|Retained child|这门课程`),
    );
    await setRatingReviewState(f.pool, target.approval.decisionId, 'revoked', {
      boundedLockWait: true,
    });
    await matrix('deny');
    assert.equal((await notification()).outcome, 'suppressed');
    assert.equal((await profile()).total, 0);
    for (const path of ['/v1/me/community/saved', '/v1/me/community/liked']) {
      const response = await get(path);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.doesNotMatch(
        JSON.stringify(response.body),
        new RegExp(`${postId}|Retained child|这门课程`),
      );
    }
    await withCommunityScopeWriter(f.pool, async (tx) => {
      const event = randomUUID();
      await tx.query(
        "INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','missing','accepted','synthetic-rating-review','synthetic-incomplete-card',clock_timestamp())",
        [event, target.approval.decisionId],
      );
      await tx.query(
        'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
        [target.approval.decisionId, event],
      );
    });
    await matrix('unavailable');
    assert.equal((await notification()).outcome, 'unavailable');
    await assert.rejects(profile());
    for (const path of ['/v1/me/community/saved', '/v1/me/community/liked']) {
      const response = await get(path);
      assert.equal(response.status, 503, JSON.stringify(response.body));
      assert.doesNotMatch(
        JSON.stringify(response.body),
        /Retained child|这门课程/,
      );
    }
  },
);

test(
  'card deferred SQL source check rejects a committed late revocation and an in-flight source writer without partial queue',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingTargetLinkFixture();
    const leased = new Set<PoolClient>();
    const connect = async () => {
      const client = await f.pool.connect();
      leased.add(client);
      const release = client.release.bind(client);
      client.release = (error?: Error | boolean) => {
        leased.delete(client);
        release(error);
      };
      return client;
    };
    t.after(async () => {
      for (const client of [...leased]) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
      await f.close();
    });
    const author = await f.actor();
    const category = await f.createLinkCategory('course'),
      target = await f.createLinkTarget(category),
      body = await f.card(target.id, 'named', author);
    const submitted = await f.linkCall(
      author,
      '/v1/community/reviews/posts',
      body,
    );
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const exact = (
      await f.pool.query(
        'SELECT envelope,digest,intent_hash FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
        [author.accountId, body.clientRequestId],
      )
    ).rows[0]!;
    const begin = async () => {
      const tx = await connect(),
        requestId = randomUUID();
      await tx.query('BEGIN');
      try {
        await tx.query("SET LOCAL lock_timeout='1000ms'");
        await tx.query("SET LOCAL statement_timeout='5000ms'");
        await tx.query(
          "INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,operation,payload_hash,review_submission_transaction) VALUES($1,$2,'publish_post',$3,pg_current_xact_id())",
          [author.accountId, requestId, exact.intent_hash],
        );
        await tx.query(
          "INSERT INTO whaleu_community.text_review_requests(account_id,client_request_id,operation,intent_hash,envelope,digest) VALUES($1,$2,'publish_post',$3,$4::jsonb,$5)",
          [
            author.accountId,
            requestId,
            exact.intent_hash,
            canonicalJson(exact.envelope),
            exact.digest,
          ],
        );
        return { tx, requestId };
      } catch (error) {
        await tx.query('ROLLBACK');
        tx.release();
        throw error;
      }
    };
    const noQueue = async (id: string) =>
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [author.accountId, id],
          )
        ).rowCount,
        0,
      );
    const first = await begin();
    try {
      await setRatingReviewState(
        f.pool,
        target.approval.decisionId,
        'revoked',
        { boundedLockWait: true },
      ).catch(async (error: unknown) => {
        t.diagnostic(
          JSON.stringify(
            (
              await first.tx.query(
                `SELECT locktype,mode,relation::regclass::text relation,classid,objid
           FROM pg_locks WHERE pid=pg_backend_pid() AND mode<>'AccessShareLock'`,
              )
            ).rows,
          ),
        );
        throw error;
      });
      await assert.rejects(
        first.tx.query('COMMIT'),
        (error) => code(error) === '23514',
      );
    } finally {
      await first.tx.query('ROLLBACK');
      first.tx.release();
    }
    await noQueue(first.requestId);
    await setRatingReviewState(f.pool, target.approval.decisionId, 'allow');
    const second = await begin(),
      writer = await connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout='1000ms'");
      await writer.query("SET LOCAL statement_timeout='5000ms'");
      await writer.query(
        'LOCK TABLE whaleu_community.rating_review_epoch IN ROW EXCLUSIVE MODE',
      );
      assert.equal(
        (
          await writer.query(
            "SELECT count(*)::int n FROM pg_locks WHERE pid=pg_backend_pid() AND relation='whaleu_community.rating_review_epoch'::regclass AND mode='RowExclusiveLock' AND granted",
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(
        second.tx.query('COMMIT'),
        (error) => code(error) === '55P03',
      );
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      await second.tx.query('ROLLBACK');
      second.tx.release();
    }
    await noQueue(second.requestId);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_community.post_rating_target_links',
        )
      ).rows[0].n,
      0,
    );
  },
);
