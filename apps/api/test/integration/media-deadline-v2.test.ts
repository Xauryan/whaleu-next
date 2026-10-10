import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool, PoolClient, QueryResult } from 'pg';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import { SyntheticMediaWorker } from '../support/media/synthetic-worker.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { CommunityMediaOwner } from '../../src/community/media/owner.js';
import { CommunityMediaAttachmentAdapter } from '../../src/community/media/attachment-adapter.js';
import { MEDIA_ATTACHMENT } from '../../src/community/community-policy.js';
import { MediaPrepareScopes } from '../../src/media/prepare-scope.js';
import { MediaIntentRepository } from '../../src/media/intent-repository.js';
import { MediaLifecycleRepository } from '../../src/media/lifecycle-repository.js';
import { prepareMediaV2Schema } from '../../src/media/contracts-v2.js';
import { sha256 } from '../../src/media/processing/protocol.js';

const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 12_000;
type Fixture = Awaited<ReturnType<typeof syntheticMediaRuntimeFixture>>;
type Actor = Awaited<ReturnType<Fixture['actor']>>;
type Timing = 'operation' | 'asset' | 'draft';

/** Timestamp-only fixture instrumentation of initial INSERTs. All immutable,
 * scope, manifest, quota, lifecycle and deferred guards remain enabled. Nothing
 * updates historical fields or replaces clock_timestamp(), current authority,
 * decoding, Media Review or publication Review. The asset-retention cases are
 * deliberately backdated retention snapshots, not a claim that the real upload
 * process ran for 24 hours; the resulting cutoff is crossed in real PG time. */
function initialTimestampFixture(tx: PoolClient, timing: Timing): () => void {
  const original = tx.query;
  const run = original.bind(tx) as (
    sql: string,
    values?: unknown[],
  ) => Promise<QueryResult>;
  tx.query = (async (sql: string, values?: unknown[]) => {
    let rewritten = sql;
    let parameters = values;
    if (
      timing === 'operation' &&
      sql.includes('INSERT INTO whaleu_media.upload_intents')
    ) {
      assert.ok(sql.includes('declared_sha256)'));
      assert.ok(sql.includes("clock_timestamp()+interval '30 minutes'"));
      assert.ok(values);
      assert.equal(values.length, 20);
      rewritten = sql
        .replace('declared_sha256)', 'declared_sha256,created_at)')
        .replace(
          "clock_timestamp()+interval '30 minutes'",
          "statement_timestamp()+$21::double precision*interval '1 millisecond'",
        )
        .replace(
          '$18,$19,$20)',
          "$18,$19,$20,statement_timestamp()-interval '30 minutes'+$21::double precision*interval '1 millisecond')",
        );
      parameters = [...values, WINDOW];
    } else if (
      timing === 'draft' &&
      sql.includes('INSERT INTO whaleu_community.media_drafts')
    ) {
      assert.ok(sql.includes('scope_revision,expires_at)'));
      assert.ok(sql.includes("clock_timestamp()+interval '24 hours'"));
      assert.ok(values);
      assert.equal(values.length, 5);
      rewritten = sql
        .replace(
          'scope_revision,expires_at)',
          'scope_revision,expires_at,created_at)',
        )
        .replace(
          "clock_timestamp()+interval '24 hours')",
          "statement_timestamp()+$6::double precision*interval '1 millisecond',statement_timestamp()-interval '24 hours'+$6::double precision*interval '1 millisecond')",
        );
      parameters = [...values, WINDOW];
    } else if (
      timing === 'asset' &&
      sql.includes('INSERT INTO whaleu_media.assets(')
    ) {
      assert.ok(sql.includes('manifest_digest,manifest)'));
      assert.ok(sql.includes('$5::jsonb FROM'));
      assert.ok(values);
      assert.equal(values.length, 5);
      rewritten = sql
        .replace(
          'manifest_digest,manifest)',
          'manifest_digest,manifest,created_at)',
        )
        .replace(
          '$5::jsonb FROM',
          "$5::jsonb,statement_timestamp()-interval '24 hours'+$6::double precision*interval '1 millisecond' FROM",
        );
      parameters = [...values, WINDOW];
    }
    return run(rewritten, parameters);
  }) as PoolClient['query'];
  return () => {
    tx.query = original;
  };
}

/** Existing worker still performs the actual sharp/measurement/Review path.
 * Only the initial immutable asset retention timestamp is supplied by fixture. */
function assetTimestampPool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'connect')
        return Reflect.get(target, property, receiver);
      return async () => {
        const tx = await target.connect();
        const restore = initialTimestampFixture(tx, 'asset');
        const originalRelease = tx.release;
        tx.release = (error?: Error | boolean) => {
          restore();
          tx.release = originalRelease;
          originalRelease.call(tx, error);
        };
        return tx;
      };
    },
  });
}

async function waitUntilAfter(pool: Pool, deadline: number): Promise<void> {
  await pool.query(
    `SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)`,
    [new Date(deadline)],
  );
  const now = (await pool.query<{ now: Date }>('SELECT clock_timestamp() now'))
    .rows[0]!.now;
  assert.ok(now.getTime() > deadline);
}

async function preparedAtHistoricalBoundary(
  f: Fixture,
  actor: Actor,
  bytes: Buffer,
  timing: Timing,
) {
  const input = prepareMediaV2Schema.parse({
    clientRequestId: randomUUID(),
    purpose: 'community-post-image',
    draftId: randomUUID(),
    spaceId: f.scope.home.spaceId,
    slot: 'images',
    ordinal: 0,
    declaration: {
      mime: 'image/png',
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
  });
  const access = f.app.get(CommunityAccessService);
  const scopes = new MediaPrepareScopes(
    new CommunityMediaOwner(access, f.app.get(CommunityRepository)),
  );
  const intents = new MediaIntentRepository(scopes);
  const receipt = await withCommunityScopeWriter(f.pool, async (tx) => {
    const restore = initialTimestampFixture(tx, timing);
    try {
      const session = await access.mediaSession(actor.accessToken, tx);
      return await intents.prepare(
        await scopes.authorizeV2(session.accountId, input, tx),
        tx,
      );
    } finally {
      restore();
    }
  });
  return receipt.intentId;
}

async function actualReady(
  f: Fixture,
  actor: Actor,
  bytes: Buffer,
  timing: Timing,
) {
  const id = await preparedAtHistoricalBoundary(f, actor, bytes, timing);
  const http = f.app.getHttpServer();
  const auth = `Bearer ${actor.accessToken}`;
  const grant = await request(http)
    .post(`/v2/media/upload-intents/${id}/grant`)
    .set('Authorization', auth)
    .send({});
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  const uploaded = await request(http)
    .post(`/v2/media/upload-intents/${id}/uploads/${grant.body.grantId}`)
    .set('Authorization', auth)
    .attach('file', bytes, {
      filename: 'deadline.png',
      contentType: 'image/png',
    });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const finalized = await request(http)
    .post(`/v2/media/upload-intents/${id}/finalize`)
    .set('Authorization', auth)
    .send({});
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  const worker =
    timing === 'asset'
      ? new SyntheticMediaWorker(assetTimestampPool(f.pool), f.storage, [
          { sha256: sha256(bytes), verdict: 'allow' },
        ])
      : f.worker;
  for (const stage of ['seal', 'process', 'review'] as const)
    assert.equal(await worker.runOne(stage), true);
  const ready = await request(http)
    .get(`/v2/media/upload-intents/${id}`)
    .set('Authorization', auth);
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(ready.body.status, 'ready_unbound', JSON.stringify(ready.body));
  const row = (
    await f.pool.query<{
      operation_created: Date;
      operation_deadline: Date;
      asset_created: Date;
      draft_created: Date;
      draft_deadline: Date;
      asset_id: string;
      manifest_digest: string;
    }>(
      `SELECT i.created_at operation_created,i.expires_at operation_deadline,a.created_at asset_created,
        d.created_at draft_created,d.expires_at draft_deadline,a.id asset_id,a.manifest_digest
      FROM whaleu_media.upload_intents i JOIN whaleu_media.assets a ON a.intent_id=i.id
      JOIN whaleu_community.media_drafts d ON d.id=a.resource_id WHERE i.id=$1`,
      [id],
    )
  ).rows[0]!;
  const retention = row.asset_created.getTime() + DAY;
  assert.equal(ready.body.readyRetentionUntil, retention);
  assert.equal(ready.body.draftExpiresAt, row.draft_deadline.getTime());
  assert.equal(
    ready.body.bindBefore,
    Math.min(retention, row.draft_deadline.getTime()),
  );
  return { id, auth, row, retention, ready: ready.body };
}

async function approvedPublication(
  f: Fixture,
  actor: Actor,
  assetId: string,
  digest: string,
) {
  const body = {
    clientRequestId: randomUUID(),
    spaceId: f.scope.home.spaceId,
    category: 'discussion' as const,
    text: 'Media retention boundary acceptance',
    imageAssetIds: [assetId],
    authorMode: 'named' as const,
    commentsPolicy: 'open' as const,
  };
  const envelope = await postApprovalEnvelope(
    f.app,
    f.pool,
    actor.accountId,
    body,
  );
  await approveEnvelope(f.pool, { ...envelope, images: [{ assetId, digest }] });
  return body;
}

async function assertNoCreatedPublication(
  f: Fixture,
  actor: Actor,
  requestId: string,
  assetId: string,
  terminalRejection = false,
) {
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
        [assetId],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_community.posts WHERE account_id=$1',
        [actor.accountId],
      )
    ).rowCount,
    0,
  );
  const receipts = await f.pool.query<{ receipt: unknown }>(
    'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
    [actor.accountId, requestId],
  );
  if (terminalRejection) {
    // Known MEDIA_NOT_READY is deliberately a durable publication rejection,
    // not a transport failure. Its receipt must exist without created content.
    assert.equal(receipts.rowCount, 1);
    assert.deepEqual(receipts.rows[0]!.receipt, {
      requestId,
      operation: 'publish_post',
      outcome: 'rejected',
      code: 'MEDIA_NOT_READY',
    });
  } else assert.equal(receipts.rowCount, 0);
}

async function collectExpired(f: Fixture): Promise<number> {
  // expireOne is a global bounded collector, not a command for this test's ID.
  // Drain current eligible work before asserting a particular target changed.
  let collected = 0;
  while (
    await withCommunityScopeWriter(f.pool, (tx) =>
      new MediaLifecycleRepository().expireOne(tx),
    )
  )
    collected++;
  return collected;
}

test(
  'v2 ready and attachment use real retention/draft cutoffs independently of operation timeout',
  { timeout: 180000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: {
        width: 32,
        height: 24,
        channels: 3,
        background: { r: 33, g: 80, b: 150 },
      },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    try {
      await seedReviewPolicy(f.pool);
      const guards = (
        await f.pool.query<{ tgname: string; tgenabled: string }>(
          `SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid IN
        ('whaleu_media.upload_intents'::regclass,'whaleu_media.assets'::regclass,
         'whaleu_media.bindings'::regclass,'whaleu_community.media_drafts'::regclass)
       AND tgname IN ('media_intent_identity','media_immutable','community_media_draft_immutable',
         'media_binding_guard','media_binding_retention','media_binding_retention_final')`,
        )
      ).rows;
      assert.equal(guards.length, 6);
      assert.ok(guards.every((guard) => guard.tgenabled === 'O'));

      const http = f.app.getHttpServer();
      await t.test(
        'ready after the exact 30-minute operation deadline remains bindable within both 24-hour clocks',
        async () => {
          const actor = await f.actor();
          const result = await actualReady(f, actor, bytes, 'operation');
          assert.equal(
            result.row.operation_deadline.getTime() -
              result.row.operation_created.getTime(),
            30 * 60 * 1000,
          );
          const body = await approvedPublication(
            f,
            actor,
            result.row.asset_id,
            result.row.manifest_digest,
          );
          await waitUntilAfter(f.pool, result.row.operation_deadline.getTime());
          const ready = await request(http)
            .get(`/v2/media/upload-intents/${result.id}`)
            .set('Authorization', result.auth);
          assert.equal(
            ready.body.status,
            'ready_unbound',
            JSON.stringify(ready.body),
          );
          assert.ok(
            ready.body.serverNow - result.row.operation_created.getTime() >
              30 * 60 * 1000,
          );
          assert.equal(
            await withCommunityScopeWriter(f.pool, (tx) =>
              new MediaLifecycleRepository().expireOne(tx),
            ),
            false,
          );
          const published = await request(http)
            .post('/v1/community/posts')
            .set('Authorization', result.auth)
            .send(body);
          assert.equal(published.status, 201, JSON.stringify(published.body));
        },
      );
      for (const timing of ['asset', 'draft'] as const) {
        await t.test(
          `${timing} is the earlier 24-hour cutoff: attachment refuses even before GC runs`,
          async () => {
            const actor = await f.actor();
            const result = await actualReady(f, actor, bytes, timing);
            const cutoff =
              timing === 'asset'
                ? result.retention
                : result.row.draft_deadline.getTime();
            assert.equal(result.ready.bindBefore, cutoff);
            if (timing === 'asset')
              assert.ok(cutoff < result.row.draft_deadline.getTime());
            else {
              assert.ok(cutoff < result.retention);
              assert.equal(
                result.row.draft_deadline.getTime() -
                  result.row.draft_created.getTime(),
                DAY,
              );
            }
            const body = await approvedPublication(
              f,
              actor,
              result.row.asset_id,
              result.row.manifest_digest,
            );
            await waitUntilAfter(f.pool, cutoff);
            assert.equal(
              (
                await f.pool.query<{ state: string }>(
                  'SELECT state FROM whaleu_media.upload_intents WHERE id=$1',
                  [result.id],
                )
              ).rows[0]!.state,
              'ready',
            );
            const status = await request(http)
              .get(`/v2/media/upload-intents/${result.id}`)
              .set('Authorization', result.auth);
            assert.equal(
              status.body.status,
              'terminal',
              JSON.stringify(status.body),
            );
            assert.equal(status.body.reason, 'expired');
            const beforeOutbox = (
              await f.pool.query<{ count: string }>(
                'SELECT count(*)::text count FROM whaleu_community.outbox',
              )
            ).rows[0]!.count;
            const published = await request(http)
              .post('/v1/community/posts')
              .set('Authorization', result.auth)
              .send(body);
            if (timing === 'asset') {
              assert.equal(
                published.status,
                201,
                JSON.stringify(published.body),
              );
              assert.deepEqual(published.body, {
                requestId: body.clientRequestId,
                operation: 'publish_post',
                outcome: 'rejected',
                code: 'MEDIA_NOT_READY',
              });
            } else {
              assert.equal(
                published.status,
                503,
                JSON.stringify(published.body),
              );
              assert.equal(published.body.error.code, 'MEDIA_UNAVAILABLE');
            }
            assert.equal(
              (
                await f.pool.query<{ count: string }>(
                  'SELECT count(*)::text count FROM whaleu_community.outbox',
                )
              ).rows[0]!.count,
              beforeOutbox,
            );
            await assertNoCreatedPublication(
              f,
              actor,
              body.clientRequestId,
              result.row.asset_id,
              timing === 'asset',
            );
            assert.ok((await collectExpired(f)) >= 1);
            assert.equal(
              (
                await f.pool.query<{ state: string }>(
                  'SELECT state FROM whaleu_media.upload_intents WHERE id=$1',
                  [result.id],
                )
              ).rows[0]!.state,
              'cleanup_pending',
            );
          },
        );
        await t.test(
          `${timing} deadline crossed after real binding work rolls the entire publication back`,
          async () => {
            const actor = await f.actor();
            const result = await actualReady(f, actor, bytes, timing);
            const cutoff = result.ready.bindBefore as number;
            const body = await approvedPublication(
              f,
              actor,
              result.row.asset_id,
              result.row.manifest_digest,
            );
            const attachment =
              f.app.get<CommunityMediaAttachmentAdapter>(MEDIA_ATTACHMENT);
            const originalBind = attachment.bind;
            let boundBeforeDeadline = false;
            attachment.bind = async (
              ...args: Parameters<CommunityMediaAttachmentAdapter['bind']>
            ) => {
              await originalBind.apply(attachment, args);
              const tx = args[3];
              const now = (
                await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
              ).rows[0]!.now.getTime();
              assert.ok(
                now < cutoff,
                'The actual binding must occur before waiting across its final deadline',
              );
              boundBeforeDeadline = true;
              await tx.query(
                `SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)`,
                [new Date(cutoff)],
              );
            };
            const beforeOutbox = (
              await f.pool.query<{ count: string }>(
                'SELECT count(*)::text count FROM whaleu_community.outbox',
              )
            ).rows[0]!.count;
            try {
              const published = await request(http)
                .post('/v1/community/posts')
                .set('Authorization', result.auth)
                .send(body);
              assert.ok(
                published.status >= 400,
                JSON.stringify(published.body),
              );
              assert.equal(boundBeforeDeadline, true);
              assert.equal(
                (
                  await f.pool.query<{ count: string }>(
                    'SELECT count(*)::text count FROM whaleu_community.outbox',
                  )
                ).rows[0]!.count,
                beforeOutbox,
              );
              await assertNoCreatedPublication(
                f,
                actor,
                body.clientRequestId,
                result.row.asset_id,
              );
            } finally {
              attachment.bind = originalBind;
            }
            assert.ok((await collectExpired(f)) >= 1);
            assert.equal(
              (
                await f.pool.query<{ state: string }>(
                  'SELECT state FROM whaleu_media.upload_intents WHERE id=$1',
                  [result.id],
                )
              ).rows[0]!.state,
              'cleanup_pending',
            );
          },
        );
      }
    } finally {
      await f.close();
    }
  },
);
