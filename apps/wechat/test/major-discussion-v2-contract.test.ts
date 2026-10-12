import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import {
  decodeDiscussionIntent,
  decodeDiscussionItem,
} from '../src/major-discussion/contract';
import {
  MAJOR_DISCUSSION_V2 as protocol,
  computeDiscussionV2IntentHash,
  decodeDiscussionV2CancelTarget,
  decodeDiscussionV2Intent,
  decodeDiscussionV2Item,
  decodeDiscussionV2Notice,
  decodeDiscussionV2Notices,
  decodeDiscussionV2Page,
  decodeDiscussionV2Receipt,
  discussionV2CancelTarget,
  matchDiscussionV2Receipt,
  type DiscussionV2Intent,
  type DiscussionV2Item,
  type DiscussionV2Page,
  type DiscussionV2Receipt,
} from '../src/major-discussion/v2-contract';
import { HttpMajorDiscussionV2Gateway } from '../src/major-discussion/v2-gateway';
import {
  PendingMajorDiscussionV2Store,
  type PendingMajorDiscussionV2,
} from '../src/major-discussion/v2-pending';
import { MemoryStorage, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const majorId = uuid(1),
  rootId = uuid(2),
  requestId = uuid(3),
  accountId = uuid(4),
  replyId = uuid(5);
const digest = 'a'.repeat(64),
  recordedAt = '2026-10-01T00:00:00.000Z';
const image = (n = 6) => ({ assetId: uuid(n), manifestDigest: digest });
const reference = (ordinal = 0, commentId = rootId) => ({
  majorId,
  commentId,
  bindingId: uuid(10 + ordinal),
  ordinal,
});
const source = {
  clientRequestId: requestId,
  expectedCatalogRevision: uuid(20),
  expectedMajorRevision: uuid(21),
};
const intent = (
  body = ' Major text ',
  images = [image()],
): DiscussionV2Intent => ({
  operation: 'major.discussion.root.v2',
  majorId,
  command: { ...source, protocol, body, images },
});
const reply = (): DiscussionV2Intent => ({
  operation: 'major.discussion.reply.v2',
  majorId,
  rootId,
  command: {
    ...source,
    protocol,
    body: 'Reply text',
    images: [image()],
    replyToReplyId: null,
  },
});
const author = {
  mode: 'named' as const,
  profileId: uuid(22),
  displayName: '合成用户',
};
const item = (patch: Partial<DiscussionV2Item> = {}): DiscussionV2Item => ({
  protocol,
  id: rootId,
  majorId,
  rootId: null,
  replyToReplyId: null,
  body: 'Root text',
  author,
  addressedAuthor: null,
  createdAt: recordedAt,
  likes: 0,
  replyCount: 0,
  isLiked: false,
  myMembershipRevision: null,
  images: [reference()],
  ...patch,
});
const page = (patch: Partial<DiscussionV2Page> = {}): DiscussionV2Page => ({
  protocol,
  majorId,
  catalogRevision: source.expectedCatalogRevision,
  majorRevision: source.expectedMajorRevision,
  discussionRevision: '1',
  root: null,
  items: [item()],
  totalCount: 1,
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
const receipt = (
  i: DiscussionV2Intent = intent(),
  rejected = false,
): DiscussionV2Receipt =>
  ({
    requestId: i.command.clientRequestId,
    majorId: i.majorId,
    operation: i.operation,
    ...(i.operation === 'major.discussion.reply.v2'
      ? { rootId: i.rootId }
      : {}),
    ...(rejected
      ? { outcome: 'rejected', code: 'MAJOR_DISCUSSION_CANCELLED' }
      : {
          outcome: 'applied',
          commentId:
            i.operation === 'major.discussion.reply.v2' ? replyId : rootId,
          createdAt: recordedAt,
        }),
  }) as DiscussionV2Receipt;
const notice = () => ({
  noticeId: requestId,
  createdAt: recordedAt,
  readAt: null,
  status: 'available',
  kind: 'reply',
  preview: { text: 'Reply text', author, thumbnail: reference(0, replyId) },
  target: { majorId, rootId, commentId: replyId },
});
const pending = (): PendingMajorDiscussionV2 => ({
  version: 2,
  accountId,
  origin: 'https://discussion.example',
  target: discussionV2CancelTarget(intent()),
  phase: 'draft',
  intentHash: null,
  uploadRecoveryKeys: [],
});

test('v2 strictly separates publication namespaces and preserves exact text and ordered image facts', () => {
  assert.deepEqual(decodeDiscussionV2Intent(intent()), intent());
  assert.deepEqual(decodeDiscussionV2Intent(reply()), reply());
  const text = ' A\n😀 ';
  assert.equal(decodeDiscussionV2Intent(intent(text, [])).command.body, text);
  assert.equal(
    decodeDiscussionV2Intent(intent('😀'.repeat(2000), [])).command.body.length,
    4000,
  );
  const three = intent('0', [image(6), image(7), image(8)]);
  assert.deepEqual(
    decodeDiscussionV2Intent(three).command.images,
    three.command.images,
  );
  for (const value of [
    intent('', []),
    intent('', [image()]),
    intent(' ', [image()]),
    intent('', Array(1)),
    intent(' \n'),
    intent('\ud800'),
    intent('a\0b'),
    intent('😀'.repeat(2001)),
    intent('', [image(), image()]),
    intent('', [image(6), image(7), image(8), image(9)]),
    { ...intent(), operation: 'major.discussion.root.v1' },
    { ...intent(), command: { ...intent().command, protocol: 'ratings-v2' } },
    { ...intent(), command: { ...intent().command, imageUrls: [] } },
    {
      ...intent(),
      command: {
        ...intent().command,
        images: [{ ...image(), url: 'https://forbidden.example' }],
      },
    },
    { ...reply(), command: { ...intent().command } },
  ])
    assert.throws(() => decodeDiscussionV2Intent(value));
  assert.throws(() => decodeDiscussionIntent(intent()));
  assert.throws(() =>
    decodeDiscussionIntent({
      operation: 'major.discussion.root.v1',
      majorId,
      command: { ...source, body: '' },
    }),
  );
});

test('v2 hash matches independent API canonical encoding and binds actor, body, target and image order', () => {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    const object = v as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  };
  const i = intent(' A\n😀 ', [image(6), image(7)]);
  const expected = createHash('sha256')
    .update(
      'whaleu:major-discussion-command:v2\n' +
        canonical({
          actorId: accountId,
          majorId,
          subjectId: null,
          operation: i.operation,
          command: i.command,
        }),
    )
    .digest('hex');
  assert.equal(computeDiscussionV2IntentHash(accountId, i), expected);
  assert.notEqual(computeDiscussionV2IntentHash(uuid(99), i), expected);
  assert.notEqual(
    computeDiscussionV2IntentHash(
      accountId,
      intent('A\n😀', [image(6), image(7)]),
    ),
    expected,
  );
  assert.notEqual(
    computeDiscussionV2IntentHash(
      accountId,
      intent(' A\n😀 ', [image(7), image(6)]),
    ),
    expected,
  );
  assert.notEqual(
    computeDiscussionV2IntentHash(accountId, { ...i, majorId: uuid(99) }),
    expected,
  );
});

test('v2 read projection requires nonblank text even with images and rejects leaked descriptors and cross-parent bindings', () => {
  assert.deepEqual(decodeDiscussionV2Page(page()), page());
  assert.equal(
    decodeDiscussionV2Item(item({ body: 'text', images: [] })).body,
    'text',
  );
  for (const value of [
    item({ body: '' }),
    item({ images: Array(1) }),
    item({ body: ' \n' }),
    { ...item(), protocol: undefined },
    { ...item(), credential: 'private' },
    item({ images: [{ ...reference(), majorId: uuid(99) }] }),
    item({ images: [{ ...reference(), commentId: uuid(99) }] }),
    item({ images: [reference(1)] }),
    item({
      images: [
        reference(),
        { ...reference(1), bindingId: reference().bindingId },
      ],
    }),
    item({
      images: [{ ...reference(), url: 'https://forbidden.example' } as never],
    }),
    item({ images: [reference(0), reference(1), reference(2), reference(3)] }),
    item({ author: { ...author, accountId } as never }),
  ])
    assert.throws(() => decodeDiscussionV2Item(value));
  assert.throws(() => decodeDiscussionItem(item()));
  for (const value of [
    page({ items: [item(), item()] }),
    page({ items: [item({ majorId: uuid(99), images: [], body: 'x' })] }),
    page({ root: item(), items: [item()] }),
    { ...page(), cursorSecret: 'leak' },
  ])
    assert.throws(() => decodeDiscussionV2Page(value));
});

test('v2 notices are metadata-only, like thumbnails are null, and unavailable notices expose no target', () => {
  assert.deepEqual(decodeDiscussionV2Notice(notice()), notice());
  const rootAuthor = {
    ...notice(),
    target: { majorId, rootId, commentId: rootId },
  };
  assert.deepEqual(decodeDiscussionV2Notice(rootAuthor), rootAuthor);
  const like = {
    ...notice(),
    kind: 'like',
    preview: { ...notice().preview, thumbnail: null },
  };
  assert.deepEqual(decodeDiscussionV2Notice(like), like);
  const hidden = {
    noticeId: requestId,
    createdAt: recordedAt,
    readAt: null,
    status: 'unavailable',
  };
  assert.deepEqual(decodeDiscussionV2Notice(hidden), hidden);
  assert.deepEqual(
    decodeDiscussionV2Notices({
      protocol,
      items: [notice()],
      nextCursor: null,
      unreadCount: 1,
    }).items,
    [notice()],
  );
  for (const value of [
    { ...notice(), kind: 'like' },
    { ...notice(), status: 'unavailable' },
    { ...notice(), preview: { text: '', author } },
    {
      ...notice(),
      preview: {
        ...notice().preview,
        thumbnail: { ...reference(0, replyId), commentId: rootId },
      },
    },
    {
      ...notice(),
      preview: {
        ...notice().preview,
        thumbnail: { ...reference(0, replyId), width: 512 },
      },
    },
  ])
    assert.throws(() => decodeDiscussionV2Notice(value));
  assert.throws(() =>
    decodeDiscussionV2Notices({ items: [], nextCursor: null, unreadCount: 0 }),
  );
});

test('v2 receipts and durable cancellation metadata match exact operation, request and root', () => {
  assert.deepEqual(decodeDiscussionV2Receipt(receipt()), receipt());
  assert.doesNotThrow(() => matchDiscussionV2Receipt(intent(), receipt()));
  assert.doesNotThrow(() =>
    matchDiscussionV2Receipt(
      discussionV2CancelTarget(reply()),
      receipt(reply(), true),
    ),
  );
  for (const value of [
    { ...receipt(), operation: 'major.discussion.root.v1' },
    { ...receipt(), body: 'leak' },
    {
      ...receipt(intent(), true),
      code: 'MAJOR_DISCUSSION_MEMBERSHIP_CONFLICT',
    },
  ])
    assert.throws(() => decodeDiscussionV2Receipt(value));
  assert.throws(() =>
    matchDiscussionV2Receipt(reply(), {
      ...receipt(reply()),
      rootId: uuid(99),
    } as never),
  );
  assert.throws(() =>
    matchDiscussionV2Receipt(intent(), { ...receipt(), requestId: uuid(99) }),
  );
  assert.throws(() =>
    decodeDiscussionV2CancelTarget({
      ...discussionV2CancelTarget(intent()),
      body: 'leak',
    }),
  );
});

test('v2 journal stores only context and stable hashes, with readback verified phase transitions', () => {
  const storage = new MemoryStorage(),
    store = new PendingMajorDiscussionV2Store(storage, pending().origin);
  const first = store.freeze(pending());
  assert.throws(() =>
    store.freeze({ ...pending(), target: discussionV2CancelTarget(reply()) }),
  );
  const key = { requestId: uuid(50), requestHash: digest };
  const withUpload = store.appendUpload(first, key);
  assert.deepEqual(store.load(accountId)?.uploadRecoveryKeys, [key]);
  assert.throws(() =>
    store.appendUpload(first, { requestId: uuid(51), requestHash: digest }),
  );
  assert.throws(() => store.appendUpload(withUpload, key));
  const submitted = store.beginSubmission(
    withUpload,
    computeDiscussionV2IntentHash(accountId, intent()),
  );
  assert.throws(() =>
    store.appendUpload(submitted, { requestId: uuid(51), requestHash: digest }),
  );
  assert.throws(() => store.beginSubmission(submitted, digest));
  const cancelled = store.beginCancellation(submitted);
  assert.equal(store.load(accountId)?.phase, 'cancel');
  assert.equal(store.load(accountId)?.intentHash, submitted.intentHash);
  assert.equal(
    new PendingMajorDiscussionV2Store(storage, 'https://other.example').load(
      accountId,
    ),
    null,
  );
  assert.equal(store.load(uuid(99)), null);
  const encoded = JSON.stringify([...storage.data.values()]);
  for (const forbidden of [
    '"body"',
    '"images"',
    '"assetId"',
    '"declaration"',
    '"path"',
    '"accessToken"',
    '"descriptor"',
  ])
    assert.equal(encoded.includes(forbidden), false);
  storage.failRemove = true;
  assert.throws(() => store.settle(cancelled, receipt(intent(), true)));
  assert.deepEqual(store.load(accountId), cancelled);
  storage.failRemove = false;
  store.settle(cancelled, receipt(intent(), true));
  assert.equal(store.load(accountId), null);
});

test('v2 journal rejects corruption, missing writes, unexpected fields and removal acknowledgements without removal', () => {
  const storage = new MemoryStorage(),
    store = new PendingMajorDiscussionV2Store(storage, pending().origin);
  const key = `whaleu.major-discussion.pending.v2:${pending().origin}:${accountId}`;
  storage.data.set('whaleu.major-discussion.pending.v1:legacy', { old: true });
  for (const raw of [
    { ...pending(), body: 'leak' },
    { ...pending(), intent: intent() },
    { ...pending(), target: { ...pending().target, images: [image()] } },
    { ...pending(), phase: 'submit' },
    { ...pending(), uploadRecoveryKeys: Array(1) },
    { ...pending(), intentHash: digest },
    {
      ...pending(),
      uploadRecoveryKeys: [
        { requestId: uuid(50), requestHash: digest, path: '/tmp/private' },
      ],
    },
    { ...pending(), uploadRecoveryKeys: [{ requestId, requestHash: digest }] },
    {
      ...pending(),
      uploadRecoveryKeys: [50, 51, 52, 53].map((n) => ({
        requestId: uuid(n),
        requestHash: digest,
      })),
    },
  ]) {
    storage.data.set(key, raw);
    assert.throws(() => store.load(accountId));
  }
  storage.data.delete(key);
  const noWrite = {
    get: storage.get.bind(storage),
    set: () => {},
    remove: storage.remove.bind(storage),
  };
  assert.throws(() =>
    new PendingMajorDiscussionV2Store(noWrite, pending().origin).freeze(
      pending(),
    ),
  );
  const frozen = store.freeze(pending());
  const noRemove = {
    get: storage.get.bind(storage),
    set: storage.set.bind(storage),
    remove: () => {},
  };
  assert.throws(() =>
    new PendingMajorDiscussionV2Store(noRemove, pending().origin).settle(
      frozen,
      receipt(intent(), true),
    ),
  );
  assert.deepEqual(store.load(accountId), frozen);
  assert.deepEqual(
    storage.data.get('whaleu.major-discussion.pending.v1:legacy'),
    { old: true },
  );
});

function gatewaySetup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpMajorDiscussionV2Gateway(
    new ApiClient('https://discussion.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  return { gateway, transport };
}
test('real v2 gateway uses owner endpoints, ordered publish facts, exact cancellation metadata and authorized reads', async () => {
  const { gateway, transport } = gatewaySetup(),
    cancel = new Cancellation();
  transport.reply(page());
  await gateway.list(majorId, null, 'likes', null, cancel);
  transport.reply(page({ root: item(), items: [], totalCount: 0 }));
  await gateway.list(majorId, rootId, 'time', null, cancel);
  transport.reply(receipt());
  await gateway.submit(intent(), cancel);
  transport.reply(receipt(reply()));
  await gateway.submit(reply(), cancel);
  transport.reply(receipt());
  await gateway.receipt(requestId, cancel);
  transport.reply(receipt(intent(), true));
  await gateway.cancel(discussionV2CancelTarget(intent()), cancel);
  transport.reply(receipt(reply(), true));
  await gateway.cancel(discussionV2CancelTarget(reply()), cancel, digest);
  transport.reply({
    protocol,
    items: [notice()],
    nextCursor: null,
    unreadCount: 1,
  });
  await gateway.notices(null, cancel);
  transport.reply(notice().target);
  await gateway.target(requestId, cancel);
  transport.reply({ noticeId: requestId, readAt: recordedAt });
  await gateway.read(requestId, cancel);
  assert.deepEqual(
    transport.requests.map((request) => new URL(request.url).pathname),
    [
      `/v2/majors/${majorId}/discussion`,
      `/v2/majors/${majorId}/discussion/${rootId}`,
      `/v2/majors/${majorId}/discussion`,
      `/v2/majors/${majorId}/discussion/${rootId}/replies`,
      `/v2/majors/discussion-requests/${requestId}`,
      `/v2/majors/discussion-requests/${requestId}/cancel`,
      `/v2/majors/discussion-requests/${requestId}/cancel`,
      '/v2/me/major-discussion/notices',
      `/v2/me/major-discussion/notices/${requestId}/target`,
      `/v2/me/major-discussion/notices/${requestId}/read`,
    ],
  );
  assert.deepEqual(transport.requests[2]!.body, intent().command);
  assert.deepEqual(transport.requests[5]!.body, {
    protocol,
    operation: intent().operation,
    majorId,
    intentHash: null,
  });
  assert.deepEqual(transport.requests[6]!.body, {
    protocol,
    operation: reply().operation,
    majorId,
    rootId,
    intentHash: digest,
  });
  assert.equal(
    new URL(transport.requests[1]!.url).searchParams.has('sort'),
    false,
  );
  assert.equal(transport.requests[9]!.method, 'PUT');
  for (const request of transport.requests)
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
});

test('v2 gateway rejects wrong target, changed receipt, repeated cursor, invalid ordering and invalid input', async () => {
  const { gateway, transport } = gatewaySetup(),
    cancel = new Cancellation();
  await assert.rejects(gateway.list('bad', null, 'likes', null, cancel));
  await assert.rejects(gateway.list(majorId, null, 'likes', null, cancel, 51));
  await assert.rejects(
    gateway.cancel(discussionV2CancelTarget(intent()), cancel, 'bad'),
  );
  assert.equal(transport.requests.length, 0);
  transport.reply(page({ nextCursor: 'cursor', continuation: 'more' }));
  await assert.rejects(gateway.list(majorId, null, 'time', 'cursor', cancel));
  transport.reply(
    page({
      items: [item(), item({ id: replyId, body: 'x', images: [], likes: 1 })],
      totalCount: 2,
    }),
  );
  await assert.rejects(gateway.list(majorId, null, 'likes', null, cancel));
  transport.reply({ ...receipt(), requestId: uuid(99) });
  await assert.rejects(gateway.receipt(requestId, cancel));
  transport.reply(receipt(reply()));
  await assert.rejects(gateway.submit(intent(), cancel));
  transport.reply({ noticeId: uuid(99), readAt: recordedAt });
  await assert.rejects(gateway.read(requestId, cancel));
  transport.reply(receipt(), 201);
  await assert.rejects(gateway.submit(intent(), cancel));
});

test('new v2 admission fails closed beside legacy journals and corrupt optional caches without rewriting any bytes', () => {
  const storage = new MemoryStorage(),
    store = new PendingMajorDiscussionV2Store(storage, pending().origin);
  const legacy = {
    version: 1,
    accountId,
    origin: pending().origin,
    phase: 'submit',
    intent: {
      operation: 'major.discussion.root.v1',
      majorId,
      command: { ...source, body: ' Exact legacy bytes 😀 ' },
    },
  };
  const legacyKey = `whaleu.major-discussion.pending.v1:${pending().origin}:${accountId}`;
  storage.data.set(legacyKey, legacy);
  assert.deepEqual(store.legacy.loadForRecovery(accountId), legacy);
  assert.throws(() => store.freeze(pending()));
  assert.deepEqual(storage.data.get(legacyKey), legacy);
  storage.data.delete(legacyKey);
  for (const key of [
    `whaleu.major-discussion-delete.pending.v1:${pending().origin}:${accountId}`,
    `whaleu.major-discussion.own-deletion-locators.v1:${pending().origin}:${accountId}`,
    `${legacyKey}:references`,
  ]) {
    const corrupt = [{ broken: 'preserve these bytes' }];
    storage.data.set(key, corrupt);
    assert.throws(() => store.assertAdmission(accountId));
    assert.throws(() => store.freeze(pending()));
    assert.deepEqual(storage.data.get(key), corrupt);
    assert.equal(store.load(accountId), null);
    storage.data.delete(key);
  }
});

test('v2 original receipt preserves bad optional locator bytes and remains independently recoverable', () => {
  const storage = new MemoryStorage(),
    store = new PendingMajorDiscussionV2Store(storage, pending().origin);
  const original = store.beginSubmission(store.freeze(pending()), digest);
  const key = `whaleu.major-discussion.own-deletion-locators.v1:${pending().origin}:${accountId}`;
  const corrupt = [{ body: 'corrupt forbidden field' }];
  storage.data.set(key, corrupt);
  assert.deepEqual(store.settle(original, receipt()), receipt());
  assert.equal(store.load(accountId), null);
  assert.deepEqual(storage.data.get(key), corrupt);
  assert.equal(store.legacy.deletionLocatorState(accountId).unavailable, true);
  assert.throws(() => store.freeze(pending()));
});

test('cold v2 receipt creates a bounded same-owner locator compatible with the existing v1 deletion store', () => {
  const storage = new MemoryStorage(),
    origin = pending().origin;
  const original = new PendingMajorDiscussionV2Store(storage, origin);
  const frozen = original.beginSubmission(original.freeze(pending()), digest);
  const cold = new PendingMajorDiscussionV2Store(storage, origin);
  assert.deepEqual(cold.load(accountId), frozen);
  cold.settle(cold.load(accountId)!, receipt());
  const later = new PendingMajorDiscussionV2Store(storage, origin);
  assert.deepEqual(later.legacy.deletionLocators(accountId), [
    { majorId, commentId: rootId, rootId: null },
  ]);
  assert.deepEqual(later.legacy.deletionLocators(uuid(99)), []);
  assert.deepEqual(
    new PendingMajorDiscussionV2Store(
      storage,
      'https://other.example',
    ).legacy.deletionLocators(accountId),
    [],
  );
});
