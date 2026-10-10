import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import {
  syntheticRatingTargetCoverFixture,
  issueSyntheticTargetCoverCapabilities,
  coverHttpOk,
} from '../support/media/ratings-target-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingScopedRepository } from '../../src/ratings/scoped/repository.js';
import { RatingRandomDraw } from '../../src/ratings/random/draw.js';
import {
  ratingScopedContextSchema,
  type RatingScopedContext,
} from '../../src/ratings/scoped/contracts.js';
import {
  ratingTargetCoverContextSchema,
  type RatingTargetCoverContext,
} from '../../src/ratings/scoped/target-cover-contracts.js';
import { ratingTargetCoverRandomResponseSchema } from '../../src/ratings/scoped/random.service.js';
import { sha256 } from '../../src/media/processing/protocol.js';

/** Real-PG regression source. The v3 endpoints below are the explicit cover
 * contract; no production capability issuer is installed by this harness. */
const coverContexts = '/v3/ratings/target-cover/contexts';
const coverRandom = '/v3/ratings/target-cover/random-target';
function unavailable(response: {
  status: number;
  body: Record<string, unknown>;
}) {
  assert.notEqual(response.status, 200, JSON.stringify(response.body));
  const error = response.body['error'] as { code?: string } | undefined;
  assert.ok(
    error?.code &&
      [
        'RATING_UNAVAILABLE',
        'RATING_SCOPE_UNAVAILABLE',
        'RATING_SCOPED_CONTEXT_CHANGED',
        'CONTENT_REVIEW_UNAVAILABLE',
        'MEDIA_UNAVAILABLE',
      ].includes(error.code),
    JSON.stringify(response.body),
  );
  assert.equal(response.body['item'], undefined);
  assert.equal(response.body['candidateCount'], undefined);
}

test(
  'optional cover registration leaves v2 authority unchanged and current full pools never skip unknown covers',
  { timeout: 360000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 40, height: 32, channels: 3, background: '#318074' },
    })
      .png()
      .toBuffer();
    const f = await syntheticRatingTargetCoverFixture(
      [{ sha256: sha256(bytes), verdict: 'allow' }],
      { registerCapabilities: false },
    );
    t.after(() => f.close());
    const actor = f.creator;
    const texts = [
      await f.createScopedTarget(actor, 'Plain A'),
      await f.createScopedTarget(actor, 'Plain B'),
    ];
    await f.createScopedTarget(actor, 'Local pure text', {
      kind: 'campus',
      campusId: f.campusA,
    });
    const context = async (
      v3: boolean,
      purpose: 'read' | 'random' = 'random',
    ) => {
      const r = await f
        .auth(
          request(f.http).post(v3 ? coverContexts : '/v2/ratings/contexts'),
          actor,
        )
        .send({ purpose, selector: { kind: 'global' }, mode: 'public' });
      coverHttpOk(r);
      if (v3) {
        assert.equal(
          ratingScopedContextSchema.safeParse(r.body).success,
          false,
        );
        return ratingTargetCoverContextSchema.parse(r.body);
      }
      assert.equal(
        ratingTargetCoverContextSchema.safeParse(r.body).success,
        false,
      );
      return ratingScopedContextSchema.parse(r.body);
    };
    const sample = async (
      v3: boolean,
      current?: RatingScopedContext | RatingTargetCoverContext,
    ) => {
      const c = current ?? (await context(v3));
      return f
        .auth(
          request(f.http).get(v3 ? coverRandom : '/v2/ratings/random-target'),
          actor,
        )
        .query({
          contextId: c.id,
          contextToken: c.token,
          categoryId: f.data.global.categoryId,
        });
    };
    const pureTextPool = async () => {
      const issued = await f
        .auth(request(f.http).post(coverContexts), actor)
        .send({
          purpose: 'random',
          selector: {
            kind: 'institution_with_global',
            anchorCampusId: f.campusA,
          },
          mode: 'public',
        });
      coverHttpOk(issued);
      const c = ratingTargetCoverContextSchema.parse(issued.body);
      return f.auth(request(f.http).get(coverRandom), actor).query({
        contextId: c.id,
        contextToken: c.token,
        categoryId: f.data.local.categoryId,
      });
    };
    const authority = async (id: string) =>
      (
        await f.pool.query(
          `SELECT authority,protocol_tuples,context->'scopeRevision' revision,context->'sourceDigest' digest,context->'capabilities' capabilities FROM whaleu_ratings.scoped_contexts WHERE id=$1`,
          [id],
        )
      ).rows[0];
    const before = await context(false),
      original = await authority(before.id);
    assert.deepEqual(original.capabilities, ['random']);
    assert.equal('targetCoverCapabilities' in original.authority, false);
    let imageId = '',
      assetId = '';
    await t.test(
      'pure text needs only the unchanged old proof even on the v3 reader',
      async () => {
        const old = await sample(false, before),
          fresh = await sample(true);
        coverHttpOk(old);
        coverHttpOk(fresh);
        assert.equal(old.body.candidateCount, 2);
        assert.equal(fresh.body.candidateCount, 2);
        const local = await pureTextPool();
        coverHttpOk(local);
        assert.equal(local.body.candidateCount, 1);
        const selected = ratingTargetCoverRandomResponseSchema.parse(
          local.body,
        ).item;
        assert.ok(selected);
        assert.equal(selected.cover, null);
        assert.equal(selected.coverContext.protocolVersion, 3);
        assert.equal(selected.coverContext.purpose, 'read');
        assert.equal(
          selected.coverContext.protocolGeneration,
          selected.locator.protocolGeneration,
        );
        assert.deepEqual(
          selected.coverContext.selector,
          selected.locator.selector,
        );
        // Aggregate pool generation is independent of the selected path generation.
        assert.equal(
          ratingTargetCoverRandomResponseSchema.safeParse({
            ...local.body,
            context: {
              ...local.body.context,
              protocolGeneration: randomUUID(),
            },
          }).success,
          true,
        );
        assert.equal(
          ratingTargetCoverRandomResponseSchema.safeParse({
            ...local.body,
            item: {
              ...selected,
              coverContext: {
                ...selected.coverContext,
                protocolGeneration: randomUUID(),
              },
            },
          }).success,
          false,
        );
      },
    );
    await t.test(
      'context 2 and context 3 cannot cross full read or random HTTP routes even for pure text',
      async () => {
        const old = await context(false),
          current = await context(true);
        unavailable(await sample(true, old));
        unavailable(await sample(false, current));
        const oldRead = await context(false, 'read'),
          currentRead = await context(true, 'read');
        for (const [path, c] of [
          [`/v3/ratings/target-cover/targets/${texts[0]!.id}`, oldRead],
          [`/v2/ratings/targets/${texts[0]!.id}`, currentRead],
        ] as const)
          unavailable(
            await f
              .auth(request(f.http).get(path), actor)
              .query({ contextId: c.id, contextToken: c.token }),
          );
      },
    );
    await t.test(
      'partial optional registration cannot alter an old response hash or authority',
      async () => {
        const version = (
          await f.pool.query<{ id: string }>(
            `SELECT v.id FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id WHERE v.logical_scope_key='global'`,
          )
        ).rows[0];
        assert.ok(version);
        await issueSyntheticTargetCoverCapabilities(f.pool, {
          protocolVersionIds: [version.id],
          validForMs: 90000,
        });
        const after = await context(false);
        assert.deepEqual(await authority(after.id), original);
        coverHttpOk(await sample(false, before));
        const count = (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_ratings.target_cover_capability_sources',
          )
        ).rows[0].n;
        const adopted = (
          await f.pool.query(
            "SELECT count(*)::int n FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id WHERE v.phase='adopted'",
          )
        ).rows[0].n;
        assert.ok(
          count > 0 && count < adopted,
          'Registration really is partial across adopted scopes',
        );
        const upload = await f.ready(actor, await f.draft(actor), bytes),
          created = await f.execute(actor, upload.input);
        imageId = created.result.targetId;
        assetId = upload.status.assetId;
      },
    );
    await t.test(
      'old reader fails explicitly; v3 complete mixed pool includes text and cover once each',
      async () => {
        unavailable(await sample(false));
        const result = await sample(true);
        coverHttpOk(result);
        assert.equal(result.body.candidateCount, 3);
        const oldRead = await context(false, 'read');
        unavailable(
          await f
            .auth(request(f.http).get(`/v2/ratings/targets/${imageId}`), actor)
            .query({ contextId: oldRead.id, contextToken: oldRead.token }),
        );
      },
    );
    await t.test(
      'every selected random item carries an exact read3 context, with cover null only for genuine text',
      async () => {
        const draw = f.app.get(RatingRandomDraw),
          originalDraw = draw.index;
        const seen = new Set<string>();
        try {
          for (let index = 0; index < 3; index++) {
            draw.index = () => index;
            const response = await sample(true);
            coverHttpOk(response);
            const selected = ratingTargetCoverRandomResponseSchema.parse(
              response.body,
            ).item;
            assert.ok(selected);
            seen.add(selected.target.id);
            assert.equal(selected.coverContext.protocolVersion, 3);
            assert.equal(selected.coverContext.purpose, 'read');
            assert.equal(selected.coverContext.mode, 'public');
            assert.deepEqual(
              selected.coverContext.selector,
              selected.locator.selector,
            );
            assert.equal(
              selected.coverContext.protocolGeneration,
              selected.locator.protocolGeneration,
            );
            const c = selected.coverContext,
              current = await f
                .auth(
                  request(f.http).get(
                    `/v3/ratings/target-cover/targets/${selected.target.id}`,
                  ),
                  actor,
                )
                .query({ contextId: c.id, contextToken: c.token });
            coverHttpOk(current);
            assert.deepEqual(current.body.cover, selected.cover);
            assert.equal(
              ratingTargetCoverRandomResponseSchema.safeParse({
                ...response.body,
                item: {
                  ...selected,
                  coverContext: { ...c, purpose: 'interact' },
                },
              }).success,
              false,
            );
            assert.equal(
              ratingTargetCoverRandomResponseSchema.safeParse({
                ...response.body,
                item: {
                  ...selected,
                  coverContext: { ...c, mode: 'admin_preview' },
                },
              }).success,
              false,
            );
            if (selected.target.id === imageId) {
              assert.ok(selected.cover);
              assert.equal(selected.cover.targetId, imageId);
              assert.equal(selected.cover.contextId, c.id);
              assert.equal(selected.cover.contextToken, c.token);
              const descriptor = await f
                .auth(
                  request(f.http).get(
                    `/v3/ratings/target-cover/targets/${imageId}/appearances/${selected.cover.appearanceId}`,
                  ),
                  actor,
                )
                .query({ contextId: c.id, contextToken: c.token });
              coverHttpOk(descriptor);
              assert.deepEqual(descriptor.body, selected.cover);
              assert.equal(
                ratingTargetCoverRandomResponseSchema.safeParse({
                  ...response.body,
                  item: {
                    ...selected,
                    cover: { ...selected.cover, contextId: randomUUID() },
                  },
                }).success,
                false,
              );
              assert.equal(
                ratingTargetCoverRandomResponseSchema.safeParse({
                  ...response.body,
                  item: {
                    ...selected,
                    cover: { ...selected.cover, targetId: randomUUID() },
                  },
                }).success,
                false,
              );
            } else assert.equal(selected.cover, null);
          }
        } finally {
          draw.index = originalDraw;
        }
        assert.equal(seen.size, 3);
      },
    );
    const repository = f.app.get(RatingScopedRepository),
      complete = repository.completePool;
    const afterScan = async (change: (tx: PoolClient) => Promise<void>) => {
      let reached = false;
      const c = await context(true);
      repository.completePool = async function (handle, tx) {
        reached = true;
        await change(tx);
        return complete.call(this, handle, tx);
      };
      try {
        unavailable(await sample(true, c));
        assert.equal(
          reached,
          true,
          'Actual complete pool was read before mutation',
        );
      } finally {
        repository.completePool = complete;
      }
    };
    await t.test(
      'zero-row optional registry deletion is observed by final proof; real immutable deletion is rejected',
      async () => {
        await afterScan(async (tx) => {
          assert.equal(
            (
              await tx.query(
                'DELETE FROM whaleu_ratings.target_cover_capability_sources WHERE false',
              )
            ).rowCount,
            0,
          );
        });
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'DELETE FROM whaleu_ratings.target_cover_capability_sources',
            ),
          ),
        );
        const current = await sample(true);
        coverHttpOk(current);
        assert.equal(current.body.candidateCount, 3);
      },
    );
    await t.test(
      'unselected asset Safety changes invalidate the whole scan and roll back',
      async () => {
        const draw = f.app.get(RatingRandomDraw),
          originalDraw = draw.index;
        draw.index = () => 0;
        try {
          const first = await sample(true);
          coverHttpOk(first);
          // A real asset change is mandatory even if deterministic ordering chose it;
          // select a different draw index first so this regression covers unselected data.
          if (first.body.item.target.id === imageId)
            draw.index = (size) => size - 1;
          const selected = await sample(true);
          coverHttpOk(selected);
          assert.notEqual(selected.body.item.target.id, imageId);
          const before = (
            await f.pool.query(
              'SELECT revision,event_id FROM whaleu_media.asset_safety_heads WHERE asset_id=$1',
              [assetId],
            )
          ).rows[0];
          await afterScan(async (tx) => {
            const asset = (
              await tx.query(
                'SELECT manifest_digest,policy_revision FROM whaleu_media.assets WHERE id=$1',
                [assetId],
              )
            ).rows[0];
            const event = randomUUID(),
              revision = String(BigInt(before.revision) + 1n);
            await tx.query(
              `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) VALUES($1::uuid,$2,$3,'unknown',$4,$5,'synthetic-cover-pool',$1::text,'{}',clock_timestamp(),clock_timestamp()+interval '1 hour')`,
              [
                event,
                assetId,
                revision,
                asset.manifest_digest,
                asset.policy_revision,
              ],
            );
            await tx.query(
              'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
              [assetId, revision, event],
            );
          });
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT revision,event_id FROM whaleu_media.asset_safety_heads WHERE asset_id=$1',
                [assetId],
              )
            ).rows[0],
            before,
          );
        } finally {
          draw.index = originalDraw;
        }
      },
    );
    await t.test(
      'a genuine v6 definition inserted after the scan cannot escape final whole-pool proof',
      async () => {
        const upload = await f.ready(actor, await f.draft(actor), bytes),
          prepared = await f.prepare(actor, upload.input);
        const database = f.app.get(DatabaseService),
          transaction = database.transaction;
        await afterScan(async (tx) => {
          // Join only this nested real owner command to the read transaction. All
          // command/Review/SQL constraints remain active; outer final proof must abort.
          database.transaction = async <T>(
            work: (client: PoolClient) => Promise<T>,
          ): Promise<T> => work(tx);
          try {
            const receipt = await f.commands.submit(
              actor.accessToken,
              upload.input,
              prepared.prepared.contextRevision,
            );
            assert.equal(receipt.outcome, 'applied');
          } finally {
            database.transaction = transaction;
          }
        });
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
              'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, upload.input.payload.clientRequestId],
            )
          ).rowCount,
          0,
        );
        const stable = await sample(true);
        coverHttpOk(stable);
        assert.equal(stable.body.candidateCount, 3);
      },
    );
    await t.test(
      'expired optional registration leaves v2 authority intact but a mixed v3 pool is wholly unavailable',
      async () => {
        const oldBeforeExpiry = await context(false),
          beforeExpiryAuthority = await authority(oldBeforeExpiry.id);
        const deadline = (
          await f.pool.query<{ delay: number }>(
            'SELECT greatest(0,extract(epoch FROM(max(valid_until)-clock_timestamp()))*1000)::integer delay FROM whaleu_ratings.target_cover_capability_sources',
          )
        ).rows[0]!.delay;
        assert.ok(deadline >= 0 && deadline <= 90000);
        await sleep(deadline + 50);
        const old = await context(false);
        assert.deepEqual(await authority(old.id), beforeExpiryAuthority);
        assert.equal(
          'targetCoverCapabilities' in (await authority(old.id)).authority,
          false,
        );
        unavailable(await sample(true));
        const pure = await pureTextPool();
        coverHttpOk(pure);
        assert.equal(pure.body.candidateCount, 1);
        // The old pure-text direct read also retains its original proof contract.
        const textRead = await context(false, 'read');
        coverHttpOk(
          await f
            .auth(
              request(f.http).get(`/v2/ratings/targets/${texts[0]!.id}`),
              actor,
            )
            .query({ contextId: textRead.id, contextToken: textRead.token }),
        );
      },
    );
  },
);
