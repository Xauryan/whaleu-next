import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { RatingDiscussionUpload } from '../src/ratings/discussion-media-upload';
import { RatingDiscussionDownload } from '../src/ratings/discussion-media-download';
import { MediaLocalFiles } from '../src/media/local-files';
import { Cancellation } from '../src/platform/contracts';
import type { WxUploadApi, UploadFiles } from '../src/platform/wechat-upload';
import type { WxMediaApi } from '../src/platform/wechat-media';
import type {
  DiscussionGrant,
  DiscussionDescriptor,
} from '../src/ratings/discussion-media-wire';
import { decodeRatingDiscussionMediaContext } from '../src/ratings/discussion-media-contract';
import { scopedContext } from './rating-scoped-helpers';
import { FakeClock, flush, signedIn } from './helpers';
import { DownloadCall, imageHeaders } from './support/media-read-fixtures';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSUcAAAAASUVORK5CYII=',
  'base64',
);
const sha256 = createHash('sha256').update(bytes).digest('hex'),
  protocol = 'ratings-discussion-media-v1';
type Pick = Parameters<NonNullable<WxUploadApi['chooseMedia']>>[0];
type Upload = Parameters<NonNullable<WxUploadApi['uploadFile']>>[0];
function harness() {
  const sessions = signedIn(id(50)),
    clock = new FakeClock(),
    resident = new Map<string, Buffer>(),
    pickers: Pick[] = [],
    uploads: Upload[] = [],
    downloads: DownloadCall[] = [];
  const files: UploadFiles = {
    stat: async (path) => resident.get(path)?.length ?? 0,
    image: async (path) => {
      assert.deepEqual(
        resident.get(path)?.subarray(0, 8),
        bytes.subarray(0, 8),
      );
      return { width: 1, height: 1, type: 'png' };
    },
    digest: async (path, _bytes, current) => {
      current();
      return createHash('sha256').update(resident.get(path)!).digest('hex');
    },
    readError: async () => null,
    unlink: async (path) => {
      resident.delete(path);
    },
  };
  const registry = new MediaLocalFiles(files),
    wx: WxUploadApi & WxMediaApi = {
      chooseMedia: (options) => {
        pickers.push(options);
      },
      uploadFile: (options) => {
        uploads.push(options);
        return { abort: () => undefined };
      },
      downloadFile: (options) => {
        const call = new DownloadCall(options);
        downloads.push(call);
        return call;
      },
    };
  const upload = new RatingDiscussionUpload(
      'https://native-discussion.invalid',
      wx,
      files,
      registry,
      sessions,
      clock,
    ),
    download = new RatingDiscussionDownload(
      'https://native-discussion.invalid',
      wx,
      files,
      registry,
      sessions,
      { refresh: async () => sessions.snapshot() },
      clock,
    );
  const ticket = sessions.snapshot(),
    session = {
      current: () => {
        sessions.assertCurrent(ticket);
        return sessions.snapshot();
      },
    };
  const grant = (n: number): DiscussionGrant => ({
    protocol,
    batchId: id(100),
    memberId: id(200 + n),
    intentId: id(300 + n),
    strategy: 'authenticated-multipart-v1',
    generation: '9007199254740993',
    grantId: id(400 + n),
    method: 'POST',
    fieldName: 'file',
    maxBytes: 5242880,
    expectedBytes: bytes.length,
    expectedMime: 'image/png',
    expectedSha256: sha256,
    grantExpiresAt: 100000,
    operationDeadlineAt: 1800000,
    serverNow: 1000,
  });
  return {
    sessions,
    clock,
    resident,
    pickers,
    uploads,
    downloads,
    registry,
    upload,
    download,
    session,
    grant,
  };
}
test('actual chooser/upload adapter streams nine synthetic PNG files on fixed Ratings route without early completion credit release', async () => {
  const h = harness();
  for (let n = 0; n < 9; n++) {
    const cancel = new Cancellation(),
      select = h.upload.pick(h.session, cancel);
    await flush();
    const path = `wxfile://tmp/discussion-${n}.png`;
    h.resident.set(path, bytes);
    h.pickers[n]!.success({
      tempFiles: [
        { tempFilePath: path, size: bytes.length, fileType: 'image' },
      ],
    });
    h.pickers[n]!.complete();
    const file = await select;
    const grant = h.grant(n),
      effect = await h.upload.upload(
        grant,
        file,
        h.session,
        cancel,
        () => undefined,
      ),
      call = h.uploads[n]!;
    assert.equal(call.name, 'file');
    assert.equal(
      call.url,
      `https://native-discussion.invalid/v3/media/ratings-discussion/members/${grant.memberId}/uploads/${grant.grantId}`,
    );
    assert.match(call.header.Authorization!, /^Bearer /);
    call.success({
      statusCode: 200,
      data: JSON.stringify({
        protocol,
        batchId: grant.batchId,
        memberId: grant.memberId,
        status: 'uploadObserved',
        intentId: grant.intentId,
        generation: grant.generation,
        grantId: grant.grantId,
        bytes: bytes.length,
        sha256,
        next: 'finalize',
      }),
    });
    await effect.result;
    assert.equal(h.upload.settled(id(50)), false);
    const otherCredit = h.registry.acquireTransfer();
    assert.throws(() => h.registry.acquireTransfer());
    otherCredit();
    let removed = false;
    const removal = h.upload.remove(file).then(() => {
      removed = true;
    });
    await flush();
    assert.equal(removed, false);
    assert.equal(h.resident.size, 1);
    call.complete();
    await effect.complete;
    await removal;
    assert.equal(h.upload.settled(id(50)), true);
    assert.equal(h.resident.size, 0);
  }
});
test('cancelled chooser invocation rejects late success and cannot adopt bytes for a subsequent generation', async () => {
  const h = harness(),
    cancel = new Cancellation(),
    first = h.upload.pick(h.session, cancel),
    failure = assert.rejects(first);
  await flush();
  cancel.cancel();
  await failure;
  await assert.rejects(() => h.upload.pick(h.session, new Cancellation()));
  const path = 'wxfile://tmp/stale-discussion.png';
  h.resident.set(path, bytes);
  h.pickers[0]!.success({
    tempFiles: [{ tempFilePath: path, size: bytes.length }],
  });
  h.pickers[0]!.complete();
  await flush();
  assert.equal(h.resident.size, 0);
});
test('abort keeps completion debt and bytes until the actual native upload complete event', async () => {
  const h = harness(),
    cancel = new Cancellation(),
    select = h.upload.pick(h.session, cancel);
  await flush();
  const path = 'wxfile://tmp/abort-discussion.png';
  h.resident.set(path, bytes);
  h.pickers[0]!.success({
    tempFiles: [{ tempFilePath: path, size: bytes.length }],
  });
  h.pickers[0]!.complete();
  const file = await select;
  const effect = await h.upload.upload(
      h.grant(0),
      file,
      h.session,
      cancel,
      () => undefined,
    ),
    failure = assert.rejects(effect.result);
  cancel.cancel();
  await failure;
  assert.equal(h.upload.settled(id(50)), false);
  const removal = h.upload.remove(file);
  await flush();
  assert.equal(h.resident.size, 1);
  h.uploads[0]!.complete();
  await removal;
  assert.equal(h.resident.size, 0);
});
test('download includes every current whole-set descriptor field, null reply literal, authentication and shared budget', async () => {
  const h = harness(),
    base = scopedContext(
      { purpose: 'read', selector: { kind: 'global' }, mode: 'public' },
      h.clock.now(),
    );
  const context = decodeRatingDiscussionMediaContext({
    ...base,
    actorId: id(50),
    protocolVersion: 4,
    capabilities: [...base.capabilities, 'discussion_images'],
    discussionMedia: {
      id: id(90),
      generation: id(91),
      sourceDigest: 'a'.repeat(64),
      validUntil: base.expiresAt,
    },
  });
  const descriptor: DiscussionDescriptor = {
      protocol,
      kind: 'ratings-discussion-media' as const,
      targetId: id(1),
      rootId: id(2),
      replyId: null,
      subjectRevision: id(3),
      contextId: context.id,
      contextToken: context.token,
      bindingId: id(4),
      ordinal: 0,
      attachmentSetDigest: 'b'.repeat(64),
      width: 1,
      height: 1,
      variants: ['thumb-v1', 'display-v1'] as const,
    },
    owner = {};
  const result = h.download.download(
    descriptor,
    context,
    'display-v1',
    owner,
    h.session,
    new Cancellation(),
  );
  await flush();
  const call = h.downloads[0]!,
    url = new URL(call.options.url);
  assert.equal(url.pathname, '/v3/media/ratings-discussion/images');
  for (const field of [
    'protocol',
    'targetId',
    'rootId',
    'replyId',
    'subjectRevision',
    'contextId',
    'contextToken',
    'bindingId',
    'ordinal',
    'attachmentSetDigest',
    'variant',
  ])
    assert.ok(url.searchParams.has(field));
  assert.equal(url.searchParams.get('replyId'), 'null');
  assert.equal(Object.keys(call.options.header).length, 1);
  const path = 'wxfile://tmp/download-discussion.png';
  h.resident.set(path, bytes);
  call.headers(imageHeaders(bytes.length));
  call.success(path);
  call.complete();
  const file = await result;
  assert.equal(
    await h.download.resolve(file, owner, h.sessions.snapshot()),
    path,
  );
  await h.download.release(file);
  assert.equal(h.resident.size, 0);
});
