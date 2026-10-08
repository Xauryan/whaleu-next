/** Current canonical owners and a real AppModule. Only I/O observation is wrapped. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { inTransaction } from '../../src/database/database.js';
import type { PoolClient } from 'pg';
import { ApprovalRepository } from '../../src/community/content-review/approval.repository.js';
import type { PublishPost, PostView } from '../../src/community/contracts.js';
import { hotScoreFixture } from './hot-score-fixture.js';
import type { HotFeedFixtureOptions } from './title-maintenance-fixture.js';
import {
  appendIdentitySelection,
  seedCommunityScope,
  withCommunityScopeWriter,
} from './community-scope-fixtures.js';
import { setRuntimeVerification } from './community-runtime-fixtures.js';
import { observeExactQueries } from './exact-discovery-counts.js';
import { HotScoreMaterializer } from '../../src/community/hot-score/materializer.js';
import { HotFeedProcessing } from '../../src/community/hot-score/processing.js';

export const hotPath = '/v1/community/hot';
export const hotRanges = [
  'day',
  'week',
  'month',
  'half_year',
  'year',
  'history',
] as const;
export type HotRange = (typeof hotRanges)[number];
export interface HotPage {
  items: PostView[];
  nextCursor: string | null;
  continuation: string;
}
export const hotIds = (page: HotPage) => page.items.map((post) => post.id);
export function hotPageShape(page: HotPage, limit = 10) {
  assert.deepEqual(Object.keys(page).sort(), [
    'continuation',
    'items',
    'nextCursor',
  ]);
  assert.ok(page.items.length <= limit);
  assert.equal(new Set(hotIds(page)).size, page.items.length);
  assert.ok(
    [
      'more',
      'scan_pending',
      'end',
      'login_required',
      'phone_verification_required',
    ].includes(page.continuation),
  );
  if (['more', 'scan_pending'].includes(page.continuation))
    assert.match(
      page.nextCursor ?? '',
      /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/,
    );
  else assert.equal(page.nextCursor, null);
  assert.ok(
    !/"(?:score|certificate|computedAt|computed_at|rank|rankOrdinal|inputs|processedHead|capturedHead|actorId|ownerId|sourceRequestId)"/.test(
      JSON.stringify(page),
    ),
  );
}
export function hotOk(response: { status: number; body: HotPage }, limit = 10) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  hotPageShape(response.body, limit);
  return response.body;
}
export function hotFailure(
  response: { status: number; body: { error?: { code?: string } } },
  status: number,
  code?: string,
) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.deepEqual(Object.keys(response.body), ['error']);
  if (code) assert.equal(response.body.error?.code, code);
}
export async function hotFeedFixture(options: HotFeedFixtureOptions = {}) {
  const f = await hotScoreFixture({
    hotFeedProcessing: 'manual_only',
    ...options,
  });
  const materializer = f.app.get(HotScoreMaterializer);
  const processing = f.app.get(HotFeedProcessing);
  const observer = observeExactQueries(f.app);
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  const world = async () => {
    const scope = await seedCommunityScope(f.pool);
    const actor = async (phone: 'verified' | 'unverified' = 'verified') => {
      const result = await f.actor();
      const facts = await setRuntimeVerification(
        f.pool,
        result.accountId,
        scope.institutionId,
        scope.home.regionId,
        'verified',
        phone,
      );
      await appendIdentitySelection(
        f.pool,
        result.accountId,
        facts,
        scope,
        scope.home.campusId,
      );
      await request(f.app.getHttpServer())
        .patch('/v1/me/profile')
        .set('Authorization', `Bearer ${result.accessToken}`)
        .send({ expectedRevision: 0, nickname: 'HotFixture', bio: '' })
        .expect(200);
      const profile = await request(f.app.getHttpServer())
        .get('/v1/me/public-profile-ref')
        .set('Authorization', `Bearer ${result.accessToken}`)
        .expect(200);
      assert.equal(typeof profile.body.profileId, 'string');
      return { ...result, profileId: profile.body.profileId as string };
    };
    const author = await actor(),
      reader = await actor();
    const publish = (extra: Partial<PublishPost> = {}, owner: Actor = author) =>
      f.publish(owner, {
        ...f.intent('Synthetic hot-feed publication'),
        spaceId: scope.home.spaceId,
        ...extra,
      });
    const hot = (
      query: Record<string, unknown> = {},
      viewer: Actor | null = reader,
    ) => {
      const call = request(f.app.getHttpServer())
        .get(hotPath)
        .query({ spaceId: scope.home.spaceId, ...query });
      return viewer
        ? call.set('Authorization', `Bearer ${viewer.accessToken}`)
        : call;
    };
    const ready = async (
      extra: Partial<PublishPost> = {},
      owner: Actor = author,
    ) => {
      const post = await publish(extra, owner);
      await materializer.refresh(post.id);
      return post;
    };
    const dated = async (publishedAt: string) => {
      // Explicit synthetic creation facts, before immutable review binding.
      // All four enrollment owners and normal deferred constraints stay active.
      const approval = await f.approve(author, {
        ...f.intent('Synthetic score coverage'),
        spaceId: scope.home.spaceId,
      });
      const id = await withCommunityScopeWriter(f.pool, async (tx) => {
        const value = await f.partialNative(
          tx,
          author.accountId,
          undefined,
          false,
          { spaceId: scope.home.spaceId, publishedAt },
        );
        await f.app.get(ApprovalRepository).bind(approval, 'post', value, tx);
        return value;
      });
      await materializer.refresh(id);
      return { id };
    };
    return { scope, actor, author, reader, publish, hot, ready, dated };
  };
  const certificate = async (id: string) =>
    (
      await f.pool.query(
        'SELECT s.*,score::text FROM whaleu_post_hotness.scores s WHERE post_id=$1',
        [id],
      )
    ).rows[0];
  const domainSnapshot = async () =>
    Object.fromEntries(
      Object.entries(await f.snapshot()).filter(
        ([key]) =>
          ![
            'whaleu_runtime.request_throttle_counters',
            'whaleu_community.discovery_cursors',
          ].includes(key),
      ),
    );
  const writeBlock = async (
    blocker: Actor,
    blocked: Actor,
    active = true,
    raw = false,
  ) => {
    const existing = (
      await f.pool.query<{ id: string }>(
        'SELECT id FROM whaleu_safety.blocks WHERE blocker_id=$1 AND blocked_id=$2',
        [blocker.accountId, blocked.accountId],
      )
    ).rows[0];
    const profile = await request(f.app.getHttpServer())
      .get('/v1/me/public-profile-ref')
      .set('Authorization', `Bearer ${blocked.accessToken}`)
      .expect(200);
    const write = async (tx: PoolClient) => {
      const id = existing?.id ?? randomUUID();
      if (existing)
        await tx.query(
          'UPDATE whaleu_safety.blocks SET active=$2,revision=revision+1 WHERE id=$1',
          [id, active],
        );
      else
        await tx.query(
          "INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,$4,1,'Synthetic hot feed','profile',$5)",
          [
            id,
            blocker.accountId,
            blocked.accountId,
            active,
            profile.body.profileId,
          ],
        );
      await tx.query(
        'INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) SELECT $1,blocker_id,id,$2,revision FROM whaleu_safety.blocks WHERE id=$3',
        [randomUUID(), active ? 'blocked' : 'unblocked', id],
      );
    };
    if (raw) await inTransaction(f.pool, write);
    else await withCommunityScopeWriter(f.pool, write);
  };
  const block = (a: Actor, b: Actor, active = true) => writeBlock(a, b, active);
  // Adversarial direct SQL bypasses the cooperative gate, never the DB guards.
  const rawBlock = (a: Actor, b: Actor, active = true) =>
    writeBlock(a, b, active, true);
  return {
    ...f,
    world,
    materializer,
    processing,
    observer,
    certificate,
    domainSnapshot,
    block,
    rawBlock,
    mutate: <T>(operation: (tx: PoolClient) => Promise<T>) =>
      withCommunityScopeWriter(f.pool, operation),
    close: async () => {
      observer.restore();
      await f.close();
    },
  };
}
export type HotFeedFixture = Awaited<ReturnType<typeof hotFeedFixture>>;
