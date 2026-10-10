import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import {
  postApprovalEnvelope,
  discussionApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import { seedExactContent } from '../support/exact-discovery-counts.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { SearchService } from '../../src/community/search/service.js';
import { searchQuerySchema } from '../../src/community/search/contracts.js';
import type { SearchCandidate } from '../../src/community/search/repository.js';
import { LocalApprovedContentVisibility } from '../../src/community/content-review/local-approved-content-visibility.js';
import { canonicalEnvelope } from '../../src/community/content-review/contracts.js';
import { ContentReviewSearchEligibilityFacade } from '../../src/community/content-review/search-eligibility.facade.js';
import { CampusContentScopeFacade } from '../../src/campus/content-scope.facade.js';
import { MediaContentSnapshotFacade } from '../../src/media/content-snapshot.facade.js';
import { SafetySearchEligibilityFacade } from '../../src/safety/search-eligibility.facade.js';
import {
  SemanticSearchEngine,
  fullCorpusScopeAuthority,
} from '../../src/community/search/semantic/engine.js';
import { SemanticCorpusRepository } from '../../src/community/search/semantic/corpus-repository.js';
import { SemanticIndexRepository } from '../../src/community/search/semantic/repository.js';
import { QwenSemanticProvider } from '../../src/community/search/semantic/provider.js';
import type { QwenSemanticTransport } from '../../src/community/search/semantic/provider.js';
import { createQwenSemanticProfile } from '../../src/community/search/semantic/profile.js';
import { installSemanticSearch } from '../../src/community/search/semantic/install.js';
import {
  captureSemanticMediaProof,
  requireSemanticMediaProof,
} from '../../src/community/search/semantic/eligibility-proof.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../../src/database/transaction-deadlines.js';

interface FixtureSharp {
  png(): FixtureSharp;
  toBuffer(): Promise<Buffer>;
}
type FixtureFactory = (input: {
  create: {
    width: number;
    height: number;
    channels: 3;
    background: { r: number; g: number; b: number };
  };
}) => FixtureSharp;
const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'COMMUNITY_UNAVAILABLE';
const vector = (at: number) =>
  Array.from({ length: 4096 }, (_, index) => (index === at ? 1 : 0));

test(
  'Media-bound semantic certificates cover single-image ancestry, negative scope and text-vector reuse',
  { timeout: 240000 },
  async (t) => {
    const name = 'sharp';
    const sharp = ((await import(name)) as { default: FixtureFactory }).default;
    const bytes = await sharp({
      create: {
        width: 80,
        height: 60,
        channels: 3,
        background: { r: 20, g: 100, b: 160 },
      },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    let installed = false;
    try {
      const author = await f.actor(),
        reader = await f.actor();
      const http = f.app.getHttpServer(),
        spaceId = f.scope.home.spaceId;
      const policy = await seedReviewPolicy(f.pool);
      const publishImage = async (text: string) => {
        const prepared = await request(http)
          .post('/v1/media/upload-intents')
          .set('Authorization', `Bearer ${author.accessToken}`)
          .send({
            clientRequestId: randomUUID(),
            purpose: 'community-post-image',
            draftId: randomUUID(),
            spaceId,
            slot: 'images',
            ordinal: 0,
            declaration: { mime: 'image/png', bytes: bytes.length },
          });
        assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
        await f.worker.upload(
          author.accountId,
          prepared.body.intentId as string,
          bytes,
        );
        for (const stage of ['seal', 'process', 'review'] as const)
          assert.equal(await f.worker.runOne(stage), true);
        const ready = await request(http)
          .get(`/v1/media/upload-intents/${prepared.body.intentId}`)
          .set('Authorization', `Bearer ${author.accessToken}`);
        assert.equal(ready.status, 200, JSON.stringify(ready.body));
        assert.equal(ready.body.status, 'ready');
        const assetId = ready.body.assetId as string;
        const digest = (
          await f.pool.query<{ manifest_digest: string }>(
            'SELECT manifest_digest FROM whaleu_media.assets WHERE id=$1',
            [assetId],
          )
        ).rows[0]!.manifest_digest;
        const body = {
          clientRequestId: randomUUID(),
          spaceId,
          category: 'discussion' as const,
          text,
          imageAssetIds: [assetId],
          authorMode: 'named' as const,
          commentsPolicy: 'open' as const,
        };
        const envelope = await postApprovalEnvelope(
          f.app,
          f.pool,
          author.accountId,
          body,
        );
        await approveEnvelope(f.pool, {
          ...envelope,
          images: [{ assetId, digest }],
        });
        const response = await request(http)
          .post('/v1/community/posts')
          .set('Authorization', `Bearer ${author.accessToken}`)
          .send(body);
        assert.equal(response.status, 201, JSON.stringify(response.body));
        return { id: response.body.resourceId as string, assetId, digest };
      };
      const image = await publishImage('needle image source'),
        imageParent = await publishImage('needle image parent');
      const commentBody = {
        clientRequestId: randomUUID(),
        text: 'needle plain comment of an image parent',
        imageAssetIds: [],
        authorMode: 'named' as const,
      };
      await approveEnvelope(
        f.pool,
        await discussionApprovalEnvelope(
          f.app,
          f.pool,
          reader.accountId,
          imageParent.id,
          commentBody,
        ),
      );
      const child = await request(http)
        .post(`/v1/community/posts/${imageParent.id}/comments`)
        .set('Authorization', `Bearer ${reader.accessToken}`)
        .send(commentBody);
      assert.equal(child.status, 201, JSON.stringify(child.body));
      const childId = child.body.resourceId as string;
      const plain = await postApprovalEnvelope(
        f.app,
        f.pool,
        author.accountId,
        {
          clientRequestId: randomUUID(),
          spaceId,
          category: 'discussion',
          text: 'needle plain seed',
          imageAssetIds: [],
          authorMode: 'named',
          commentsPolicy: 'open',
        },
      );
      await seedExactContent(f.pool, policy, 'post', 33, (index) => ({
        ...plain,
        text: `needle plain ${index}`,
      }));
      await installSemanticSearch(f.pool);
      installed = true;
      const searches = f.app.get(SearchService),
        index = new SemanticIndexRepository();
      const certificates = new ContentReviewSearchEligibilityFacade(
        f.app.get(LocalApprovedContentVisibility),
        f.app.get(CampusContentScopeFacade),
        new MediaContentSnapshotFacade(),
      );
      const corpus = new SemanticCorpusRepository(
        new SafetySearchEligibilityFacade(),
      );
      const profile = createQwenSemanticProfile({
        providerId: 'offline-fixture',
        deploymentId: 'media-discovery',
        deploymentRevision: 'fixture-v1',
        embeddingModelRevision: 'fixture-v1',
        rerankerModelRevision: 'fixture-v1',
      });
      let embeds = 0,
        duringRerank: (() => Promise<void>) | undefined;
      const reranked: string[][] = [];
      const transport: QwenSemanticTransport = {
        embed: async (envelope) => {
          embeds++;
          return {
            profileIdentity: envelope.profileIdentity,
            indexSpaceKey: envelope.indexSpaceKey,
            response: {
              model: envelope.request.model,
              data: envelope.request.input.map((text, index) => ({
                index,
                embedding: vector(text.includes('image') ? 1 : 0),
              })),
            },
          };
        },
        rerank: async (envelope) => {
          reranked.push(envelope.request.documents.map((doc) => doc.text));
          await duringRerank?.();
          return {
            profileIdentity: envelope.profileIdentity,
            indexSpaceKey: envelope.indexSpaceKey,
            response: {
              model: envelope.request.model,
              results: envelope.request.documents.map((doc, index) => ({
                index,
                id: doc.id,
                score: -index,
              })),
            },
          };
        },
      };
      const provider = new QwenSemanticProvider(profile, transport);
      const engine = new SemanticSearchEngine(
        provider,
        index,
        fullCorpusScopeAuthority(
          searches,
          index,
          certificates,
          corpus,
          profile,
        ),
        'local_fixture',
        certificates,
      );
      const query = searchQuerySchema.parse({
        spaceId,
        type: 'all',
        q: 'needle',
        limit: '1',
      });
      const token = reader.accessToken;
      const read = <T>(run: (tx: PoolClient) => Promise<T>) =>
        inTransaction(
          f.pool,
          async (tx) => {
            await lockSafetyPolicy(tx);
            return run(tx);
          },
          { isolationLevel: 'read committed' },
        );
      const candidate = async (
        kind: 'post' | 'comment',
        id: string,
      ): Promise<SearchCandidate> => {
        const row = (
          await f.pool.query<{ at: string }>(
            `SELECT to_char(${kind === 'post' ? 'published_at' : 'created_at'} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM whaleu_community.${kind === 'post' ? 'posts' : 'root_comments'} WHERE id=$1`,
            [id],
          )
        ).rows[0]!;
        return {
          kind,
          id,
          postId: kind === 'post' ? id : imageParent.id,
          rootCommentId: kind === 'post' ? null : id,
          spaceId,
          at: row.at,
        };
      };
      const imageCandidate = await candidate('post', image.id),
        parentCandidate = await candidate('post', imageParent.id),
        childCandidate = await candidate('comment', childId);
      const recertify = (subject: SearchCandidate) =>
        read(async (tx) => {
          const result = await certificates.captureEligibilityV2(
            subject,
            profile,
            tx,
          );
          assert.notEqual(result.decision, 'unknown');
          assert.ok(result.certificate);
          await certificates.persist(result.certificate, tx);
          return result.certificate;
        });
      const safety = async (state: 'allow' | 'held' | 'revoked') =>
        withCommunityScopeWriter(f.pool, async (tx) => {
          const head = (
            await tx.query<{ revision: string; valid_until: Date }>(
              `SELECT h.revision::text,e.valid_until FROM whaleu_media.asset_safety_heads h JOIN whaleu_media.asset_safety_events e ON e.id=h.event_id WHERE h.asset_id=$1 FOR UPDATE OF h`,
              [image.assetId],
            )
          ).rows[0]!;
          const revision = Number(head.revision) + 1;
          const event = randomUUID();
          await tx.query(
            `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
        VALUES($1,$2,$3,$4,$5,'media-static-v1','registered-synthetic-media',$6,'{}',clock_timestamp()-interval '2 hours',$7)`,
            [
              event,
              image.assetId,
              revision,
              state,
              image.digest,
              `${state}:${event}`,
              head.valid_until,
            ],
          );
          await tx.query(
            'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
            [image.assetId, revision, event],
          );
        });
      await t.test(
        'empty image posts retain nonempty public and canonical contracts and cannot mint certificates',
        async () => {
          const before = (
            await f.pool.query(
              'SELECT count(*)::integer AS n FROM whaleu_community.posts',
            )
          ).rows[0]!.n;
          const rejected = await request(http)
            .post('/v1/community/posts')
            .set('Authorization', `Bearer ${author.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              spaceId,
              category: 'discussion',
              text: '',
              imageAssetIds: [image.assetId],
              authorMode: 'named',
              commentsPolicy: 'open',
            });
          assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
          assert.throws(() =>
            canonicalEnvelope({
              ...plain,
              text: '',
              images: [{ assetId: image.assetId, digest: image.digest }],
            }),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::integer AS n FROM whaleu_community.posts',
              )
            ).rows[0]!.n,
            before,
          );
          const absentId = randomUUID();
          await assert.rejects(
            read(async (tx) =>
              certificates.captureEligibilityV2(
                {
                  ...imageCandidate,
                  id: absentId,
                  postId: absentId,
                },
                profile,
                tx,
              ),
            ),
            unavailable,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_semantic.certificates_v2 WHERE content_id=$1',
                [absentId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'mixed v1/v2 indexing includes single-image parent certificates and plain child vectors',
        async () => {
          assert.equal((await engine.indexScope(token, query)).indexed, 36);
          const version = (
            await f.pool.query<{
              certificate_version: number;
              media_chain: { attachments: unknown[] }[];
            }>(
              'SELECT certificate_version,media_chain FROM whaleu_semantic.certificates_v2 WHERE content_id=$1',
              [childId],
            )
          ).rows[0]!;
          assert.equal(version.certificate_version, 2);
          assert.equal(version.media_chain.length, 2);
          assert.equal(version.media_chain[0]!.attachments.length, 1);
          assert.deepEqual(version.media_chain[1]!.attachments, []);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_semantic.embeddings WHERE content_id=$1',
                [imageParent.id],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (await f.pool.query('SELECT 1 FROM whaleu_semantic.certificates'))
              .rowCount,
            33,
          );
          assert.equal((await engine.search(token, query)).items.length, 1);
          assert.equal(
            reranked.at(-1)!.some((text) => text.includes('image')),
            false,
            'All three image-dependent bodies lie outside the rerank top32',
          );
          const childQuery = searchQuerySchema.parse({
            spaceId,
            type: 'comment',
            postId: imageParent.id,
            q: 'needle',
          });
          assert.equal(
            (await engine.search(token, childQuery)).items[0]?.contentId,
            childId,
          );
          const disabled = await request(http)
            .get('/v1/community/search/semantic')
            .query({ spaceId, q: 'needle' });
          assert.equal(disabled.body.error.code, 'SEMANTIC_SEARCH_DISABLED');
        },
      );
      const oldV1 = (
        await f.pool.query(
          'SELECT to_jsonb(c)::text AS bytes FROM whaleu_semantic.certificates c ORDER BY content_id',
        )
      ).rows;
      const oldVector = (
        await f.pool.query(
          'SELECT embedding::text,source_revision::text,body_digest FROM whaleu_semantic.embeddings WHERE content_id=$1',
          [image.id],
        )
      ).rows;
      await t.test(
        'non-top32 image post and image ancestor missing certificates fail fullscope coverage',
        async () => {
          await f.pool.query(
            'DELETE FROM whaleu_semantic.certificates_v2 WHERE content_id=$1',
            [image.id],
          );
          await assert.rejects(engine.search(token, query), unavailable);
          await recertify(imageCandidate);
          await f.pool.query(
            'DELETE FROM whaleu_semantic.certificates_v2 WHERE content_id=$1',
            [imageParent.id],
          );
          await assert.rejects(engine.search(token, query), unavailable);
          await recertify(parentCandidate);
          assert.equal((await engine.search(token, query)).items.length, 1);
        },
      );
      await t.test(
        'negative head changes during provider waits fail even when allowed ranks are unchanged',
        async () => {
          await safety('held');
          assert.equal((await engine.search(token, query)).items.length, 1);
          duringRerank = async () => {
            await safety('revoked');
          };
          await assert.rejects(engine.search(token, query), unavailable);
          duringRerank = undefined;
          await safety('allow');
          await assert.rejects(
            engine.search(token, query),
            unavailable,
            'Restoration cannot revive the old head certificate',
          );
          const calls = embeds;
          await recertify(imageCandidate);
          assert.equal(
            embeds,
            calls,
            'Media-only recertification never invokes a model',
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT embedding::text,source_revision::text,body_digest FROM whaleu_semantic.embeddings WHERE content_id=$1',
                [image.id],
              )
            ).rows,
            oldVector,
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT to_jsonb(c)::text AS bytes FROM whaleu_semantic.certificates c ORDER BY content_id',
              )
            ).rows,
            oldV1,
          );
          assert.equal((await engine.search(token, query)).items.length, 1);
        },
      );
      await t.test(
        'v2 JSON reconstruction and rollback-era capture cannot persist',
        async () => {
          await read(async (tx) => {
            const result = await certificates.captureEligibilityV2(
              childCandidate,
              profile,
              tx,
            );
            assert.ok(result.certificate);
            await assert.rejects(
              certificates.persist({ ...result.certificate }, tx),
              unavailable,
            );
            const checkpoint = checkpointTransactionDeadlines(tx);
            await tx.query('SAVEPOINT semantic_brand');
            await tx.query('ROLLBACK TO SAVEPOINT semantic_brand');
            restoreTransactionDeadlines(tx, checkpoint);
            await tx.query('RELEASE SAVEPOINT semantic_brand');
            await assert.rejects(
              certificates.persist(result.certificate, tx),
              unavailable,
            );
          });
        },
      );
      await t.test(
        'whole-scope Media final fence rejects a real writer waiting behind the reader policy gate',
        async () => {
          const writer = await f.pool.connect();
          let pending: Promise<{ error?: unknown }> | undefined;
          try {
            await writer.query('BEGIN');
            const writerPid = (
              await writer.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              )
            ).rows[0]!.pid;
            await assert.rejects(
              read(async (tx) => {
                // Retain the ordinary Safety SHARE gate. A raw Media writer
                // obtains its relation lock before its statement trigger waits
                // for this reader's common-policy gate.
                await captureSemanticMediaProof(tx);
                requireSemanticMediaProof(tx);
                const readerPid = (
                  await tx.query<{ pid: number }>(
                    'SELECT pg_backend_pid() AS pid',
                  )
                ).rows[0]!.pid;
                pending = writer
                  .query('DELETE FROM whaleu_media.bindings WHERE false')
                  .then(
                    () => ({}),
                    (error: unknown) => ({ error }),
                  );
                let blocked = false;
                const deadline = Date.now() + 2000;
                while (!blocked && Date.now() < deadline) {
                  blocked =
                    (
                      await f.pool.query<{ blocked: boolean }>(
                        `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='relation'
                       AND relation='whaleu_media.bindings'::regclass AND mode='RowExclusiveLock' AND granted)
                     AND EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted)
                     AND $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked`,
                        [writerPid, readerPid],
                      )
                    ).rows[0]?.blocked === true;
                  if (!blocked) await sleep(5);
                }
                assert.equal(
                  blocked,
                  true,
                  'Writer must hold bindings RowExclusive and wait on this reader before finalization',
                );
                // Do not await the writer here. Final Media SHARE NOWAIT must
                // fail on its relation lock, rolling back this read and releasing
                // the common-policy gate so that the writer can finish.
              }),
              unavailable,
            );
            assert.ok(pending);
            const result = await pending;
            if (result.error) throw result.error;
            await writer.query('COMMIT');
          } finally {
            if (pending) await pending;
            await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );
    } finally {
      if (installed) await f.pool.query('DROP SCHEMA whaleu_semantic CASCADE');
      await f.close();
    }
  },
);
