/** Real AppModule owners + disposable synthetic facts. Never mocks Review, SQL
 * guards, command kernels, sessions, publication, or effect capture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ratingScopedFixture } from './rating-scoped-fixture.js';
import { RatingScopedCommands } from '../../src/ratings/scoped/commands.service.js';
import {
  ratingScopedCommandContextSchema,
  ratingScopedIntentSchema,
  ratingScopedPreparationSchema,
  ratingScopedReceiptSchema,
  type RatingScopedContext,
  type RatingScopedIntent,
  type RatingNavigationSelector,
} from '../../src/ratings/scoped/contracts.js';
import { ratingScopedEditContextSchema } from '../../src/ratings/scoped/controller.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';

export function scopedCommandContext(c: RatingScopedContext) {
  assert.equal(c.heads.length, 1);
  return ratingScopedCommandContextSchema.parse({
    id: c.id,
    token: c.token,
    tokenDigest: c.tokenDigest,
    selector: c.selector,
    scopeRevision: c.scopeRevision,
    protocolGeneration: c.protocolGeneration,
    catalogRevision: c.heads[0]!.catalogRevision,
    headRevision: c.heads[0]!.headRevision,
    sourceDigest: c.sourceDigest,
  });
}
export function scopedCommandRoute(i: RatingScopedIntent) {
  switch (i.operation) {
    case 'set_score_scoped':
      return {
        method: 'put' as const,
        path: `/v2/ratings/targets/${i.payload.targetId}/my-score`,
      };
    case 'create_comment_scoped':
      return {
        method: 'post' as const,
        path: `/v2/ratings/targets/${i.payload.targetId}/comments`,
      };
    case 'create_reply_scoped':
      return {
        method: 'post' as const,
        path: `/v2/ratings/comments/${i.payload.rootId}/replies`,
      };
    case 'set_comment_like_scoped':
      return {
        method: 'put' as const,
        path: `/v2/ratings/comments/${i.payload.rootId}/like`,
      };
    case 'set_reply_like_scoped':
      return {
        method: 'put' as const,
        path: `/v2/ratings/replies/${i.payload.replyId}/like`,
      };
    case 'set_target_subscription_scoped':
      return {
        method: 'put' as const,
        path: `/v2/ratings/targets/${i.payload.targetId}/subscription`,
      };
    case 'create_target_scoped':
      return {
        method: 'post' as const,
        path: '/v2/ratings/management/targets',
      };
    case 'edit_target_scoped':
      return {
        method: 'post' as const,
        path: '/v2/ratings/management/owner-edit/commit',
      };
  }
}
export function scopedSuccess(
  value: unknown,
  outcome: 'applied' | 'noop' = 'applied',
) {
  const receipt = ratingScopedReceiptSchema.parse(value);
  if (receipt.outcome === 'closed') assert.fail(JSON.stringify(receipt));
  assert.equal(receipt.outcome, outcome, JSON.stringify(receipt));
  // Receipt schema validates the operation-specific result at this boundary.
  return {
    ...receipt,
    result: receipt.result as Record<string, string | number | boolean | null>,
  };
}
export async function ratingScopedCommandFixture() {
  const f = await ratingScopedFixture();
  try {
    const data = await f.seedScopedCatalogs({ different: false });
    // This issuance must precede activation: adding it later changes the exact
    // source vector and deliberately invalidates the accepted scoped catalog.
    await f.issueSource({
      kind: 'native_scoped_create',
      key: 'synthetic-native-scoped-create',
      scopeKeys: f.scopeKeys,
      payload: {
        enabled: true,
        genericKind: 'general',
        scopeKeys: f.scopeKeys,
      },
    });
    await f.publish({ activate: true });
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    const commands = f.app.get(RatingScopedCommands);
    const read = async (
      actor: Actor,
      path: string,
      selector: RatingNavigationSelector = { kind: 'global' },
    ) => {
      const context = await f.scopedContext(actor, selector);
      const response = await f
        .auth(request(f.http).get(path), actor)
        .query({ contextId: context.id, contextToken: context.token });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['vary'], 'Authorization');
      return response.body;
    };
    const intent = async (
      actor: Actor,
      operation: RatingScopedIntent['operation'],
      payload: Record<string, unknown>,
      selector: RatingNavigationSelector = { kind: 'global' },
    ) => {
      const purpose =
        operation === 'create_target_scoped'
          ? 'create_target'
          : operation === 'edit_target_scoped'
            ? 'edit_target'
            : 'interact';
      const context = await f.scopedContext(actor, selector, purpose);
      const categoryId =
        payload['categoryId'] ??
        (selector.kind === 'global'
          ? data.global.categoryId
          : data.local.categoryId);
      const category = (
        await f.pool.query<{ effective_revision: string }>(
          'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
          [context.heads[0]!.catalogRevision, categoryId],
        )
      ).rows[0];
      assert.ok(category, 'Intent uses a genuinely compiled current category');
      return ratingScopedIntentSchema.parse({
        protocolVersion: 2,
        operation,
        context: scopedCommandContext(context),
        payload: {
          clientRequestId: randomUUID(),
          categoryId,
          expectedCategoryRevision: category.effective_revision,
          ...payload,
        },
      });
    };
    const prepare = async (actor: Actor, input: RatingScopedIntent) => {
      if (
        input.operation === 'create_target_scoped' ||
        input.operation === 'edit_target_scoped'
      ) {
        const path =
          input.operation === 'create_target_scoped'
            ? '/v2/ratings/management/prepare'
            : '/v2/ratings/management/owner-edit/prepare';
        const response = await f
          .auth(request(f.http).post(path), actor)
          .send(input);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return ratingScopedPreparationSchema.parse(response.body);
      }
      // Content has no separate public prepare route. Use the real command owner
      // to persist its exact envelope, then issue a synthetic acceptance for it.
      return ratingScopedPreparationSchema.parse(
        await commands.prepare(actor.accessToken, input),
      );
    };
    const approve = async (
      actor: Actor,
      input: RatingScopedIntent,
      options: Parameters<typeof f.approveScoped>[1] = {},
    ) => {
      const row = (
        await f.pool.query<{ envelope: unknown }>(
          'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows[0];
      assert.ok(
        row?.envelope,
        'Review must consume a real persisted preparation',
      );
      return f.approveScoped(
        canonicalRatingScopedEnvelope(row.envelope),
        options,
      );
    };
    const send = (
      actor: Actor,
      input: RatingScopedIntent,
      preparationContextRevision?: string,
    ) => {
      const route = scopedCommandRoute(input);
      return f.auth(request(f.http)[route.method](route.path), actor).send({
        ...input,
        ...(preparationContextRevision &&
        (input.operation === 'create_target_scoped' ||
          input.operation === 'edit_target_scoped')
          ? { preparationContextRevision }
          : {}),
      });
    };
    const execute = async (
      actor: Actor,
      input: RatingScopedIntent,
      review = true,
    ) => {
      const needsReview = [
        'create_target_scoped',
        'edit_target_scoped',
        'create_comment_scoped',
        'create_reply_scoped',
      ].includes(input.operation);
      const prepared = needsReview ? await prepare(actor, input) : null;
      const approved =
        needsReview && review ? await approve(actor, input) : null;
      const response = await send(actor, input, prepared?.contextRevision);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return {
        input,
        prepared,
        approved,
        response,
        receipt: ratingScopedReceiptSchema.parse(response.body),
      };
    };
    const createTarget = async (
      actor: Actor = f.creator,
      name = 'Synthetic scoped target',
      selector: RatingNavigationSelector = { kind: 'global' },
    ) => {
      const input = await intent(
        actor,
        'create_target_scoped',
        { name, description: 'Exact scoped definition', assetIds: [] },
        selector,
      );
      const done = await execute(actor, input);
      const receipt = scopedSuccess(done.receipt);
      return {
        ...done,
        receipt,
        id: String(receipt.result['targetId']),
        revision: String(receipt.result['revision']),
      };
    };
    const editIntent = async (
      actor: Actor,
      targetId: string,
      patch: Record<string, unknown> = {},
      selector: RatingNavigationSelector = { kind: 'global' },
    ) => {
      const context = await f.scopedContext(actor, selector, 'edit_target');
      const response = await f
        .auth(
          request(f.http).get(
            `/v2/ratings/management/owner-edit/targets/${targetId}/context`,
          ),
          actor,
        )
        .query({ contextId: context.id, contextToken: context.token });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const current = ratingScopedEditContextSchema.parse(response.body);
      return ratingScopedIntentSchema.parse({
        protocolVersion: 2,
        operation: 'edit_target_scoped',
        context: scopedCommandContext(context),
        payload: {
          clientRequestId: randomUUID(),
          targetId,
          expectedTargetRevision: current.revision,
          expectedDefinitionRevision: current.definitionRevision,
          expectedContentVersion: current.contentVersion,
          categoryId: current.categoryId,
          expectedCategoryRevision: current.categoryRevision,
          name: current.name,
          description: current.description,
          assetIds: [],
          ...patch,
        },
      });
    };
    const freshSession = async (actor: Actor): Promise<Actor> => {
      const identity = (
        await f.pool.query<{
          provider: 'wechat';
          app_id: string;
          subject: string;
        }>(
          'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
          [actor.accountId],
        )
      ).rows[0]!;
      const accessToken = mintToken('access'),
        refreshToken = mintToken('refresh');
      const session = await f.app.get(IdentityRepository).createSession(
        {
          provider: identity.provider,
          appId: identity.app_id,
          subject: identity.subject,
        },
        { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
      );
      assert.notEqual(session.sessionId, actor.sessionId);
      return { ...actor, ...session, accessToken, refreshToken };
    };
    const effects = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
      'events',(SELECT count(*) FROM whaleu_ratings.effect_events),
      'groups',(SELECT count(*) FROM whaleu_ratings.reward_groups),
      'units',(SELECT count(*) FROM whaleu_ratings.reward_units),
      'obligations',(SELECT count(*) FROM whaleu_ratings.notice_obligations),
      'notices',(SELECT count(*) FROM whaleu_notifications.rating_notices),
      'subscriptionNotices',(SELECT count(*) FROM whaleu_notifications.rating_subscription_notices),
      'scoreTransitions',(SELECT count(*) FROM whaleu_ratings.score_transitions),
      'commentTransitions',(SELECT count(*) FROM whaleu_ratings.comment_transitions),
      'replyTransitions',(SELECT count(*) FROM whaleu_ratings.reply_transitions),
      'likeTransitions',(SELECT count(*) FROM whaleu_ratings.like_transitions),
      'subscriptionTransitions',(SELECT count(*) FROM whaleu_ratings.subscription_transitions)) state`)
      ).rows[0]!.state;
    return {
      ...f,
      data,
      scopedCommands: commands,
      commandIntent: intent,
      prepareCommand: prepare,
      approveCommand: approve,
      sendCommand: send,
      executeCommand: execute,
      createScopedTarget: createTarget,
      scopedEditIntent: editIntent,
      scopedRead: read,
      freshSession,
      scopedEffects: effects,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
export type RatingScopedCommandFixture = Awaited<
  ReturnType<typeof ratingScopedCommandFixture>
>;
