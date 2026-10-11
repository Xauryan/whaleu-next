import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import {
  publishErrandV2Schema,
  errandPublicationHash,
} from '../src/errands/publication-contracts.js';
import {
  canonicalErrandEnvelope,
  errandApprovalDigest,
} from '../src/community/content-review/errand-contracts.js';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import { errandDetailSchema } from '../src/errands/contracts.js';
const id = randomUUID;
const scope = {
  targetRegionId: id(),
  sourceRegionId: id(),
  identityCampusId: id(),
  identitySelectionId: id(),
  topologySnapshotId: id(),
  affiliationAssertionId: id(),
  affiliationSnapshotId: id(),
};
const base = {
  protocol: 'errand-publication-v2',
  clientRequestId: id(),
  draftId: id(),
  draftRevision: 1,
  targetRegionId: scope.targetRegionId,
  title: 'Title',
  publicText: 'Public',
  privateText: 'Private',
  expectedTimeText: 'Today',
  reward: '1.1200',
  publisherContacts: { wechat: 'fixture', phone: '12345678901' },
};
const image = (slot: string) => ({
  slot,
  assetId: id(),
  manifestDigest: 'a'.repeat(64),
});
test('Publication v2 has independently bounded ordered public/private slots and cannot reclassify one asset', () => {
  for (const count of [0, 1, 3]) {
    const v = publishErrandV2Schema.parse({
      ...base,
      publicMedia: Array.from({ length: count }, (_, i) => image(`public${i}`)),
      privateMedia: Array.from({ length: count }, (_, i) =>
        image(`private${i}`),
      ),
    });
    assert.equal(v.publicMedia.length, count);
    assert.equal(v.privateMedia.length, count);
    assert.equal(v.reward, '1.12');
  }
  const p = image('public0');
  for (const bad of [
    { publicMedia: [p], privateMedia: [{ ...p, slot: 'private0' }] },
    { publicMedia: [image('private0')], privateMedia: [] },
    { publicMedia: [image('public1'), image('public0')], privateMedia: [] },
    { publicMedia: [p, p], privateMedia: [] },
  ])
    assert.equal(
      publishErrandV2Schema.safeParse({ ...base, ...bad }).success,
      false,
    );
  assert.equal(
    publishErrandV2Schema.safeParse({
      ...base,
      publicMedia: [image('public2')],
      privateMedia: [],
    }).success,
    true,
    'Removing another slot never relabels the survivor',
  );
});
test('Review v1 namespace remains byte-identical; v2 fixes every actual immutable image fact and scope', () => {
  const v1 = canonicalErrandEnvelope({
    version: 1,
    accountId: id(),
    purpose: 'publish_errand',
    title: 'Title',
    publicText: 'Public',
    privateText: 'Private',
    expectedTimeText: 'Today',
    reward: '1.12',
    publisherContacts: base.publisherContacts,
    scope,
    publicAssetIds: [],
    privateAssetIds: [],
  });
  assert.equal(
    errandApprovalDigest(v1),
    createHash('sha256')
      .update('whaleu-errand-content-approval:v1\n' + canonicalJson(v1))
      .digest('hex'),
  );
  const {
    publicAssetIds: _p,
    privateAssetIds: _v,
    ...core
  } = v1.version === 1 ? v1 : assert.fail('Expected v1');
  void _p;
  void _v;
  const v2 = canonicalErrandEnvelope({
    ...core,
    version: 2,
    draftId: base.draftId,
    draftRevision: 1,
    mediaRevision: 1,
    publicMedia: [image('public0')],
    privateMedia: [image('private0')],
  });
  if (v2.version !== 2) assert.fail('Expected v2');
  for (const patch of [
    { mediaRevision: 2 },
    { draftId: id() },
    { draftRevision: 2 },
    { privateMedia: [] },
    { publicMedia: [{ ...v2.publicMedia[0], manifestDigest: 'b'.repeat(64) }] },
  ])
    assert.notEqual(
      errandApprovalDigest(v2),
      errandApprovalDigest(canonicalErrandEnvelope({ ...v2, ...patch })),
    );
  assert.ok(Object.isFrozen(v2.publicMedia[0]));
  assert.ok(Object.isFrozen(v2.privateMedia));
  const command = publishErrandV2Schema.parse({
    ...base,
    publicMedia: v2.publicMedia,
    privateMedia: v2.privateMedia,
  });
  const { clientRequestId: _id, ...intent } = command;
  void _id;
  assert.equal(
    errandPublicationHash(command),
    createHash('sha256')
      .update(
        'whaleu:errand-command:v2\n' +
          canonicalJson({ operation: 'publish', intent }),
      )
      .digest('hex'),
  );
});
test('Current descriptor output omits all private image metadata for nonparticipants', () => {
  const orderId = id(),
    value = {
      id: orderId,
      revision: id(),
      title: 'Title',
      publicText: 'Public',
      expectedTimeText: 'Today',
      reward: '1',
      state: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      acceptedAt: null,
      completedAt: null,
      cancelledAt: null,
      targetRegion: { id: id(), label: 'Target' },
      sourceRegion: { id: id(), label: 'Source' },
      scope: 'foreign',
      mediaRevision: 1,
      publicMedia: [],
      relation: 'none',
      capabilities: {
        accept: true,
        cancel: false,
        complete: false,
        delete: false,
      },
    };
  assert.equal(errandDetailSchema.safeParse(value).success, true);
  assert.equal(
    errandDetailSchema.safeParse({ ...value, privateMedia: [] }).success,
    false,
  );
  assert.equal(
    errandDetailSchema.safeParse({
      ...value,
      publicMedia: [
        {
          protocol: 'errand-media-v1',
          kind: 'errand-media',
          orderId,
          revision: 1,
          slot: 'private0',
          bindingId: id(),
          width: 10,
          height: 10,
          variants: ['thumb-v1', 'display-v1'],
        },
      ],
    }).success,
    false,
  );
});
