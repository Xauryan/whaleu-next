import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  ANNOUNCEMENT_MEDIA_PROTOCOL,
  prepareAnnouncementMediaSchema,
  announcementMediaRequestHash,
  announcementDescriptorSchema,
} from '../src/media/contracts-announcement.js';
import { prepareCategoryIconMediaSchema } from '../src/media/contracts-category-icon.js';
import { prepareOrganizationMediaSchema } from '../src/media/contracts-organization.js';
import {
  announcementMediaBindingsSchema,
  announcementMediaChangesSchema,
} from '../src/announcements/media/contracts.js';
import { prepareProfileMediaSchema } from '../src/media/contracts-profile.js';
const require = createRequire(import.meta.url);
const native = require('../../wechat/src/media/announcement-contract.ts');
test('Announcement image protocol is closed and request hash includes original actor announcement slot revision and declaration', () => {
  const actor = randomUUID(),
    input = {
      protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
      clientRequestId: randomUUID(),
      announcementId: randomUUID(),
      slot: 'gallery0',
      revision: 1,
      declaration: { mime: 'image/png', bytes: 20, sha256: 'a'.repeat(64) },
    };
  assert.deepEqual(prepareAnnouncementMediaSchema.parse(input), input);
  assert.equal(
    announcementMediaRequestHash(actor, input),
    native.announcementMediaPrepareHash(actor, input),
  );
  for (const patch of [
    { announcementId: randomUUID() },
    { slot: 'gallery1' },
    { revision: 2 },
    { clientRequestId: randomUUID() },
  ])
    assert.notEqual(
      announcementMediaRequestHash(actor, { ...input, ...patch }),
      announcementMediaRequestHash(actor, input),
    );
  assert.notEqual(
    announcementMediaRequestHash(randomUUID(), input),
    announcementMediaRequestHash(actor, input),
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
      prepareAnnouncementMediaSchema.parse({ ...input, ...patch }),
    );
    assert.throws(() =>
      native.decodeAnnouncementMediaPrepare({ ...input, ...patch }),
    );
  }
  assert.throws(() => prepareOrganizationMediaSchema.parse(input));
  assert.throws(() => prepareProfileMediaSchema.parse(input));
  assert.throws(() => prepareCategoryIconMediaSchema.parse(input));
  const descriptor = {
    protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
    kind: 'announcement-media',
    announcementId: input.announcementId,
    slot: 'gallery0',
    revision: 1,
    bindingId: randomUUID(),
    width: 100,
    height: 100,
    variants: ['thumb-v1', 'display-v1'],
  };
  assert.deepEqual(
    announcementDescriptorSchema.parse(descriptor),
    native.decodeAnnouncementMediaDescriptor(descriptor),
  );
  assert.throws(() =>
    native.decodeAnnouncementMediaDescriptor({
      ...descriptor,
      original: 'https://example.invalid/qr',
    }),
  );
});

test('Announcement bindings allow exactly zero to nine distinct gallery slots and no cover', () => {
  const ids = Array.from({ length: 9 }, () => randomUUID());
  const all = Object.fromEntries(
    ids.map((id, index) => [`gallery${index}`, id]),
  );
  assert.deepEqual(announcementMediaBindingsSchema.parse({}), {});
  assert.deepEqual(announcementMediaBindingsSchema.parse(all), all);
  for (const invalid of [
    { ...all, cover: randomUUID() },
    { ...all, gallery9: randomUUID() },
    { ...all, gallery0: ids[1] },
    { ...all, gallery0: { url: 'https://bad.invalid' } },
    { avatar: randomUUID() },
  ])
    assert.throws(() => announcementMediaBindingsSchema.parse(invalid));
  assert.deepEqual(
    announcementMediaChangesSchema.parse({
      gallery0: { action: 'replace', assetId: ids[0] },
      gallery8: { action: 'remove' },
    }),
    {
      gallery0: { action: 'replace', assetId: ids[0] },
      gallery8: { action: 'remove' },
    },
  );
  for (const invalid of [
    { cover: { action: 'keep' } },
    { gallery9: { action: 'keep' } },
    { gallery0: { action: 'replace', bindingId: ids[0] } },
    { gallery0: { action: 'replace', assetId: ids[0], approved: true } },
  ])
    assert.throws(() => announcementMediaChangesSchema.parse(invalid));
});
