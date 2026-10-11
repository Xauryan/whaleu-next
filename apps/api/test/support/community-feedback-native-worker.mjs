/** Actual native HTTP gateways and controllers, with synthetic platform only. */
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
  HttpFeedbackNoticesGateway,
} = require('../../../wechat/src/community/feedback-notices-gateway.ts');
const {
  HttpProfileGateway,
} = require('../../../wechat/src/profile/gateway.ts');
const {
  ComposeController,
} = require('../../../wechat/src/pages/community-compose/controller.ts');
const {
  PendingAttemptStore,
  DraftStore,
} = require('../../../wechat/src/community/pending-attempt.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  NativeExperienceTransport,
  nativeOrigin,
  memoryStorage,
} = require('./experience-native-bridge.ts');
const send = (v) =>
  new Promise((resolve, reject) =>
    process.send(v, (e) => (e ? reject(e) : resolve())),
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
    let view,
      issued = 0;
    const gateway = new HttpCommunityGateway(api);
    const runtime = {
      sessions,
      gateway,
      profiles: new HttpProfileGateway(api),
      pending: new PendingAttemptStore(storage, nativeOrigin),
      drafts: new DraftStore(storage, nativeOrigin),
      newRequestId: async () => {
        issued++;
        return randomUUID();
      },
    };
    const topic = await gateway.feedbackTopic(new Cancellation());
    assert.equal(topic.space.id, input.spaceId);
    controller = new ComposeController(
      runtime,
      {
        operation: 'publish_post',
        spaceId: topic.space.id,
        category: 'feedback',
      },
      (v) => (view = v),
    );
    await controller.load();
    assert.equal(view.loaded, true, view.error);
    controller.setAuthorMode('anonymous');
    controller.setText('Native public feedback preserved');
    controller.setFeedbackField('wechat', 'native-contact');
    controller.setFeedbackConsent(true);
    assert.equal(view.canSubmit, true, view.blocker);
    await controller.submit();
    assert.equal(view.reviewStatus, 'pending', view.error);
    const original = runtime.pending.load(input.credentials.accountId);
    assert.equal(original.payload.feedback.contacts.wechat, 'native-contact');
    controller.dispose();
    const decision = new Promise((resolve) => process.once('message', resolve));
    await send({
      event: 'pending',
      requestId: original.payload.clientRequestId,
    });
    assert.equal((await decision).event, 'approved');
    controller = new ComposeController(runtime, null, (v) => (view = v));
    await controller.load();
    assert.equal(view.feedbackDraft.wechat, 'native-contact');
    await controller.recover();
    assert.equal(view.reviewStatus, 'approved', view.error);
    await controller.recover(true);
    assert.equal(view.receiptStatus, '发布已确认', view.error);
    const resourceId = view.resourceId;
    assert.equal(issued, 1);
    assert.equal(runtime.pending.load(input.credentials.accountId), null);
    const feed = await gateway.feed(
      { spaceId: input.spaceId, category: 'feedback' },
      new Cancellation(),
    );
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0].id, resourceId);
    assert.equal(feed.items[0].author.kind, 'anonymous');
    assert.equal(
      feed.items[0].feedback.authorSchool,
      'Synthetic community institution',
    );
    assert.equal(JSON.stringify(feed).includes('native-contact'), false);
    const detail = await gateway.post(resourceId, new Cancellation());
    assert.equal(detail.viewer.canComment, true);
    assert.equal(detail.author.kind, 'anonymous');
    assert.equal(
      (await gateway.feedbackContacts(resourceId, new Cancellation())).contacts
        .wechat,
      'native-contact',
    );
    sessions.completeLogin(sessions.beginLogin(), input.adminCredentials);
    const notices = new HttpFeedbackNoticesGateway(api);
    const page = await notices.list(null, new Cancellation());
    assert.equal(page.items.length, 1);
    assert.equal(page.unreadCount, 1);
    const noticeId = page.items[0].noticeId;
    const target = await notices.target(noticeId, new Cancellation());
    assert.equal(target.status, 'available');
    assert.equal(target.postId, resourceId);
    await notices.read(noticeId, new Cancellation());
    assert.equal((await notices.list(null, new Cancellation())).unreadCount, 0);
    await send({
      event: 'done',
      requestId: original.payload.clientRequestId,
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
