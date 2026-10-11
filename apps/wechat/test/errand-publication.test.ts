import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ErrandPublicationJournal,
  ErrandImageComposer,
  errandPublicationRequestHash,
  canonicalErrandPublication,
} from '../src/errands/publication-runtime';
import { decodeErrandDetail } from '../src/errands/contract';
import {
  MemoryStorage,
  FakeClock,
  ScriptedTransport,
  signedIn,
  response,
} from './helpers';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { createErrandMediaRuntime } from '../src/errands/media-runtime';
import { MediaLocalFiles } from '../src/media/local-files';
import { ReadFiles } from './support/media-read-fixtures';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('Errand v2 journal is account/origin isolated and stores immutable IDs/hashes only', () => {
  const storage = new MemoryStorage(),
    journal = new ErrandPublicationJournal(storage, 'https://errand.invalid');
  const pending = {
    version: 2 as const,
    accountId: id(1),
    draftId: id(2),
    targetRegionId: id(3),
    revision: 1 as const,
    images: [
      {
        slot: 'private0' as const,
        assetId: id(4),
        manifestDigest: 'a'.repeat(64),
      },
    ],
    publication: { requestId: id(5), requestHash: 'b'.repeat(64) },
  };
  journal.write(pending);
  assert.deepEqual(journal.read(id(1)), pending);
  assert.equal(journal.read(id(9)), null);
  assert.equal(
    new ErrandPublicationJournal(storage, 'https://other.invalid').read(id(1)),
    null,
  );
  const value = JSON.stringify(journal.read(id(1)));
  for (const forbidden of [
    'wxfile:',
    'phone',
    'wechat',
    'privateText',
    'Authorization',
    'bytes',
  ])
    assert.equal(value.includes(forbidden), false);
  assert.throws(() => journal.clear({ ...pending, draftId: id(8) }));
  journal.clear(pending);
  assert.equal(journal.read(id(1)), null);
});
test('Errand v2 command hash is canonical and cannot be changed by image order/audience/manifest while original v1 stays separate', () => {
  const value = {
    protocol: 'errand-publication-v2',
    clientRequestId: id(1),
    draftId: id(2),
    draftRevision: 1,
    publicMedia: [
      { slot: 'public0', assetId: id(3), manifestDigest: 'a'.repeat(64) },
    ],
    privateMedia: [],
  };
  assert.equal(
    errandPublicationRequestHash(value),
    errandPublicationRequestHash({ ...value, clientRequestId: id(9) }),
  );
  for (const change of [
    { draftId: id(8) },
    { draftRevision: 2 },
    { publicMedia: [], privateMedia: value.publicMedia },
    {
      publicMedia: [
        { ...value.publicMedia[0], manifestDigest: 'b'.repeat(64) },
      ],
    },
  ])
    assert.notEqual(
      errandPublicationRequestHash(value),
      errandPublicationRequestHash({ ...value, ...change }),
    );
  assert.equal(canonicalErrandPublication({ z: 1, a: 'x' }), '{"a":"x","z":1}');
});
test('Errand native descriptor collections do not accept leaked private images on nonparticipant detail', () => {
  const core = {
    id: id(1),
    revision: id(2),
    title: 'Title',
    publicText: 'Public',
    expectedTimeText: 'Today',
    reward: '1',
    state: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    acceptedAt: null,
    completedAt: null,
    cancelledAt: null,
    targetRegion: { id: id(3), label: 'Target' },
    sourceRegion: { id: id(3), label: 'Source' },
    scope: 'home',
    relation: 'none',
    capabilities: {
      accept: true,
      cancel: false,
      complete: false,
      delete: false,
    },
    mediaRevision: 1,
    publicMedia: [],
  };
  assert.equal(decodeErrandDetail(core).privateMedia, undefined);
  assert.throws(() => decodeErrandDetail({ ...core, privateMedia: [] }));
  const descriptor = {
    protocol: 'errand-media-v1',
    kind: 'errand-media',
    orderId: id(1),
    slot: 'private0',
    revision: 1,
    bindingId: id(4),
    width: 10,
    height: 10,
    variants: ['thumb-v1', 'display-v1'],
  };
  assert.throws(() =>
    decodeErrandDetail({ ...core, publicMedia: [descriptor] }),
  );
  assert.throws(() =>
    decodeErrandDetail({ ...core, privateMedia: [descriptor] }),
  );
  const related = decodeErrandDetail({
    ...core,
    relation: 'publisher',
    privateText: 'Private',
    privateMedia: [descriptor],
    capabilities: {
      accept: false,
      cancel: true,
      complete: false,
      delete: true,
    },
  });
  assert.equal(related.privateMedia?.length, 1);
});

test('Uncertain draft creation and corrupt recovery cannot silently fall back to a new v1 publication', async () => {
  const storage = new MemoryStorage(),
    sessions = signedIn(id(1)),
    transport = new ScriptedTransport(),
    clock = new FakeClock(),
    api = new ApiClient('https://errand.invalid', transport, sessions, {
      refresh: async () => sessions.snapshot(),
    }),
    files = Object.assign(new ReadFiles(), {
      digest: async () => 'a'.repeat(64),
    }),
    media = createErrandMediaRuntime({
      api,
      sessions,
      storage,
      origin: 'https://errand.invalid',
      clock,
      files,
      registry: new MediaLocalFiles(files),
      auth: { refresh: async () => sessions.snapshot() },
      newRequestId: async () => id(4),
      wx: {
        chooseMedia: () => assert.fail('Unconfirmed draft cannot pick a file'),
      },
    }),
    journal = new ErrandPublicationJournal(storage, 'https://errand.invalid'),
    composer = new ErrandImageComposer(
      api,
      sessions,
      media,
      journal,
      async () => id(2),
      () => {},
    );
  transport.steps.push(async () => {
    throw new ClientError('network', 'Synthetic lost draft result');
  });
  await composer.choose('public0', id(3));
  assert.equal(composer.hasDraft, true);
  assert.equal(journal.read(id(1))?.draftId, id(2));
  assert.equal(transport.requests.length, 1);
  composer.dispose();
  const key = [...storage.data.keys()].find((v) =>
    v.startsWith('whaleu.errand-publication.v2.'),
  )!;
  storage.data.set(key, { version: 2 });
  const recovered = new ErrandImageComposer(
    api,
    sessions,
    media,
    journal,
    async () => assert.fail('Corrupt original must not rekey'),
    () => {},
  );
  assert.equal(recovered.hasDraft, true);
  assert.equal(recovered.frozen, true);
  recovered.dispose();
  media.hide();
});

test('Twenty unrecorded quota uploads settle every original Media key before freeing the parent draft capacity', async () => {
  const storage = new MemoryStorage(),
    sessions = signedIn(id(1)),
    transport = new ScriptedTransport(),
    clock = new FakeClock(),
    api = new ApiClient('https://errand.invalid', transport, sessions, {
      refresh: async () => sessions.snapshot(),
    }),
    files = Object.assign(new ReadFiles(), {
      digest: async () => 'a'.repeat(64),
    });
  let keys = 100,
    picks = 0;
  const media = createErrandMediaRuntime({
      api,
      sessions,
      storage,
      origin: 'https://errand.invalid',
      clock,
      files,
      registry: new MediaLocalFiles(files),
      auth: { refresh: async () => sessions.snapshot() },
      newRequestId: async () => id(keys++),
      wx: {
        chooseMedia(o) {
          const path = `wxfile://tmp/quota-${picks++}`;
          files.put(path);
          o.success({
            tempFiles: [{ tempFilePath: path, size: 100, fileType: 'image' }],
          });
          o.complete();
        },
      },
    }),
    journal = new ErrandPublicationJournal(storage, 'https://errand.invalid'),
    composer = new ErrandImageComposer(
      api,
      sessions,
      media,
      journal,
      async () => id(keys++),
      () => {},
    );
  for (let n = 0; n < 20; n++) {
    const draftId = id(keys);
    transport.reply({
      protocol: 'errand-publication-v2',
      draftId,
      targetRegionId: id(3),
      revision: 1,
      state: 'open',
      expiresAt: 2000,
    });
    transport.reply(
      {
        error: {
          code: 'MEDIA_RATE_LIMITED',
          message: 'Synthetic quota refusal',
        },
      },
      429,
      { 'retry-after': '1' },
    );
    await composer.choose('public0', id(3));
    assert.equal(media.pendingTargets(draftId).length, 1);
    assert.equal(composer.hasDraft, true);
    if (n === 10) {
      transport.reply({
        protocol: 'errand-publication-v2',
        draftId,
        targetRegionId: id(3),
        revision: 1,
        state: 'cancelled',
        expiresAt: 2000,
      });
      transport.steps.push(async (req) =>
        response({
          protocol: 'errand-media-v1',
          requestId: req.url.split('/').slice(-1)[0],
          serverNow: 1000,
          state: 'not_recorded',
          requestHash: null,
        }),
      );
      transport.reply(
        {
          error: {
            code: 'MEDIA_RATE_LIMITED',
            message: 'Synthetic cleanup quota',
          },
        },
        429,
        { 'retry-after': '1' },
      );
      await composer.cancelDraft();
      assert.equal(
        composer.hasDraft,
        true,
        'Rate-limited upload tombstone must keep its owner recovery entry',
      );
      assert.equal(journal.read(id(1))?.draftId, draftId);
      assert.equal(media.pendingTargets(draftId).length, 1);
    }
    transport.reply({
      protocol: 'errand-publication-v2',
      draftId,
      targetRegionId: id(3),
      revision: 1,
      state: 'cancelled',
      expiresAt: 2000,
    });
    transport.steps.push(async (req) =>
      response({
        protocol: 'errand-media-v1',
        requestId: req.url.split('/').slice(-1)[0],
        serverNow: 1000,
        state: 'not_recorded',
        requestHash: null,
      }),
    );
    transport.steps.push(async (req) => {
      assert.ok(
        req.body && typeof req.body === 'object' && !Array.isArray(req.body),
      );
      return response({
        protocol: 'errand-media-v1',
        requestId: req.url.split('/').slice(-2)[0],
        serverNow: 1000,
        state: 'cancelled_before_prepare',
        requestHash: req.body['requestHash'],
        reason: 'cancelled',
      });
    });
    await composer.cancelDraft();
    assert.equal(composer.hasDraft, false);
    assert.equal(journal.read(id(1)), null);
    assert.deepEqual(media.pendingTargets(), []);
  }
  assert.equal(picks, 20);
  assert.equal(transport.steps.length, 0);
  assert.equal(
    transport.requests.filter(
      (x) => x.url.endsWith('/cancel') && x.url.includes('/upload-requests/'),
    ).length,
    21,
  );
  composer.dispose();
  media.hide();
});
