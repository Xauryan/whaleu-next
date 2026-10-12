import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { inTransaction } from '../../src/database/database.js';
import { majorDiscussionFixture } from './major-discussion-fixture.js';
import { syntheticMediaRuntimeFixture } from './media/runtime-fixture.js';
import { MAJOR_DISCUSSION_MEDIA_RUNTIME } from '../../src/majors/discussion/media/facade.js';
import {
  majorDiscussionMediaStatusSchema,
  majorDiscussionMediaGrantSchema,
  MAJOR_DISCUSSION_MEDIA_PROTOCOL,
} from '../../src/media/contracts-major-discussion.js';
import { majorDiscussionMediaReviewDigest } from '../../src/community/content-review/major-discussion-media-review.facade.js';
import type {
  MajorRootPublishV2,
  MajorReplyPublishV2,
} from '../../src/majors/discussion/contracts-v2.js';
import { sha256 } from '../../src/media/processing/protocol.js';
export async function majorDiscussionMediaFixture(
  fixtures: readonly {
    sha256: string;
    verdict: 'allow' | 'held' | 'revoked';
  }[],
  configure?: (builder: TestingModuleBuilder) => void,
) {
  const media = await syntheticMediaRuntimeFixture(fixtures, {
    configureTestModule(builder, { storage, ingressStorage }) {
      builder
        .overrideProvider(MAJOR_DISCUSSION_MEDIA_RUNTIME)
        .useValue({ planning: ingressStorage, storage, ingressStorage });
      configure?.(builder);
    },
  });
  const major = await majorDiscussionFixture(media);
  return { ...media, ...major };
}
export type MajorDiscussionMediaFixture = Awaited<
  ReturnType<typeof majorDiscussionMediaFixture>
>;
export const majorMediaPrefix = '/v3/media/major-discussions';
export function majorMediaOk(
  response: { status: number; body: unknown },
  status = 200,
) {
  assert.equal(response.status, status, JSON.stringify(response.body));
}
export async function reviewMajorDiscussionV2(
  pool: Pool,
  actorId: string,
  majorId: string,
  command: MajorRootPublishV2 | MajorReplyPublishV2,
  rootId: string | null = null,
  verdict: 'allow' | 'reject' = 'allow',
  options: {
    consumeUntil?: Date;
    visibilityUntil?: Date;
    issuedAt?: Date;
  } = {},
) {
  return inTransaction(pool, async (tx) => {
    const id = randomUUID(),
      policy = randomUUID(),
      target = 'replyToReplyId' in command ? command.replyToReplyId : null,
      replyToActorId = target
        ? ((
            await tx.query<{ actor_id: string }>(
              'SELECT actor_id FROM whaleu_majors.major_discussion_comments WHERE id=$1',
              [target],
            )
          ).rows[0]?.actor_id ?? null)
        : null,
      envelope = {
        version: 2 as const,
        purpose: rootId
          ? ('major.discussion.reply.v2' as const)
          : ('major.discussion.root.v2' as const),
        actorId,
        requestId: command.clientRequestId,
        majorId,
        catalogRevision: command.expectedCatalogRevision,
        majorRevision: command.expectedMajorRevision,
        body: command.body,
        images: command.images,
        rootId,
        replyToReplyId: target,
        replyToActorId,
      };
    await tx.query(
      "INSERT INTO whaleu_community.major_discussion_media_review_policies(id,issuer,source_reference,coverage,valid_from,valid_until) VALUES($1,'synthetic:local-major-discussion-review','synthetic:no-live-provider','complete',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '2 hours')",
      [policy],
    );
    await tx.query(
      'INSERT INTO whaleu_community.major_discussion_media_review_decisions(id,actor_id,request_id,major_id,catalog_id,major_revision,purpose,root_id,reply_to_reply_id,reply_to_actor_id,body,images,policy_id,verdict,digest,issued_at,consume_until,visibility_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,coalesce($16::timestamptz,clock_timestamp()),$17,$18)',
      [
        id,
        actorId,
        command.clientRequestId,
        majorId,
        command.expectedCatalogRevision,
        command.expectedMajorRevision,
        envelope.purpose,
        rootId,
        target,
        replyToActorId,
        command.body,
        JSON.stringify(command.images),
        policy,
        verdict,
        majorDiscussionMediaReviewDigest(envelope),
        options.issuedAt ?? null,
        options.consumeUntil ?? new Date(Date.now() + 3600000),
        options.visibilityUntil ?? new Date(Date.now() + 3600000),
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_community.major_discussion_media_review_heads(actor_id,request_id,decision_id,state) VALUES($1,$2,$3,'active') ON CONFLICT(actor_id,request_id) DO UPDATE SET decision_id=EXCLUDED.decision_id,state='active'",
      [actorId, command.clientRequestId, id],
    );
    return id;
  });
}
export async function readyMajorDiscussionImage(
  f: MajorDiscussionMediaFixture,
  actor: { accountId: string; accessToken: string },
  context: {
    publicationRequestId: string;
    majorId: string;
    catalogRevision: string;
    majorRevision: string;
    rootId: string | null;
    replyToReplyId: string | null;
    ordinal: number;
  },
  bytes: Buffer,
) {
  const input = {
      protocol: MAJOR_DISCUSSION_MEDIA_PROTOCOL,
      clientRequestId: randomUUID(),
      ...context,
      declaration: {
        mime: 'image/png' as const,
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
    },
    http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`;
  const prepare = await request(http)
    .post(`${majorMediaPrefix}/upload-intents`)
    .set('Authorization', auth)
    .send(input);
  majorMediaOk(prepare);
  const initial = majorDiscussionMediaStatusSchema.parse(prepare.body);
  const granted = await request(http)
    .post(`${majorMediaPrefix}/upload-intents/${initial.intentId}/grant`)
    .set('Authorization', auth)
    .send({});
  majorMediaOk(granted);
  const grant = majorDiscussionMediaGrantSchema.parse(granted.body);
  majorMediaOk(
    await request(http)
      .post(
        `${majorMediaPrefix}/upload-intents/${initial.intentId}/uploads/${grant.grantId}`,
      )
      .set('Authorization', auth)
      .attach('file', bytes, {
        filename: 'synthetic-major-discussion-image',
        contentType: 'image/png',
      }),
  );
  majorMediaOk(
    await request(http)
      .post(`${majorMediaPrefix}/upload-intents/${initial.intentId}/finalize`)
      .set('Authorization', auth)
      .send({}),
  );
  for (const kind of ['seal', 'process', 'review'] as const)
    assert.equal(await f.worker.runOne(kind), true);
  const response = await request(http)
    .get(`${majorMediaPrefix}/upload-intents/${initial.intentId}`)
    .set('Authorization', auth);
  majorMediaOk(response);
  const status = majorDiscussionMediaStatusSchema.parse(response.body);
  if (status.status !== 'ready_unbound') assert.fail(JSON.stringify(status));
  return {
    input,
    status,
    fact: { assetId: status.assetId, manifestDigest: status.manifestDigest },
  };
}
