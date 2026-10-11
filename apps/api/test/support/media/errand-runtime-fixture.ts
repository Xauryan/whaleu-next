import type { TestingModuleBuilder } from '@nestjs/testing';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from './runtime-fixture.js';
import {
  ERRAND_MEDIA_RUNTIME,
  ErrandMediaService,
} from '../../../src/errands/media/facade.js';
import { ErrandPublicationService } from '../../../src/errands/publication-service.js';
import {
  ERRAND_MEDIA_PROTOCOL,
  errandMediaStatusSchema,
  errandMediaGrantSchema,
} from '../../../src/media/contracts-errand.js';
import type { ErrandMediaSlot } from '../../../src/media/contracts-errand.js';
import {
  ERRAND_PUBLICATION_PROTOCOL,
  publishErrandV2Schema,
} from '../../../src/errands/publication-contracts.js';
import type { ErrandImageFact } from '../../../src/errands/publication-contracts.js';
import { canonicalErrandEnvelope } from '../../../src/community/content-review/errand-contracts.js';
import { sha256 } from '../../../src/media/processing/protocol.js';
import { seedErrandFeature } from '../errand-runtime-fixture.js';
import { approveErrand } from '../errand-review-fixtures.js';
export const errandMediaPrefix = '/v3/media/errands';
export function errandMediaOk(
  r: { status: number; body: unknown },
  status = 200,
) {
  assert.equal(r.status, status, JSON.stringify(r.body));
}
/** Disposable real owners/Review/SQL; only storage, ingress and processors are synthetic. */
export async function errandMediaFixture(
  fixtures: readonly {
    sha256: string;
    verdict: 'allow' | 'held' | 'revoked';
  }[],
  options: {
    configureTestModule?: (builder: TestingModuleBuilder) => void;
  } = {},
) {
  const base = await syntheticMediaRuntimeFixture(fixtures, {
    configureTestModule(builder, { storage, ingressStorage }) {
      builder
        .overrideProvider(ERRAND_MEDIA_RUNTIME)
        .useValue({ planning: ingressStorage, storage, ingressStorage });
      options.configureTestModule?.(builder);
    },
  });
  const publications = base.app.get(ErrandPublicationService),
    media = base.app.get(ErrandMediaService);
  const actor = async () => {
    const value = await base.actor();
    await seedErrandFeature(base.pool, value.accountId);
    return value;
  };
  return { ...base, publications, media, actor };
}
export type ErrandMediaFixture = Awaited<ReturnType<typeof errandMediaFixture>>;
export type ErrandMediaActor = Awaited<ReturnType<ErrandMediaFixture['actor']>>;
export async function createErrandMediaDraft(
  f: ErrandMediaFixture,
  actor: ErrandMediaActor,
) {
  return f.publications.create(actor.accessToken, {
    protocol: ERRAND_PUBLICATION_PROTOCOL,
    draftId: randomUUID(),
    targetRegionId: f.scope.home.regionId,
  });
}
export async function readyErrandImage(
  f: ErrandMediaFixture,
  actor: ErrandMediaActor,
  draft: Awaited<ReturnType<typeof createErrandMediaDraft>>,
  slot: ErrandMediaSlot,
  bytes: Buffer,
) {
  const http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`,
    input = {
      protocol: ERRAND_MEDIA_PROTOCOL,
      clientRequestId: randomUUID(),
      draftId: draft.draftId,
      draftRevision: draft.revision,
      targetRegionId: draft.targetRegionId,
      slot,
      declaration: {
        mime: 'image/png',
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
    };
  const prepared = await request(http)
    .post(`${errandMediaPrefix}/upload-intents`)
    .set('Authorization', auth)
    .send(input);
  errandMediaOk(prepared);
  const initial = errandMediaStatusSchema.parse(prepared.body);
  const grantResponse = await request(http)
    .post(`${errandMediaPrefix}/upload-intents/${initial.intentId}/grant`)
    .set('Authorization', auth)
    .send({});
  errandMediaOk(grantResponse);
  const grant = errandMediaGrantSchema.parse(grantResponse.body);
  errandMediaOk(
    await request(http)
      .post(
        `${errandMediaPrefix}/upload-intents/${initial.intentId}/uploads/${grant.grantId}`,
      )
      .set('Authorization', auth)
      .attach('file', bytes, {
        filename: 'synthetic-errand-image',
        contentType: 'image/png',
      }),
  );
  errandMediaOk(
    await request(http)
      .post(`${errandMediaPrefix}/upload-intents/${initial.intentId}/finalize`)
      .set('Authorization', auth)
      .send({}),
  );
  for (const kind of ['seal', 'process', 'review'] as const)
    assert.equal(await f.worker.runOne(kind), true);
  const response = await request(http)
    .get(`${errandMediaPrefix}/upload-intents/${initial.intentId}`)
    .set('Authorization', auth);
  errandMediaOk(response);
  const status = errandMediaStatusSchema.parse(response.body);
  assert.equal(status.status, 'ready_unbound');
  if (status.status !== 'ready_unbound')
    assert.fail('Expected reviewed unbound asset');
  return {
    input,
    status,
    fact: {
      slot,
      assetId: status.assetId,
      manifestDigest: status.manifestDigest,
    } satisfies ErrandImageFact,
  };
}
export function errandMediaBody(
  f: ErrandMediaFixture,
  draft: Awaited<ReturnType<typeof createErrandMediaDraft>>,
  facts: readonly ErrandImageFact[],
) {
  return publishErrandV2Schema.parse({
    protocol: ERRAND_PUBLICATION_PROTOCOL,
    clientRequestId: randomUUID(),
    draftId: draft.draftId,
    draftRevision: draft.revision,
    targetRegionId: f.scope.home.regionId,
    title: 'Synthetic image errand',
    publicText: 'Synthetic public instructions',
    privateText: 'Synthetic participant-only instructions',
    expectedTimeText: 'Tomorrow',
    reward: '12',
    publisherContacts: { wechat: 'fixture_publisher', phone: '12345678901' },
    publicMedia: facts.filter((x) => x.slot.startsWith('public')),
    privateMedia: facts.filter((x) => x.slot.startsWith('private')),
  });
}
export async function publishErrandImages(
  f: ErrandMediaFixture,
  actor: ErrandMediaActor,
  draft: Awaited<ReturnType<typeof createErrandMediaDraft>>,
  facts: readonly ErrandImageFact[],
) {
  const body = errandMediaBody(f, draft, facts),
    prepared = await f.publications.prepare(actor.accessToken, body);
  const scope = (
    await f.pool.query(
      'SELECT scope FROM whaleu_errands.media_drafts WHERE id=$1',
      [draft.draftId],
    )
  ).rows[0]!.scope;
  const envelope = canonicalErrandEnvelope({
    version: 2,
    accountId: actor.accountId,
    purpose: 'publish_errand',
    title: body.title,
    publicText: body.publicText,
    privateText: body.privateText,
    expectedTimeText: body.expectedTimeText,
    reward: body.reward,
    publisherContacts: body.publisherContacts,
    scope,
    draftId: draft.draftId,
    draftRevision: draft.revision,
    mediaRevision: 1,
    publicMedia: body.publicMedia,
    privateMedia: body.privateMedia,
  });
  const approval = await approveErrand(f.pool, envelope);
  const receipt = await f.publications.publish(
    actor.accessToken,
    prepared.requestId,
    prepared.requestHash,
  );
  assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
  if (receipt.outcome !== 'applied')
    assert.fail('Expected applied publication');
  return {
    body,
    prepared,
    approval,
    receipt,
    id: receipt.orderId,
    revision: receipt.revision,
  };
}
