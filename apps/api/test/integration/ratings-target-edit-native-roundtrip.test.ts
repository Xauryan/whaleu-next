import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  ratingEditFixture,
  ratingEditPrefix as prefix,
} from '../support/rating-edit-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
import {
  platformStorage,
  protocolFailure,
  serverFailure,
} from '../support/experience-native-bridge.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import type {
  PrepareRatingTargetEdit,
  RatingTargetEditReceipt,
} from '../../src/ratings/management/target-edit/contracts.js';

// Actual native controller/runtime/strict decoders -> HTTPS-origin platform bridge
// -> AppModule HTTP -> disposable PG. Review is seeded only from a real persisted
// preparation's canonical envelope via the shared fixture; no authorization or
// command result is synthesized. Platform response loss/storage are the only seams.
interface Intent {
  operation: 'edit_target';
  payload: PrepareRatingTargetEdit;
}
interface Pending {
  version: 7;
  accountId: string;
  intent: Intent;
}
interface View {
  ready: boolean;
  name: string;
  description: string;
  frozen: boolean;
  editConfirmation: boolean;
  canCancelEditing: boolean;
  cancelEditingConfirmation: boolean;
  receiptStatus: string;
  recoveryOperation: string;
  needsRefresh: boolean;
  error: string;
}
interface Sent {
  path: string;
  method: string;
  bodyBytes?: string;
}
class ObservedEditTransport extends DirectoryHttpTransport {
  readonly sent: Sent[] = [];
  approvePreparation:
    ((input: PrepareRatingTargetEdit) => Promise<void>) | null = null;
  override async send(input: Parameters<DirectoryHttpTransport['send']>[0]) {
    const url = new URL(input.url);
    this.sent.push({
      path: `${url.pathname}${url.search}`,
      method: input.method,
      ...(input.body === undefined
        ? {}
        : { bodyBytes: JSON.stringify(input.body) }),
    });
    const result = await super.send(input);
    if (result.status === 200 && url.pathname.startsWith(prefix)) {
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.headers['vary'], 'Authorization');
      if (
        url.pathname === `${prefix}/prepare` &&
        result.body !== null &&
        typeof result.body === 'object' &&
        !('outcome' in result.body)
      )
        await this.approvePreparation?.(input.body as PrepareRatingTargetEdit);
    }
    return result;
  }
}
const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  RatingTargetOwnerEditingController,
} = require('../../../wechat/src/ratings/target-owner-editing-controller.ts');
const {
  decodeRatingTargetOwnerEditingContext,
  decodeRatingTargetOwnerEditingIntent,
  decodeRatingTargetOwnerEditingPrepared,
  decodeRatingTargetOwnerEditingReceipt,
} = require('../../../wechat/src/ratings/target-owner-editing-contract.ts');
const {
  decodeRatingCommandIntent,
} = require('../../../wechat/src/ratings/pending.ts');

test(
  'M2B native controller/AppModule HTTP/PG editing, stable prepare, original journals and history-first recovery',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingEditFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      outsider = await f.actor(),
      administrator = await f.actor();
    await f.grant(administrator, 'super_admin');
    const catalog = await f.catalog(owner, {
      regionId: f.scope.home.regionId,
      count: 6,
    });
    const [
      target,
      cancelTarget,
      sessionTarget,
      changedTarget,
      noopTarget,
      legacyTarget,
    ] = catalog.targets;
    assert.ok(
      target &&
        cancelTarget &&
        sessionTarget &&
        changedTarget &&
        noopTarget &&
        legacyTarget,
    );
    type Actor = typeof owner;
    const approved = new Map<string, string>();
    function native(actor: Actor, storage = platformStorage()) {
      const transport = new ObservedEditTransport(f.port),
        sessions = new SessionStore();
      sessions.completeLogin(sessions.beginLogin(), actor);
      const auth = new AuthService(
        sessions,
        new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
        {
          login: async () => {
            throw new Error('No real provider calls');
          },
        },
        systemClock,
      );
      const api = new ApiClient(
        directoryNativeOrigin,
        transport,
        sessions,
        auth,
      );
      const runtime = createCommunityRuntime(
        { sessions, api },
        storage,
        directoryNativeOrigin,
      );
      const views: View[] = [];
      const controller = new RatingTargetOwnerEditingController(
        runtime,
        (view: View) => views.push(view),
      );
      t.after(() => controller.dispose());
      transport.approvePreparation = async (input) => {
        if (!approved.has(input.clientRequestId)) {
          const review = await f.approveEdit(actor, input);
          approved.set(input.clientRequestId, review.decisionId);
        }
      };
      transport.checkResponse = (path, status, body) => {
        if (status !== 200 || !path.startsWith(prefix)) return;
        const bytes = JSON.stringify(body);
        assert.doesNotMatch(
          bytes,
          /"(?:creatorId|creator_id|actorId|accountId|source|origin|campusId|review|body|author)"/,
        );
        for (const person of [owner, outsider, administrator]) {
          assert.equal(bytes.includes(person.accountId), false);
          assert.equal(bytes.includes(person.accessToken), false);
        }
        const decode = path.endsWith('/context')
          ? decodeRatingTargetOwnerEditingContext
          : path.endsWith('/prepare')
            ? decodeRatingTargetOwnerEditingPrepared
            : decodeRatingTargetOwnerEditingReceipt;
        assert.deepEqual(decode(body), body);
        assert.throws(
          () => decode({ ...(body as object), creatorId: owner.accountId }),
          protocolFailure,
        );
        if (!path.endsWith('/context'))
          assert.doesNotMatch(bytes, /"(?:name|description)"/);
      };
      return {
        transport,
        sessions,
        runtime,
        controller,
        device: storage,
        views,
        cancellation: new Cancellation(),
        view: () => views[views.length - 1]!,
        pending: () =>
          runtime.pendingRatings.load(actor.accountId) as Pending | null,
      };
    }
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
    const state = async (id: string) =>
      (
        await f.pool.query<{
          active: boolean;
          revision: string;
          definition_revision: string;
          content_version: number;
        }>(
          'SELECT t.active,t.revision,h.definition_revision,h.content_version FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id WHERE t.id=$1',
          [id],
        )
      ).rows[0]!;
    const editCount = async (id: string) =>
      (
        await f.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM whaleu_ratings.target_edit_transitions WHERE target_id=$1',
          [id],
        )
      ).rows[0]!.n;
    const noText = (view: View) => {
      assert.equal(view.name, '');
      assert.equal(view.description, '');
    };
    const device = platformStorage();
    let own = native(owner, device);

    await t.test(
      'only the current ordinary creator receives editable text, independent of administrator status',
      async () => {
        await own.controller.load({ targetId: target.id });
        assert.equal(own.view().ready, true, own.view().error);
        assert.equal(own.view().name, 'Synthetic target 1');
        assert.deepEqual(
          own.transport.sent.map((row) => [row.method, row.path]),
          [['GET', `${prefix}/targets/${target.id}/context`]],
        );
        for (const actor of [outsider, administrator]) {
          const denied = native(actor);
          await assert.rejects(
            () =>
              denied.runtime.ratingTargetOwnerEditing.context(
                target.id,
                denied.cancellation,
              ),
            serverFailure('RATING_NOT_FOUND'),
          );
          await assert.rejects(
            () =>
              denied.runtime.ratingTargetOwnerEditing.context(
                randomUUID(),
                denied.cancellation,
              ),
            serverFailure('RATING_NOT_FOUND'),
          );
          await denied.controller.load({ targetId: target.id });
          denied.controller.requestEdit();
          await denied.controller.confirmEdit();
          assert.equal(denied.view().ready, false);
          noText(denied.view());
          assert.equal(denied.pending(), null);
          assert.ok(denied.transport.sent.every((row) => row.method === 'GET'));
        }
      },
    );

    await t.test(
      'each v1-v6 serialized journal blocks v7 and uses its original historical HTTP lookup before any edit context',
      async () => {
        const current = await f.editContext(owner, legacyTarget.id);
        const candidate: Intent = decodeRatingTargetOwnerEditingIntent({
          operation: 'edit_target',
          payload: f.editIntent(current, { name: 'Blocked new edit' }),
        });
        const originalInputs = [
          {
            operation: 'set_score',
            targetId: legacyTarget.id,
            payload: {
              clientRequestId: randomUUID(),
              regionId: catalog.regionId,
              expectedTargetRevision: legacyTarget.revision,
              expectedRevision: null,
              score: 4,
            },
          },
          {
            operation: 'create_comment',
            targetId: legacyTarget.id,
            payload: {
              clientRequestId: randomUUID(),
              regionId: catalog.regionId,
              expectedTargetRevision: legacyTarget.revision,
              authorMode: 'named',
              body: 'Unsent legacy body',
              assetIds: [],
            },
          },
          {
            operation: 'set_target_subscription',
            targetId: legacyTarget.id,
            payload: {
              clientRequestId: randomUUID(),
              regionId: catalog.regionId,
              expectedTargetRevision: legacyTarget.revision,
              expectedSubscriptionRevision: randomUUID(),
              subscribed: true,
            },
          },
          {
            operation: 'admin_delete_comment',
            subjectId: randomUUID(),
            payload: {
              clientRequestId: randomUUID(),
              targetId: legacyTarget.id,
              expectedTargetRevision: legacyTarget.revision,
              expectedRevision: randomUUID(),
              expectedContextRevision: 'x'.repeat(43),
            },
          },
          {
            operation: 'create_target',
            payload: {
              clientRequestId: randomUUID(),
              regionId: catalog.regionId,
              categoryId: current.categoryId,
              expectedCategoryRevision: current.categoryRevision,
              expectedCatalogRevision: current.catalogRevision,
              name: 'Unsent legacy target text',
              description: '',
              assetIds: [],
            },
          },
          {
            operation: 'delete_target',
            payload: {
              clientRequestId: randomUUID(),
              targetId: legacyTarget.id,
              expectedTargetRevision: legacyTarget.revision,
            },
          },
        ];
        const receiptPrefixes = [
          '/v1/ratings/requests',
          '/v1/ratings/requests',
          '/v1/ratings/subscription-requests',
          '/v1/ratings/admin/requests',
          '/v1/ratings/management/requests',
          '/v1/ratings/management/owner-deletion/requests',
        ];
        for (const [index, input] of originalInputs.entries()) {
          const legacy = native(owner),
            version = index + 1,
            intent = decodeRatingCommandIntent(input);
          const old = legacy.runtime.pendingRatings.freeze({
            version,
            accountId: owner.accountId,
            intent,
          });
          const key = `whaleu.ratings.pending.v${version}:${directoryNativeOrigin}:${owner.accountId}`;
          const bytes = JSON.stringify(legacy.device.storage.get(key));
          assert.throws(() =>
            legacy.runtime.pendingRatings.freeze({
              version: 7,
              accountId: owner.accountId,
              intent: candidate,
            }),
          );
          assert.equal(JSON.stringify(legacy.device.storage.get(key)), bytes);
          await legacy.controller.load({ targetId: randomUUID() });
          assert.equal(legacy.view().frozen, true);
          noText(legacy.view());
          assert.deepEqual(
            legacy.runtime.pendingRatings.load(owner.accountId),
            old,
          );
          assert.deepEqual(
            legacy.transport.sent.map((row) => [row.method, row.path]),
            [
              [
                'GET',
                `${receiptPrefixes[index]}/${input.payload.clientRequestId}`,
              ],
            ],
          );
          assert.equal(JSON.stringify(legacy.device.storage.get(key)), bytes);
        }
        // Also establish a real prior score receipt through HTTP/PG before editing.
        const score = decodeRatingCommandIntent({
          ...originalInputs[0],
          targetId: target.id,
          payload: {
            ...originalInputs[0]!.payload,
            clientRequestId: randomUUID(),
            expectedTargetRevision: target.revision,
          },
        });
        own.runtime.pendingRatings.freeze({
          version: 1,
          accountId: owner.accountId,
          intent: score,
        });
        own.transport.dropSuccess = {
          path: `/v1/ratings/targets/${target.id}/my-score`,
          method: 'PUT',
        };
        await assert.rejects(() =>
          own.runtime.ratings.command(score, own.cancellation),
        );
        await own.controller.load(null);
        assert.equal(own.pending(), null);
        noText(own.view());
        assert.match(own.view().receiptStatus, /历史操作/);
      },
    );

    let pending!: Pending, applied!: RatingTargetEditReceipt;
    await t.test(
      'lost prepare and lost commit preserve one canonical original request and publish exactly once',
      async () => {
        const immutable = (
          await f.pool.query(
            'SELECT creator_id,category_id,region_id,source_id,name,description,envelope,content_version FROM whaleu_ratings.targets WHERE id=$1',
            [target.id],
          )
        ).rows;
        const scores = (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.scores WHERE target_id=$1',
            [target.id],
          )
        ).rows;
        await own.controller.load({ targetId: target.id });
        own.controller.setName('  Edited native target 🌊  ');
        own.controller.setDescription('  Native definition two  ');
        const before = own.transport.sent.length;
        await own.controller.confirmEdit();
        assert.equal(own.transport.sent.length, before);
        own.transport.dropSuccess = {
          path: `${prefix}/prepare`,
          method: 'POST',
        };
        own.controller.requestEdit();
        await Promise.all([
          own.controller.confirmEdit(),
          own.controller.confirmEdit(),
        ]);
        pending = own.pending()!;
        assert.equal(pending.version, 7);
        assert.equal(pending.intent.payload.name, 'Edited native target 🌊');
        assert.equal(own.view().frozen, true);
        noText(own.view());
        assert.equal(await editCount(target.id), 0);
        assert.equal((await state(target.id)).content_version, 1);
        const preparation = (
          await f.pool.query<{ context_revision: string; envelope: unknown }>(
            'SELECT context_revision,envelope FROM whaleu_ratings.target_edit_preparations WHERE account_id=$1 AND request_id=$2',
            [owner.accountId, pending.intent.payload.clientRequestId],
          )
        ).rows[0]!;
        assert.ok(preparation);
        assert.equal(preparation.context_revision.length, 43);
        await own.controller.recover();
        assert.deepEqual(own.pending(), pending);
        own.transport.dropSuccess = {
          path: `${prefix}/commit`,
          method: 'POST',
        };
        await own.controller.recover(true);
        assert.deepEqual(own.pending(), pending);
        noText(own.view());
        assert.equal(await editCount(target.id), 1);
        const after = await state(target.id);
        assert.equal(after.active, true);
        assert.equal(after.content_version, 2);
        assert.notEqual(
          after.revision,
          pending.intent.payload.expectedTargetRevision,
        );
        assert.notEqual(
          after.definition_revision,
          pending.intent.payload.expectedDefinitionRevision,
        );
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT creator_id,category_id,region_id,source_id,name,description,envelope,content_version FROM whaleu_ratings.targets WHERE id=$1',
              [target.id],
            )
          ).rows,
          immutable,
        );
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.scores WHERE target_id=$1',
              [target.id],
            )
          ).rows,
          scores,
        );
        const sends = own.transport.sent.slice(before);
        assert.equal(
          sends.filter((row) => row.path === `${prefix}/prepare`).length,
          2,
        );
        assert.equal(
          sends.filter((row) => row.path === `${prefix}/commit`).length,
          1,
        );
        for (const row of sends.filter(
          (row) => row.path === `${prefix}/prepare`,
        ))
          assert.equal(row.bodyBytes, JSON.stringify(pending.intent.payload));
        assert.deepEqual(
          JSON.parse(
            sends.find((row) => row.path === `${prefix}/commit`)!.bodyBytes!,
          ),
          {
            ...pending.intent.payload,
            expectedContextRevision: preparation.context_revision,
          },
        );
        applied = await own.runtime.ratingTargetOwnerEditing.receipt(
          pending.intent.payload.clientRequestId,
          own.cancellation,
        );
        assert.equal(applied.outcome, 'applied');
        assert.deepEqual(
          await own.runtime.ratingTargetOwnerEditing.cancel(
            pending.intent,
            own.cancellation,
          ),
          applied,
        );
        assert.deepEqual(
          own.pending(),
          pending,
          'Direct receipt reads do not settle the controller journal',
        );
      },
    );

    await t.test(
      'lost explicit cancellation closes only the original edit and cannot apply on a late retry',
      async () => {
        const cancelDevice = platformStorage();
        let cancel = native(owner, cancelDevice);
        await cancel.controller.load({ targetId: cancelTarget.id });
        cancel.controller.setName('Never published cancellation text');
        cancel.transport.failNext = `${prefix}/commit`;
        cancel.controller.requestEdit();
        await cancel.controller.confirmEdit();
        const original = cancel.pending()!;
        assert.equal(original.version, 7);
        assert.equal(await editCount(cancelTarget.id), 0);
        const before = cancel.transport.sent.length;
        await cancel.controller.confirmCancelEditing();
        assert.equal(cancel.transport.sent.length, before);
        cancel.controller.requestCancelEditing();
        cancel.controller.dismissCancelEditing();
        await cancel.controller.confirmCancelEditing();
        assert.equal(cancel.transport.sent.length, before);
        cancel.controller.requestCancelEditing();
        cancel.transport.dropSuccess = {
          path: `${prefix}/cancel`,
          method: 'POST',
        };
        await cancel.controller.confirmCancelEditing();
        assert.deepEqual(cancel.pending(), original);
        cancel.controller.dispose();
        cancel = native(owner, cancelDevice);
        await cancel.controller.load(null);
        assert.equal(cancel.pending(), null);
        assert.match(cancel.view().receiptStatus, /已撤销/);
        noText(cancel.view());
        assert.deepEqual(
          cancel.transport.sent.map((row) => [row.method, row.path]),
          [
            [
              'GET',
              `${prefix}/requests/${original.intent.payload.clientRequestId}`,
            ],
          ],
        );
        assert.deepEqual(
          await cancel.runtime.ratingTargetOwnerEditing.command(
            original.intent,
            cancel.cancellation,
          ),
          {
            requestId: original.intent.payload.clientRequestId,
            operation: 'edit_target',
            outcome: 'rejected',
            code: 'RATING_EDIT_CANCELLED',
          },
        );
        assert.equal(await editCount(cancelTarget.id), 0);
        assert.equal((await state(cancelTarget.id)).content_version, 1);
      },
    );

    await t.test(
      'a real new session first recovers history, then stable prepare closes the unfinished old-session context',
      async () => {
        const sessionDevice = platformStorage();
        let current = native(owner, sessionDevice);
        await current.controller.load({ targetId: sessionTarget.id });
        current.controller.setName('Never published previous-session text');
        current.transport.failNext = `${prefix}/commit`;
        current.controller.requestEdit();
        await current.controller.confirmEdit();
        const original = current.pending()!,
          bytes = JSON.stringify(original);
        const prepared = await current.runtime.ratingTargetOwnerEditing.prepare(
          original.intent,
          current.cancellation,
        );
        current.controller.dispose();
        const replacement = await freshSession(owner);
        current = native(replacement, sessionDevice);
        await current.controller.load({ targetId: changedTarget.id });
        assert.equal(JSON.stringify(current.pending()), bytes);
        noText(current.view());
        assert.deepEqual(
          current.transport.sent.map((row) => [row.method, row.path]),
          [
            [
              'GET',
              `${prefix}/requests/${original.intent.payload.clientRequestId}`,
            ],
          ],
        );
        await current.controller.recover(true);
        assert.equal(current.pending(), null);
        assert.match(current.view().receiptStatus, /已关闭/);
        noText(current.view());
        assert.deepEqual(
          current.transport.sent.slice(1).map((row) => [row.method, row.path]),
          [
            ['POST', `${prefix}/prepare`],
            ['POST', `${prefix}/commit`],
          ],
        );
        assert.deepEqual(
          JSON.parse(current.transport.sent.at(-1)!.bodyBytes!),
          {
            ...original.intent.payload,
            expectedContextRevision: prepared.contextRevision,
          },
        );
        const receipt = await current.runtime.ratingTargetOwnerEditing.receipt(
          original.intent.payload.clientRequestId,
          current.cancellation,
        );
        assert.equal(receipt.code, 'RATING_EDIT_CONTEXT_CHANGED');
        assert.equal(await editCount(sessionTarget.id), 0);
      },
    );

    await t.test(
      'a current definition change closes the original tuple without applying or repopulating its private draft',
      async () => {
        const stale = native(owner);
        await stale.controller.load({ targetId: changedTarget.id });
        stale.controller.setName('Stale unpublished client draft');
        stale.transport.failNext = `${prefix}/prepare`;
        stale.controller.requestEdit();
        await stale.controller.confirmEdit();
        const original = stale.pending()!;
        await f.edit(owner, changedTarget.id, {
          name: 'Other device current definition',
        });
        await stale.controller.recover(true);
        assert.equal(stale.pending(), null);
        noText(stale.view());
        assert.match(stale.view().receiptStatus, /已关闭/);
        assert.equal(await editCount(changedTarget.id), 1);
        assert.equal(
          (
            await stale.runtime.ratingTargetOwnerEditing.receipt(
              original.intent.payload.clientRequestId,
              stale.cancellation,
            )
          ).code,
          'RATING_EDIT_CONTEXT_CHANGED',
        );
      },
    );

    await t.test(
      'a true identical-text noop has no new definition, transition or Review binding',
      async () => {
        const unchanged = native(owner);
        unchanged.transport.approvePreparation = null;
        await unchanged.controller.load({ targetId: noopTarget.id });
        const before = await state(noopTarget.id);
        unchanged.controller.requestEdit();
        await unchanged.controller.confirmEdit();
        assert.equal(unchanged.pending(), null);
        noText(unchanged.view());
        assert.match(unchanged.view().receiptStatus, /历史操作/);
        assert.deepEqual(await state(noopTarget.id), before);
        assert.equal(await editCount(noopTarget.id), 0);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=$1',
              [noopTarget.id],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.rating_target_definition_bindings WHERE target_id=$1',
              [noopTarget.id],
            )
          ).rowCount,
          0,
        );
      },
    );

    await t.test(
      'hidden current Review, lost eligibility and a new login do not prevent historical recovery or disclose journal text',
      async () => {
        const originalBytes = JSON.stringify(
          device.storage.get(
            `whaleu.ratings.pending.v7:${directoryNativeOrigin}:${owner.accountId}`,
          ),
        );
        const other = native(outsider, device);
        await other.controller.load({ targetId: target.id });
        noText(other.view());
        assert.equal(other.pending(), null);
        assert.equal(other.view().canCancelEditing, false);
        assert.ok(
          other.transport.sent.every((row) => !row.path.includes('/requests/')),
        );
        assert.equal(
          JSON.stringify(
            device.storage.get(
              `whaleu.ratings.pending.v7:${directoryNativeOrigin}:${owner.accountId}`,
            ),
          ),
          originalBytes,
        );
        const reviewId = approved.get(pending.intent.payload.clientRequestId);
        assert.ok(reviewId);
        await setRatingReviewState(f.pool, reviewId, 'revoked');
        const hidden = native(owner);
        await hidden.controller.load({ targetId: target.id });
        assert.equal(hidden.view().ready, false);
        noText(hidden.view());
        await assert.rejects(
          () =>
            hidden.runtime.ratingTargetOwnerEditing.context(
              target.id,
              hidden.cancellation,
            ),
          serverFailure('RATING_NOT_FOUND'),
        );
        await f.certify(owner.accountId, {
          affiliation: 'unavailable',
          phone: 'unavailable',
          identity: false,
        });
        own.controller.dispose();
        own = native(await freshSession(owner), device);
        await own.controller.load(null);
        assert.equal(own.pending(), null);
        noText(own.view());
        assert.equal(own.view().ready, false);
        assert.match(own.view().receiptStatus, /历史操作/);
        assert.deepEqual(
          own.transport.sent.map((row) => [row.method, row.path]),
          [
            [
              'GET',
              `${prefix}/requests/${pending.intent.payload.clientRequestId}`,
            ],
          ],
        );
        assert.deepEqual(
          await own.runtime.ratingTargetOwnerEditing.receipt(
            pending.intent.payload.clientRequestId,
            own.cancellation,
          ),
          applied,
        );
        await assert.rejects(
          () =>
            other.runtime.ratingTargetOwnerEditing.receipt(
              pending.intent.payload.clientRequestId,
              other.cancellation,
            ),
          serverFailure('REQUEST_NOT_FOUND'),
        );
        assert.equal(await editCount(target.id), 1);
      },
    );
  },
);
