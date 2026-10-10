import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { syntheticRatingDiscussionFixture } from '../support/media/ratings-discussion-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { sha256 } from '../../src/media/processing/protocol.js';

const constrained = (error: unknown) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23514',
  );
/** Raw SQL counterexamples against real prepared/processed assets. No trigger
 * bypass, disabled constraint, invented provider approval or mocked SQL owner. */
test(
  'Media7 SQL rejects a complete attachment set without original publication and isolates all request keys',
  { timeout: 480000 },
  async (t) => {
    const sharp = (await import('sharp')).default,
      bytes = await sharp({
        create: { width: 32, height: 24, channels: 3, background: '#576b83' },
      })
        .png()
        .toBuffer();
    const f = await syntheticRatingDiscussionFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actor = f.creator,
      upload = await f.ready(actor, await f.draft(actor), [bytes, bytes]);
    const batch = (
      await f.pool.query<{
        id: string;
        server_scope_id: string;
        scope_revision: string;
      }>(
        'SELECT id,server_scope_id,scope_revision FROM whaleu_media.ratings_discussion_batches WHERE id=$1',
        [upload.batch.batchId],
      )
    ).rows[0]!;
    const images = upload.batch.sealedPlan!.orderedMembers;
    const members = (
      await f.pool.query<{ member_id: string; source_slot: number }>(
        'SELECT member_id,source_slot FROM whaleu_media.ratings_discussion_members WHERE batch_id=$1',
        [batch.id],
      )
    ).rows;
    const parent = {
      ownerKind: 'ratings',
      resourceKind: 'rating_comment',
      resourceId: randomUUID(),
      targetId: f.target.id,
      contentVersion: 1,
    };
    const insertScope = async (tx: PoolClient) =>
      tx.query(
        `INSERT INTO whaleu_media.scope_consumptions(actor_id,owner_kind,resource_kind,scope_resource_id,scope_revision,resource_id,content_version,attach_evidence)
    VALUES($1,'ratings','rating_comment',$2,$3,$4,1,$5::jsonb)`,
        [
          actor.accountId,
          batch.server_scope_id,
          batch.scope_revision,
          parent.resourceId,
          JSON.stringify({
            version: 7,
            batchId: batch.id,
            sealedPlanDigest: upload.batch.sealedPlanDigest,
            parent,
            assets: images.map((i) => ({
              assetId: i.assetId,
              digest: i.manifestDigest,
            })),
          }),
        ],
      );
    const insertImage = async (tx: PoolClient, index: number) => {
      const image = images[index]!,
        member = members.find((m) => m.member_id === image.memberId)!;
      await tx.query(
        `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence)
     VALUES($1,$2,$3,'ratings','rating_comment',$4,1,'images',$5,$6::jsonb)`,
        [
          randomUUID(),
          image.assetId,
          image.manifestDigest,
          parent.resourceId,
          index,
          JSON.stringify({
            version: 7,
            batchId: batch.id,
            memberId: member.member_id,
            sourceSlot: member.source_slot,
            sealedPlanDigest: upload.batch.sealedPlanDigest,
            scopeId: batch.server_scope_id,
            scopeRevision: batch.scope_revision,
          }),
        ],
      );
    };
    const consume = async (tx: PoolClient) => {
      await tx.query(
        "UPDATE whaleu_media.ratings_discussion_batches SET state='consumed',consumed_parent=$2::jsonb,revision=$3 WHERE id=$1",
        [batch.id, JSON.stringify(parent), randomUUID()],
      );
      await tx.query(
        "UPDATE whaleu_media.ratings_discussion_members SET state='bound' WHERE batch_id=$1",
        [batch.id],
      );
    };
    const noResidue = async () => {
      const row = (
        await f.pool.query<{
          bindings: number;
          consumptions: number;
          subjects: number;
          reviews: number;
          receipts: number;
          state: string;
        }>(
          `SELECT
     (SELECT count(*)::int FROM whaleu_media.bindings WHERE resource_kind='rating_comment' AND resource_id=$1) bindings,
     (SELECT count(*)::int FROM whaleu_media.scope_consumptions WHERE scope_resource_id=$2) consumptions,
     (SELECT count(*)::int FROM whaleu_ratings.comments WHERE id=$1) subjects,
     (SELECT count(*)::int FROM whaleu_community.rating_discussion_media_bindings WHERE subject_id=$1) reviews,
     (SELECT count(*)::int FROM whaleu_ratings.requests WHERE account_id=$3 AND request_id=$4) receipts,
     (SELECT state FROM whaleu_media.ratings_discussion_batches WHERE id=$5) state`,
          [
            parent.resourceId,
            batch.server_scope_id,
            actor.accountId,
            upload.identity.commandRequestId,
            batch.id,
          ],
        )
      ).rows[0]!;
      assert.deepEqual(row, {
        bindings: 0,
        consumptions: 0,
        subjects: 0,
        reviews: 0,
        receipts: 0,
        state: 'sealed',
      });
    };
    await t.test(
      'full exact Media set still cannot invent an original Ratings publication',
      async () => {
        let reachedDeferred = false;
        await assert.rejects(
          withCommunityScopeWriter(f.pool, async (tx) => {
            await insertScope(tx);
            for (let n = 0; n < images.length; n++) await insertImage(tx, n);
            await consume(tx);
            reachedDeferred = true;
            await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          }),
          constrained,
        );
        assert.equal(
          reachedDeferred,
          true,
          'the counterexample must reach deferred owner completeness',
        );
        await noResidue();
      },
    );
    await t.test(
      'first image alone cannot persist a partial whole-set consumption',
      async () => {
        let insertedFirst = false;
        await assert.rejects(
          withCommunityScopeWriter(f.pool, async (tx) => {
            await insertScope(tx);
            await insertImage(tx, 0);
            insertedFirst = true;
            await consume(tx);
            await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          }),
          constrained,
        );
        assert.equal(insertedFirst, true);
        await noResidue();
      },
    );
    await t.test(
      'batch and member keys cannot be original business commands',
      async () => {
        for (const key of [
          upload.identity.batchRequestId,
          upload.batch.members[0]!.requestId,
        ]) {
          await assert.rejects(
            withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'create_comment_scoped',$3)",
                [actor.accountId, key, 'b'.repeat(64)],
              ),
            ),
            constrained,
          );
        }
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "INSERT INTO whaleu_media.ratings_discussion_batch_request_fences(actor_id,batch_request_id,identity_hash,state) VALUES($1,$2,$3,'cancelled_before_prepare')",
              [
                actor.accountId,
                upload.batch.members[0]!.requestId,
                'c'.repeat(64),
              ],
            ),
          ),
          constrained,
        );
        await noResidue();
      },
    );
    await t.test(
      'reserved publication command key cannot become an absent batch/member fence',
      async () => {
        for (const kind of ['batch', 'member'] as const)
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              await tx.query(
                'INSERT INTO whaleu_ratings.command_claims(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
                [
                  actor.accountId,
                  upload.identity.commandRequestId,
                  `prepare_discussion_media_${kind}`,
                  'd'.repeat(64),
                ],
              );
              if (kind === 'batch')
                await tx.query(
                  "INSERT INTO whaleu_media.ratings_discussion_batch_request_fences(actor_id,batch_request_id,identity_hash,state) VALUES($1,$2,$3,'cancelled_before_prepare')",
                  [
                    actor.accountId,
                    upload.identity.commandRequestId,
                    'd'.repeat(64),
                  ],
                );
              else
                await tx.query(
                  'INSERT INTO whaleu_media.ratings_discussion_request_markers(actor_id,client_request_id,request_hash) VALUES($1,$2,$3)',
                  [
                    actor.accountId,
                    upload.identity.commandRequestId,
                    'd'.repeat(64),
                  ],
                );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
            }),
            constrained,
          );
        await noResidue();
      },
    );
    await t.test(
      'allow on ordinal zero is insufficient when another selected image is held',
      async () => {
        await withCommunityScopeWriter(f.pool, async (tx) => {
          const image = images[1]!,
            row = (
              await tx.query<{ revision: string; policy_revision: string }>(
                'SELECT h.revision::text,a.policy_revision FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$1 FOR UPDATE OF a,h',
                [image.assetId],
              )
            ).rows[0]!;
          const event = randomUUID(),
            revision = String(BigInt(row.revision) + 1n);
          await tx.query(
            "INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) VALUES($1::uuid,$2,$3,'held',$4,$5,'synthetic-discussion-counterexample',$1::text,'{}',clock_timestamp(),clock_timestamp()+interval '1 hour')",
            [
              event,
              image.assetId,
              revision,
              image.manifestDigest,
              row.policy_revision,
            ],
          );
          await tx.query(
            'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
            [image.assetId, revision, event],
          );
        });
        let insertedFirst = false,
          reachedSecond = false;
        await assert.rejects(
          withCommunityScopeWriter(f.pool, async (tx) => {
            await insertScope(tx);
            await insertImage(tx, 0);
            insertedFirst = true;
            await insertImage(tx, 1);
            reachedSecond = true;
          }),
          constrained,
        );
        assert.equal(insertedFirst, true);
        assert.equal(reachedSecond, false);
        await noResidue();
      },
    );
  },
);
