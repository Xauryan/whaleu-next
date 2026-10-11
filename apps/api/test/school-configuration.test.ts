import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  saveSchoolEntrySchema,
  schoolCommandHash,
  schoolJoinUrlSchema,
} from '../src/school-configuration/contracts.js';
import { selectSchoolManagement } from '../src/school-configuration/access.js';
import { projectSchoolEntry } from '../src/school-configuration/service.js';
import type { SchoolEntryRow } from '../src/school-configuration/repository.js';
const require = createRequire(import.meta.url);
const native = require('../../wechat/src/school-configuration/contract.ts');
const actor = randomUUID(),
  region = randomUUID(),
  other = randomUUID();
const body = () =>
  saveSchoolEntrySchema.parse({
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    entry: {
      kind: 'group',
      enabled: true,
      name: '合成学校 👋',
      description: '服务说明\n仅用于验收',
      joinUrl: 'https://qun.qq.com/group/example',
      qqGroupNumber: '12345678',
      maxGroupNumber: 3,
    },
    qrcode: { action: 'keep' },
  });
test('school management consumes only exact true super/school grants; selected scope never broadens developer', () => {
  const school = {
    id: randomUUID(),
    role: 'school_admin' as const,
    operatingRegionId: region,
    validUntil: null,
  };
  assert.equal(selectSchoolManagement([school]).regionId, region);
  assert.throws(() => selectSchoolManagement([school], other));
  assert.throws(() =>
    selectSchoolManagement(
      [{ ...school, role: 'developer', operatingRegionId: null }],
      region,
    ),
  );
  assert.throws(() =>
    selectSchoolManagement([
      { ...school, role: 'super_admin', operatingRegionId: null },
    ]),
  );
  assert.equal(
    selectSchoolManagement(
      [{ ...school, role: 'super_admin', operatingRegionId: null }],
      other,
    ).regionId,
    other,
  );
  assert.throws(() =>
    selectSchoolManagement([school, { ...school, id: randomUUID() }]),
  );
});
test('strict bounded service commands reject secrets, foreign media URLs and unsafe join destinations; native hashes match exact UTF8 intent', () => {
  const command = body();
  assert.equal(
    schoolCommandHash(actor, region, 'treehole', command),
    native.schoolCommandHash(actor, region, 'treehole', command),
  );
  assert.notEqual(
    schoolCommandHash(actor, region, 'treehole', command),
    schoolCommandHash(actor, other, 'treehole', command),
  );
  for (const unsafe of [
    'http://qun.qq.com/a',
    'https://qun.qq.com.evil.test/a',
    'https://user:secret@qun.qq.com/a',
    'https://qun.qq.com:444/a',
    'javascript:alert(1)',
    'https://127.0.0.1/a',
    'https://qun.qq.com\\@evil.test/a',
  ])
    assert.equal(schoolJoinUrlSchema.safeParse(unsafe).success, false, unsafe);
  for (const patch of [
    { ...command, appSecret: 'secret' },
    {
      ...command,
      entry: { ...command.entry, qrcodeUrl: 'https://example.test/qr.png' },
    },
    {
      ...command,
      qrcode: { action: 'replace', assetId: 'https://example.test/qr.png' },
    },
  ])
    assert.equal(saveSchoolEntrySchema.safeParse(patch).success, false);
});
test('public projection hides all disabled fields and reports unconfigured honestly while admin can edit retained values', () => {
  assert.equal(projectSchoolEntry('admin', null).state, 'unconfigured');
  const row: SchoolEntryRow = {
    region_id: region,
    entry_key: 'admin',
    revision: '1',
    data: { kind: 'admin', enabled: false, wechatId: 'synthetic_admin' },
    qr_binding_id: randomUUID(),
    publication_hash: 'a'.repeat(64),
    actor_id: actor,
    grant_id: randomUUID(),
    published_at: new Date(),
  };
  assert.deepEqual(projectSchoolEntry('admin', row), {
    entryKey: 'admin',
    revision: 1,
    state: 'disabled',
    data: null,
    qrcode: { status: 'none' },
  });
  assert.equal(projectSchoolEntry('admin', row, true).data?.kind, 'admin');
});
