/** Production native controller/gateways in a separate process. Only the platform
 * transport/storage and fixture credentials are supplied by the disposable test. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const {
  HttpCommunityGateway,
} = require('../../../wechat/src/community/gateway.ts');
const {
  HttpProfileGateway,
} = require('../../../wechat/src/profile/gateway.ts');
const {
  PendingAttemptStore,
  DraftStore,
} = require('../../../wechat/src/community/pending-attempt.ts');
const {
  ComposeController,
} = require('../../../wechat/src/pages/community-compose/controller.ts');
const {
  NativeExperienceTransport,
  nativeOrigin,
  memoryStorage,
} = require('./experience-native-bridge.ts');
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
process.once('message', async (input) => {
  let controller;
  try {
    const sessions = new SessionStore();
    sessions.completeLogin(sessions.beginLogin(), input.credentials);
    const transport = new NativeExperienceTransport(input.port);
    const api = new ApiClient(nativeOrigin, transport, sessions, {
      refresh: async () => {
        throw Error('Unexpected refresh');
      },
    });
    const storage = memoryStorage();
    let issued = 0,
      view;
    const runtime = {
      sessions,
      gateway: new HttpCommunityGateway(api),
      profiles: new HttpProfileGateway(api),
      pending: new PendingAttemptStore(storage, nativeOrigin),
      drafts: new DraftStore(storage, nativeOrigin),
      newRequestId: async () => {
        issued++;
        return randomUUID();
      },
    };
    const route = {
      operation: 'publish_post',
      spaceId: input.spaceId,
      category: 'discussion',
    };
    controller = new ComposeController(runtime, route, (value) => {
      view = value;
    });
    await controller.load();
    assert.equal(view.loaded, true, view.error);
    controller.setAuthorMode('named');
    controller.setAllowAnonymousDm(false);
    controller.setText('Exact native local-review roundtrip');
    await controller.submit();
    assert.equal(view.reviewStatus, 'pending', view.error);
    const original = runtime.pending.load(input.credentials.accountId);
    assert.ok(original);
    assert.equal(issued, 1);
    const decision = new Promise((resolve) => process.once('message', resolve));
    await send({
      event: 'pending',
      requestId: original.payload.clientRequestId,
    });
    assert.equal((await decision).event, 'approved');
    await controller.recover();
    assert.equal(view.reviewStatus, 'approved', view.error);
    assert.deepEqual(
      runtime.pending.load(input.credentials.accountId),
      original,
    );
    assert.equal(
      transport.exchanges.filter(
        (call) => call.path === '/v1/community/posts' && call.method === 'POST',
      ).length,
      0,
    );
    await controller.recover(true);
    assert.equal(view.receiptStatus, '发布已确认', view.error);
    const resourceId = view.resourceId;
    assert.equal(runtime.pending.load(input.credentials.accountId), null);
    assert.equal(issued, 1, 'Explicit publish reuses original key');
    await controller.load();
    controller.setAuthorMode('named');
    controller.setAllowAnonymousDm(false);
    controller.setText('Keep draft after cancelled native review');
    await controller.submit();
    assert.equal(view.reviewStatus, 'pending', view.error);
    const cancelAttempt = runtime.pending.load(input.credentials.accountId);
    transport.dropSuccess = {
      path: `/v1/community/reviews/requests/${cancelAttempt.payload.clientRequestId}/cancel`,
      method: 'POST',
    };
    await controller.cancelReview();
    assert.equal(
      view.frozen,
      true,
      'Lost server cancellation keeps the local barrier',
    );
    assert.deepEqual(
      runtime.pending.load(input.credentials.accountId),
      cancelAttempt,
    );
    controller.dispose();
    controller = new ComposeController(runtime, null, (value) => {
      view = value;
    });
    await controller.load();
    await controller.recover();
    assert.equal(
      runtime.pending.load(input.credentials.accountId),
      null,
      view.error,
    );
    assert.equal(view.receiptStatus, '服务器已确认取消，原请求不能再发布');
    assert.equal(view.text, 'Keep draft after cancelled native review');
    assert.equal(view.canSubmit, false);
    assert.equal(issued, 2);
    await send({
      event: 'done',
      requestId: original.payload.clientRequestId,
      cancelledRequestId: cancelAttempt.payload.clientRequestId,
      resourceId,
      issued,
    });
  } catch (error) {
    await send({
      event: 'failure',
      message: error instanceof Error ? error.stack : String(error),
    });
    process.exitCode = 1;
  } finally {
    controller?.dispose();
    process.disconnect();
  }
});
