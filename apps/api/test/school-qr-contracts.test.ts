import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  SCHOOL_QR_MEDIA_PROTOCOL,
  prepareSchoolQrMediaSchema,
  schoolQrMediaRequestHash,
  schoolQrDescriptorSchema,
} from '../src/media/contracts-school-qr.js';
import { prepareCategoryIconMediaSchema } from '../src/media/contracts-category-icon.js';
import { prepareProfileMediaSchema } from '../src/media/contracts-profile.js';
const require = createRequire(import.meta.url);
const native = require('../../wechat/src/school-configuration/qr-contract.ts');
test('School QR protocol is closed and request hash includes original actor region slot revision and declaration', () => {
  const actor = randomUUID(),
    input = {
      protocol: SCHOOL_QR_MEDIA_PROTOCOL,
      clientRequestId: randomUUID(),
      regionId: randomUUID(),
      entryKey: 'treehole',
      expectedRevision: 0,
      declaration: { mime: 'image/png', bytes: 20, sha256: 'a'.repeat(64) },
    };
  assert.deepEqual(prepareSchoolQrMediaSchema.parse(input), input);
  assert.equal(
    schoolQrMediaRequestHash(actor, input),
    native.schoolQrPrepareHash(actor, input),
  );
  for (const patch of [
    { regionId: randomUUID() },
    { entryKey: 'review' },
    { expectedRevision: 1 },
    { clientRequestId: randomUUID() },
  ])
    assert.notEqual(
      schoolQrMediaRequestHash(actor, { ...input, ...patch }),
      schoolQrMediaRequestHash(actor, input),
    );
  assert.notEqual(
    schoolQrMediaRequestHash(randomUUID(), input),
    schoolQrMediaRequestHash(actor, input),
  );
  for (const patch of [
    { protocol: 'profile-media-v1' },
    { ownerKind: 'community' },
    { resourceId: randomUUID() },
    { slot: 'avatar' },
    { approved: true },
    { url: 'https://example.invalid/qr' },
    { entryKey: 'any' },
    { expectedRevision: -1 },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.throws(() =>
      prepareSchoolQrMediaSchema.parse({ ...input, ...patch }),
    );
    assert.throws(() => native.decodeSchoolQrPrepare({ ...input, ...patch }));
  }
  assert.throws(() => prepareProfileMediaSchema.parse(input));
  assert.throws(() => prepareCategoryIconMediaSchema.parse(input));
  const descriptor = {
    protocol: SCHOOL_QR_MEDIA_PROTOCOL,
    kind: 'school-configuration-qr',
    regionId: input.regionId,
    entryKey: 'treehole',
    entryRevision: 1,
    bindingId: randomUUID(),
    width: 100,
    height: 100,
    variants: ['thumb-v1', 'display-v1'],
  };
  assert.deepEqual(
    schoolQrDescriptorSchema.parse(descriptor),
    native.decodeSchoolQrDescriptor(descriptor),
  );
  assert.throws(() =>
    native.decodeSchoolQrDescriptor({
      ...descriptor,
      original: 'https://example.invalid/qr',
    }),
  );
});
