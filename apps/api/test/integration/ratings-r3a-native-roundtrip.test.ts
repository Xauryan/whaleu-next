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
} from '../support/experience-native-bridge.js';

// Real native decoders/controller -> ApiClient -> AppModule HTTP -> disposable PG.
// Only platform HTTP/storage and a deliberately lost response are bridged.
interface Locator {
  subjectKind: 'comment' | 'reply';
  targetId: string;
  rootId: string;
  subjectId: string;
}
interface Context extends Locator {
  regionId: string | null;
  targetRevision: string;
  rootRevision: string;
  revision: string;
  deleted: boolean;
  contextRevision?: string;
}
interface View {
  loaded: boolean;
  frozen: boolean;
  canConfirm: boolean;
  error: string;
  context: Context | null;
  receiptStatus: string;
}
interface AdminIntent {
  operation: 'admin_delete_comment' | 'admin_delete_reply';
  subjectId: string;
  payload: {
    clientRequestId: string;
    targetId: string;
    expectedTargetRevision: string;
    expectedRevision: string;
    expectedContextRevision: string;
    rootId?: string;
    expectedRootRevision?: string;
  };
}
interface AdminReceipt {
  requestId: string;
  operation: 'admin_delete_comment' | 'admin_delete_reply';
  outcome: 'applied' | 'noop';
  targetId: string;
  rootId: string;
  subjectId: string;
  revision: string;
  occurredAt: string;
}
interface Sent {
  path: string;
  method: string;
  bodyBytes?: string;
}
class ObservedDeletionTransport extends DirectoryHttpTransport {
  readonly sent: Sent[] = [];
  override send(input: Parameters<DirectoryHttpTransport['send']>[0]) {
    const url = new URL(input.url);
    this.sent.push({
      path: `${url.pathname}${url.search}`,
      method: input.method,
      ...(input.body === undefined
        ? {}
        : { bodyBytes: JSON.stringify(input.body) }),
    });
    return super.send(input);
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
  RatingDeletionController,
} = require('../../../wechat/src/ratings/deletion-controller.ts');
const {
  decodeRatingDeletionContext,
  decodeRatingAdminDeletionContext,
  decodeRatingAdminDeletionReceipt,
  ratingOwnerDeletionIntent,
} = require('../../../wechat/src/ratings/deletion-contract.ts');
const {
  decodeRatingReceipt,
  decodeRatingIntent,
} = require('../../../wechat/src/ratings/contract.ts');

test(
  'R3A actual native HTTP/PG metadata cleanup and typed admin lost-response recovery preserve old owner journals',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingDeletionFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      replyOwner = await f.actor(),
      administrator = await f.actor({
        affiliation: 'unverified',
        identity: false,
      });
    const grantId = await f.grant(
      administrator,
      'school_admin',
      f.scope.home.regionId,
    );
    const catalog = await f.catalog(owner, {
        regionId: f.scope.home.regionId,
        count: 1,
      }),
      target = catalog.targets[0]!;
    const root = await f.publish(
      owner,
      catalog,
      target,
      f.body(catalog, target, { authorMode: 'anonymous' }),
    );
    const reply = await f.publishReply(
      replyOwner,
      catalog,
      target,
      root,
      f.replyBody(catalog, target, root, { authorMode: 'anonymous' }),
    );
    const cleanupRoot = await f.publish(owner, catalog, target),
      legacyRoot = await f.publish(owner, catalog, target);
    await f.origin(target.id, 'known_school', f.scope.home.campusId);
    type Actor = typeof owner;
    function native(actor: Actor) {
      const transport = new ObservedDeletionTransport(f.port),
        sessions = new SessionStore(),
        device = platformStorage();
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
        device,
        directoryNativeOrigin,
      );
      const views: View[] = [];
      const controller = new RatingDeletionController(runtime, (view: View) =>
        views.push(view),
      );
      t.after(() => controller.dispose());
      transport.checkResponse = (path, status, body) => {
        if (status !== 200) return;
        const bytes = JSON.stringify(body);
        for (const actor of [owner, replyOwner, administrator]) {
          assert.equal(bytes.includes(actor.accountId), false);
          assert.equal(bytes.includes(actor.accessToken), false);
        }
        assert.doesNotMatch(
          bytes,
          /"(?:body|author|authorId|actorId|accountId|personaId|profileId|grantId|originCampusId|sourceReference)"/,
        );
        if (path.endsWith('/deletion-context')) {
          const decode = path.includes('/admin/')
            ? decodeRatingAdminDeletionContext
            : decodeRatingDeletionContext;
          assert.deepEqual(decode(body), body);
          assert.throws(
            () =>
              decode({
                ...(body as object),
                body: 'forbidden private content',
              }),
            protocolFailure,
          );
        } else if (path.includes('/admin/')) {
          assert.deepEqual(decodeRatingAdminDeletionReceipt(body), body);
          assert.throws(
            () =>
              decodeRatingAdminDeletionReceipt({
                ...(body as object),
                authorId: owner.accountId,
              }),
            protocolFailure,
          );
        }
      };
      return {
        transport,
        device,
        runtime,
        controller,
        cancel: new Cancellation(),
        view: () => views.at(-1)!,
      };
    }
    const admin = native(administrator),
      own = native(owner),
      childOwner = native(replyOwner);
    const rootLocator: Locator = {
      subjectKind: 'comment',
      targetId: target.id,
      rootId: root.id,
      subjectId: root.id,
    };
    let adminPending!: { version: 4; accountId: string; intent: AdminIntent };
    let historical!: AdminReceipt;
    await t.test(
      'lost admin DELETE commits once; revoked role can recover own historical receipt without restoring current capability',
      async () => {
        await admin.controller.load(rootLocator);
        assert.equal(
          admin.transport.sent.length,
          0,
          'Opening panel must not probe any admin scope',
        );
        await admin.controller.readContext('admin');
        assert.equal(admin.view().canConfirm, true, admin.view().error);
        assert.equal(admin.view().context?.subjectId, root.id);
        assert.equal('contextRevision' in admin.view().context!, false);
        const path = `/v1/ratings/admin/comments/${root.id}`;
        admin.transport.dropSuccess = { path, method: 'DELETE' };
        await admin.controller.confirmDelete();
        adminPending = admin.runtime.pendingRatings.load(
          administrator.accountId,
        );
        assert.equal(adminPending.version, 4);
        assert.equal(adminPending.intent.operation, 'admin_delete_comment');
        assert.equal(admin.view().frozen, true);
        assert.equal(admin.view().context, null);
        const sent = admin.transport.sent.filter(
          (row) => row.method === 'DELETE',
        );
        assert.equal(sent.length, 1);
        assert.equal(
          sent[0]!.bodyBytes,
          JSON.stringify(adminPending.intent.payload),
        );
        const row = (
          await f.pool.query<{
            revision: string;
            account_id: string;
            delete_request_id: string | null;
            admin_delete_audit_id: string;
          }>(
            'SELECT revision,account_id,delete_request_id,admin_delete_audit_id FROM whaleu_ratings.comments WHERE id=$1',
            [root.id],
          )
        ).rows[0]!;
        assert.equal(row.account_id, owner.accountId);
        assert.equal(row.delete_request_id, null);
        assert.ok(row.admin_delete_audit_id);
        root.revision = row.revision;
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
            [grantId, administrator.accountId],
          ),
        );
        historical = await admin.runtime.ratingDeletion.receipt(
          adminPending.intent.payload.clientRequestId,
          admin.cancel,
        );
        assert.equal(historical.subjectId, root.id);
        assert.equal(historical.revision, root.revision);
        assert.throws(() => decodeRatingReceipt(historical), protocolFailure);
        const before = admin.transport.sent.length;
        await admin.controller.recover();
        assert.equal(
          admin.runtime.pendingRatings.load(administrator.accountId),
          null,
        );
        assert.equal(admin.view().canConfirm, false);
        assert.equal(admin.view().context, null);
        assert.match(admin.view().receiptStatus, /历史操作/);
        assert.ok(
          admin.transport.sent
            .slice(before)
            .every((row) => row.method === 'GET'),
        );
        assert.equal(
          (
            await f.pool.query<{ n: number }>(
              'SELECT count(*)::int n FROM whaleu_ratings.effect_events WHERE admin_delete_audit_id=$1',
              [row.admin_delete_audit_id],
            )
          ).rows[0]!.n,
          1,
        );
        assert.equal(
          (
            await f.pool.query<{ deleted_at: Date | null }>(
              'SELECT deleted_at FROM whaleu_ratings.replies WHERE id=$1',
              [reply.id],
            )
          ).rows[0]!.deleted_at,
          null,
        );
      },
    );
    await t.test(
      'author re-reads fresh metadata and clears hidden root/live reply after target/catalog/review/affiliation loss without public reads',
      async () => {
        await f.catalog(owner, { regionId: catalog.regionId, hidden: true });
        await setRatingReviewState(
          f.pool,
          target.approval.decisionId,
          'revoked',
        );
        await setRatingReviewState(
          f.pool,
          cleanupRoot.approval.decisionId,
          'revoked',
        );
        await f.certify(owner.accountId, {
          affiliation: 'unverified',
          identity: false,
        });
        await f.certify(replyOwner.accountId, {
          affiliation: 'unavailable',
          identity: false,
        });
        target.revision = randomUUID();
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_ratings.targets SET active=false,revision=$2 WHERE id=$1',
            [target.id, target.revision],
          ),
        );
        for (const [n, subject, locator] of [
          [
            own,
            cleanupRoot,
            {
              subjectKind: 'comment',
              targetId: target.id,
              rootId: cleanupRoot.id,
              subjectId: cleanupRoot.id,
            },
          ],
          [
            childOwner,
            reply,
            {
              subjectKind: 'reply',
              targetId: target.id,
              rootId: root.id,
              subjectId: reply.id,
            },
          ],
        ] as const) {
          await n.controller.load(locator);
          await n.controller.readContext('owner');
          assert.equal(n.view().canConfirm, true, n.view().error);
          const context = n.view().context!;
          assert.equal(context.targetRevision, target.revision);
          assert.equal(context.revision, subject.revision);
          if (locator.subjectKind === 'reply')
            assert.equal(context.rootRevision, root.revision);
          await n.controller.confirmDelete();
          assert.equal(
            n.runtime.pendingRatings.load(
              locator.subjectKind === 'reply'
                ? replyOwner.accountId
                : owner.accountId,
            ),
            null,
          );
          assert.equal(n.view().context?.deleted, true, n.view().error);
          assert.equal(n.view().canConfirm, false);
          assert.ok(
            n.transport.sent.every(
              (row) =>
                row.path.endsWith('/deletion-context') ||
                row.method === 'DELETE',
            ),
          );
          const command = n.transport.sent.find(
            (row) => row.method === 'DELETE',
          )!;
          const body = JSON.parse(command.bodyBytes!) as {
            clientRequestId: string;
          };
          assert.deepEqual(
            JSON.parse(command.bodyBytes!),
            ratingOwnerDeletionIntent(context, body.clientRequestId).payload,
          );
          assert.equal(
            'expectedContextRevision' in JSON.parse(command.bodyBytes!),
            false,
          );
        }
      },
    );
    await t.test(
      'unchanged owner v1 lost-response journal and admin v4 refuse cross-receipt or cross-operation settlement',
      async () => {
        const legacyLocator: Locator = {
          subjectKind: 'comment',
          targetId: target.id,
          rootId: legacyRoot.id,
          subjectId: legacyRoot.id,
        };
        const context = await own.runtime.ratingDeletion.context(
          'owner',
          legacyLocator,
          own.cancel,
        );
        const intent = decodeRatingIntent(
          ratingOwnerDeletionIntent(context, randomUUID()),
        );
        const old = own.runtime.pendingRatings.freeze({
          version: 1,
          accountId: owner.accountId,
          intent,
        });
        const oldKey = `whaleu.ratings.pending.v1:${directoryNativeOrigin}:${owner.accountId}`;
        const oldBytes = JSON.stringify(own.device.storage.get(oldKey));
        assert.throws(() =>
          own.runtime.pendingRatings.freeze({
            version: 4,
            accountId: owner.accountId,
            intent: adminPending.intent,
          }),
        );
        assert.equal(JSON.stringify(own.device.storage.get(oldKey)), oldBytes);
        own.transport.dropSuccess = {
          path: `/v1/ratings/comments/${legacyRoot.id}`,
          method: 'DELETE',
        };
        await assert.rejects(() =>
          own.runtime.ratings.command(intent, own.cancel),
        );
        assert.equal(JSON.stringify(own.device.storage.get(oldKey)), oldBytes);
        const ownerReceipt = await own.runtime.ratings.receipt(
          intent.payload.clientRequestId,
          own.cancel,
        );
        assert.equal(ownerReceipt.operation, 'delete_comment');
        assert.throws(
          () => decodeRatingAdminDeletionReceipt(ownerReceipt),
          protocolFailure,
        );
        assert.throws(
          () => own.runtime.pendingRatings.settle(old, historical),
          protocolFailure,
        );
        assert.equal(JSON.stringify(own.device.storage.get(oldKey)), oldBytes);
        await own.controller.load(legacyLocator);
        assert.equal(own.runtime.pendingRatings.load(owner.accountId), null);
        assert.equal(own.view().context?.deleted, true, own.view().error);
        const repeatedAdmin = admin.runtime.pendingRatings.freeze(adminPending);
        assert.throws(() =>
          admin.runtime.pendingRatings.freeze({
            version: 1,
            accountId: administrator.accountId,
            intent,
          }),
        );
        assert.throws(
          () =>
            admin.runtime.pendingRatings.settle(repeatedAdmin, ownerReceipt),
          protocolFailure,
        );
        assert.deepEqual(
          admin.runtime.pendingRatings.load(administrator.accountId),
          adminPending,
        );
        assert.deepEqual(
          await admin.runtime.ratingDeletion.receipt(
            adminPending.intent.payload.clientRequestId,
            admin.cancel,
          ),
          historical,
        );
        admin.runtime.pendingRatings.settle(repeatedAdmin, historical);
        assert.equal(
          admin.runtime.pendingRatings.load(administrator.accountId),
          null,
        );
      },
    );
  },
);
