import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  ACTIVITY_MEDIA_PROTOCOL,
  prepareActivityMediaSchema,
  activityMediaRequestHash,
  activityDescriptorSchema,
} from '../src/media/contracts-activity.js';
import { prepareCategoryIconMediaSchema } from '../src/media/contracts-category-icon.js';
import { prepareOrganizationMediaSchema } from '../src/media/contracts-organization.js';
import {
  activityMediaBindingsSchema,
  activityMediaChangesSchema,
} from '../src/activities/media/contracts.js';
import { prepareProfileMediaSchema } from '../src/media/contracts-profile.js';
const require = createRequire(import.meta.url);
const native = require('../../wechat/src/activities/media-contract.ts');
test('Activity image protocol is closed and request hash includes original actor activity slot revision and declaration', () => {
  const actor = randomUUID(),
    input = {
      protocol: ACTIVITY_MEDIA_PROTOCOL,
      clientRequestId: randomUUID(),
      activityId: randomUUID(),
      slot: 'cover',
      revision: 1,
      declaration: { mime: 'image/png', bytes: 20, sha256: 'a'.repeat(64) },
    };
  assert.deepEqual(prepareActivityMediaSchema.parse(input), input);
  assert.equal(
    activityMediaRequestHash(actor, input),
    native.activityMediaPrepareHash(actor, input),
  );
  for (const patch of [
    { activityId: randomUUID() },
    { slot: 'gallery0' },
    { revision: 2 },
    { clientRequestId: randomUUID() },
  ])
    assert.notEqual(
      activityMediaRequestHash(actor, { ...input, ...patch }),
      activityMediaRequestHash(actor, input),
    );
  assert.notEqual(
    activityMediaRequestHash(randomUUID(), input),
    activityMediaRequestHash(actor, input),
  );
  for (const patch of [
    { protocol: 'profile-media-v1' },
    { ownerKind: 'community' },
    { resourceId: randomUUID() },
    { slot: 'foreign' },
    { approved: true },
    { url: 'https://example.invalid/qr' },
    { slot: 'any' },
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.throws(() =>
      prepareActivityMediaSchema.parse({ ...input, ...patch }),
    );
    assert.throws(() =>
      native.decodeActivityMediaPrepare({ ...input, ...patch }),
    );
  }
  assert.throws(() => prepareOrganizationMediaSchema.parse(input));
  assert.throws(() => prepareProfileMediaSchema.parse(input));
  assert.throws(() => prepareCategoryIconMediaSchema.parse(input));
  const descriptor = {
    protocol: ACTIVITY_MEDIA_PROTOCOL,
    kind: 'activity-media',
    activityId: input.activityId,
    slot: 'cover',
    revision: 1,
    bindingId: randomUUID(),
    width: 100,
    height: 100,
    variants: ['thumb-v1', 'display-v1'],
  };
  assert.deepEqual(
    activityDescriptorSchema.parse(descriptor),
    native.decodeActivityMediaDescriptor(descriptor),
  );
  assert.throws(() =>
    native.decodeActivityMediaDescriptor({
      ...descriptor,
      original: 'https://example.invalid/qr',
    }),
  );
});

test('Activity bindings support exactly one cover and nine distinct gallery slots without accepting a descriptor or another owner', () => {
  const ids = Array.from({ length: 10 }, () => randomUUID());
  const all = {
    cover: ids[0],
    ...Object.fromEntries(
      ids.slice(1).map((id, index) => [`gallery${index}`, id]),
    ),
  };
  assert.deepEqual(activityMediaBindingsSchema.parse(all), all);
  assert.deepEqual(activityMediaBindingsSchema.parse({ cover: null }), {
    cover: null,
  });
  for (const invalid of [
    { ...all, gallery9: randomUUID() },
    { ...all, cover: { url: 'https://example.invalid/a' } },
    { ...all, gallery0: ids[0] },
    { ...all, mainQr: randomUUID() },
    { avatar: randomUUID() },
  ])
    assert.throws(() => activityMediaBindingsSchema.parse(invalid));
  assert.deepEqual(
    activityMediaChangesSchema.parse({
      cover: { action: 'replace', assetId: ids[0] },
      gallery8: { action: 'remove' },
    }),
    {
      cover: { action: 'replace', assetId: ids[0] },
      gallery8: { action: 'remove' },
    },
  );
  for (const invalid of [
    { cover: { action: 'replace', bindingId: ids[0] } },
    { gallery9: { action: 'keep' } },
    { cover: { action: 'replace', assetId: ids[0], approved: true } },
  ])
    assert.throws(() => activityMediaChangesSchema.parse(invalid));
});
