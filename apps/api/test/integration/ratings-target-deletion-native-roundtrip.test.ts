import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ratingDeletionFixture } from '../support/rating-deletion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
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

// Actual native runtime/controller/decoders -> ApiClient -> AppModule HTTP -> PG.
// The bridge replaces platform I/O/storage and response delivery only. All
// ownership, verification, Review, shared claims and receipts use real services
// and disposable canonical owner facts. No production issuer/provider is used.
const prefix = '/v1/ratings/management/owner-deletion';
interface Intent {
  operation: 'delete_target';
  payload: {
    clientRequestId: string;
    targetId: string;
    expectedTargetRevision: string;
  };
}
interface Pending {
  version: 6;
  accountId: string;
  intent: Intent;
}
type Receipt =
  | {
      requestId: string;
      operation: 'delete_target';
      outcome: 'applied' | 'noop';
      targetId: string;
      revision: string;
      occurredAt: string;
    }
  | {
      requestId: string;
      operation: 'delete_target';
      outcome: 'rejected';
      code: string;
    };
interface View {
  ready: boolean;
  deleted: boolean;
  frozen: boolean;
  deleteConfirmation: boolean;
  canCancelDeletion: boolean;
  cancelDeletionConfirmation: boolean;
  receiptStatus: string;
  returnToCatalog: boolean;
  error: string;
}
interface Sent {
  path: string;
  method: string;
  bodyBytes?: string;
}
class ObservedTargetDeletionTransport extends DirectoryHttpTransport {
  readonly sent: Sent[] = [];
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
  RatingTargetOwnerDeletionController,
} = require('../../../wechat/src/ratings/target-owner-deletion-controller.ts');
const {
  decodeRatingTargetOwnerDeletionContext,
  decodeRatingTargetOwnerDeletionIntent,
  decodeRatingTargetOwnerDeletionReceipt,
} = require('../../../wechat/src/ratings/target-owner-deletion-contract.ts');
const {
  decodeRatingIntent,
} = require('../../../wechat/src/ratings/contract.ts');

test(
  'M2A actual native HTTP/PG creator cleanup, shared journal, explicit cancellation and historical recovery',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingDeletionFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      outsider = await f.actor(),
      administrator = await f.actor();
    await f.grant(administrator, 'super_admin');
    const catalog = await f.catalog(owner, {
      regionId: f.scope.home.regionId,
      count: 3,
    });
    const [target, cancelTarget, hiddenTarget] = catalog.targets;
    assert.ok(target && cancelTarget && hiddenTarget);
    type Actor = typeof owner;
    const device = platformStorage();
    function native(actor: Actor, storage = platformStorage()) {
      const transport = new ObservedTargetDeletionTransport(f.port),
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
      const controller = new RatingTargetOwnerDeletionController(
        runtime,
        (view: View) => views.push(view),
      );
      t.after(() => controller.dispose());
      transport.checkResponse = (path, status, body) => {
        if (status !== 200 || !path.startsWith(prefix)) return;
        const bytes = JSON.stringify(body);
        assert.doesNotMatch(
          bytes,
          /"(?:name|description|body|author|creatorId|creator_id|actorId|accountId|regionId|source|origin|campusId|review|count|parentId|descendants)"/,
        );
        for (const actor of [owner, outsider, administrator]) {
          assert.equal(bytes.includes(actor.accountId), false);
          assert.equal(bytes.includes(actor.accessToken), false);
        }
        const decode = path.endsWith('/context')
          ? decodeRatingTargetOwnerDeletionContext
          : decodeRatingTargetOwnerDeletionReceipt;
        assert.deepEqual(decode(body), body);
        assert.throws(
          () => decode({ ...(body as object), name: 'forbidden hidden text' }),
          protocolFailure,
        );
      };
      return {
        transport,
        sessions,
        runtime,
        controller,
        device: storage,
        cancellation: new Cancellation(),
        view: () => views[views.length - 1]!,
        pending: () =>
          runtime.pendingRatings.load(actor.accountId) as Pending | null,
      };
    }
    let own = native(owner, device);
    const state = async (id: string) =>
      (
        await f.pool.query<{ active: boolean; revision: string }>(
          'SELECT active,revision FROM whaleu_ratings.targets WHERE id=$1',
          [id],
        )
      ).rows[0]!;
    const auditCount = async (id: string) =>
      (
        await f.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM whaleu_ratings.target_owner_delete_audits WHERE target_id=$1',
          [id],
        )
      ).rows[0]!.n;
    const tombstoneCount = async (id: string) =>
      (
        await f.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM whaleu_ratings.target_owner_tombstones WHERE target_id=$1',
          [id],
        )
      ).rows[0]!.n;
    const originalIntent = (id: string, revision: string): Intent =>
      decodeRatingTargetOwnerDeletionIntent({
        operation: 'delete_target',
        payload: {
          clientRequestId: randomUUID(),
          targetId: id,
          expectedTargetRevision: revision,
        },
      });

    await t.test(
      'real metadata admits only the creator, including when a different account has a global administrator role',
      async () => {
        await own.controller.load({ targetId: target.id });
        assert.equal(own.view().ready, true, own.view().error);
        assert.equal(own.view().deleteConfirmation, false);
        assert.deepEqual(
          own.transport.sent.map((row) => row.path),
          [`${prefix}/targets/${target.id}/context`],
        );
        const context = await own.runtime.ratingTargetOwnerDeletion.context(
          target.id,
          own.cancellation,
        );
        assert.deepEqual(context, {
          targetId: target.id,
          revision: target.revision,
          deletion: { kind: 'not_owner_deleted' },
        });
        for (const actor of [outsider, administrator]) {
          const denied = native(actor);
          await assert.rejects(
            () =>
              denied.runtime.ratingTargetOwnerDeletion.context(
                target.id,
                denied.cancellation,
              ),
            serverFailure('RATING_NOT_FOUND'),
          );
          await assert.rejects(
            () =>
              denied.runtime.ratingTargetOwnerDeletion.context(
                randomUUID(),
                denied.cancellation,
              ),
            serverFailure('RATING_NOT_FOUND'),
          );
          await denied.controller.load({ targetId: target.id });
          assert.equal(denied.view().ready, false);
          denied.controller.requestDelete();
          await denied.controller.confirmDelete();
          assert.equal(denied.pending(), null);
          assert.ok(denied.transport.sent.every((row) => row.method === 'GET'));
        }
        assert.equal((await state(target.id)).active, true);
        assert.equal(await auditCount(target.id), 0);
      },
    );

    await t.test(
      'an actual v1 score lost-response journal blocks v6 and recovers across the new deletion page without changing old bytes',
      async () => {
        const intent = decodeRatingIntent({
          operation: 'set_score',
          targetId: target.id,
          payload: {
            clientRequestId: randomUUID(),
            regionId: catalog.regionId,
            expectedTargetRevision: target.revision,
            expectedRevision: null,
            score: 4,
          },
        });
        const old = own.runtime.pendingRatings.freeze({
          version: 1,
          accountId: owner.accountId,
          intent,
        });
        const key = `whaleu.ratings.pending.v1:${directoryNativeOrigin}:${owner.accountId}`;
        const bytes = JSON.stringify(device.storage.get(key));
        assert.throws(() =>
          own.runtime.pendingRatings.freeze({
            version: 6,
            accountId: owner.accountId,
            intent: originalIntent(target.id, target.revision),
          }),
        );
        assert.equal(JSON.stringify(device.storage.get(key)), bytes);
        own.transport.dropSuccess = {
          path: `/v1/ratings/targets/${target.id}/my-score`,
          method: 'PUT',
        };
        await assert.rejects(() =>
          own.runtime.ratings.command(intent, own.cancellation),
        );
        assert.deepEqual(own.runtime.pendingRatings.load(owner.accountId), old);
        assert.equal(JSON.stringify(device.storage.get(key)), bytes);
        const before = own.transport.sent.length;
        await own.controller.load(null);
        assert.equal(own.pending(), null);
        assert.equal(own.view().ready, false);
        assert.match(own.view().receiptStatus, /历史操作/);
        assert.deepEqual(
          own.transport.sent.slice(before).map((row) => [row.method, row.path]),
          [['GET', `/v1/ratings/requests/${intent.payload.clientRequestId}`]],
        );
        assert.equal(
          (
            await f.pool.query<{ score: number }>(
              'SELECT score FROM whaleu_ratings.scores WHERE target_id=$1 AND account_id=$2',
              [target.id, owner.accountId],
            )
          ).rows[0]!.score,
          4,
        );
        assert.equal(await auditCount(target.id), 0);
      },
    );

    await t.test(
      'a persisted but unsent v6 needs explicit server cancellation; lost cancellation recovers and a late original submit cannot delete',
      async () => {
        await own.controller.load({ targetId: cancelTarget.id });
        assert.equal(own.view().ready, true, own.view().error);
        const before = own.transport.sent.length;
        await own.controller.confirmDelete();
        assert.equal(
          own.transport.sent.length,
          before,
          'Deletion requires its own second confirmation',
        );
        own.transport.failNext = `${prefix}/targets/${cancelTarget.id}`;
        own.controller.requestDelete();
        await own.controller.confirmDelete();
        const pending = own.pending()!;
        assert.equal(pending.version, 6);
        assert.equal(pending.intent.payload.targetId, cancelTarget.id);
        assert.equal(own.view().frozen, true);
        assert.equal(await auditCount(cancelTarget.id), 0);
        await own.controller.recover(); // A real REQUEST_NOT_FOUND does not settle.
        assert.deepEqual(own.pending(), pending);
        const beforeCancel = own.transport.sent.length;
        await own.controller.confirmCancelDeletion();
        assert.equal(
          own.transport.sent.length,
          beforeCancel,
          'Closing a form is not server cancellation',
        );
        own.controller.requestCancelDeletion();
        own.transport.dropSuccess = {
          path: `${prefix}/cancel`,
          method: 'POST',
        };
        await own.controller.confirmCancelDeletion();
        assert.deepEqual(own.pending(), pending);
        const sentCancel = own.transport.sent[own.transport.sent.length - 1]!;
        assert.equal(
          sentCancel.bodyBytes,
          JSON.stringify(pending.intent.payload),
        );
        own.controller.dispose();
        own = native(owner, device);
        await own.controller.load({ targetId: target.id });
        assert.equal(own.pending(), null);
        assert.equal(own.view().returnToCatalog, false);
        assert.match(own.view().receiptStatus, /已撤销/);
        assert.deepEqual(
          own.transport.sent.map((row) => [row.method, row.path]),
          [
            [
              'GET',
              `${prefix}/requests/${pending.intent.payload.clientRequestId}`,
            ],
          ],
        );
        const late: Receipt =
          await own.runtime.ratingTargetOwnerDeletion.command(
            pending.intent,
            own.cancellation,
          );
        assert.deepEqual(late, {
          requestId: pending.intent.payload.clientRequestId,
          operation: 'delete_target',
          outcome: 'rejected',
          code: 'RATING_TARGET_DELETION_CANCELLED',
        });
        assert.equal((await state(cancelTarget.id)).active, true);
        assert.equal(await auditCount(cancelTarget.id), 0);
        assert.equal(await tombstoneCount(cancelTarget.id), 0);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.target_owner_delete_closures WHERE actor_account_id=$1 AND request_id=$2',
              [owner.accountId, pending.intent.payload.clientRequestId],
            )
          ).rowCount,
          1,
        );
      },
    );

    let applied!: Receipt;
    let pending!: Pending;
    await t.test(
      'double confirmation commits through normal HTTP once; lost POST response preserves v6 and all original score/definition history',
      async () => {
        const definition = (
          await f.pool.query(
            'SELECT creator_id,category_id,region_id,source_id,name,description,envelope FROM whaleu_ratings.targets WHERE id=$1',
            [target.id],
          )
        ).rows;
        const scores = (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.scores WHERE target_id=$1',
            [target.id],
          )
        ).rows;
        assert.equal(scores.length, 1);
        await own.controller.load({ targetId: target.id });
        assert.equal(own.view().ready, true, own.view().error);
        const start = own.transport.sent.length;
        own.transport.dropSuccess = {
          path: `${prefix}/targets/${target.id}`,
          method: 'POST',
        };
        own.controller.requestDelete();
        await Promise.all([
          own.controller.confirmDelete(),
          own.controller.confirmDelete(),
        ]);
        pending = own.pending()!;
        assert.equal(pending.version, 6);
        assert.equal(pending.intent.payload.targetId, target.id);
        assert.equal(
          pending.intent.payload.expectedTargetRevision,
          target.revision,
        );
        assert.equal(own.view().frozen, true);
        assert.equal(own.view().ready, false);
        const sent = own.transport.sent
          .slice(start)
          .filter((row) => row.method === 'POST');
        assert.equal(sent.length, 1);
        assert.deepEqual(JSON.parse(sent[0]!.bodyBytes!), {
          clientRequestId: pending.intent.payload.clientRequestId,
          expectedTargetRevision: target.revision,
        });
        const stateAfter = await state(target.id);
        assert.equal(stateAfter.active, false);
        assert.notEqual(stateAfter.revision, target.revision);
        assert.equal(await auditCount(target.id), 1);
        assert.equal(await tombstoneCount(target.id), 1);
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT creator_id,category_id,region_id,source_id,name,description,envelope FROM whaleu_ratings.targets WHERE id=$1',
              [target.id],
            )
          ).rows,
          definition,
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
        applied = await own.runtime.ratingTargetOwnerDeletion.command(
          pending.intent,
          own.cancellation,
        );
        assert.equal(applied.outcome, 'applied');
        assert.deepEqual(
          await own.runtime.ratingTargetOwnerDeletion.cancel(
            pending.intent,
            own.cancellation,
          ),
          applied,
          'An applied receipt wins over later cancellation',
        );
        assert.deepEqual(
          own.pending(),
          pending,
          'Direct receipt observation does not silently settle a controller journal',
        );
        assert.equal(await auditCount(target.id), 1);
      },
    );

    await t.test(
      'real new session and loss of current affiliation/phone/catalog/Review still restore historical receipt before route or cleanup gates',
      async () => {
        const originalBytes = JSON.stringify(
          device.storage.get(
            `whaleu.ratings.pending.v6:${directoryNativeOrigin}:${owner.accountId}`,
          ),
        );
        const other = native(outsider, device);
        await other.controller.load({ targetId: target.id });
        assert.equal(other.pending(), null);
        assert.equal(other.view().frozen, false);
        assert.equal(other.view().canCancelDeletion, false);
        assert.ok(
          other.transport.sent.every((row) => !row.path.includes('/requests/')),
        );
        assert.equal(
          JSON.stringify(
            device.storage.get(
              `whaleu.ratings.pending.v6:${directoryNativeOrigin}:${owner.accountId}`,
            ),
          ),
          originalBytes,
        );
        own.controller.dispose();
        await f.catalog(owner, {
          regionId: catalog.regionId,
          count: 0,
          hidden: true,
        });
        await setRatingReviewState(
          f.pool,
          target.approval.decisionId,
          'revoked',
        );
        await f.certify(owner.accountId, {
          affiliation: 'unavailable',
          phone: 'unavailable',
          identity: false,
        });
        const identity = (
          await f.pool.query<{
            provider: 'wechat';
            app_id: string;
            subject: string;
          }>(
            'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
            [owner.accountId],
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
          {
            access: hashToken(accessToken),
            refresh: hashToken(refreshToken),
          },
        );
        assert.notEqual(session.sessionId, owner.sessionId);
        const nextActor = { ...owner, ...session, accessToken, refreshToken };
        own = native(nextActor, device);
        await own.controller.load(null);
        assert.equal(own.pending(), null);
        assert.equal(own.view().ready, false);
        assert.equal(own.view().deleted, false);
        assert.match(own.view().receiptStatus, /历史操作/);
        assert.doesNotMatch(
          JSON.stringify(own.view()),
          /Synthetic target|Synthetic category/,
        );
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
          await own.runtime.ratingTargetOwnerDeletion.receipt(
            pending.intent.payload.clientRequestId,
            own.cancellation,
          ),
          applied,
        );
        await assert.rejects(
          () =>
            other.runtime.ratingTargetOwnerDeletion.receipt(
              pending.intent.payload.clientRequestId,
              other.cancellation,
            ),
          serverFailure('REQUEST_NOT_FOUND'),
        );
        await assert.rejects(
          () =>
            own.runtime.ratingTargetOwnerDeletion.context(
              target.id,
              own.cancellation,
            ),
          serverFailure('VERIFICATION_UNAVAILABLE'),
        );
        assert.equal(await auditCount(target.id), 1);
        assert.equal(await tombstoneCount(target.id), 1);
      },
    );

    await t.test(
      'hidden inactive creator locator supports a genuine native metadata-only deletion without public or affiliation reads',
      async () => {
        await f.certify(owner.accountId, {
          affiliation: 'unavailable',
          identity: false,
        });
        const inactiveRevision = randomUUID();
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_ratings.targets SET active=false,revision=$2 WHERE id=$1',
            [hiddenTarget.id, inactiveRevision],
          ),
        );
        await setRatingReviewState(
          f.pool,
          hiddenTarget.approval.decisionId,
          'revoked',
        );
        const start = own.transport.sent.length;
        await own.controller.load({ targetId: hiddenTarget.id });
        assert.equal(own.view().ready, true, own.view().error);
        assert.equal(
          own.view().deleted,
          false,
          'Ordinary inactive is not owner-deleted',
        );
        own.controller.requestDelete();
        await own.controller.confirmDelete();
        assert.equal(own.pending(), null);
        assert.equal(own.view().returnToCatalog, true);
        assert.deepEqual(
          own.transport.sent.slice(start).map((row) => [row.method, row.path]),
          [
            ['GET', `${prefix}/targets/${hiddenTarget.id}/context`],
            ['POST', `${prefix}/targets/${hiddenTarget.id}`],
          ],
        );
        assert.equal((await state(hiddenTarget.id)).active, false);
        assert.notEqual(
          (await state(hiddenTarget.id)).revision,
          inactiveRevision,
        );
        assert.equal(await tombstoneCount(hiddenTarget.id), 1);
        assert.deepEqual(
          (
            await f.pool.query<{ before_active: boolean }>(
              'SELECT before_active FROM whaleu_ratings.target_owner_delete_audits WHERE target_id=$1',
              [hiddenTarget.id],
            )
          ).rows,
          [{ before_active: false }],
        );
      },
    );
  },
);
