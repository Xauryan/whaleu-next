import type { SchoolEntryData } from '../../../src/school-configuration/contracts.js';
/** Explicit Media9 test DI; all school/session/CAS/Media guards and actual image
 * processing remain real. No production provider or external credentials. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from './runtime-fixture.js';
import {
  SCHOOL_QR_MEDIA_RUNTIME,
  SchoolQrMediaService,
} from '../../../src/school-configuration/media/facade.js';
import {
  SCHOOL_QR_MEDIA_PROTOCOL,
  schoolQrMediaStatusSchema,
  schoolQrMediaGrantSchema,
  schoolQrMediaUploadObservedSchema,
} from '../../../src/media/contracts-school-qr.js';
import type { SchoolQrEntryKey } from '../../../src/media/contracts-school-qr.js';
import { sha256 } from '../../../src/media/processing/protocol.js';
import { withCommunityScopeWriter } from '../community-scope-fixtures.js';
export async function schoolQrFixture(
  fixtures: readonly {
    sha256: string;
    verdict: 'allow' | 'held' | 'revoked';
  }[],
) {
  const base = await syntheticMediaRuntimeFixture(fixtures, {
    configureTestModule(builder, { storage, ingressStorage }) {
      builder
        .overrideProvider(SCHOOL_QR_MEDIA_RUNTIME)
        .useValue({ planning: ingressStorage, storage, ingressStorage });
    },
  });
  return { ...base, qr: base.app.get(SchoolQrMediaService) };
}
export type SchoolQrFixture = Awaited<ReturnType<typeof schoolQrFixture>>;
export type SchoolQrActor = Awaited<ReturnType<SchoolQrFixture['actor']>>;
export const qrPrefix = '/v3/media/school-configuration';
export function qrOk(
  response: { status: number; body: unknown },
  status = 200,
) {
  assert.equal(response.status, status, JSON.stringify(response.body));
}
export async function grantSchool(
  f: SchoolQrFixture,
  actor: SchoolQrActor,
  role: 'school_admin' | 'super_admin' | 'developer' = 'school_admin',
  region = f.scope.home.regionId,
) {
  const id = randomUUID();
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic-school-qr-test')`,
      [id, actor.accountId, role, role === 'school_admin' ? region : null],
    ),
  );
  return id;
}
export async function readySchoolQr(
  f: SchoolQrFixture,
  actor: SchoolQrActor,
  bytes: Buffer,
  entryKey: SchoolQrEntryKey = 'treehole',
  expectedRevision = 0,
  regionId = f.scope.home.regionId,
) {
  const http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`;
  const input = {
    protocol: SCHOOL_QR_MEDIA_PROTOCOL,
    clientRequestId: randomUUID(),
    regionId,
    entryKey,
    expectedRevision,
    declaration: {
      mime: 'image/png',
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
  };
  const prepared = await request(http)
    .post(`${qrPrefix}/upload-intents`)
    .set('Authorization', auth)
    .send(input);
  qrOk(prepared);
  const initial = schoolQrMediaStatusSchema.parse(prepared.body);
  const granted = await request(http)
    .post(`${qrPrefix}/upload-intents/${initial.intentId}/grant`)
    .set('Authorization', auth)
    .send({});
  qrOk(granted);
  const grant = schoolQrMediaGrantSchema.parse(granted.body);
  const uploaded = await request(http)
    .post(
      `${qrPrefix}/upload-intents/${initial.intentId}/uploads/${grant.grantId}`,
    )
    .set('Authorization', auth)
    .attach('file', bytes, {
      filename: 'ignored-school-qr',
      contentType: 'image/png',
    });
  qrOk(uploaded);
  assert.equal(
    schoolQrMediaUploadObservedSchema.parse(uploaded.body).sha256,
    sha256(bytes),
  );
  qrOk(
    await request(http)
      .post(`${qrPrefix}/upload-intents/${initial.intentId}/finalize`)
      .set('Authorization', auth)
      .send({}),
  );
  for (const kind of ['seal', 'process', 'review'] as const)
    assert.equal(await f.worker.runOne(kind), true);
  const result = await request(http)
    .get(`${qrPrefix}/upload-intents/${initial.intentId}`)
    .set('Authorization', auth);
  qrOk(result);
  const status = schoolQrMediaStatusSchema.parse(result.body);
  return { input, status };
}
export function schoolData(
  entryKey: SchoolQrEntryKey,
  enabled = true,
): SchoolEntryData {
  return entryKey === 'admin'
    ? { kind: 'admin', enabled, wechatId: 'school_admin' }
    : entryKey === 'official_account'
      ? {
          kind: 'official_account',
          enabled,
          name: 'School account',
          description: 'School services',
        }
      : {
          kind: 'group',
          enabled,
          name: 'School group',
          description: 'School services',
          joinUrl: '',
          qqGroupNumber: '',
          maxGroupNumber: null,
        };
}
export async function publishSchoolQr(
  f: SchoolQrFixture,
  actor: SchoolQrActor,
  entryKey: SchoolQrEntryKey,
  revision: number,
  qrcode:
    { action: 'keep' | 'remove' } | { action: 'replace'; assetId: string },
  enabled = true,
) {
  const command = {
    clientRequestId: randomUUID(),
    expectedRevision: revision,
    entry: schoolData(entryKey, enabled),
    qrcode,
  };
  const result = await request(f.app.getHttpServer())
    .post(
      `/v1/me/school-configuration/${f.scope.home.regionId}/entries/${entryKey}`,
    )
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(command);
  qrOk(result);
  return { command, response: result };
}
