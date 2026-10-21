import { withReadingWorkerRole } from './reading-worker-role.js';
import {
  readingCommentDetailSchema,
  readingReplyDetailSchema,
  readingReplyNodeSchema,
} from '../../src/community/reading-content/contracts.js';
import { textSourceReadV2Schema } from '../../src/community/reading-formatting/reader.js';
import { CurrentContentMediaProof } from '../../src/community/content-review/media-proof.js';
import { MediaAssetRepository } from '../../src/media/asset-repository.js';
/** Actual Media owner/binding/safety facts for an ordinary legacy image ancestor
 * of genuine v6 text-only source descendants. Test storage/issuer only; no
 * canonical, current Media, Review, or SQL guard is replaced. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { configureHttp } from '../../src/http/http.js';
import {
  ReadingFormattingRuntime,
  decodeCandidate,
} from '../../src/community/reading-formatting/runtime.js';
import type {
  QueueCursor,
  ReadingClaim,
} from '../../src/community/reading-formatting/runtime.js';
import { formatSource } from '../../src/community/reading-formatting/formatter.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { configureSyntheticCommunityMedia } from './media/runtime-fixture.js';
import { SyntheticMediaStorage } from './media/synthetic-storage.js';
import { SyntheticMediaIngressStorage } from './media/synthetic-ingress-storage.js';
import { SyntheticMediaWorker } from './media/synthetic-worker.js';
import { postApprovalEnvelope } from './community-runtime-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from './community-approval-fixtures.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';

interface Sharp {
  png(): Sharp;
  toBuffer(): Promise<Buffer>;
}
type SharpFactory = (input: {
  create: {
    width: number;
    height: number;
    channels: 3;
    background: { r: number; g: number; b: number };
  };
}) => Sharp;
export async function verifyReadingAncestorMedia(f: {
  /** Optional disposable least-privilege worker role; HTTP publication stays canonical. */
  workerRole?: string;
  /** Exercise the same canonical Media proof through versioned thread envelopes. */
  sourceAware?: boolean;
  pool: Pool;
  config: RuntimeConfig;
  actor: { accountId: string; accessToken: string };
  scope: { home: { spaceId: string } };
  decide: (id: string) => Promise<unknown>;
  rawComplete: (
    tx: PoolClient,
    id: string,
    leaseSeconds?: number,
  ) => Promise<string>;
}) {
  const storage = await SyntheticMediaStorage.create();
  let app: INestApplication | undefined;
  try {
    const builder = configureSyntheticCommunityMedia(
      Test.createTestingModule({ imports: [AppModule.register(f.config)] }),
      storage,
      new SyntheticMediaIngressStorage(storage),
    );
    app = (await builder.compile()).createNestApplication({ logger: false });
    configureHttp(app);
    await app.init();
    const http = app.getHttpServer(),
      auth = `Bearer ${f.actor.accessToken}`,
      runtime = app.get(ReadingFormattingRuntime);
    const sharpName = 'sharp',
      sharp = ((await import(sharpName)) as { default: SharpFactory }).default;
    const bytes = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 20, g: 100, b: 160 },
      },
    })
      .png()
      .toBuffer();
    const mediaWorker = new SyntheticMediaWorker(f.pool, storage, [
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    const prepared = await request(http)
      .post('/v1/media/upload-intents')
      .set('Authorization', auth)
      .send({
        clientRequestId: randomUUID(),
        purpose: 'community-post-image',
        draftId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        slot: 'images',
        ordinal: 0,
        declaration: { mime: 'image/png', bytes: bytes.length },
      });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    await mediaWorker.upload(f.actor.accountId, prepared.body.intentId, bytes);
    for (const stage of ['seal', 'process', 'review'] as const)
      assert.equal(await mediaWorker.runOne(stage), true);
    const ready = await request(http)
      .get(`/v1/media/upload-intents/${prepared.body.intentId}`)
      .set('Authorization', auth);
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    assert.equal(ready.body.status, 'ready');
    const assetId = ready.body.assetId as string,
      asset = (
        await f.pool.query(
          'SELECT manifest_digest,policy_revision FROM whaleu_media.assets WHERE id=$1',
          [assetId],
        )
      ).rows[0]!;
    const parentBody = {
      clientRequestId: randomUUID(),
      spaceId: f.scope.home.spaceId,
      category: 'discussion' as const,
      text: 'Real reviewed legacy image ancestor',
      imageAssetIds: [assetId],
      authorMode: 'named' as const,
      commentsPolicy: 'open' as const,
    };
    const policy = await seedReviewPolicy(f.pool);
    const envelope = await postApprovalEnvelope(
      app,
      f.pool,
      f.actor.accountId,
      parentBody,
    );
    await approveEnvelope(
      f.pool,
      {
        ...envelope,
        images: [{ assetId, digest: asset.manifest_digest as string }],
      },
      { policyRevisionId: policy },
    );
    // Real empty-to-first-binding race: capture the negative Media fact for
    // this newly created actual parent immediately before its real bind. The
    // native bind executes normally, but mandatory final proof must roll back.
    const originalBind = MediaAssetRepository.prototype.bind;
    let absenceObserved = false,
      bindingPerformed = false;
    MediaAssetRepository.prototype.bind = async function (
      accepted,
      parent,
      tx,
    ) {
      assert.equal(parent.ownerKind, 'community');
      if (parent.ownerKind !== 'community')
        throw new Error('Fixture requires Community parent');
      assert.equal(
        (
          await new CurrentContentMediaProof().absent(
            parent.resourceKind,
            parent.resourceId,
            tx,
          )
        ).kind,
        'allow',
      );
      absenceObserved = true;
      await originalBind.call(this, accepted, parent, tx);
      bindingPerformed = true;
    };
    try {
      const rejected = await request(http)
        .post('/v1/community/posts')
        .set('Authorization', auth)
        .send(parentBody);
      assert.equal(rejected.status, 503, JSON.stringify(rejected.body));
      assert.equal(rejected.body.error.code, 'MEDIA_UNAVAILABLE');
      assert.equal(
        bindingPerformed,
        true,
        'The real first binding executed before its final negative-proof rejection',
      );
      assert.equal(
        absenceObserved,
        true,
        'Actual Media absence leaf must have run before the real first bind',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT id FROM whaleu_media.bindings WHERE asset_id=$1',
            [assetId],
          )
        ).rowCount,
        0,
      );
    } finally {
      MediaAssetRepository.prototype.bind = originalBind;
    }
    const parent = await request(http)
      .post('/v1/community/posts')
      .set('Authorization', auth)
      .send(parentBody);
    assert.equal(parent.status, 201, JSON.stringify(parent.body));
    const createSource = async (
      path: string,
      extra: Record<string, unknown> = {},
    ) => {
      const body = {
        clientRequestId: randomUUID(),
        text: ('鲸'.repeat(119) + '。').repeat(3),
        imageAssetIds: [],
        authorMode: 'named',
        textSource: {
          version: 1,
          format: 'plain',
          readingFormatting: 'auto',
        },
        ...extra,
      };
      const submitted = await request(http)
        .post(path.replace('/v1/community/', '/v1/community/reviews/'))
        .set('Authorization', auth)
        .send(body);
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
      assert.equal(submitted.body.status, 'pending');
      await f.decide(body.clientRequestId);
      const published = await request(http)
        .post(path)
        .set('Authorization', auth)
        .send(body);
      assert.equal(published.status, 201, JSON.stringify(published.body));
      return published.body.resourceId as string;
    };
    const root = await createSource(
        `/v1/community/posts/${parent.body.resourceId}/comments`,
      ),
      reply = await createSource(`/v1/community/comments/${root}/replies`, {
        targetReplyId: null,
      });
    const find = async (id: string) => {
      let cursor: QueueCursor | null = null;
      for (let page = 0; page < 32; page++) {
        const rows = await runtime.candidates(cursor);
        if (!rows.length) break;
        for (const raw of rows) {
          const { schedule, job } = decodeCandidate(raw);
          if (job.success && job.data.content_id === id) return raw;
          cursor = {
            jobKey: schedule.job_key,
            nextProbeAt: schedule.next_probe_at,
          };
        }
      }
      throw new Error('Missing due descendant');
    };
    const plan = (claim: ReadingClaim) => {
      const result = formatSource(claim.source);
      assert.equal(result.kind, 'plan');
      if (result.kind !== 'plan') throw new Error('Missing plan');
      return result.plan;
    };
    const graph = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object('jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY job_key) FROM whaleu_community.reading_format_jobs j),'results',(SELECT jsonb_agg(to_jsonb(r) ORDER BY job_key) FROM whaleu_community.reading_format_results r),'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY content_kind,content_id) FROM whaleu_community.community_text_sources s),'slots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY slot_id) FROM whaleu_community.reading_format_slots s)) value`,
        )
      ).rows[0]!.value;
    const append = async (
      tx: PoolClient,
      state: 'allow' | 'revoked',
      seconds = 3600,
    ) => {
      const revision =
          Number(
            (
              await tx.query(
                'SELECT revision FROM whaleu_media.asset_safety_heads WHERE asset_id=$1 FOR UPDATE',
                [assetId],
              )
            ).rows[0]!.revision,
          ) + 1,
        event = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) VALUES($1::uuid,$2,$3,$4,$5,$6,'reading-ancestor-media-fixture',($1::uuid)::text,'{}',clock_timestamp()-interval '1 second',clock_timestamp()+$7::double precision*interval '1 second')`,
        [
          event,
          assetId,
          revision,
          state,
          asset.manifest_digest,
          asset.policy_revision,
          seconds,
        ],
      );
      await tx.query(
        'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
        [assetId, revision, event],
      );
    };
    const read = async (kind: string, id: string) => {
      const response = await request(http)
        .get(
          f.sourceAware
            ? `/v2/community/${kind === 'comment' ? 'comments' : 'replies'}/${id}`
            : `/v2/community/text-sources/${kind}/${id}`,
        )
        .set('Authorization', auth);
      if (!f.sourceAware || response.status !== 200) return response;
      // Validate the real envelope before adapting assertions shared with the
      // standalone source reader. Do not replace access or final owner proof.
      const node =
        kind === 'comment'
          ? readingCommentDetailSchema.parse(response.body)
          : readingReplyDetailSchema.parse(response.body);
      assert.equal(node.content.id, id);
      assert.equal(node.body.classification, 'reviewedSource');
      if (node.body.classification !== 'reviewedSource')
        throw new Error('Missing source evidence');
      return { ...response, body: node.body.value };
    };
    const raw = await find(reply),
      before = await graph(),
      held = await f.pool.connect();
    try {
      await held.query('BEGIN');
      await held.query(
        'SELECT * FROM whaleu_media.asset_safety_heads WHERE asset_id=$1 FOR UPDATE',
        [assetId],
      );
      await assert.rejects(runtime.claim(raw));
      assert.deepEqual(await graph(), before);
    } finally {
      await held.query('ROLLBACK');
      held.release();
    }
    const asWorker = <T>(run: () => Promise<T>) =>
      f.workerRole
        ? withReadingWorkerRole(app!.get(DatabaseService), f.workerRole, run)
        : run();
    const claim = await asWorker(() => runtime.claim(raw));
    assert.ok(claim);
    const claimed = await graph();
    await withCommunityScopeWriter(f.pool, (tx) => append(tx, 'revoked'));
    let revocationFailure: unknown;
    let revocationCleanupFailure: unknown;
    try {
      await assert.rejects(runtime.complete(claim, plan(claim)));
      for (const [kind, id] of [
        ['comment', root],
        ['reply', reply],
      ]) {
        const denied = await read(kind!, id!);
        assert.notEqual(denied.status, 200);
        for (const key of ['source', 'presentation', 'sourceHash', 'text'])
          assert.equal(Object.hasOwn(denied.body, key), false);
      }
      assert.deepEqual(
        await graph(),
        claimed,
        'Revocation/reader denial must not mutate any source, job, slot or result',
      );
    } catch (error) {
      revocationFailure = error;
    } finally {
      try {
        await withCommunityScopeWriter(f.pool, (tx) => append(tx, 'allow'));
      } catch (cleanupError) {
        revocationCleanupFailure = cleanupError;
      }
    }
    if (
      revocationFailure !== undefined &&
      revocationCleanupFailure !== undefined
    )
      throw new AggregateError(
        [revocationFailure, revocationCleanupFailure],
        'Media revocation and isolation cleanup both failed',
        { cause: revocationFailure },
      );
    if (revocationFailure !== undefined) throw revocationFailure;
    if (revocationCleanupFailure !== undefined) throw revocationCleanupFailure;
    assert.equal(
      await asWorker(() => runtime.complete(claim, plan(claim))),
      true,
    );
    const formatted = await read('reply', reply);
    assert.equal(formatted.status, 200, JSON.stringify(formatted.body));
    assert.equal(formatted.body.presentation.status, 'formatted');
    // Change an ancestor's current Media fact after optional lookup, not just the
    // target's own empty image array. Mandatory canonical proof must reject all.
    const database = app.get(DatabaseService),
      original = database.transaction.bind(database);
    const safetyHead = async () =>
      (
        await f.pool.query(
          'SELECT to_jsonb(h) value FROM whaleu_media.asset_safety_heads h WHERE asset_id=$1',
          [assetId],
        )
      ).rows[0]!.value;
    const beforeInjection = await safetyHead();
    let injected = 0;
    let primaryFailure: unknown;
    let cleanupFailure: unknown;
    database.transaction = (operation, options) =>
      original(async (tx) => {
        const result = await operation(tx);
        const node = f.sourceAware
          ? readingReplyNodeSchema.safeParse(result)
          : null;
        const parsed = textSourceReadV2Schema.safeParse(
          f.sourceAware
            ? node?.success &&
              node.data.body.classification === 'reviewedSource'
              ? node.data.body.value
              : null
            : result,
        );
        if (
          parsed.success &&
          parsed.data.source.kind === 'reply' &&
          parsed.data.source.id === reply
        ) {
          assert.equal(parsed.data.presentation.status, 'formatted');
          assert.equal(injected, 0);
          await append(tx, 'revoked');
          injected++;
        }
        return result;
      }, options);
    try {
      const denied = await read('reply', reply);
      assert.equal(
        injected,
        1,
        'Exact descendant read must reach the Media mutation',
      );
      assert.equal(denied.status, 503, JSON.stringify(denied.body));
      for (const key of ['source', 'presentation', 'text'])
        assert.equal(Object.hasOwn(denied.body, key), false);
      assert.deepEqual(
        await safetyHead(),
        beforeInjection,
        'Mandatory Media final proof must roll back its mutation',
      );
    } catch (error) {
      primaryFailure = error;
    } finally {
      database.transaction = original;
      try {
        // Retain the original failure if cleanup also fails. Never hide a
        // committed mutation by appending a replacement allow before asserting.
        if (
          JSON.stringify(await safetyHead()) !== JSON.stringify(beforeInjection)
        )
          await withCommunityScopeWriter(f.pool, (tx) => append(tx, 'allow'));
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
    }
    if (primaryFailure !== undefined && cleanupFailure !== undefined)
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        'Media race and isolation cleanup both failed',
        { cause: primaryFailure },
      );
    if (primaryFailure !== undefined) throw primaryFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
    const afterInjection = await read('reply', reply);
    assert.equal(
      afterInjection.status,
      200,
      JSON.stringify(afterInjection.body),
    );
    assert.equal(afterInjection.body.presentation.status, 'formatted');
    // The ordinary deferred SQL path must re-evaluate expired ancestor Media,
    // independently of an accepted lease that is still live for ten seconds.
    await withCommunityScopeWriter(f.pool, (tx) => append(tx, 'allow', 3));
    const tx = await f.pool.connect();
    try {
      await tx.query('BEGIN');
      await f.rawComplete(tx, root, 10);
      await tx.query(
        'SELECT pg_sleep(GREATEST(0,extract(epoch FROM e.valid_until-clock_timestamp()))+0.02) FROM whaleu_media.asset_safety_events e JOIN whaleu_media.asset_safety_heads h ON h.event_id=e.id WHERE h.asset_id=$1',
        [assetId],
      );
      await assert.rejects(
        tx.query('COMMIT'),
        /expired before deferred closure/,
      );
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
    const expired = await read('reply', reply);
    assert.notEqual(expired.status, 200);
    assert.equal(Object.hasOwn(expired.body, 'source'), false);
    await withCommunityScopeWriter(f.pool, (tx) => append(tx, 'allow'));
    const rootClaim = await runtime.claim(await find(root));
    assert.ok(rootClaim);
    assert.equal(await runtime.complete(rootClaim, plan(rootClaim)), true);
  } finally {
    await app?.close();
    await storage.dispose();
  }
}
