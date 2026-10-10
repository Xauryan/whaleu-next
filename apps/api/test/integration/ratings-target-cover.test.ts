import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import request from 'supertest';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import {
  syntheticRatingTargetCoverFixture,
  coverHttpOk,
} from '../support/media/ratings-target-runtime-fixture.js';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { MediaRequiredProof } from '../../src/media/required-proof.js';
import {
  ratingTargetCoverIntentSchema,
  ratingTargetCoverReceiptSchema,
} from '../../src/ratings/scoped/target-cover-contracts.js';

/** Unexecuted acceptance source until the parent grants the exclusive PG lease.
 * Every scenario retains ordinary HTTP, owner CAS, exact Review and PG guards. */
test(
  'Ratings target single cover crosses real upload, Review, current definition, replacement and durable cleanup',
  { timeout: 360000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#246a93' },
    })
      .png()
      .toBuffer();
    const jpeg = await sharp({
      create: { width: 72, height: 52, channels: 3, background: '#a45c31' },
    })
      .jpeg()
      .toBuffer();
    const f = await syntheticRatingTargetCoverFixture([
      { sha256: sha256(png), verdict: 'allow' },
      { sha256: sha256(jpeg), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actor = f.creator;
    let targetId = '';
    const head = async () =>
      (
        await f.pool.query(
          `SELECT t.revision,h.content_version,h.definition_revision,d.envelope
    FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id
    JOIN whaleu_ratings.target_definition_versions d ON (d.target_id,d.content_version,d.definition_revision)=(h.target_id,h.content_version,h.definition_revision) WHERE t.id=$1`,
          [targetId],
        )
      ).rows[0];
    const active = async () =>
      (
        await f.pool.query<{ count: number }>(
          `SELECT count(*)::int count FROM whaleu_ratings.target_cover_appearances a
    JOIN whaleu_media.bindings b ON b.id=a.media_binding_id WHERE a.target_id=$1 AND b.detached_at IS NULL`,
          [targetId],
        )
      ).rows[0]!.count;
    const imageGet = (
      cover: {
        targetId: string;
        appearanceId: string;
        contextId: string;
        contextToken: string;
      },
      authenticated = true,
    ) => {
      const r = request(f.http)
        .get(
          `/v3/media/ratings-target/targets/${cover.targetId}/appearances/${cover.appearanceId}/display-v1`,
        )
        .query({
          contextId: cover.contextId,
          contextToken: cover.contextToken,
        });
      return authenticated ? f.auth(r, actor) : r;
    };

    await t.test(
      'create consumes one current exact asset and original receipt recovery never rebinds',
      async () => {
        const upload = await f.ready(actor, await f.draft(actor), png);
        const created = await f.execute(actor, upload.input);
        assert.equal(created.receipt.outcome, 'applied');
        targetId = created.result.targetId;
        assert.equal(await active(), 1);
        const row = await head();
        assert.equal(row.envelope.version, 6);
        assert.equal(row.content_version, 1);
        assert.equal(row.envelope.cover.assetId, upload.status.assetId);
        const before = await f.pool.query(
          'SELECT count(*)::int count FROM whaleu_media.bindings WHERE asset_id=$1',
          [upload.status.assetId],
        );
        const replay = await f.send(
          actor,
          upload.input,
          created.prepared.contextRevision,
        );
        coverHttpOk(replay);
        assert.deepEqual(replay.body, created.receipt);
        const receipt = await f.auth(
          request(f.http).get(
            `/v3/ratings/target-cover/receipts/${upload.input.payload.clientRequestId}`,
          ),
          actor,
        );
        coverHttpOk(receipt);
        assert.deepEqual(receipt.body, created.receipt);
        assert.doesNotMatch(
          JSON.stringify(receipt.body),
          /"(?:descriptor|contextToken|manifest|url|bucket)"/,
        );
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT count(*)::int count FROM whaleu_media.bindings WHERE asset_id=$1',
              [upload.status.assetId],
            )
          ).rows,
          before.rows,
        );
        const current = await f.read(actor, targetId);
        assert.ok(current.cover);
        const bytes = await imageGet(current.cover);
        coverHttpOk(bytes);
        assert.equal(bytes.headers['cache-control'], 'private, no-store');
        assert.equal(bytes.headers['accept-ranges'], 'none');
        assert.ok(Buffer.isBuffer(bytes.body));
        assert.notEqual(
          (await imageGet(current.cover, false)).status,
          200,
          'Ratings has no Profile guest path',
        );
        assert.notEqual(
          (await imageGet(current.cover).set('Range', 'bytes=0-1')).status,
          200,
        );
      },
    );

    await t.test(
      'ordinary runtime remains unavailable and v2 recovery stays byte-exact across v6 adoption',
      async () => {
        const disabled = await f
          .auth(
            request(f.ordinaryHttp).post(
              '/v3/media/ratings-target/upload-scopes',
            ),
            actor,
          )
          .send({
            protocol: 'ratings-target-media-v1',
            clientRequestId: randomUUID(),
            editScopeId: randomUUID(),
            scopeRevision: 'a'.repeat(64),
            slot: 'cover',
            declaration: {
              mime: 'image/png',
              bytes: png.length,
              sha256: sha256(png),
            },
          });
        assert.notEqual(disabled.status, 200);
        const legacy = await f.createScopedTarget(
          actor,
          'Legacy receipt retained',
        );
        const draft = await f.draft(actor, legacy.id);
        const legacyEdit = await f.scopedEditIntent(actor, legacy.id);
        const crossNew = await f
          .auth(request(f.http).post('/v3/ratings/target-cover/prepare'), actor)
          .send({ ...draft, context: legacyEdit.context });
        assert.notEqual(
          crossNew.status,
          200,
          'A v2 authority cannot authorize command3',
        );
        const crossOld = await f
          .auth(
            request(f.http).post('/v2/ratings/management/owner-edit/prepare'),
            actor,
          )
          .send({ ...legacyEdit, context: draft.context });
        assert.notEqual(
          crossOld.status,
          200,
          'A v3 authority cannot authorize a fresh command2 definition',
        );
        await f.execute(
          actor,
          ratingTargetCoverIntentSchema.parse({
            ...draft,
            payload: {
              ...draft.payload,
              name: 'Now exact v6',
              cover: { action: 'clear' },
            },
          }),
        );
        const replay = await f.sendCommand(
          actor,
          legacy.input,
          legacy.prepared?.contextRevision,
        );
        coverHttpOk(replay);
        assert.deepEqual(replay.body, legacy.receipt);
        // JSON object key order is not part of the historical receipt contract.
        assert.equal(
          canonicalJson(replay.body),
          canonicalJson(legacy.response.body),
        );
        const oldStatus = await f.auth(
          request(f.http).get(
            `/v2/ratings/requests/${legacy.input.payload.clientRequestId}`,
          ),
          actor,
        );
        coverHttpOk(oldStatus);
        assert.equal(
          canonicalJson(oldStatus.body),
          canonicalJson(legacy.response.body),
        );
        const current = await f.draft(actor, legacy.id);
        const { cover: removedCover, ...payload } = current.payload;
        void removedCover;
        const rejected = await f
          .auth(
            request(f.http).post('/v2/ratings/management/owner-edit/prepare'),
            actor,
          )
          .send({
            ...current,
            protocolVersion: 2,
            payload: { ...payload, assetIds: [] },
          });
        assert.notEqual(
          rejected.status,
          200,
          'Old empty assetIds must not silently clear a current v6 cover definition',
        );
      },
    );

    await t.test(
      'text-only keep retains the immutable appearance and single asset binding',
      async () => {
        const before = await head(),
          draft = await f.draft(actor, targetId);
        const input = ratingTargetCoverIntentSchema.parse({
          ...draft,
          payload: { ...draft.payload, name: 'Edited text, same cover' },
        });
        const result = await f.execute(actor, input);
        assert.equal(result.receipt.outcome, 'applied');
        const after = await head();
        assert.equal(after.content_version, before.content_version + 1);
        assert.deepEqual(after.envelope.cover, before.envelope.cover);
        assert.equal(await active(), 1);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int count FROM whaleu_media.bindings WHERE asset_id=$1',
              [before.envelope.cover.assetId],
            )
          ).rows[0].count,
          1,
        );
      },
    );

    await t.test(
      'replace and clear move body and cover together and enqueue exact old-object cleanup',
      async () => {
        const before = await f.read(actor, targetId);
        assert.ok(before.cover);
        const upload = await f.ready(
          actor,
          await f.draft(actor, targetId),
          jpeg,
          'image/jpeg',
        );
        await f.execute(actor, upload.input);
        const changed = await f.read(actor, targetId);
        assert.ok(changed.cover);
        assert.notEqual(changed.cover.appearanceId, before.cover.appearanceId);
        assert.equal(await active(), 1);
        assert.notEqual((await imageGet(before.cover)).status, 200);
        const detached = (
          await f.pool.query(
            'SELECT detached_at FROM whaleu_media.bindings WHERE id=$1',
            [before.cover.bindingId],
          )
        ).rows[0];
        assert.ok(detached.detached_at);
        assert.ok(
          (
            await f.pool.query(
              `SELECT 1 FROM whaleu_media.cleanup_obligations o LEFT JOIN whaleu_media.object_attempts source ON source.id=o.object_attempt_id LEFT JOIN whaleu_media.derived_object_attempts derived ON derived.id=o.derived_attempt_id JOIN whaleu_media.assets a ON a.id=o.asset_id OR a.intent_id=coalesce(source.intent_id,derived.intent_id) JOIN whaleu_media.bindings b ON b.asset_id=a.id WHERE b.id=$1`,
              [before.cover.bindingId],
            )
          ).rowCount,
        );
        const draft = await f.draft(actor, targetId);
        await f.execute(
          actor,
          ratingTargetCoverIntentSchema.parse({
            ...draft,
            payload: { ...draft.payload, cover: { action: 'clear' } },
          }),
        );
        assert.equal((await f.read(actor, targetId)).cover, null);
        assert.equal(await active(), 0);
        assert.notEqual((await imageGet(changed.cover)).status, 200);
      },
    );

    await t.test(
      'failure after actual bind/finish rolls back definition, consumption, detach and receipt',
      async () => {
        for (const point of ['bind', 'finish'] as const) {
          const upload = await f.ready(
            actor,
            await f.draft(actor, targetId),
            png,
          );
          const prepared = await f.prepare(actor, upload.input),
            before = await head();
          const assets = f.media.assets;
          const bind = assets.bindRatings,
            finish = assets.finishRatingsReplacement;
          if (point === 'bind')
            assets.bindRatings = async (...args: Parameters<typeof bind>) => {
              await bind.apply(assets, args);
              throw new Error('SYNTHETIC_AFTER_BIND');
            };
          else
            assets.finishRatingsReplacement = async (
              ...args: Parameters<typeof finish>
            ) => {
              await finish.apply(assets, args);
              throw new Error('SYNTHETIC_AFTER_FINISH');
            };
          try {
            assert.notEqual(
              (
                await f.send(
                  actor,
                  upload.input,
                  prepared.prepared.contextRevision,
                )
              ).status,
              200,
            );
          } finally {
            assets.bindRatings = bind;
            assets.finishRatingsReplacement = finish;
          }
          assert.deepEqual(await head(), before);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
                [upload.status.assetId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.scope_consumptions WHERE scope_resource_id=$1',
                [upload.scope.scopeId],
              )
            ).rowCount,
            0,
          );
          const retry = await f.send(
            actor,
            upload.input,
            prepared.prepared.contextRevision,
          );
          coverHttpOk(retry);
          assert.equal(
            ratingTargetCoverReceiptSchema.parse(retry.body).outcome,
            'applied',
          );
        }
      },
    );

    await t.test(
      'outer Media read facts survive replacement and zero-row raw writes',
      async () => {
        const upload = await f.ready(
          actor,
          await f.draft(actor, targetId),
          jpeg,
          'image/jpeg',
        );
        const prepared = await f.prepare(actor, upload.input),
          before = await head();
        const assets = f.media.assets,
          original = assets.prepareRatingsReplacement;
        assets.prepareRatingsReplacement = async (
          ...args: Parameters<typeof original>
        ) => {
          await new MediaRequiredProof().capture(args[3]);
          return original.apply(assets, args);
        };
        try {
          assert.notEqual(
            (
              await f.send(
                actor,
                upload.input,
                prepared.prepared.contextRevision,
              )
            ).status,
            200,
          );
        } finally {
          assets.prepareRatingsReplacement = original;
        }
        assert.deepEqual(await head(), before);
        coverHttpOk(
          await f.send(actor, upload.input, prepared.prepared.contextRevision),
        );
        await assert.rejects(
          f.media.authorized(actor.accessToken, async (_session, tx) => {
            await new MediaRequiredProof().capture(tx);
            await tx.query(
              'UPDATE whaleu_media.bindings SET detach_reason=detach_reason WHERE false',
            );
          }),
        );
      },
    );

    await t.test(
      'concurrent body/cover CAS permits only one complete definition, including apparent noop',
      async () => {
        const left = await f.draft(actor, targetId),
          right = await f.draft(actor, targetId);
        const a = ratingTargetCoverIntentSchema.parse({
          ...left,
          payload: { ...left.payload, name: 'Concurrent body winner' },
        });
        const b = ratingTargetCoverIntentSchema.parse({
          ...right,
          payload: { ...right.payload, cover: { action: 'clear' } },
        });
        const pa = await f.prepare(actor, a),
          pb = await f.prepare(actor, b);
        const results = await Promise.all([
          f.send(actor, a, pa.prepared.contextRevision),
          f.send(actor, b, pb.prepared.contextRevision),
        ]);
        for (const response of results) coverHttpOk(response);
        assert.deepEqual(
          results
            .map((r) => ratingTargetCoverReceiptSchema.parse(r.body).outcome)
            .sort(),
          ['applied', 'closed'],
        );
        const stale = await f
          .auth(request(f.http).post('/v3/ratings/target-cover/prepare'), actor)
          .send({
            ...left,
            payload: { ...left.payload, clientRequestId: randomUUID() },
          });
        assert.notEqual(stale.status, 200, 'CAS must precede noop');
      },
    );

    await t.test(
      'held and unknown current assets gate the whole definition; hidden owner deletion still drains history',
      async () => {
        const upload = await f.ready(
          actor,
          await f.draft(actor, targetId),
          png,
        );
        await f.execute(actor, upload.input);
        const view = await f.read(actor, targetId);
        assert.ok(view.cover);
        for (const state of ['held', 'unknown'] as const) {
          await withCommunityScopeWriter(f.pool, async (tx) => {
            const row = (
              await tx.query<{
                revision: string;
                manifest_digest: string;
                policy_revision: string;
              }>(
                `SELECT h.revision::text,a.manifest_digest,a.policy_revision FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$1 FOR UPDATE OF a,h`,
                [upload.status.assetId],
              )
            ).rows[0]!;
            const event = randomUUID(),
              revision = String(BigInt(row.revision) + 1n);
            await tx.query(
              `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
          VALUES($1::uuid,$2,$3,$4,$5,$6,'synthetic-ratings-cover-hold',$1::text,'{}',clock_timestamp(),clock_timestamp()+interval '1 hour')`,
              [
                event,
                upload.status.assetId,
                revision,
                state,
                row.manifest_digest,
                row.policy_revision,
              ],
            );
            await tx.query(
              'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
              [upload.status.assetId, revision, event],
            );
          });
          assert.notEqual((await imageGet(view.cover)).status, 200);
          const context = await f.context(actor, 'read');
          const response = await f
            .auth(
              request(f.http).get(
                `/v3/ratings/target-cover/targets/${targetId}`,
              ),
              actor,
            )
            .query({ contextId: context.id, contextToken: context.token });
          assert.notEqual(
            response.status,
            200,
            'Unknown cannot become a nullable cover with public text',
          );
        }
        const before = await head();
        const deleted = await f
          .auth(
            request(f.http).post(
              `/v1/ratings/management/owner-deletion/targets/${targetId}`,
            ),
            actor,
          )
          .send({
            clientRequestId: randomUUID(),
            expectedTargetRevision: before.revision,
          });
        coverHttpOk(deleted);
        assert.ok(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.target_cover_cleanup WHERE target_id=$1',
              [targetId],
            )
          ).rowCount,
        );
        while (await f.media.cleanupOne()) {
          /* durable keyset pages, including all historical appearances */
        }
        assert.equal(await active(), 0);
        assert.equal(
          (
            await f.pool.query(
              'SELECT phase FROM whaleu_ratings.target_cover_cleanup WHERE target_id=$1',
              [targetId],
            )
          ).rows[0].phase,
          'complete',
        );
        assert.equal(await f.media.cleanupOne(), false);
        assert.notEqual((await imageGet(view.cover)).status, 200);
        const obligations = (
          await f.pool.query<{ count: number; delay: number }>(
            `SELECT count(*)::int count,greatest(0,extract(epoch FROM(max(not_before)-clock_timestamp()))*1000)::integer delay FROM whaleu_media.cleanup_obligations WHERE state='pending'`,
          )
        ).rows[0]!;
        assert.ok(obligations.count > 0);
        assert.ok(obligations.delay >= 0 && obligations.delay <= 120000);
        await sleep(obligations.delay + 50); // Observe real retention; never rewrite persisted clocks.
        const cleanup = new SyntheticMediaCleanup(f.pool, f.storage);
        for (;;) {
          const result = await cleanup.runOne();
          if (result === 'idle') break;
          assert.equal(result, 'deleted');
        }
        assert.equal(
          (
            await f.pool.query(
              `SELECT count(*)::int count FROM whaleu_media.cleanup_obligations o LEFT JOIN whaleu_media.object_attempts source ON source.id=o.object_attempt_id LEFT JOIN whaleu_media.derived_object_attempts derived ON derived.id=o.derived_attempt_id JOIN whaleu_media.assets a ON a.id=o.asset_id OR a.intent_id=coalesce(source.intent_id,derived.intent_id) JOIN whaleu_ratings.target_cover_appearances p ON p.asset_id=a.id WHERE p.target_id=$1 AND (o.state<>'deleted' OR o.confirmed_deleted_at IS NULL)`,
              [targetId],
            )
          ).rows[0].count,
          0,
        );
        assert.ok(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=$1',
              [targetId],
            )
          ).rowCount,
          'History is retained',
        );
      },
    );
  },
);

/** Regression for optional Media cleanup: history existence is the sole enqueue
 * prerequisite. Current cover/Review/Safety eligibility never erases history. */
test(
  'target cover cleanup queues only real immutable appearance history, including cleared and hidden histories',
  { timeout: 180000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 44, height: 34, channels: 3, background: '#426d9a' },
    })
      .png()
      .toBuffer();
    const f = await syntheticRatingTargetCoverFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actor = f.creator;
    const remove = async (targetId: string, revision: string) => {
      const response = await f
        .auth(
          request(f.http).post(
            `/v1/ratings/management/owner-deletion/targets/${targetId}`,
          ),
          actor,
        )
        .send({
          clientRequestId: randomUUID(),
          expectedTargetRevision: revision,
        });
      coverHttpOk(response);
      assert.equal(response.body.outcome, 'applied');
    };
    await t.test(
      'legacy and v6 pure-text targets that never had an appearance create no cleanup queue',
      async () => {
        const legacy = await f.createScopedTarget(actor, 'Never had cover v5');
        const current = await f.execute(actor, await f.draft(actor));
        for (const target of [
          { id: legacy.id, revision: legacy.revision },
          { id: current.result.targetId, revision: current.result.revision },
        ]) {
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.target_cover_appearances WHERE target_id=$1',
                [target.id],
              )
            ).rowCount,
            0,
          );
          await remove(target.id, target.revision);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.target_cover_cleanup WHERE target_id=$1',
                [target.id],
              )
            ).rowCount,
            0,
          );
        }
        assert.equal(await f.media.cleanupOne(), false);
      },
    );
    for (const clear of [true, false])
      await t.test(
        clear
          ? 'cleared cover history still queues and drains when current Review is unknown'
          : 'replaced old appearance and unknown current asset still queue and drain',
        async () => {
          const first = await f.ready(actor, await f.draft(actor), bytes),
            created = await f.execute(actor, first.input),
            targetId = created.result.targetId;
          const second = await f.ready(
            actor,
            await f.draft(actor, targetId),
            bytes,
          );
          let current = await f.execute(actor, second.input);
          if (clear) {
            const draft = await f.draft(actor, targetId);
            current = await f.execute(
              actor,
              ratingTargetCoverIntentSchema.parse({
                ...draft,
                payload: { ...draft.payload, cover: { action: 'clear' } },
              }),
            );
          }
          const history = (
            await f.pool.query<{ id: string; asset_id: string }>(
              `SELECT id,asset_id FROM whaleu_ratings.target_cover_appearances WHERE target_id=$1 ORDER BY id`,
              [targetId],
            )
          ).rows;
          assert.equal(history.length, 2);
          await withCommunityScopeWriter(f.pool, async (tx) => {
            const reviewEvent = randomUUID();
            await tx.query(
              `INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','missing','accepted','synthetic-cover-cleanup','synthetic-hidden-current-definition',clock_timestamp())`,
              [reviewEvent, current.approved.decisionId],
            );
            await tx.query(
              'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
              [current.approved.decisionId, reviewEvent],
            );
            for (const appearance of history) {
              const asset = (
                await tx.query<{
                  revision: string;
                  manifest_digest: string;
                  policy_revision: string;
                }>(
                  `SELECT h.revision::text,a.manifest_digest,a.policy_revision FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$1 FOR UPDATE OF a,h`,
                  [appearance.asset_id],
                )
              ).rows[0]!;
              const event = randomUUID(),
                revision = String(BigInt(asset.revision) + 1n);
              await tx.query(
                `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) VALUES($1::uuid,$2,$3,'unknown',$4,$5,'synthetic-cover-cleanup',$1::text,'{}',clock_timestamp(),clock_timestamp()+interval '1 hour')`,
                [
                  event,
                  appearance.asset_id,
                  revision,
                  asset.manifest_digest,
                  asset.policy_revision,
                ],
              );
              await tx.query(
                'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
                [appearance.asset_id, revision, event],
              );
            }
          });
          const context = await f.context(actor, 'read');
          const hidden = await f
            .auth(
              request(f.http).get(
                `/v3/ratings/target-cover/targets/${targetId}`,
              ),
              actor,
            )
            .query({ contextId: context.id, contextToken: context.token });
          assert.equal(hidden.status, 503, JSON.stringify(hidden.body));
          await remove(targetId, current.result.revision);
          assert.equal(
            (
              await f.pool.query(
                'SELECT phase FROM whaleu_ratings.target_cover_cleanup WHERE target_id=$1',
                [targetId],
              )
            ).rows[0]?.phase,
            'pending',
          );
          assert.equal(await f.media.cleanupOne(), true);
          const queue = (
            await f.pool.query<{ phase: string; after_appearance_id: string }>(
              'SELECT phase,after_appearance_id FROM whaleu_ratings.target_cover_cleanup WHERE target_id=$1',
              [targetId],
            )
          ).rows[0]!;
          assert.equal(queue.phase, 'complete');
          assert.equal(queue.after_appearance_id, history.at(-1)!.id);
          assert.equal(
            (
              await f.pool.query(
                `SELECT 1 FROM whaleu_ratings.target_cover_appearances p JOIN whaleu_media.bindings b ON b.id=p.media_binding_id WHERE p.target_id=$1 AND b.detached_at IS NULL`,
                [targetId],
              )
            ).rowCount,
            0,
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT id,asset_id FROM whaleu_ratings.target_cover_appearances WHERE target_id=$1 ORDER BY id',
                [targetId],
              )
            ).rows,
            history,
          );
          assert.equal(await f.media.cleanupOne(), false);
        },
      );
  },
);

test(
  'actual Review6 target reads fail their final fence on zero-row and held writers to the exact new binding table',
  { timeout: 90000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 38, height: 30, channels: 3, background: '#83613c' },
    })
      .png()
      .toBuffer();
    const f = await syntheticRatingTargetCoverFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actor = f.creator,
      upload = await f.ready(actor, await f.draft(actor), bytes),
      created = await f.execute(actor, upload.input),
      targetId = created.result.targetId;
    const { RatingScopedRepository } =
      await import('../../src/ratings/scoped/repository.js');
    const repository = f.app.get(RatingScopedRepository),
      target = repository.target;
    const statement =
      'UPDATE whaleu_community.rating_target_cover_definition_bindings SET digest=digest WHERE false';
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_community.rating_target_cover_definition_bindings WHERE target_id=$1',
          [targetId],
        )
      ).rowCount,
      1,
    );
    for (const held of [false, true])
      await t.test(
        held
          ? 'concurrent held writer is rejected without waiting'
          : 'same-transaction zero-row write cannot disappear from final proof',
        async () => {
          const context = await f.context(actor, 'read'),
            holder = held ? await f.pool.connect() : null;
          if (holder) await holder.query('BEGIN');
          const holderPid = holder
            ? (
                await holder.query<{ pid: number }>(
                  'SELECT pg_backend_pid() pid',
                )
              ).rows[0]!.pid
            : null;
          let reached = false,
            writer: Promise<number | null> | undefined;
          repository.target = async function (
            ...args: Parameters<typeof target>
          ) {
            const result = await target.apply(this, args);
            if (!reached) {
              reached = true;
              if (!holder)
                assert.equal((await args[2].query(statement)).rowCount, 0);
              else {
                // Do not await the writer's trigger gate while this reader holds the
                // authority lock. Its already-granted table lock is the final-fence threat.
                writer = holder
                  .query(statement)
                  .then((value) => value.rowCount);
                void writer.catch(() => undefined);
                const deadline = Date.now() + 2000;
                for (;;) {
                  const state = (
                    await f.pool.query<{ granted: boolean; blocked: boolean }>(
                      `SELECT
              EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='relation' AND relation='whaleu_community.rating_target_cover_definition_bindings'::regclass AND mode='RowExclusiveLock' AND granted) granted,
              EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0) blocked`,
                      [holderPid],
                    )
                  ).rows[0]!;
                  if (state.granted && state.blocked) break;
                  if (Date.now() >= deadline)
                    assert.fail(
                      'Real Review6 writer did not reach the held-table/blocked-authority boundary',
                    );
                  await sleep(5);
                }
              }
            }
            return result;
          };
          try {
            const response = await f
              .auth(
                request(f.http).get(
                  `/v3/ratings/target-cover/targets/${targetId}`,
                ),
                actor,
              )
              .query({ contextId: context.id, contextToken: context.token })
              .timeout({ deadline: 5000 });
            assert.equal(reached, true);
            assert.equal(response.status, 503, JSON.stringify(response.body));
            assert.ok(
              ['CONTENT_REVIEW_UNAVAILABLE', 'RATING_UNAVAILABLE'].includes(
                response.body.error.code,
              ),
            );
            assert.equal(response.body.target, undefined);
            assert.equal(response.body.cover, undefined);
          } finally {
            repository.target = target;
            if (holder) {
              // The HTTP reader has completed/rolled back before waiting on its writer.
              try {
                if (writer) assert.equal(await writer, 0);
              } finally {
                await holder.query('ROLLBACK');
                holder.release();
              }
            }
          }
          assert.ok((await f.read(actor, targetId)).cover);
        },
      );
  },
);
