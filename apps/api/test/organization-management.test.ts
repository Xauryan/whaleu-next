import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  createOrganizationSchema,
  saveOrganizationSchema,
  reviewOrganizationSchema,
  organizationMemberCommandSchema,
  organizationIdSchema,
  organizationRequestIdSchema,
  organizationCommandHash,
} from '../src/organizations/management/contracts.js';
import { requireOrganizationImages } from '../src/organizations/management/service.js';
const require = createRequire(import.meta.url),
  native = require('../../wechat/src/organizations/contract.ts');
const data = () => ({
  kind: 'org' as const,
  platform: 'qq' as const,
  categoryId: randomUUID(),
  name: '校园组织',
  introText: '介绍',
  qqGroupNumber: '12345',
});
test('organization canonical command hashes agree across native and API for every action', () => {
  const actor = randomUUID(),
    id = randomUUID(),
    cas = {
      clientRequestId: randomUUID(),
      expectedRevision: 1,
      expectedAuthorityVersion: 1,
    };
  const commands = [
    createOrganizationSchema.parse({
      ...cas,
      action: 'create',
      organizationId: id,
      regionId: randomUUID(),
      expectedRevision: 0,
      expectedAuthorityVersion: 0,
      data: data(),
    }),
    saveOrganizationSchema.parse({
      ...cas,
      action: 'save',
      data: data(),
      mediaChanges: {
        avatar: { action: 'replace', assetId: randomUUID() },
        introImage8: { action: 'keep' },
      },
    }),
    reviewOrganizationSchema.parse({
      ...cas,
      action: 'reject',
      reason: '请补充真实信息',
    }),
    organizationMemberCommandSchema.parse({
      ...cas,
      action: 'transfer_owner',
      targetProfileId: randomUUID(),
    }),
  ];
  for (const c of commands) {
    assert.equal(
      organizationCommandHash(actor, id, c),
      native.organizationCommandHash(actor, id, c),
    );
    assert.notEqual(
      organizationCommandHash(actor, id, c),
      organizationCommandHash(randomUUID(), id, c),
    );
  }
});
test('new organization owner rejects noncanonical UUIDs before hashing, locking or DB casts', () => {
  const upper = 'ABCDEFAB-1234-4234-8234-123456789ABC';
  assert.equal(organizationIdSchema.safeParse(upper).success, false);
  assert.equal(organizationRequestIdSchema.safeParse(upper).success, false);
  const cas = {
      clientRequestId: randomUUID(),
      expectedRevision: 1,
      expectedAuthorityVersion: 1,
    },
    command = { ...cas, action: 'save', data: data(), mediaChanges: {} };
  assert.equal(
    saveOrganizationSchema.safeParse({ ...command, clientRequestId: upper })
      .success,
    false,
  );
  assert.equal(
    saveOrganizationSchema.safeParse({
      ...command,
      data: { ...command.data, categoryId: upper },
    }).success,
    false,
  );
  assert.equal(
    saveOrganizationSchema.safeParse({
      ...command,
      mediaChanges: { avatar: { action: 'replace', assetId: upper } },
    }).success,
    false,
  );
});
test('legacy platform requirements retain real required images and nine introduction slots', () => {
  const d = data(),
    binding = randomUUID();
  assert.throws(() => requireOrganizationImages(d, {}));
  assert.throws(() => requireOrganizationImages(d, { avatar: binding }));
  requireOrganizationImages(d, {
    avatar: binding,
    mainQr: randomUUID(),
    introImage8: randomUUID(),
  });
  const wechat = { ...d, platform: 'wechat' as const, qqGroupNumber: null };
  assert.throws(() =>
    requireOrganizationImages(wechat, {
      avatar: binding,
      mainQr: randomUUID(),
    }),
  );
  requireOrganizationImages(wechat, {
    avatar: binding,
    mainQr: randomUUID(),
    managerContact: randomUUID(),
  });
  assert.throws(() =>
    requireOrganizationImages(
      { ...wechat, kind: 'official', platform: 'official' },
      { avatar: binding, mainQr: randomUUID(), managerContact: randomUUID() },
    ),
  );
  assert.equal(
    createOrganizationSchema.safeParse({
      action: 'create',
      clientRequestId: randomUUID(),
      organizationId: randomUUID(),
      regionId: randomUUID(),
      expectedRevision: 0,
      expectedAuthorityVersion: 0,
      data: { ...d, name: '一二三四五六七八九十一' },
    }).success,
    false,
  );
  assert.equal(
    reviewOrganizationSchema.safeParse({
      action: 'reject',
      clientRequestId: randomUUID(),
      expectedRevision: 1,
      expectedAuthorityVersion: 1,
      reason: ' ',
    }).success,
    false,
  );
});
