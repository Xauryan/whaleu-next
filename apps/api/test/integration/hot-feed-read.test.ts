import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  hotFeedFixture,
  hotIds,
  hotOk,
  hotFailure,
  hotPath,
  hotRanges,
} from '../support/hot-feed-fixture.js';
import { setReviewState } from '../support/community-approval-fixtures.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import {
  HOT_SCORE_FORMULA_FINGERPRINT,
  HOT_SCORE_EXPRESSION_FINGERPRINT,
} from '../../src/community/hot-score/formula.js';

const trading = {
  subtype: 'shuma' as const,
  price: '12.5',
  urgency: 'normal' as const,
  location: 'Synthetic market',
  contacts: { wechat: 'private-hot-contact', qq: '', phone: '' },
};

test(
  'unified public hot: fresh certificates, exact ordering, live navigation and current visibility',
  { timeout: 300000 },
  async (t) => {
    const f = await hotFeedFixture();
    try {
      await t.test(
        'known zero is materialized; older unknown coverage is never enrolled or represented as zero',
        async () => {
          const w = await f.world(),
            fresh = await w.publish();
          assert.equal(await f.certificate(fresh.id), undefined);
          assert.deepEqual(hotIds(hotOk(await w.hot())), []);
          const old = await f.rawUnknown(w.author);
          const before = await f.domainSnapshot();
          hotOk(await w.hot());
          assert.deepEqual(
            await f.domainSnapshot(),
            before,
            'HTTP must not settle, enroll, calculate or alter domain state',
          );
          await f.materializer.refresh(fresh.id);
          const cert = await f.certificate(fresh.id);
          assert.ok(cert);
          const bytes = JSON.stringify(cert);
          assert.ok(bytes.includes('0.0000'));
          assert.ok(bytes.includes(HOT_SCORE_FORMULA_FINGERPRINT));
          assert.ok(bytes.includes(HOT_SCORE_EXPRESSION_FINGERPRINT));
          assert.ok(bytes.includes(fresh.body.clientRequestId));
          assert.ok(bytes.includes(w.author.accountId));
          assert.deepEqual(hotIds(hotOk(await w.hot())), [fresh.id]);
          await f.materializer.refresh(old);
          assert.equal(await f.certificate(old), undefined);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_post_hotness.processing WHERE post_id=$1',
                [old],
              )
            ).rowCount,
            0,
          );
          for (const component of ['subscription', 'like', 'comment', 'view'])
            assert.equal(
              (
                await f.pool.query(
                  `SELECT 1 FROM whaleu_post_hotness.${component}_baselines WHERE post_id=$1`,
                  [old],
                )
              ).rowCount,
              0,
            );
        },
      );
      await t.test(
        'strict endpoint grammar, guest preview and supplied invalid credentials never downgrade',
        async () => {
          const w = await f.world();
          for (let n = 0; n < 3; n++) await w.ready();
          const guest = await w.hot({ limit: '1' }, null);
          assert.equal(hotOk(guest, 1).continuation, 'login_required');
          assert.equal(guest.headers['cache-control'], 'private, no-store');
          assert.equal(guest.headers['vary'], 'Authorization');
          for (const query of [
            { range: 'all' },
            { range: 'Day' },
            { limit: '0' },
            { limit: '11' },
            { limit: '01' },
            { limit: '1.0' },
            { limit: '1e0' },
            { spaceId: 'invalid' },
            { cursor: 'x' },
            { cursor: randomBytes(32).toString('base64url') + '=' },
            { score: '1' },
            { accountId: w.reader.accountId },
            { category: 'discussion' },
            { choose: '1' },
            { sort: 'score' },
          ])
            hotFailure(await w.hot(query), 400);
          for (const extra of [
            '&range=day&range=week',
            '&limit=1&limit=2',
            '&range%5B%5D=day',
          ])
            hotFailure(
              await request(f.app.getHttpServer()).get(
                `${hotPath}?spaceId=${w.scope.home.spaceId}${extra}`,
              ),
              400,
            );
          hotFailure(await request(f.app.getHttpServer()).get(hotPath), 400);
          hotFailure(
            await request(f.app.getHttpServer())
              .get(hotPath)
              .query({ spaceId: w.scope.home.spaceId })
              .set('Authorization', 'Bearer invalid'),
            401,
          );
          const unverified = await w.actor('unverified');
          assert.equal(
            hotOk(await w.hot({ limit: 1 }, unverified), 1).continuation,
            'phone_verification_required',
          );
          const first = hotOk(await w.hot({ limit: 1 }), 1);
          assert.equal(first.continuation, 'more');
          hotFailure(
            await w.hot({ limit: 1, cursor: first.nextCursor }, null),
            401,
          );
          hotFailure(
            await w.hot({ limit: 1, cursor: first.nextCursor }, unverified),
            403,
            'PHONE_VERIFICATION_REQUIRED',
          );
        },
      );
      await t.test(
        'PostgreSQL numeric order and UUID ties are independent of string order and publication date',
        async () => {
          const w = await f.world(),
            rows = [];
          for (const views of ['1', '32', '243', '0', '0']) {
            const p = await w.publish();
            rows.push({ id: p.id, views });
            if (views !== '0')
              await f.pool.query(
                'UPDATE whaleu_post_hotness.view_states SET count=$2::bigint WHERE post_id=$1',
                [p.id, views],
              );
            await f.materializer.refresh(p.id);
          }
          const expected = await f.pool.query<{
            post_id: string;
            score: string;
          }>(
            'SELECT post_id,score::text FROM whaleu_post_hotness.scores s WHERE post_id=ANY($1::uuid[]) ORDER BY s.score DESC,post_id DESC',
            [rows.map((r) => r.id)],
          );
          assert.deepEqual(
            expected.rows.map((r) => r.score),
            ['68.4000', '30.4000', '7.6000', '0.0000', '0.0000'],
          );
          assert.deepEqual(
            hotIds(hotOk(await w.hot())),
            expected.rows.map((r) => r.post_id),
          );
          const first = hotOk(await w.hot({ limit: 2 }), 2),
            second = hotOk(
              await w.hot({ limit: 2, cursor: first.nextCursor }),
              2,
            );
          assert.deepEqual(
            [...hotIds(first), ...hotIds(second)],
            expected.rows.slice(0, 4).map((r) => r.post_id),
          );
          assert.equal(Buffer.from(first.nextCursor!, 'base64url').length, 32);
          assert.ok(
            !Buffer.from(first.nextCursor!, 'base64url')
              .toString('utf8')
              .includes('score'),
          );
        },
      );
      await t.test(
        'captured like/save/comment backlog and accepted views invalidate immediately without read-side work',
        async () => {
          const w = await f.world(),
            post = await w.ready(),
            initial = await f.certificate(post.id);
          for (const component of [
            'like',
            'subscription',
            'comment',
            'view',
          ] as const) {
            if (component === 'like') {
              await f.like(w.reader, post.id);
              await f.like(w.reader, post.id, false);
            }
            if (component === 'subscription') {
              await f.save(w.reader, post.id);
              await f.save(w.reader, post.id, false);
            }
            if (component === 'comment') {
              const root = await f.root(w.reader, post.id);
              await f.deleteContent(w.reader, 'root', root.id).expect(204);
            }
            if (component === 'view') await f.view(w.reader, [post.id]);
            const before = await f.domainSnapshot();
            assert.deepEqual(hotIds(hotOk(await w.hot())), [], component);
            assert.deepEqual(await f.domainSnapshot(), before);
            if (component !== 'view') await f.settle(component, post.id);
            assert.deepEqual(
              hotIds(hotOk(await w.hot())),
              [],
              'Settlement alone cannot make the old certificate current',
            );
            await f.materializer.refresh(post.id);
            assert.deepEqual(hotIds(hotOk(await w.hot())), [post.id]);
            assert.notDeepEqual(await f.certificate(post.id), initial);
          }
        },
      );
      await t.test(
        'scope and rolling publication-age windows exclude future, resolved and urgent rows',
        async () => {
          const w = await f.world();
          const now = (
            await f.pool.query<{ at: Date }>('SELECT clock_timestamp() at')
          ).rows[0]!.at;
          const ages = [0, 2, 8, 31, 181, 366, -1],
            rows = [];
          for (const age of ages) {
            const p = await w.dated(
              new Date(now.getTime() - age * 86400000).toISOString(),
            );
            rows.push(p.id);
          }
          for (const [range, count] of [
            ['day', 1],
            ['week', 2],
            ['month', 3],
            ['half_year', 4],
            ['year', 5],
            ['history', 6],
          ] as const) {
            const ids = hotIds(hotOk(await w.hot({ range })));
            assert.deepEqual(
              [...ids].sort(),
              rows.slice(0, count).sort(),
              range,
            );
          }
          const normal = await w.ready({ category: 'trading', trading });
          const urgent = await w.ready({
            category: 'trading',
            trading: { ...trading, urgency: 'urgent' },
          });
          const resolved = await w.ready({ category: 'trading', trading });
          await request(f.app.getHttpServer())
            .post(`/v1/community/posts/${resolved.id}/trading/resolution`)
            .set('Authorization', `Bearer ${w.author.accessToken}`)
            .send({ clientRequestId: randomUUID(), resolution: 'resolved' })
            .expect(201);
          const global = await w.ready({ spaceId: w.scope.global.spaceId });
          const home = hotIds(hotOk(await w.hot({ range: 'history' })));
          assert.ok(home.includes(normal.id));
          assert.ok(!home.includes(urgent.id));
          assert.ok(!home.includes(resolved.id));
          assert.ok(!home.includes(global.id));
          assert.deepEqual(
            hotIds(hotOk(await w.hot({ spaceId: w.scope.global.spaceId }))),
            [global.id],
          );
          await f.mutate((tx) =>
            tx.query(
              'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
              [w.scope.home.spaceId],
            ),
          );
          hotFailure(await w.hot(), 409, 'COMMUNITY_SCOPE_UNAVAILABLE');
        },
      );
      await t.test(
        'unified score retains blocked actor inputs while named/anonymous post and nested visibility stay current',
        async () => {
          const w = await f.world(),
            blocked = await w.actor(),
            incoming = await w.actor();
          const own = await w.ready(),
            hidden = await w.ready({}, blocked),
            anonymous = await w.ready({ authorMode: 'anonymous' }, blocked),
            reverse = await w.ready({}, incoming);
          const namedRoot = await f.root(blocked, own.id),
            anonRoot = await f.root(blocked, own.id, 'anonymous'),
            visibleRoot = await f.root(incoming, own.id);
          await f.reply(blocked, own.id, visibleRoot.id);
          await f.reply(blocked, own.id, visibleRoot.id, 'anonymous');
          await f.like(blocked, own.id);
          await f.view(blocked, [own.id]);
          await f.settleAll(own.id);
          await f.materializer.refresh(own.id);
          const cert = await f.certificate(own.id);
          await f.block(w.reader, blocked);
          await f.block(incoming, w.reader);
          const result = hotOk(await w.hot());
          assert.ok(!hotIds(result).includes(hidden.id));
          assert.ok(hotIds(result).includes(anonymous.id));
          assert.ok(hotIds(result).includes(reverse.id));
          const card = result.items.find((p) => p.id === own.id)!;
          assert.equal(card.commentCount, 2);
          assert.equal(card.replyCount, 1);
          assert.notEqual(namedRoot.id, anonRoot.id);
          assert.deepEqual(
            await f.certificate(own.id),
            cert,
            'Viewer filtering never changes the unified score',
          );
          assert.ok(!JSON.stringify(result).includes(blocked.accountId));
          assert.ok(!JSON.stringify(result).includes(namedRoot.id));
          const decision = (
            await f.pool.query<{ decision_id: string }>(
              "SELECT decision_id FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=$1",
              [reverse.id],
            )
          ).rows[0]!.decision_id;
          await setReviewState(f.pool, decision, 'held');
          assert.ok(!hotIds(hotOk(await w.hot())).includes(reverse.id));
        },
      );
      await t.test(
        'live old coordinate survives score movement; cross-page repeats are valid and visibility guard changes restart',
        async () => {
          const w = await f.world(),
            p = await w.publish(),
            other = await w.publish();
          await f.like(w.reader, p.id);
          await f.settle('like', p.id);
          await f.materializer.refresh(p.id);
          await f.materializer.refresh(other.id);
          const first = hotOk(await w.hot({ limit: 1 }), 1);
          assert.deepEqual(hotIds(first), [p.id]);
          await f.like(w.reader, p.id, false);
          await f.settle('like', p.id);
          await f.materializer.refresh(p.id);
          const second = hotOk(
            await w.hot({ limit: 1, cursor: first.nextCursor }),
            1,
          );
          assert.ok(
            second.items.length === 1,
            'A score/vector change does not restart the cursor',
          );
          const all = [...hotIds(second)];
          if (second.nextCursor)
            all.push(
              ...hotIds(
                hotOk(await w.hot({ limit: 1, cursor: second.nextCursor }), 1),
              ),
            );
          assert.ok(
            all.includes(p.id),
            'Previously emitted post moved below old coordinate and can reappear',
          );
          for (const patch of [
            { range: 'week' },
            { limit: 2 },
            { spaceId: w.scope.global.spaceId },
          ])
            hotFailure(
              await w.hot({ limit: 1, cursor: first.nextCursor, ...patch }),
              400,
            );
          const different = await w.actor();
          hotFailure(
            await w.hot({ limit: 1, cursor: first.nextCursor }, different),
            400,
          );
          const provider = (
            await f.pool.query<{
              provider: 'wechat';
              appId: string;
              subject: string;
            }>(
              'SELECT provider,app_id AS "appId",subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
              [w.reader.accountId],
            )
          ).rows[0]!;
          const accessToken = mintToken('access'),
            refreshToken = mintToken('refresh');
          const replacement = await f.identity.createSession(provider, {
            access: hashToken(accessToken),
            refresh: hashToken(refreshToken),
          });
          assert.equal(replacement.accountId, w.reader.accountId);
          hotFailure(
            await w.hot(
              { limit: 1, cursor: first.nextCursor },
              { ...replacement, accessToken, refreshToken },
            ),
            400,
          );
          await f.deletePost(w.author, p.id);
          hotFailure(
            await w.hot({ limit: 1, cursor: first.nextCursor }),
            409,
            'DISCOVERY_RESTART_REQUIRED',
          );
        },
      );
      await t.test(
        'session token expiry is final and a revoked session is never treated as guest',
        async () => {
          const w = await f.world();
          await w.ready();
          await f.pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
            [hashToken(w.reader.accessToken)],
          );
          hotFailure(await w.hot(), 401);
          const noPhone = await w.actor('unverified');
          assert.equal(
            hotOk(await w.hot({}, noPhone)).continuation,
            'end',
            'A complete first page needs no phone continuation',
          );
          await setRuntimeVerification(
            f.pool,
            noPhone.accountId,
            w.scope.institutionId,
            w.scope.home.regionId,
            'verified',
            'verified',
          );
          for (const range of hotRanges) hotOk(await w.hot({ range }, noPhone));
        },
      );
    } finally {
      await f.close();
    }
  },
);
