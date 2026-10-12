import assert from 'node:assert/strict';
import test from 'node:test';
import { registerMajorDiscussionPage } from '../src/major-discussion/page';
import { discussionHarness } from './major-discussion-helpers';
import { PendingMajorDiscussionStore } from '../src/major-discussion/pending';
import type { CommunityRuntime } from '../src/community/runtime';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { MediaLocalFiles } from '../src/media/local-files';
import type { UploadFiles, WxUploadApi } from '../src/platform/wechat-upload';
import type { WxMediaApi } from '../src/platform/wechat-media';
import type { HttpRequest, HttpResponse } from '../src/platform/contracts';
import {
  createMajorDiscussionImageRuntime,
  type MajorDiscussionImageView,
  type MajorDiscussionGalleryView,
} from '../src/major-discussion/image-runtime';
import {
  decodeMajorDiscussionMediaPrepare,
  majorDiscussionMediaPrepareHash,
  MAJOR_DISCUSSION_MEDIA_PROTOCOL as protocol,
} from '../src/major-discussion/media-contract';
import type { MajorDiscussionMediaPrepare } from '../src/major-discussion/media-contract';
import { MemoryStorage, FakeClock, signedIn, flush } from './helpers';
const last = <T>(values: readonly T[], offset = 1): T | undefined =>
  values[values.length - offset];
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(1),
  majorId = id(2),
  origin = 'https://api.example.invalid',
  digest = 'a'.repeat(64);
const context = {
  majorId,
  catalogRevision: id(3),
  majorRevision: id(4),
  rootId: null,
  replyToReplyId: null,
};
function harness() {
  const storage = new MemoryStorage(),
    clock = new FakeClock(),
    sessions = signedIn(actor),
    calls: HttpRequest[] = [],
    removed: string[] = [],
    inputs = new Map<string, MajorDiscussionMediaPrepare>(),
    observed: string[] = [];
  let sequence = 20,
    pickSequence = 0,
    holdUpload = false,
    holdPicker = false,
    losePublication = false,
    publicationMissing = false,
    wrongRecoveryTarget = false,
    failCancellation = false,
    holdDownload = false;
  let heldUpload:
      Parameters<NonNullable<WxUploadApi['uploadFile']>>[0] | undefined,
    heldPicker:
      Parameters<NonNullable<WxUploadApi['chooseMedia']>>[0] | undefined,
    heldDownload:
      Parameters<NonNullable<WxMediaApi['downloadFile']>>[0] | undefined;
  let latest: MajorDiscussionMediaPrepare | undefined;
  const files: UploadFiles = {
    stat: async () => 10,
    image: async () => ({ width: 20, height: 20, type: 'png' }),
    digest: async () => digest,
    readError: async () => ({}),
    unlink: async (path) => {
      removed.push(path);
    },
  };
  const registry = new MediaLocalFiles(files);
  const status = (input: MajorDiscussionMediaPrepare, ready = false) => ({
    protocol,
    intentId: id(100 + input.ordinal),
    requestId: input.clientRequestId,
    requestHash: majorDiscussionMediaPrepareHash(actor, input),
    serverNow: 1000,
    ...(ready
      ? {
          status: 'ready_unbound',
          assetId: id(200 + input.ordinal),
          manifestDigest: String(input.ordinal + 1).repeat(64),
          bindBefore: 20000,
          mediaProof: 'current',
        }
      : { status: 'prepared', operationDeadlineAt: 20000, upload: 'none' }),
  });
  const response = (body: unknown): HttpResponse => ({
    status: 200,
    headers: {},
    body,
  });
  let resolveReceipt: (request: HttpRequest) => HttpResponse = (request) => {
    const command = request.body as Record<string, unknown>;
    return response({
      requestId: command.clientRequestId,
      majorId,
      operation: 'major.discussion.root.v2',
      outcome: 'applied',
      commentId: id(300),
      createdAt: '2026-10-12T00:00:00.000Z',
    });
  };
  const api = new ApiClient(
    origin,
    {
      send: async (request) => {
        calls.push(request);
        const url = new URL(request.url),
          path = url.pathname;
        if (path.endsWith('/upload-intents')) {
          const input = decodeMajorDiscussionMediaPrepare(request.body);
          latest = input;
          inputs.set(input.clientRequestId, input);
          const journal = [...storage.data.values()][0] as {
            uploadRecoveryKeys: { requestId: string }[];
          };
          assert.equal(
            last(journal.uploadRecoveryKeys)?.requestId,
            input.clientRequestId,
            'durable journal readback precedes prepare',
          );
          return response(status(input));
        }
        if (path.endsWith('/grant'))
          return response({
            protocol,
            strategy: 'authenticated-multipart-v1',
            intentId: id(100 + latest!.ordinal),
            generation: '1',
            grantId: id(501),
            method: 'POST',
            fieldName: 'file',
            maxBytes: 5242880,
            expectedBytes: 10,
            expectedMime: 'image/png',
            expectedSha256: digest,
            grantExpiresAt: 10000,
            operationDeadlineAt: 20000,
            serverNow: 1000,
          });
        if (path.endsWith('/finalize')) return response(status(latest!, true));
        if (path.includes('/upload-requests/') && path.endsWith('/cancel')) {
          const requestId = last(path.split('/'), 2)!;
          const body = request.body as Record<string, unknown>;
          return response({
            protocol,
            requestId,
            requestHash: body.requestHash,
            serverNow: 1000,
            state: 'cancelled_before_prepare',
            reason: 'cancelled',
          });
        }
        if (path.includes('/upload-requests/')) {
          const requestId = last(path.split('/'))!;
          return response({
            protocol,
            requestId,
            requestHash: null,
            state: 'not_recorded',
            serverNow: 1000,
          });
        }
        if (
          path.startsWith('/v2/') &&
          path.endsWith('/cancel') &&
          failCancellation
        )
          throw new ClientError(
            'network',
            'Original cancellation response unknown',
          );
        if (path.startsWith('/v2/') && path.endsWith('/cancel'))
          return response({
            requestId: last(path.split('/'), 2),
            majorId,
            operation: 'major.discussion.root.v2',
            outcome: 'rejected',
            code: 'MAJOR_DISCUSSION_CANCELLED',
          });
        if (path.includes('/discussion-requests/')) {
          if (wrongRecoveryTarget)
            return response({
              requestId: last(path.split('/')),
              majorId: id(999),
              operation: 'major.discussion.root.v2',
              outcome: 'rejected',
              code: 'MAJOR_DISCUSSION_CANCELLED',
            });
          if (publicationMissing)
            throw new ClientError('http', 'Missing', {
              httpStatus: 404,
              serverCode: 'REQUEST_NOT_FOUND',
            });
          return response({
            requestId: last(path.split('/')),
            majorId,
            operation: 'major.discussion.root.v2',
            outcome: 'applied',
            commentId: id(300),
            createdAt: '2026-10-12T00:00:00.000Z',
          });
        }
        if (
          path.startsWith('/v2/') &&
          path.endsWith('/discussion') &&
          request.method === 'GET'
        )
          return response({
            protocol: 'major-discussion-v2',
            majorId,
            catalogRevision: context.catalogRevision,
            majorRevision: context.majorRevision,
            discussionRevision: '1',
            root: null,
            items: [],
            totalCount: 0,
            nextCursor: null,
            continuation: 'end',
          });
        if (path.startsWith('/v2/') && path.endsWith('/discussion')) {
          if (losePublication)
            throw new ClientError('network', 'Response lost');
          return resolveReceipt(request);
        }
        if (path.includes('/bindings/'))
          return response({
            protocol,
            kind: 'major-discussion-media',
            majorId,
            commentId: id(300),
            bindingId: last(path.split('/')),
            ordinal: Number(url.searchParams.get('ordinal')),
            width: 20,
            height: 20,
            variants: ['thumb-v1', 'display-v1'],
          });
        throw new Error(`Unexpected ${path}`);
      },
    },
    sessions,
    {
      refresh: async () => {
        throw new Error('unexpected refresh');
      },
    },
  );
  const finishPicker = (options: NonNullable<typeof heldPicker>) => {
    options.success({
      tempFiles: [
        { tempFilePath: `wxfile://tmp/pick-${++pickSequence}.png`, size: 10 },
      ],
    });
    options.complete();
  };
  const finishUpload = (
    options: NonNullable<typeof heldUpload>,
    complete = true,
  ) => {
    options.success({
      statusCode: 200,
      data: JSON.stringify({
        protocol,
        status: 'uploadObserved',
        intentId: id(100 + latest!.ordinal),
        generation: '1',
        grantId: id(501),
        bytes: 10,
        sha256: digest,
        next: 'finalize',
      }),
    });
    if (complete) options.complete();
  };
  const wx: WxUploadApi & WxMediaApi = {
    chooseMedia(options) {
      observed.push('choose');
      assert.equal(options.count, 1);
      if (holdPicker) heldPicker = options;
      else finishPicker(options);
    },
    uploadFile(options) {
      observed.push('upload');
      assert.equal(
        options.url,
        `${origin}/v3/media/major-discussions/upload-intents/${id(100 + latest!.ordinal)}/uploads/${id(501)}`,
      );
      assert.match(options.header.Authorization ?? '', /^Bearer /);
      heldUpload = options;
      if (!holdUpload) finishUpload(options);
      return {
        abort() {
          observed.push('abort');
        },
      };
    },
    downloadFile(options) {
      observed.push('download');
      heldDownload = options;
      const task = {
        abort() {
          observed.push('download-abort');
        },
        onHeadersReceived(
          listener: (x: { header: Record<string, string> }) => void,
        ) {
          listener({
            header: {
              'content-type': 'image/png',
              'content-length': '10',
              'cache-control': 'private, no-store',
              'x-content-type-options': 'nosniff',
            },
          });
          if (!holdDownload) {
            options.success({
              statusCode: 200,
              tempFilePath: 'wxfile://tmp/view.png',
            });
            options.complete();
          }
        },
        offHeadersReceived() {},
        onProgressUpdate() {},
        offProgressUpdate() {},
      };
      return task;
    },
  };
  const runtime = createMajorDiscussionImageRuntime({
    api,
    sessions,
    storage,
    origin,
    clock,
    newRequestId: async () => id(++sequence),
    wx,
    files,
    registry,
    auth: {
      refresh: async () => {
        throw new Error('unexpected refresh');
      },
    },
  });
  const views: MajorDiscussionImageView[] = [],
    galleries: MajorDiscussionGalleryView[] = [],
    composer = runtime.createComposer((v) => views.push(v)),
    gallery = runtime.createGallery((v) => galleries.push(v));
  return {
    runtime,
    composer,
    gallery,
    storage,
    sessions,
    clock,
    registry,
    calls,
    removed,
    observed,
    inputs,
    view: () => last(views)!,
    galleryView: () => last(galleries)!,
    set holdUpload(v: boolean) {
      holdUpload = v;
    },
    set holdPicker(v: boolean) {
      holdPicker = v;
    },
    set losePublication(v: boolean) {
      losePublication = v;
    },
    set failCancellation(v: boolean) {
      failCancellation = v;
    },
    set wrongRecoveryTarget(v: boolean) {
      wrongRecoveryTarget = v;
    },
    set publicationMissing(v: boolean) {
      publicationMissing = v;
    },
    set holdDownload(v: boolean) {
      holdDownload = v;
    },
    finishPicker: () => finishPicker(heldPicker!),
    uploadObserved: () => finishUpload(heldUpload!, false),
    uploadComplete: () => heldUpload!.complete(),
    downloadLate: () => {
      heldDownload!.success({
        statusCode: 200,
        tempFilePath: 'wxfile://tmp/late.png',
      });
      heldDownload!.complete();
    },
    set receipt(v: typeof resolveReceipt) {
      resolveReceipt = v;
    },
  };
}
async function until(condition: () => boolean) {
  for (let n = 0; n < 80 && !condition(); n++) await flush();
  assert.equal(condition(), true, 'expected asynchronous native boundary');
}
test('real native picker/inspection/grant/upload/finalize publishes ordered three-image text content and metadata-only recovery', async () => {
  const h = harness();
  h.composer.restore();
  for (let i = 0; i < 3; i++) await h.composer.pick(context);
  assert.equal(h.view().imageCount, 3);
  await h.composer.pick(context);
  assert.equal(h.observed.filter((x) => x === 'choose').length, 3);
  const saved = JSON.stringify([...h.storage.data.values()]);
  for (const forbidden of [
    'wxfile:',
    'accessToken',
    'refreshToken',
    'manifestDigest',
    'image/png',
    'body',
  ])
    assert.equal(saved.includes(forbidden), false);
  assert.equal(h.inputs.size, 3);
  assert.deepEqual(
    [...h.inputs.values()].map((v) => v.ordinal),
    [0, 1, 2],
  );
  const result = await h.composer.publish(context, ' Exact text 😀 ');
  assert.equal(result?.outcome, 'applied');
  const post = h.calls.find(
    (c) => c.url === `${origin}/v2/majors/${majorId}/discussion`,
  )!;
  const body = post.body as { body: string; images: { assetId: string }[] };
  assert.equal(body.body, ' Exact text 😀 ');
  assert.deepEqual(
    body.images.map((i) => i.assetId),
    [id(200), id(201), id(202)],
  );
  assert.equal(h.runtime.pending.load(actor), null);
  assert.deepEqual(h.runtime.pending.legacy.deletionLocators(actor), [
    { majorId, commentId: id(300), rootId: null },
  ]);
  await flush();
  assert.equal(h.removed.length, 3);
});
test('native success does not release uploader quiet fence; finalization waits complete and hide retains original recovery', async () => {
  const h = harness();
  h.holdUpload = true;
  const work = h.composer.pick(context);
  await until(() => h.observed.includes('upload'));
  h.uploadObserved();
  await flush();
  assert.equal(
    h.calls.some((c) => c.url.endsWith('/finalize')),
    false,
  );
  assert.equal(h.removed.length, 0);
  h.runtime.hide();
  h.uploadComplete();
  await work;
  await flush();
  assert.equal(h.view().imageCount, 0);
  assert.equal(h.storage.data.size, 1);
  assert.equal(h.removed.length, 1);
});
test('picker-induced hide suspends only picker, does not upload until foreground, unload rejects late callback', async () => {
  const h = harness();
  h.holdPicker = true;
  const work = h.composer.pick(context);
  await until(() => h.observed.includes('choose'));
  h.runtime.hide();
  assert.equal(h.runtime.pickerActive, true);
  h.finishPicker();
  await flush();
  assert.equal(h.calls.length, 0);
  h.composer.resumePicker();
  await work;
  assert.equal(h.view().imageCount, 1);
  const late = harness();
  late.holdPicker = true;
  const abandoned = late.composer.pick(context);
  await until(() => late.observed.includes('choose'));
  late.composer.dispose();
  late.finishPicker();
  await abandoned;
  await flush();
  assert.equal(late.calls.length, 0);
  assert.equal(late.removed.length, 1);
});
test('publication response loss survives cold restart; not_recorded never manufactures key, cancel fences original before uploads', async () => {
  const h = harness();
  await h.composer.pick(context);
  h.losePublication = true;
  await h.composer.publish(context, 'secret unsaved text');
  const original = [...h.storage.data.values()][0];
  h.composer.dispose();
  const views: MajorDiscussionImageView[] = [];
  const cold = h.runtime.createComposer((v) => views.push(v));
  cold.restore();
  assert.equal(last(views)?.imageFrozen, true);
  h.publicationMissing = true;
  const before = h.calls.length;
  await cold.recover();
  assert.equal(
    h.calls.slice(before).some((c) => c.method === 'POST'),
    false,
  );
  assert.deepEqual([...h.storage.data.values()][0], original);
  const result = await cold.cancelOriginal();
  assert.equal(result?.outcome, 'rejected');
  const cancels = h.calls.filter((c) => c.url.endsWith('/cancel'));
  assert.match(cancels[0]!.url, /\/v2\/majors\/discussion-requests\//);
  assert.match(
    cancels[1]!.url,
    /\/v3\/media\/major-discussions\/upload-requests\//,
  );
  assert.equal(h.storage.data.size, 0);
});
test('durable storage failure prevents prepare/upload/publication and original account change closes local state', async () => {
  const h = harness();
  h.storage.failWrite = true;
  await h.composer.pick(context);
  assert.equal(h.calls.length, 0);
  assert.equal(h.observed.includes('upload'), false);
  assert.equal(h.view().imageFrozen, true);
  const good = harness();
  await good.composer.pick(context);
  good.sessions.logout();
  assert.equal(good.view().imageCount, 0);
  assert.equal(good.storage.data.size, 1);
  await good.composer.publish(context, 'late');
  assert.equal(
    good.calls.some((c) => c.url.startsWith(`${origin}/v2/`)),
    false,
  );
});
test('controlled first-party gallery revokes on close, expiry and late download, with no native preview', async () => {
  const h = harness();
  const refs = [
    { majorId, commentId: id(300), bindingId: id(400), ordinal: 0 },
  ];
  await h.gallery.open(refs);
  assert.equal(h.galleryView().gallerySrc, 'wxfile://tmp/view.png');
  assert.ok(
    h.calls.some((c) => c.url.endsWith(`bindings/${id(400)}?ordinal=0`)),
  );
  h.clock.advance(30000);
  await flush();
  assert.equal(h.galleryView().galleryOpen, false);
  assert.ok(h.removed.includes('wxfile://tmp/view.png'));
  const late = harness();
  late.holdDownload = true;
  const work = late.gallery.open(refs);
  await until(() => late.observed.includes('download'));
  late.gallery.clear();
  late.downloadLate();
  await work;
  await flush();
  assert.equal(late.galleryView().gallerySrc, '');
  assert.ok(late.removed.includes('wxfile://tmp/late.png'));
});
test('cold restored metadata is revoked on account switch before any new operation', async () => {
  const h = harness();
  await h.composer.pick(context);
  h.composer.dispose();
  const views: MajorDiscussionImageView[] = [];
  const cold = h.runtime.createComposer((v) => views.push(v));
  cold.restore();
  assert.equal(last(views)?.imagePending, true);
  h.sessions.logout();
  assert.equal(last(views)?.imageRequestId, '');
  assert.equal(last(views)?.imagePending, false);
});
test('Stop waiting exposes the preserved original journal once cancellation settles', async () => {
  const h = harness();
  h.holdUpload = true;
  const work = h.composer.pick(context);
  await until(() => h.observed.includes('upload'));
  h.composer.clear();
  h.composer.restore();
  h.uploadComplete();
  await work;
  await flush();
  assert.equal(h.view().imagePending, true);
  assert.equal(h.view().imageRecoverable, true);
  assert.notEqual(h.view().imageRequestId, '');
  assert.equal(h.view().imageFrozen, true);
});
interface NativePage {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  onLoad(query: unknown): void;
  onShow(): void;
  onHide(): void;
  onUnload(): void;
  onPickImage(event: { currentTarget: { dataset: { source: string } } }): void;
  onConfirmPublish(): void;
  onBody(event: { detail: { value: string } }): void;
  onSubmit(): Promise<void>;
  onCancelWait(): void;
}
test('actual registered Major Page loads v2, picker hide resumes, and two explicit publish taps require text and dispatch v2', async () => {
  const h = harness(),
    base = discussionHarness();
  const runtime: CommunityRuntime = {
    ...base.runtime,
    sessions: h.sessions,
    pendingMajorDiscussion: new PendingMajorDiscussionStore(h.storage, origin),
    majorDiscussionV2: h.runtime.publication,
    majorDiscussionImages: h.runtime,
  };
  const globals = globalThis as unknown as Record<string, unknown>,
    original = { Page: globals.Page, getApp: globals.getApp, wx: globals.wx };
  let definition: NativePage | undefined;
  globals.Page = (value: NativePage) => {
    definition = value;
  };
  globals.getApp = () => ({ community: runtime });
  globals.wx = {};
  try {
    registerMajorDiscussionPage('roots');
    const page = definition!;
    page.setData = function (patch) {
      this.data = { ...this.data, ...patch };
    };
    page.onLoad({ majorId });
    page.onShow();
    await until(() => page.data.loaded === true);
    assert.equal(page.data.imageEnabled, true);
    assert.ok(
      h.calls.some((c) => c.method === 'GET' && c.url.includes('/v2/majors/')),
    );
    h.holdPicker = true;
    page.onPickImage({ currentTarget: { dataset: { source: 'album' } } });
    await until(() => h.observed.includes('choose'));
    h.runtime.hide();
    runtime.privateViews?.clear();
    page.onHide();
    h.finishPicker();
    await flush();
    assert.equal(h.observed.includes('upload'), false);
    page.onShow();
    await until(() => page.data.imageCount === 1);
    await until(() => page.data.imageBusy === false);
    assert.equal(page.data.canPublish, false);
    page.onBody({ detail: { value: 'Native Major text' } });
    assert.equal(page.data.canPublish, true);
    await page.onSubmit();
    assert.equal(
      h.calls.filter(
        (c) => c.method === 'POST' && c.url.endsWith('/discussion'),
      ).length,
      0,
    );
    page.onConfirmPublish();
    assert.equal(page.data.confirming, 'publish');
    await page.onSubmit();
    assert.equal(
      h.calls.filter(
        (c) => c.method === 'POST' && c.url.endsWith('/discussion'),
      ).length,
      1,
    );
    assert.equal(page.data.body, '');
    page.onUnload();
    assert.equal(page.data.gallerySrc, '');
  } finally {
    Object.assign(globals, original);
  }
});
test('wrong-target recovered receipt cannot cancel any original upload before rejection', async () => {
  const h = harness();
  await h.composer.pick(context);
  h.losePublication = true;
  await h.composer.publish(context, 'original');
  h.wrongRecoveryTarget = true;
  const before = h.calls.length;
  await h.composer.recover();
  assert.equal(
    h.calls.slice(before).some((value) => value.method === 'POST'),
    false,
  );
  assert.equal(h.storage.data.size, 1);
  assert.equal(h.view().imageFrozen, true);
});
test('whole-set removal or reorder requires confirmed original publication/upload cancellation before a new draft key', async () => {
  const h = harness();
  await h.composer.pick(context);
  await h.composer.pick(context);
  const original = h.runtime.pending.load(actor)!;
  assert.equal(original.phase, 'draft');
  assert.equal(original.intentHash, null);
  assert.equal(original.uploadRecoveryKeys.length, 2);
  h.failCancellation = true;
  await h.composer.cancelOriginal();
  assert.equal(h.runtime.pending.load(actor)!.phase, 'cancel');
  assert.equal(h.view().imageFrozen, true);
  const picked = h.observed.filter((value) => value === 'choose').length,
    requests = h.calls.length;
  await h.composer.pick(context);
  assert.equal(h.observed.filter((value) => value === 'choose').length, picked);
  assert.equal(h.calls.length, requests);
  assert.equal(
    h.runtime.pending.load(actor)!.target.clientRequestId,
    original.target.clientRequestId,
  );
  h.failCancellation = false;
  const receipt = await h.composer.cancelOriginal();
  assert.equal(receipt?.outcome, 'rejected');
  assert.equal(h.runtime.pending.load(actor), null);
  assert.equal(h.view().imageCount, 0);
  const cancellations = h.calls.filter(
    (value) =>
      value.url.includes('/upload-requests/') && value.url.endsWith('/cancel'),
  );
  assert.equal(cancellations.length, 2);
  for (const [index, key] of original.uploadRecoveryKeys.entries())
    assert.ok(cancellations[index]!.url.includes(key.requestId));
  await h.composer.pick(context);
  const replacement = h.runtime.pending.load(actor)!;
  assert.notEqual(
    replacement.target.clientRequestId,
    original.target.clientRequestId,
  );
  assert.equal(replacement.phase, 'draft');
  assert.equal(replacement.uploadRecoveryKeys.length, 1);
  assert.equal(last([...h.inputs.values()])!.ordinal, 0);
  assert.equal(h.view().imageCount, 1);
});

test('Major never creates an image-only publication or freezes an invalid text attempt', async () => {
  for (const body of ['', ' \n', '\u0000', '\ud800', '😀'.repeat(2001)]) {
    const h = harness();
    assert.equal(await h.composer.publish(context, body), null);
    assert.equal(h.calls.length, 0);
    assert.equal(h.runtime.pending.load(actor), null);
  }
  const h = harness();
  await h.composer.pick(context);
  const prior = h.runtime.pending.load(actor);
  assert.equal(await h.composer.publish(context, ''), null);
  assert.deepEqual(h.runtime.pending.load(actor), prior);
  assert.equal(
    h.calls.some((call) => call.url.startsWith(`${origin}/v2/`)),
    false,
  );
});

test('legacy original key is restored before corrupt newer metadata and no picker admission overwrites caches', async () => {
  const h = harness();
  const legacy = h.runtime.pending.legacy;
  const original = legacy.freeze({
    version: 1,
    accountId: actor,
    origin,
    phase: 'submit',
    intent: {
      operation: 'major.discussion.root.v1',
      majorId,
      command: {
        clientRequestId: id(999),
        expectedCatalogRevision: context.catalogRevision,
        expectedMajorRevision: context.majorRevision,
        body: ' old text 😀 ',
      },
    },
  });
  const key = `whaleu.major-discussion.pending.v2:${origin}:${actor}`;
  const locatorKey = `whaleu.major-discussion.own-deletion-locators.v1:${origin}:${actor}`;
  const bad = { broken: 'do not overwrite' };
  h.storage.data.set(key, bad);
  h.storage.data.set(locatorKey, bad);
  h.composer.restore();
  assert.equal(h.view().imageRecoverable, false);
  assert.match(h.view().imageStatus, /原文字讨论/);
  await h.composer.pick(context);
  assert.equal(h.observed.length, 0);
  assert.deepEqual(legacy.loadForRecovery(actor), original);
  legacy.settle(original, {
    requestId: id(999),
    majorId,
    operation: 'major.discussion.root.v1',
    outcome: 'applied',
    commentId: id(300),
    createdAt: '2026-10-12T00:00:00.000Z',
  });
  assert.equal(legacy.loadForRecovery(actor), null);
  assert.deepEqual(h.storage.data.get(key), bad);
  assert.deepEqual(h.storage.data.get(locatorKey), bad);
  h.composer.restore();
  await h.composer.pick(context);
  assert.equal(h.calls.length, 0);
  assert.equal(h.observed.length, 0);
});
