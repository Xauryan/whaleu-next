import { IdentityService } from '../../src/identity/identity.service.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
/** Explicit disposable synthetic facts; never a production startup issuer. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { directoryRuntimeFixture } from './directory-runtime-fixture.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { approveDm } from './dm-owner-fixture.js';
import type { DmApprovalOptions } from './dm-owner-fixture.js';
import { canonicalDmEnvelope } from '../../src/community/content-review/dm-contracts.js';
import { dmReceiptSchema } from '../../src/messaging/contracts.js';
import type { DmEntry } from '../../src/messaging/contracts.js';
import {
  postApprovalEnvelope,
  discussionApprovalEnvelope,
} from './community-runtime-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from './community-approval-fixtures.js';
export async function messagingRuntimeFixture() {
  const f = await directoryRuntimeFixture(),
    http = f.app.getHttpServer();
  const actor = async (options: Parameters<typeof f.actor>[0] = {}) => {
    const a = await f.actor(options);
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1) ON CONFLICT DO NOTHING',
        [a.accountId],
      );
      await tx.query(
        `INSERT INTO whaleu_messaging.coverage_heads(account_id,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until,revision) VALUES($1,'local','accepted','synthetic-dm-local','isolated-local-inception','isolated-test-policy',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour',$2)`,
        [a.accountId, randomUUID()],
      );
    });
    const profileId = (
      await f.pool.query<{ public_id: string }>(
        'SELECT public_id FROM whaleu_profile.profiles WHERE account_id=$1',
        [a.accountId],
      )
    ).rows[0]!.public_id;
    return { ...a, profileId };
  };
  type Actor = Awaited<ReturnType<typeof actor>>;
  const relogin = async (a: Actor): Promise<Actor> => {
    // Synthetic fixture account mapping only, never production credentials.
    const identity = (
      await f.pool.query<{ subject: string }>(
        "SELECT subject FROM whaleu_identity.provider_identities WHERE provider='wechat' AND app_id='synthetic-runtime-only' AND account_id=$1",
        [a.accountId],
      )
    ).rows[0];
    assert.ok(identity);
    await f.app.get(IdentityService).logout(a.accessToken);
    const accessToken = mintToken('access'),
      refreshToken = mintToken('refresh');
    const session = await f.app.get(IdentityRepository).createSession(
      {
        provider: 'wechat',
        appId: 'synthetic-runtime-only',
        subject: identity.subject,
      },
      { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
    );
    assert.equal(session.accountId, a.accountId);
    return { ...a, ...session, accessToken, refreshToken };
  };
  const auth = (r: request.Test, a: Actor) =>
    r.set('Authorization', `Bearer ${a.accessToken}`);
  const get = (a: Actor, path: string, query: Record<string, unknown> = {}) =>
    auth(request(http).get('/v1/private-messages/' + path), a).query(query);
  const post = (a: Actor, path: string, body: unknown) =>
    auth(request(http).post('/v1/private-messages/' + path), a).send(
      body as object,
    );
  const open = async (
    a: Actor,
    entry: DmEntry,
    initiationMode: 'named' | 'anonymous' = 'named',
    key = randomUUID(),
  ) => {
    const response = await post(a, 'conversations', {
      clientRequestId: key,
      entry,
      initiationMode,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const receipt = dmReceiptSchema.parse(response.body);
    assert.notEqual(receipt.outcome, 'rejected', JSON.stringify(receipt));
    if (receipt.outcome === 'rejected') throw new Error(receipt.code);
    return receipt;
  };
  const approval = async (
    a: Actor,
    id: string,
    body: { clientRequestId: string; text: string },
    options: DmApprovalOptions = {},
  ) => {
    const c = (
      await f.pool.query<{
        account0: string;
        mode0: 'named' | 'anonymous';
        mode1: 'named' | 'anonymous';
        context_digest: string;
      }>('SELECT * FROM whaleu_messaging.conversations WHERE id=$1', [id])
    ).rows[0]!;
    const envelope = canonicalDmEnvelope({
      version: 1,
      purpose: 'send_private_message',
      accountId: a.accountId,
      clientRequestId: body.clientRequestId,
      conversationId: id,
      contextDigest: c.context_digest,
      senderSlot: c.account0 === a.accountId ? 0 : 1,
      participantModes: [c.mode0, c.mode1],
      text: body.text,
      assetIds: [],
    });
    return approveDm(f.pool, envelope, options);
  };
  const send = async (
    a: Actor,
    id: string,
    text: string,
    key = randomUUID(),
    options: DmApprovalOptions = {},
  ) => {
    const body = { clientRequestId: key, text },
      review = await approval(a, id, body, options);
    const response = await post(a, `conversations/${id}/messages`, body);
    return { response, body, review };
  };
  const publish = async (
    a: Actor,
    mode: 'named' | 'anonymous',
    allowAnonymousDm?: boolean,
  ) => {
    const body = {
      clientRequestId: randomUUID(),
      spaceId: f.scope.global.spaceId,
      category: 'discussion' as const,
      text: 'Synthetic source',
      imageAssetIds: [],
      authorMode: mode,
      commentsPolicy: 'open' as const,
      ...(allowAnonymousDm === undefined ? {} : { allowAnonymousDm }),
    };
    const policyRevisionId = await seedReviewPolicy(f.pool);
    const envelope = await postApprovalEnvelope(
      f.app,
      f.pool,
      a.accountId,
      body,
    );
    await approveEnvelope(f.pool, envelope, { policyRevisionId });
    const response = await auth(
      request(http).post('/v1/community/posts'),
      a,
    ).send(body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'created',
      JSON.stringify(response.body),
    );
    return response.body.resourceId as string;
  };
  const discussion = async (
    a: Actor,
    postId: string,
    rootCommentId: string | null = null,
    targetReplyId: string | null = null,
  ) => {
    const body = {
      clientRequestId: randomUUID(),
      text: 'Synthetic anonymous discussion',
      imageAssetIds: [],
      authorMode: 'anonymous' as const,
      ...(rootCommentId ? { targetReplyId } : {}),
    };
    const policyRevisionId = await seedReviewPolicy(f.pool);
    const envelope = await discussionApprovalEnvelope(
      f.app,
      f.pool,
      a.accountId,
      postId,
      body,
      rootCommentId,
    );
    await approveEnvelope(f.pool, envelope, { policyRevisionId });
    const path = rootCommentId
      ? `/v1/community/comments/${rootCommentId}/replies`
      : `/v1/community/posts/${postId}/comments`;
    const response = await auth(request(http).post(path), a).send(body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.outcome, 'created');
    return response.body.resourceId as string;
  };
  return {
    ...f,
    http,
    actor,
    relogin,
    auth,
    get,
    post,
    open,
    approval,
    send,
    publish,
    discussion,
  };
}
export type MessagingFixture = Awaited<
  ReturnType<typeof messagingRuntimeFixture>
>;
