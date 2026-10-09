import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import { inTransaction } from '../../src/database/database.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import type {
  PublishPost,
  PublishComment,
} from '../../src/community/contracts.js';
import type { PublishReply } from '../../src/community/discussion/contracts.js';
import type {
  EffectiveContentEnvelope,
  EffectiveContentEnvelopeV1,
} from '../../src/community/content-review/contracts.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from './verification-fixtures.js';

/** Test-only owner session storage: no identity-provider override or login route. */
export async function createRuntimeActor(app: INestApplication) {
  const config = app.get<RuntimeConfig>(APP_CONFIG),
    url = new URL(config.DATABASE_URL);
  if (
    config.NODE_ENV !== 'test' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/whaleu_test'
  )
    throw new Error(
      'Synthetic runtime helpers require disposable loopback whaleu_test',
    );
  const accessToken = mintToken('access'),
    refreshToken = mintToken('refresh');
  const session = await app.get(IdentityRepository).createSession(
    {
      provider: 'wechat',
      appId: 'synthetic-runtime-only',
      subject: randomUUID(),
    },
    { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
  );
  return { ...session, accessToken, refreshToken };
}
export async function setRuntimeVerification(
  pool: Pool,
  accountId: string,
  institutionId: string,
  originRegionId: string,
  affiliation: 'verified' | 'unverified' | 'unavailable' = 'verified',
  phone: 'verified' | 'unverified' | 'unavailable' = 'verified',
  expiresAt = new Date(Date.now() + 3600000),
) {
  const a = syntheticAssertion(accountId, institutionId, 'affiliation', {
    origin_region_id: originRegionId,
    assertion_state: affiliation === 'unverified' ? 'unverified' : 'verified',
    expires_at: expiresAt,
  });
  const p = syntheticAssertion(accountId, institutionId, 'phone', {
    assertion_state: phone === 'unverified' ? 'unverified' : 'verified',
    expires_at: expiresAt,
  });
  const snapshot = await setSyntheticSnapshot(pool, accountId, [
    ...(affiliation === 'unavailable' ? [] : [a]),
    ...(phone === 'unavailable' ? [] : [p]),
  ]);
  return {
    assertionId: a.id,
    snapshotId: snapshot.snapshotId,
    institutionId,
    originRegionId,
    validUntil: expiresAt.getTime(),
  };
}
export function postApprovalEnvelope(
  app: INestApplication,
  pool: Pool,
  accountId: string,
  input: PublishPost & { allowAnonymousDm?: undefined },
): Promise<EffectiveContentEnvelopeV1>;
export function postApprovalEnvelope(
  app: INestApplication,
  pool: Pool,
  accountId: string,
  input: PublishPost,
): Promise<EffectiveContentEnvelope>;
export async function postApprovalEnvelope(
  app: INestApplication,
  pool: Pool,
  accountId: string,
  input: PublishPost,
): Promise<EffectiveContentEnvelope> {
  const body = publishPostSchema.parse(input);
  return inTransaction(pool, async (tx) => {
    await lockSafetyPolicy(tx);
    const space = await app.get(CommunityRepository).space(body.spaceId, tx);
    const authority = await app
      .get(CommunityAccessService)
      .authority(accountId, space, tx, { publication: true });
    if (!authority.publicationScope) throw new Error('Canonical scope missing');
    return {
      ...(body.allowAnonymousDm === undefined
        ? { version: 1 as const, authorMode: body.authorMode }
        : {
            version: 2 as const,
            authorMode: 'named' as const,
            allowAnonymousDm: body.allowAnonymousDm,
          }),
      accountId,
      purpose: 'publish_post',
      spaceId: body.spaceId,
      category: body.category,
      commentsPolicy: body.commentsPolicy,
      postId: null,
      rootCommentId: null,
      targetReplyId: null,
      text: body.text,
      images: [],
      component: body.component ?? { kind: 'none' },
      trading: body.trading ?? null,
      scope: authority.publicationScope,
    };
  });
}
/** Deliberately v1 fixture for historical/search shape transformations. New
 * explicit opt-in tests use postApprovalEnvelope and preserve its v2 union. */
export async function postApprovalEnvelopeV1(
  app: INestApplication,
  pool: Pool,
  accountId: string,
  input: PublishPost,
): Promise<EffectiveContentEnvelopeV1> {
  const envelope = await postApprovalEnvelope(app, pool, accountId, input);
  if (envelope.version !== 1)
    throw new Error('Historical fixture requires Review v1');
  return envelope;
}
export async function discussionApprovalEnvelope(
  app: INestApplication,
  pool: Pool,
  accountId: string,
  postId: string,
  body: PublishComment | PublishReply,
  rootCommentId: string | null = null,
): Promise<EffectiveContentEnvelopeV1> {
  return inTransaction(pool, async (tx) => {
    await lockSafetyPolicy(tx);
    const repo = app.get(CommunityRepository),
      post = await repo.post(postId, tx),
      space = await repo.space(post.space_id, tx);
    const authority = await app
      .get(CommunityAccessService)
      .authority(accountId, space, tx, {
        publication: true,
        targetPostId: post.id,
      });
    if (!authority.publicationScope) throw new Error('Canonical scope missing');
    return {
      version: 1,
      accountId,
      purpose: rootCommentId ? 'publish_reply' : 'publish_comment',
      spaceId: space.id,
      category: post.category,
      authorMode:
        post.author_mode === 'anonymous' && post.account_id === accountId
          ? 'anonymous'
          : body.authorMode,
      commentsPolicy: post.comments_policy,
      postId,
      rootCommentId,
      targetReplyId: 'targetReplyId' in body ? body.targetReplyId : null,
      text: body.text,
      images: [],
      component: { kind: 'none' },
      trading: null,
      scope: authority.publicationScope,
    };
  });
}
