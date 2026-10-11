import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  ORGANIZATION_MEDIA_PROTOCOL,
  prepareOrganizationMediaSchema,
  organizationMediaRequestHash,
  organizationDescriptorSchema,
} from '../src/media/contracts-organization.js';
import { prepareCategoryIconMediaSchema } from '../src/media/contracts-category-icon.js';
import { prepareProfileMediaSchema } from '../src/media/contracts-profile.js';
const require = createRequire(import.meta.url);
const native = require('../../wechat/src/organizations/media-contract.ts');
test('Organization image protocol is closed and request hash includes original actor organization slot revision and declaration', () => {
  const actor = randomUUID(),
    input = {
      protocol: ORGANIZATION_MEDIA_PROTOCOL,
      clientRequestId: randomUUID(),
      organizationId: randomUUID(),
      slot: 'avatar',
      applicationRevision: 1,
      declaration: { mime: 'image/png', bytes: 20, sha256: 'a'.repeat(64) },
    };
  assert.deepEqual(prepareOrganizationMediaSchema.parse(input), input);
  assert.equal(
    organizationMediaRequestHash(actor, input),
    native.organizationMediaPrepareHash(actor, input),
  );
  for (const patch of [
    { organizationId: randomUUID() },
    { slot: 'mainQr' },
    { applicationRevision: 2 },
    { clientRequestId: randomUUID() },
  ])
    assert.notEqual(
      organizationMediaRequestHash(actor, { ...input, ...patch }),
      organizationMediaRequestHash(actor, input),
    );
  assert.notEqual(
    organizationMediaRequestHash(randomUUID(), input),
    organizationMediaRequestHash(actor, input),
  );
  for (const patch of [
    { protocol: 'profile-media-v1' },
    { ownerKind: 'community' },
    { resourceId: randomUUID() },
    { slot: 'foreign' },
    { approved: true },
    { url: 'https://example.invalid/qr' },
    { slot: 'any' },
    { applicationRevision: -1 },
    { applicationRevision: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.throws(() =>
      prepareOrganizationMediaSchema.parse({ ...input, ...patch }),
    );
    assert.throws(() =>
      native.decodeOrganizationMediaPrepare({ ...input, ...patch }),
    );
  }
  assert.throws(() => prepareProfileMediaSchema.parse(input));
  assert.throws(() => prepareCategoryIconMediaSchema.parse(input));
  const descriptor = {
    protocol: ORGANIZATION_MEDIA_PROTOCOL,
    kind: 'organization-media',
    organizationId: input.organizationId,
    slot: 'avatar',
    applicationRevision: 1,
    bindingId: randomUUID(),
    width: 100,
    height: 100,
    variants: ['thumb-v1', 'display-v1'],
  };
  assert.deepEqual(
    organizationDescriptorSchema.parse(descriptor),
    native.decodeOrganizationMediaDescriptor(descriptor),
  );
  assert.throws(() =>
    native.decodeOrganizationMediaDescriptor({
      ...descriptor,
      original: 'https://example.invalid/qr',
    }),
  );
});
