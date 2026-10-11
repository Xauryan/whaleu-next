/** Explicit disposable Media10 DI. Actual organization applicant/roles, owner
 * CAS, image decoding, Safety review and delivery remain unchanged. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from './runtime-fixture.js';
import {
  ORGANIZATION_MEDIA_RUNTIME,
  OrganizationMediaService,
} from '../../../src/organizations/media/facade.js';
import {
  ORGANIZATION_MEDIA_PROTOCOL,
  organizationMediaStatusSchema,
  organizationMediaGrantSchema,
  organizationMediaUploadObservedSchema,
} from '../../../src/media/contracts-organization.js';
import type { OrganizationMediaSlot } from '../../../src/media/contracts-organization.js';
import type { OrganizationData } from '../../../src/organizations/management/contracts.js';
import { organizationReceiptSchema } from '../../../src/organizations/management/contracts.js';
import { sha256 } from '../../../src/media/processing/protocol.js';
import {
  seedDirectoryTaxonomy,
  seedDirectoryCatalog,
  syntheticDirectoryCategory,
} from '../directory-catalog-fixtures.js';
import { withCommunityScopeWriter } from '../community-scope-fixtures.js';
export async function organizationMediaFixture(
  fixtures: readonly {
    sha256: string;
    verdict: 'allow' | 'held' | 'revoked';
  }[],
) {
  const base = await syntheticMediaRuntimeFixture(fixtures, {
    configureTestModule(builder, { storage, ingressStorage }) {
      builder
        .overrideProvider(ORGANIZATION_MEDIA_RUNTIME)
        .useValue({ planning: ingressStorage, storage, ingressStorage });
    },
  });
  try {
    const category = syntheticDirectoryCategory(),
      official = syntheticDirectoryCategory();
    const orgTax = await seedDirectoryTaxonomy(
      base.pool,
      base.scope.home.regionId,
      'org',
      [category],
    );
    const officialTax = await seedDirectoryTaxonomy(
      base.pool,
      base.scope.home.regionId,
      'official',
      [official],
    );
    await seedDirectoryCatalog(
      base.pool,
      base.scope.home.regionId,
      'org',
      orgTax,
      [],
    );
    await seedDirectoryCatalog(
      base.pool,
      base.scope.home.regionId,
      'official',
      officialTax,
      [],
    );
    return {
      ...base,
      media: base.app.get(OrganizationMediaService),
      category,
      official,
    };
  } catch (error) {
    await base.close();
    throw error;
  }
}
export type OrganizationMediaFixture = Awaited<
  ReturnType<typeof organizationMediaFixture>
>;
export type OrganizationMediaActor = Awaited<
  ReturnType<OrganizationMediaFixture['actor']>
>;
export const organizationMediaPrefix = '/v3/media/organizations';
export const organizationApiPrefix = '/v1/organizations';
export function organizationOk(
  response: { status: number; body: unknown },
  status = 200,
) {
  assert.equal(response.status, status, JSON.stringify(response.body));
}
export async function createOrganizationDraft(
  f: OrganizationMediaFixture,
  actor: OrganizationMediaActor,
  platform: 'qq' | 'wechat' | 'official' = 'wechat',
) {
  const id = randomUUID(),
    data: OrganizationData = {
      kind: platform === 'official' ? 'official' : 'org',
      platform,
      categoryId: platform === 'official' ? f.official.id : f.category.id,
      name: '校园社团',
      introText: '真实组织媒体测试',
      qqGroupNumber: platform === 'qq' ? '12345678' : null,
    };
  const input = {
    action: 'create',
    clientRequestId: randomUUID(),
    organizationId: id,
    regionId: f.scope.home.regionId,
    expectedRevision: 0,
    expectedAuthorityVersion: 0,
    data,
  };
  const response = await request(f.app.getHttpServer())
    .post(organizationApiPrefix)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(input);
  organizationOk(response);
  return { id, data, receipt: organizationReceiptSchema.parse(response.body) };
}
export async function grantOrganizationSchoolReviewer(
  f: OrganizationMediaFixture,
  actor: OrganizationMediaActor,
) {
  const id = randomUUID();
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic-organization-media-test')`,
      [id, actor.accountId, f.scope.home.regionId],
    ),
  );
  return id;
}
export async function readyOrganizationImage(
  f: OrganizationMediaFixture,
  actor: OrganizationMediaActor,
  organizationId: string,
  slot: OrganizationMediaSlot,
  applicationRevision: number,
  bytes: Buffer,
) {
  const http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`,
    input = {
      protocol: ORGANIZATION_MEDIA_PROTOCOL,
      clientRequestId: randomUUID(),
      organizationId,
      slot,
      applicationRevision,
      declaration: {
        mime: 'image/png',
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
    };
  const prepared = await request(http)
    .post(`${organizationMediaPrefix}/upload-intents`)
    .set('Authorization', auth)
    .send(input);
  organizationOk(prepared);
  const initial = organizationMediaStatusSchema.parse(prepared.body);
  const granted = await request(http)
    .post(`${organizationMediaPrefix}/upload-intents/${initial.intentId}/grant`)
    .set('Authorization', auth)
    .send({});
  organizationOk(granted);
  const grant = organizationMediaGrantSchema.parse(granted.body);
  const uploaded = await request(http)
    .post(
      `${organizationMediaPrefix}/upload-intents/${initial.intentId}/uploads/${grant.grantId}`,
    )
    .set('Authorization', auth)
    .attach('file', bytes, {
      filename: 'ignored-organization-image',
      contentType: 'image/png',
    });
  organizationOk(uploaded);
  assert.equal(
    organizationMediaUploadObservedSchema.parse(uploaded.body).sha256,
    sha256(bytes),
  );
  organizationOk(
    await request(http)
      .post(
        `${organizationMediaPrefix}/upload-intents/${initial.intentId}/finalize`,
      )
      .set('Authorization', auth)
      .send({}),
  );
  for (const kind of ['seal', 'process', 'review'] as const)
    assert.equal(await f.worker.runOne(kind), true);
  const response = await request(http)
    .get(`${organizationMediaPrefix}/upload-intents/${initial.intentId}`)
    .set('Authorization', auth);
  organizationOk(response);
  return { input, status: organizationMediaStatusSchema.parse(response.body) };
}
