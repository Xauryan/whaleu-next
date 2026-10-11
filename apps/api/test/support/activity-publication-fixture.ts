import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from './media/runtime-fixture.js';
import {
  ORGANIZATION_MEDIA_RUNTIME,
  OrganizationMediaService,
} from '../../src/organizations/media/facade.js';
import {
  ACTIVITY_MEDIA_RUNTIME,
  ActivityMediaService,
} from '../../src/activities/media/facade.js';
import {
  ACTIVITY_REVIEW_RUNTIME,
  ActivityReviewProcessor,
} from '../../src/activities/publication/review.js';
import type { ActivityReviewRuntime } from '../../src/activities/publication/review.js';
import type { ActivityPublicationContent } from '../../src/activities/publication/contracts.js';
import {
  seedDirectoryTaxonomy,
  seedDirectoryCatalog,
  syntheticDirectoryCategory,
} from './directory-catalog-fixtures.js';
import {
  createOrganizationDraft,
  readyOrganizationImage,
  grantOrganizationSchoolReviewer,
  organizationOk,
} from './media/organization-runtime-fixture.js';
export async function activityPublicationFixture(
  fixtures: readonly {
    sha256: string;
    verdict: 'allow' | 'held' | 'revoked';
  }[],
  options: {
    reviewResult?: 'allow' | 'reject' | 'failed';
    reviewDelay?: () => Promise<void>;
  } = {},
) {
  const runtime: ActivityReviewRuntime = {
    mode: 'simulation',
    policyId: randomUUID(),
    issuer: 'disposable-activity-review',
    validFrom: new Date(Date.now() - 60000),
    validUntil: new Date(Date.now() + 86400000),
    async evaluate(envelope) {
      await options.reviewDelay?.();
      return {
        result: options.reviewResult ?? 'allow',
        provenanceRef: `synthetic-real-queue:${envelope.activityId}:${envelope.draftRevision}`,
      };
    },
  };
  const base = await syntheticMediaRuntimeFixture(fixtures, {
    configureTestModule(builder, { storage, ingressStorage }) {
      const media = { planning: ingressStorage, storage, ingressStorage };
      builder
        .overrideProvider(ORGANIZATION_MEDIA_RUNTIME)
        .useValue(media)
        .overrideProvider(ACTIVITY_MEDIA_RUNTIME)
        .useValue(media)
        .overrideProvider(ACTIVITY_REVIEW_RUNTIME)
        .useValue(runtime);
    },
  });
  try {
    const category = syntheticDirectoryCategory(),
      official = syntheticDirectoryCategory();
    for (const [kind, c] of [
      ['org', category],
      ['official', official],
    ] as const) {
      const tax = await seedDirectoryTaxonomy(
        base.pool,
        base.scope.home.regionId,
        kind,
        [c],
      );
      await seedDirectoryCatalog(
        base.pool,
        base.scope.home.regionId,
        kind,
        tax,
        [],
      );
    }
    return {
      ...base,
      media: base.app.get(OrganizationMediaService),
      activityMedia: base.app.get(ActivityMediaService),
      reviewProcessor: base.app.get(ActivityReviewProcessor),
      category,
      official,
      reviewRuntime: runtime,
    };
  } catch (error) {
    await base.close();
    throw error;
  }
}
export type ActivityPublicationFixture = Awaited<
  ReturnType<typeof activityPublicationFixture>
>;
export type ActivityPublicationActor = Awaited<
  ReturnType<ActivityPublicationFixture['actor']>
>;
export async function approvedActivityOrganizer(
  f: ActivityPublicationFixture,
  actor: ActivityPublicationActor,
  reviewer: ActivityPublicationActor,
  png: Buffer,
) {
  await grantOrganizationSchoolReviewer(f, reviewer);
  const org = await createOrganizationDraft(f, actor, 'qq');
  const assets: {
    avatar?: { action: 'replace'; assetId: string };
    mainQr?: { action: 'replace'; assetId: string };
  } = {};
  for (const slot of ['avatar', 'mainQr'] as const) {
    const image = await readyOrganizationImage(f, actor, org.id, slot, 1, png);
    if (image.status.status !== 'ready_unbound')
      throw Error('Organization image did not become ready');
    assets[slot] = { action: 'replace', assetId: image.status.assetId };
  }
  const submit = await request(f.app.getHttpServer())
    .post(`/v1/organizations/${org.id}/content`)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send({
      action: 'submit',
      clientRequestId: randomUUID(),
      expectedRevision: 1,
      expectedAuthorityVersion: 1,
      data: org.data,
      mediaChanges: assets,
    });
  organizationOk(submit);
  organizationOk(
    await request(f.app.getHttpServer())
      .post(`/v1/organizations/${org.id}/review`)
      .query({ regionId: f.scope.home.regionId })
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({
        action: 'approve',
        clientRequestId: randomUUID(),
        expectedRevision: 2,
        expectedAuthorityVersion: 1,
        reason: '',
      }),
  );
  return { ...org, revision: 2 };
}
export const activityFixtureContent: ActivityPublicationContent = {
  title: '校园开放日',
  description: '活动介绍',
  types: ['offline', 'reward'],
  activityTime: '周六下午两点',
  activityLocation: '图书馆一楼',
  endAt: null,
  showOrganizerQr: false,
};
export async function createActivityDraft(
  f: ActivityPublicationFixture,
  actor: ActivityPublicationActor,
  org: { id: string; revision: number },
  content: ActivityPublicationContent = activityFixtureContent,
) {
  const id = randomUUID(),
    command = {
      action: 'create' as const,
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      organization: { source: 'managed' as const, organizationId: org.id },
      organizationRevision: org.revision,
      content,
    };
  const response = await request(f.app.getHttpServer())
    .post(`/v1/activity-publication/drafts/${id}/commands`)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(command);
  organizationOk(response);
  return { id, revision: 1, content, receipt: response.body, command };
}
