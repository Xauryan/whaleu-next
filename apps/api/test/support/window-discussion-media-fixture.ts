import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { inTransaction } from '../../src/database/database.js';
import { windowDiscussionFixture } from './window-discussion-fixture.js';
import { syntheticMediaRuntimeFixture } from './media/runtime-fixture.js';
import { WINDOW_DISCUSSION_MEDIA_RUNTIME } from '../../src/ratings/windows/discussion/media/facade.js';
import {
  windowDiscussionMediaStatusSchema,
  windowDiscussionMediaGrantSchema,
  WINDOW_DISCUSSION_MEDIA_PROTOCOL,
} from '../../src/media/contracts-window-discussion.js';
import { windowDiscussionMediaReviewDigest } from '../../src/community/content-review/window-discussion-media-review.facade.js';
import type {
  WindowRootPublishV2,
  WindowReplyPublishV2,
} from '../../src/ratings/windows/discussion/contracts-v2.js';
import { sha256 } from '../../src/media/processing/protocol.js';
export async function windowDiscussionMediaFixture(
  fixtures: readonly {
    sha256: string;
    verdict: 'allow' | 'held' | 'revoked';
  }[],
  configure?: (builder: TestingModuleBuilder) => void,
) {
  const media = await syntheticMediaRuntimeFixture(fixtures, {
    configureTestModule(builder, { storage, ingressStorage }) {
      builder
        .overrideProvider(WINDOW_DISCUSSION_MEDIA_RUNTIME)
        .useValue({ planning: ingressStorage, storage, ingressStorage });
      configure?.(builder);
    },
  });
  const window = await windowDiscussionFixture(media);
  return { ...media, ...window };
}
export type WindowDiscussionMediaFixture = Awaited<
  ReturnType<typeof windowDiscussionMediaFixture>
>;
export const windowMediaPrefix = '/v3/media/window-discussions';
export function windowMediaOk(
  response: { status: number; body: unknown },
  status = 200,
) {
  assert.equal(response.status, status, JSON.stringify(response.body));
}
export async function reviewWindowDiscussionV2(
  pool: Pool,
  actorId: string,
  windowId: string,
  command: WindowRootPublishV2 | WindowReplyPublishV2,
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
              'SELECT actor_id FROM whaleu_ratings.window_discussion_comments WHERE id=$1',
              [target],
            )
          ).rows[0]?.actor_id ?? null)
        : null,
      envelope = {
        version: 2 as const,
        purpose: rootId
          ? ('window.discussion.reply.v2' as const)
          : ('window.discussion.root.v2' as const),
        actorId,
        requestId: command.clientRequestId,
        windowId,
        catalogRevision: command.expectedCatalogRevision,
        windowRevision: command.expectedWindowRevision,
        body: command.body,
        images: command.images,
        rootId,
        replyToReplyId: target,
        replyToActorId,
      };
    await tx.query(
      "INSERT INTO whaleu_community.window_discussion_media_review_policies(id,issuer,source_reference,coverage,valid_from,valid_until) VALUES($1,'synthetic:local-window-discussion-review','synthetic:no-live-provider','complete',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '2 hours')",
      [policy],
    );
    await tx.query(
      'INSERT INTO whaleu_community.window_discussion_media_review_decisions(id,actor_id,request_id,window_id,catalog_id,window_revision,purpose,root_id,reply_to_reply_id,reply_to_actor_id,body,images,policy_id,verdict,digest,issued_at,consume_until,visibility_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,coalesce($16::timestamptz,clock_timestamp()),$17,$18)',
      [
        id,
        actorId,
        command.clientRequestId,
        windowId,
        command.expectedCatalogRevision,
        command.expectedWindowRevision,
        envelope.purpose,
        rootId,
        target,
        replyToActorId,
        command.body,
        JSON.stringify(command.images),
        policy,
        verdict,
        windowDiscussionMediaReviewDigest(envelope),
        options.issuedAt ?? null,
        options.consumeUntil ?? new Date(Date.now() + 3600000),
        options.visibilityUntil ?? new Date(Date.now() + 3600000),
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_community.window_discussion_media_review_heads(actor_id,request_id,decision_id,state) VALUES($1,$2,$3,'active') ON CONFLICT(actor_id,request_id) DO UPDATE SET decision_id=EXCLUDED.decision_id,state='active'",
      [actorId, command.clientRequestId, id],
    );
    return id;
  });
}
export async function readyWindowDiscussionImage(
  f: WindowDiscussionMediaFixture,
  actor: { accountId: string; accessToken: string },
  context: {
    publicationRequestId: string;
    windowId: string;
    catalogRevision: string;
    windowRevision: string;
    rootId: string | null;
    replyToReplyId: string | null;
    ordinal: number;
  },
  bytes: Buffer,
) {
  const input = {
      protocol: WINDOW_DISCUSSION_MEDIA_PROTOCOL,
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
    .post(`${windowMediaPrefix}/upload-intents`)
    .set('Authorization', auth)
    .send(input);
  windowMediaOk(prepare);
  const initial = windowDiscussionMediaStatusSchema.parse(prepare.body);
  const granted = await request(http)
    .post(`${windowMediaPrefix}/upload-intents/${initial.intentId}/grant`)
    .set('Authorization', auth)
    .send({});
  windowMediaOk(granted);
  const grant = windowDiscussionMediaGrantSchema.parse(granted.body);
  windowMediaOk(
    await request(http)
      .post(
        `${windowMediaPrefix}/upload-intents/${initial.intentId}/uploads/${grant.grantId}`,
      )
      .set('Authorization', auth)
      .attach('file', bytes, {
        filename: 'synthetic-window-discussion-image',
        contentType: 'image/png',
      }),
  );
  windowMediaOk(
    await request(http)
      .post(`${windowMediaPrefix}/upload-intents/${initial.intentId}/finalize`)
      .set('Authorization', auth)
      .send({}),
  );
  for (const kind of ['seal', 'process', 'review'] as const)
    assert.equal(await f.worker.runOne(kind), true);
  const response = await request(http)
    .get(`${windowMediaPrefix}/upload-intents/${initial.intentId}`)
    .set('Authorization', auth);
  windowMediaOk(response);
  const status = windowDiscussionMediaStatusSchema.parse(response.body);
  if (status.status !== 'ready_unbound') assert.fail(JSON.stringify(status));
  return {
    input,
    status,
    fact: { assetId: status.assetId, manifestDigest: status.manifestDigest },
  };
}
