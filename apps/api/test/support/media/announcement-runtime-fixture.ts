import { syntheticMediaRuntimeFixture } from './runtime-fixture.js';
import { withCommunityScopeWriter } from '../community-scope-fixtures.js';
import {
  ANNOUNCEMENT_MEDIA_RUNTIME,
  AnnouncementMediaService,
} from '../../../src/announcements/media/facade.js';
/** Typed12 announcement helper. The caller owns real role grants and publication
 * fixture setup; only immutable byte storage and processing adapters are fake. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  ANNOUNCEMENT_MEDIA_PROTOCOL,
  announcementMediaStatusSchema,
  announcementMediaGrantSchema,
  announcementMediaUploadObservedSchema,
} from '../../../src/media/contracts-announcement.js';
import type { AnnouncementMediaSlot } from '../../../src/media/contracts-announcement.js';
import { sha256 } from '../../../src/media/processing/protocol.js';
export const announcementMediaPrefix = '/v3/media/announcements';
export function announcementMediaOk(
  response: { status: number; body: unknown },
  status = 200,
) {
  assert.equal(response.status, status, JSON.stringify(response.body));
}
export async function readyAnnouncementImage(
  f: {
    app: INestApplication;
    worker: { runOne(kind: 'seal' | 'process' | 'review'): Promise<boolean> };
  },
  actor: { accessToken: string },
  announcementId: string,
  slot: AnnouncementMediaSlot,
  revision: number,
  bytes: Buffer,
) {
  const http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`;
  const input = {
    protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
    clientRequestId: randomUUID(),
    announcementId,
    slot,
    revision,
    declaration: {
      mime: 'image/png',
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
  };
  const prepared = await request(http)
    .post(`${announcementMediaPrefix}/upload-intents`)
    .set('Authorization', auth)
    .send(input);
  announcementMediaOk(prepared);
  const initial = announcementMediaStatusSchema.parse(prepared.body);
  const granted = await request(http)
    .post(`${announcementMediaPrefix}/upload-intents/${initial.intentId}/grant`)
    .set('Authorization', auth)
    .send({});
  announcementMediaOk(granted);
  const grant = announcementMediaGrantSchema.parse(granted.body);
  const uploaded = await request(http)
    .post(
      `${announcementMediaPrefix}/upload-intents/${initial.intentId}/uploads/${grant.grantId}`,
    )
    .set('Authorization', auth)
    .attach('file', bytes, {
      filename: 'ignored-announcement-image',
      contentType: 'image/png',
    });
  announcementMediaOk(uploaded);
  assert.equal(
    announcementMediaUploadObservedSchema.parse(uploaded.body).sha256,
    sha256(bytes),
  );
  announcementMediaOk(
    await request(http)
      .post(
        `${announcementMediaPrefix}/upload-intents/${initial.intentId}/finalize`,
      )
      .set('Authorization', auth)
      .send({}),
  );
  for (const kind of ['seal', 'process', 'review'] as const)
    assert.equal(await f.worker.runOne(kind), true);
  const response = await request(http)
    .get(`${announcementMediaPrefix}/upload-intents/${initial.intentId}`)
    .set('Authorization', auth);
  announcementMediaOk(response);
  return { input, status: announcementMediaStatusSchema.parse(response.body) };
}

export async function announcementMediaFixture(
  fixtures: readonly {
    sha256: string;
    verdict: 'allow' | 'held' | 'revoked';
  }[],
) {
  const base = await syntheticMediaRuntimeFixture(fixtures, {
    configureTestModule(builder, { storage, ingressStorage }) {
      builder
        .overrideProvider(ANNOUNCEMENT_MEDIA_RUNTIME)
        .useValue({ planning: ingressStorage, storage, ingressStorage });
    },
  });
  return { ...base, announcementMedia: base.app.get(AnnouncementMediaService) };
}
export type AnnouncementMediaFixture = Awaited<
  ReturnType<typeof announcementMediaFixture>
>;
export type AnnouncementMediaActor = Awaited<
  ReturnType<AnnouncementMediaFixture['actor']>
>;
export async function grantAnnouncementSchool(
  f: AnnouncementMediaFixture,
  actor: AnnouncementMediaActor,
  role: 'school_admin' | 'super_admin' | 'developer' = 'school_admin',
  region = f.scope.home.regionId,
) {
  const id = randomUUID();
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic-announcement-media-test')`,
      [id, actor.accountId, role, role === 'school_admin' ? region : null],
    ),
  );
  return id;
}
export const announcementMediaContent = {
  versionLabel: '1',
  bodyText: '公告独立图片测试',
  announcementDate: null,
  popupEnabled: true,
  highlight: false,
  popupTitle: null,
  popupBodyText: null,
};
export async function createAnnouncementDraft(
  f: AnnouncementMediaFixture,
  actor: AnnouncementMediaActor,
) {
  const id = randomUUID();
  const result = await request(f.app.getHttpServer())
    .post(`/v1/announcement-management/${id}/commands`)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send({
      action: 'create',
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      content: announcementMediaContent,
      audience: { kind: 'fixed' },
    });
  announcementMediaOk(result);
  return id;
}
