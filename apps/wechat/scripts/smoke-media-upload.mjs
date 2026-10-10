import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function observe(page) {
  const waiting = new Set();
  const setData = page.setData.bind(page);
  page.setData = (patch) => {
    setData(patch);
    for (const inspect of [...waiting]) inspect();
  };
  return (predicate) => {
    if (predicate(page.data)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const inspect = () => {
        if (!predicate(page.data)) return;
        clearTimeout(timer);
        waiting.delete(inspect);
        resolve();
      };
      const timer = setTimeout(() => {
        waiting.delete(inspect);
        reject(new Error('Expected emitted Page state did not arrive'));
      }, 5000);
      waiting.add(inspect);
    });
  };
}
/** Compiled Page + real native adapters with synthetic SDK/server callbacks only.
 * Actual socket/PG/sharp/Review behavior is covered by separate API integration tests. */
export async function smokeMediaUpload({ app, dist, mountPage, postWire }) {
  const load = (file) => require(path.join(dist, file));
  const { PendingMediaStore } = load('media/pending.js');
  const { PendingAttemptStore } = load('community/pending-attempt.js');
  const { createMediaUploadRuntime, mediaPublicationOwner } = load(
    'media/upload-runtime.js',
  );
  const { uploadRequestHash } = load('media/upload-contracts.js');
  const { AuthenticatedMediaUpload } = load('media/authenticated-upload.js');
  const { WechatUploadFiles } = load('platform/wechat-upload.js');
  const { MediaLocalFiles } = load('media/local-files.js');
  const { systemClock } = load('platform/clock.js');
  const { ClientError } = load('api/errors.js');
  const sessions = app.identity.sessions;
  const originalCredentials = sessions.snapshot().credentials;
  assert.ok(originalCredentials);
  const original = {
    mediaUpload: app.community.mediaUpload,
    gateway: app.community.gateway,
    profiles: app.community.profiles,
    pending: app.community.pending,
    newRequestId: app.community.newRequestId,
  };
  const values = new Map();
  const storage = {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, structuredClone(value)),
    remove: (key) => values.delete(key),
  };
  const origin = 'https://emitted-upload.invalid';
  const pending = new PendingMediaStore(storage, origin);
  const publicationPending = new PendingAttemptStore(storage, origin);
  const spaceId = postWire().space.id;
  const module = path.join(
    dist,
    'pages/community-compose/community-compose.js',
  );
  const query = { spaceId, category: 'discussion' };
  const bytes = new Uint8Array(65537).fill(51);
  const nativeFiles = new Map();
  const uploads = [],
    pickCalls = [],
    prepares = [];
  let uploadArrival = deferred();
  const draftArrival = deferred(),
    draftGate = deferred();
  let idCalls = 0,
    holdDraft = true,
    serverStatus;
  const newRequestId = async () => {
    idCalls++;
    if (holdDraft) {
      holdDraft = false;
      draftArrival.resolve();
      return draftGate.promise;
    }
    return randomUUID();
  };
  const sdk = {
    chooseMedia(input) {
      pickCalls.push(input);
      assert.equal(input.count, 1);
      assert.deepEqual(input.mediaType, ['image']);
      const local = `wxfile://tmp/emitted-upload-${pickCalls.length}`;
      nativeFiles.set(local, bytes);
      input.success({
        tempFiles: [
          { tempFilePath: local, size: bytes.length, fileType: 'image' },
        ],
      });
      input.complete();
    },
    getFileSystemManager: () => ({
      getFileInfo(input) {
        const value = nativeFiles.get(input.filePath);
        if (value) input.success({ size: value.length });
        else input.fail({});
      },
      readFile(input) {
        assert.ok(input.length <= 65536);
        const value = nativeFiles.get(input.filePath);
        if (value)
          input.success({
            data: value.slice(input.position, input.position + input.length)
              .buffer,
          });
        else input.fail({});
      },
      unlink(input) {
        nativeFiles.delete(input.filePath);
        input.success();
      },
    }),
    getImageInfo(input) {
      input.success({
        width: 80,
        height: 60,
        type: 'png',
        orientation: 'up',
        path: input.src,
      });
    },
    uploadFile(input) {
      const operation = { input, progress: undefined };
      uploads.push(operation);
      uploadArrival.resolve(operation);
      return {
        abort() {},
        onProgressUpdate(listener) {
          operation.progress = listener;
        },
        offProgressUpdate() {},
      };
    },
  };
  const gateway = {
    async recover(requestId) {
      if (!serverStatus)
        return {
          version: 2,
          requestId,
          requestHash: null,
          serverNow: Date.now(),
          state: 'not_recorded',
        };
      assert.equal(requestId, serverStatus.requestId);
      return {
        version: 2,
        requestId,
        requestHash: serverStatus.requestHash,
        serverNow: Date.now(),
        state:
          serverStatus.status === 'bound_history' ? 'bound_history' : 'active',
        status: serverStatus,
      };
    },
    async prepare(input, session) {
      prepares.push(input);
      serverStatus = {
        version: 2,
        intentId: randomUUID(),
        requestId: input.clientRequestId,
        requestHash: uploadRequestHash(
          session.current().credentials.accountId,
          input,
        ),
        serverNow: Date.now(),
        status: 'prepared',
        operationDeadlineAt: Date.now() + 1800000,
        upload: 'none',
      };
      return serverStatus;
    },
    async status() {
      return serverStatus;
    },
    async grant(intentId) {
      const declaration = prepares.at(-1).declaration;
      return {
        version: 1,
        strategy: 'authenticated-multipart-v1',
        intentId,
        generation: '1',
        grantId: randomUUID(),
        method: 'POST',
        fieldName: 'file',
        maxBytes: 5242880,
        expectedBytes: declaration.bytes,
        expectedMime: declaration.mime,
        expectedSha256: declaration.sha256,
        grantExpiresAt: Date.now() + 60000,
        operationDeadlineAt: Date.now() + 1800000,
        serverNow: Date.now(),
      };
    },
    async finalize() {
      assert.fail('This emitted race fixture does not process images');
    },
    async cancelRequest() {
      assert.fail('A created publication must not send media cancel');
    },
  };
  app.community.profiles = {
    profile: async () => ({
      accountId: sessions.snapshot().credentials.accountId,
      preferences: {
        defaultCommentAnonymousEnabled: false,
        defaultCommentNonAnonymousEnabled: false,
      },
    }),
  };
  app.community.gateway = {
    ...original.gateway,
    capabilities: async () => ({
      publish: { availability: 'allowed', reason: null },
      authorModes: ['named', 'anonymous'],
      canDisableComments: false,
      mediaAvailability: 'unavailable',
      postImageLimit: 9,
      commentImageLimit: 3,
      commentRules: {
        unverifiedRequiresNamed: true,
        ownAnonymousPostForcesAnonymous: true,
      },
    }),
  };
  app.community.pending = publicationPending;
  app.community.newRequestId = newRequestId;
  const files = new WechatUploadFiles(sdk, systemClock);
  const transfer = new AuthenticatedMediaUpload(
    origin,
    sdk,
    files,
    new MediaLocalFiles(files),
    sessions,
    systemClock,
  );
  let page;
  try {
    assert.equal(
      original.mediaUpload,
      undefined,
      'Formal runtime never installs an uploader',
    );
    const template = readFileSync(
      path.join(dist, 'pages/community-compose/community-compose.wxml'),
      'utf8',
    );
    assert.match(
      template,
      /<view wx:if="\{\{batchMode\}\}" class="media-batch">/,
    );
    assert.match(
      template,
      /<view wx:elif="\{\{canSelectImage\}\}"><button bindtap="onSelectImage"/,
    );
    assert.match(
      template,
      /mediaStatus !== 'idle' &amp;&amp; mediaStatus !== 'terminal' &amp;&amp; mediaStatus !== 'bound_history'/,
    );
    assert.match(template, /mediaBusy/);
    page = mountPage(module, query);
    let state = observe(page);
    await state((view) => view.loaded && !view.busy);
    assert.equal(page.data.canSelectImage, false);
    page.onSelectImage();
    assert.equal(idCalls, 0);
    assert.equal(pickCalls.length, 0);
    page.onUnload();

    app.community.mediaUpload = createMediaUploadRuntime({
      sessions,
      pending,
      gateway,
      transfer,
      clock: systemClock,
      newRequestId,
      privateViews: app.community.privateViews,
    });
    page = mountPage(module, query);
    state = observe(page);
    await state((view) => view.loaded && !view.busy && !view.mediaBusy);
    assert.equal(page.data.canSelectImage, true);
    page.onSelectImage();
    page.onSelectImage();
    const selected = page.controller.selectImage();
    await draftArrival.promise;
    assert.equal(idCalls, 1);
    assert.equal(pickCalls.length, 0);
    assert.equal(page.data.mediaBusy, true);
    draftGate.resolve(randomUUID());
    const upload = await uploadArrival.promise;
    assert.equal(pickCalls.length, 1);
    assert.equal(idCalls, 2);
    assert.equal(prepares.length, 1);
    const savedA = pending.load(originalCredentials.accountId);
    assert.equal(savedA.phase, 'upload_uncertain');
    upload.progress({
      progress: 100,
      totalBytesSent: bytes.length,
      totalBytesExpectedToSend: bytes.length,
    });
    assert.equal(page.data.mediaStatus, 'uploading');
    page.onHide();
    const hidden = structuredClone(page.data);
    upload.progress({
      progress: 100,
      totalBytesSent: bytes.length,
      totalBytesExpectedToSend: bytes.length,
    });
    upload.input.fail({});
    upload.input.complete();
    await selected;
    assert.deepEqual(page.data, hidden);
    assert.equal(
      pending.load(originalCredentials.accountId).clientRequestId,
      savedA.clientRequestId,
    );

    // New actor gets its own immutable operation. Same-account relogin changes epoch.
    const otherCredentials = {
      ...originalCredentials,
      accountId: randomUUID(),
    };
    sessions.completeLogin(sessions.beginLogin(), otherCredentials);
    serverStatus = undefined;
    uploadArrival = deferred();
    page = mountPage(module, query);
    state = observe(page);
    await state((view) => view.loaded && !view.busy && !view.mediaBusy);
    const otherSelection = page.controller.selectImage();
    const otherUpload = await uploadArrival.promise;
    sessions.completeLogin(sessions.beginLogin(), otherCredentials);
    const relogged = structuredClone(page.data);
    otherUpload.progress({
      progress: 100,
      totalBytesSent: bytes.length,
      totalBytesExpectedToSend: bytes.length,
    });
    otherUpload.input.fail({});
    otherUpload.input.complete();
    await otherSelection;
    assert.deepEqual(page.data, relogged);
    assert.ok(pending.load(otherCredentials.accountId));
    assert.ok(pending.load(originalCredentials.accountId));
    page.onUnload();

    sessions.completeLogin(sessions.beginLogin(), originalCredentials);
    let record = pending.load(originalCredentials.accountId);
    const assetId = randomUUID();
    record = pending.update(record, { phase: 'ready_hint', assetId });
    const attempt = {
      version: 1,
      accountId: originalCredentials.accountId,
      operation: 'publish_post',
      payload: {
        clientRequestId: randomUUID(),
        spaceId,
        category: 'discussion',
        text: 'Compiled media publication fixture',
        imageAssetIds: [assetId],
        authorMode: 'named',
        commentsPolicy: 'open',
      },
    };
    publicationPending.freeze(attempt);
    const order = [];
    let receiptCreated = false;
    const receiptGateway = {
      async receipt(requestId) {
        order.push('receipt');
        if (!receiptCreated)
          throw new ClientError('http', 'Not recorded', {
            serverCode: 'REQUEST_NOT_FOUND',
          });
        return {
          requestId,
          operation: 'publish_post',
          outcome: 'created',
          resourceId: randomUUID(),
          createdAt: '2026-10-10T00:00:00Z',
        };
      },
    };
    const publication = mediaPublicationOwner(
      publicationPending,
      receiptGateway,
    );
    app.community.mediaUpload = createMediaUploadRuntime({
      sessions,
      pending,
      gateway: {
        ...gateway,
        async status() {
          order.push('status');
          return serverStatus;
        },
      },
      transfer,
      clock: systemClock,
      newRequestId,
      publication,
    });
    app.community.mediaUpload.beforePublication(attempt);
    serverStatus = {
      version: 2,
      intentId: record.intentId,
      requestId: record.clientRequestId,
      requestHash: record.requestHash,
      serverNow: Date.now(),
      status: 'bound_history',
      assetId,
      bindingId: randomUUID(),
      publication: pending.load(originalCredentials.accountId).publication,
      attachmentState: 'detached',
    };
    page = mountPage(module, query);
    await page.controller.recoverImage();
    assert.deepEqual(order, ['receipt']);
    assert.equal(page.data.mediaStatus, 'publication_pending');
    assert.equal(
      pending.load(originalCredentials.accountId).phase,
      'publication_uncertain',
    );
    receiptCreated = true;
    await page.controller.cancelImage();
    assert.deepEqual(order, ['receipt', 'receipt', 'status']);
    assert.equal(page.data.mediaStatus, 'bound_history');
    assert.equal(pending.load(originalCredentials.accountId), null);
    assert.ok(publicationPending.load(originalCredentials.accountId));
  } finally {
    page?.onUnload();
    for (const upload of uploads) upload.input.complete();
    sessions.completeLogin(sessions.beginLogin(), originalCredentials);
    Object.assign(app.community, original);
  }
  console.log(
    'Media upload emitted compose smoke passed: default closed, explicit DI, coalesced picker/request, immutable journal, 100% not ready, hide/relogin late callbacks discarded, original publication receipt precedes bound recovery. Synthetic device/server callbacks only.',
  );
}
