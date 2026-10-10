import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { inTransaction } from '../../src/database/database.js';
import { registerTransactionDeadline } from '../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { authorizeDiscussionPublication } from '../../src/community/discussion/publication-target.js';
import {
  collectDiscussionAncestorMedia,
  discussionAncestorAuthorization,
  withDiscussionMediaMutation,
} from '../../src/media/discussion-ancestor-proof.js';
import { MediaAssetRepository } from '../../src/media/asset-repository.js';
import { MediaOwnerProofRegistry } from '../../src/media/owner-proof.js';
import {
  MediaRequiredProof,
  mediaCountProofOwner,
} from '../../src/media/required-proof.js';
import type { MediaParent } from '../../src/media/contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import {
  publishDiscussionPost,
  readyDiscussionBatch,
  sealDiscussionBatch,
  responseOk,
} from '../support/media/discussion-batch-fixture.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { discussionApprovalEnvelope } from '../support/community-runtime-fixtures.js';

const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'MEDIA_UNAVAILABLE';
const denied = (error: unknown) => error instanceof ApplicationError;

/** A real zero-row statement still advances Media's mandatory writer epoch.
 * It changes no asset identity and invokes the ordinary installed writer gates. */
async function mediaWrite(tx: PoolClient): Promise<void> {
  await tx.query(
    'UPDATE whaleu_media.assets SET created_at=created_at WHERE false',
  );
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test(
  'discussion ancestor mutation proof retains unrelated mandatory facts and fails closed at real PostgreSQL commit',
  { timeout: 480000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#314159' },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    try {
      await seedReviewPolicy(f.pool);
      const actor = await f.actor();
      const postId = await publishDiscussionPost(f, actor);
      const ready = await readyDiscussionBatch(
        f,
        actor,
        { kind: 'comment', postId },
        1,
        [{ mime: 'image/png', bytes }],
      );
      const sealed = await sealDiscussionBatch(
        f,
        actor,
        ready.status,
        'Ancestor proof fixture',
      );
      const published = await request(f.app.getHttpServer())
        .post(sealed.path)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(sealed.body);
      responseOk(published, 201);
      assert.equal(published.body.outcome, 'created');
      const rootId = published.body.resourceId as string;
      const targetBody = {
        clientRequestId: randomUUID(),
        text: 'A referenced reply',
        imageAssetIds: [],
        authorMode: 'named' as const,
        targetReplyId: null,
      };
      await approveEnvelope(
        f.pool,
        await discussionApprovalEnvelope(
          f.app,
          f.pool,
          actor.accountId,
          postId,
          targetBody,
          rootId,
        ),
      );
      const targetResponse = await request(f.app.getHttpServer())
        .post(`/v1/community/comments/${rootId}/replies`)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(targetBody);
      responseOk(targetResponse, 201);
      assert.equal(targetResponse.body.outcome, 'created');
      const targetId = targetResponse.body.resourceId as string;
      const access = f.app.get(CommunityAccessService),
        repository = f.app.get(CommunityRepository);
      const parent: MediaParent = {
        ownerKind: 'community',
        resourceKind: 'comment',
        resourceId: rootId,
        contentVersion: 1,
      };
      const images = (
        await f.pool.query<{ assetId: string; digest: string }>(
          'SELECT asset_id AS "assetId",digest FROM whaleu_community.comment_images WHERE comment_id=$1 ORDER BY position',
          [rootId],
        )
      ).rows;
      assert.equal(images.length, 1);
      const identity = {
        actor: actor.accountId,
        target: {
          kind: 'reply' as const,
          rootCommentId: rootId,
          targetReplyId: targetId,
        },
      };
      const authorize = (tx: PoolClient) =>
        authorizeDiscussionPublication(
          access,
          repository,
          actor.accountId,
          identity.target,
          tx,
        );
      const transaction = <T>(run: (tx: PoolClient) => Promise<T>) =>
        inTransaction(
          f.pool,
          async (tx) => {
            await lockSafetyPolicy(tx, true);
            return run(tx);
          },
          { isolationLevel: 'read committed' },
        );

      // Test-only commit markers and a deferred writer. They are created only in
      // the disposable fixture schema; no runtime hook or production API is added.
      await f.pool
        .query(`CREATE TABLE whaleu_media.synthetic_discussion_proof_markers(id uuid PRIMARY KEY,write_at_commit boolean NOT NULL DEFAULT false);
      CREATE FUNCTION whaleu_media.synthetic_discussion_deferred_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.write_at_commit THEN UPDATE whaleu_media.assets SET created_at=created_at WHERE false; END IF; RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER synthetic_discussion_deferred_write AFTER INSERT ON whaleu_media.synthetic_discussion_proof_markers
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.synthetic_discussion_deferred_write()`);
      const mark = (tx: PoolClient, id: string, atCommit = false) =>
        tx.query(
          'INSERT INTO whaleu_media.synthetic_discussion_proof_markers(id,write_at_commit) VALUES($1,$2)',
          [id, atCommit],
        );
      const markerExists = async (id: string) =>
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_media.synthetic_discussion_proof_markers WHERE id=$1',
            [id],
          )
        ).rowCount === 1;

      await t.test(
        'expected Media SQL followed by complete real ancestor reauthorization commits',
        async () => {
          const id = randomUUID();
          await transaction((tx) =>
            withDiscussionMediaMutation(tx, identity, async () => {
              await authorize(tx);
              const before = await mediaCountProofOwner.capture(tx);
              await mediaWrite(tx);
              assert.notDeepEqual(
                await mediaCountProofOwner.capture(tx),
                before,
              );
              await mark(tx, id);
            }),
          );
          assert.equal(await markerExists(id), true);
        },
      );

      await t.test(
        'an unawaited collector cannot commit before its finalization; a caught failed collector also poisons commit',
        async () => {
          const id = randomUUID(),
            started = deferred(),
            stop = deferred();
          let running: Promise<unknown> | undefined;
          try {
            await assert.rejects(
              transaction(async (tx) => {
                running = withDiscussionMediaMutation(
                  tx,
                  identity,
                  async () => {
                    await authorize(tx);
                    await mark(tx, id);
                    started.resolve();
                    await stop.promise;
                    throw new Error('SYNTHETIC_CANCEL_UNFINISHED_COLLECTOR');
                  },
                );
                // Observe failure immediately to avoid an unhandled rejection while
                // the ordinary transaction wrapper attempts its actual final proof.
                void running.catch(() => undefined);
                await Promise.race([started.promise, running]);
                // Deliberately omit awaiting running: finalization must reject this.
              }),
              unavailable,
            );
          } finally {
            stop.resolve();
            if (running)
              await assert.rejects(
                running,
                /SYNTHETIC_CANCEL_UNFINISHED_COLLECTOR/,
              );
          }
          assert.equal(await markerExists(id), false);
          const caught = randomUUID();
          await assert.rejects(
            transaction(async (tx) => {
              await assert.rejects(
                withDiscussionMediaMutation(tx, identity, async () => {
                  await authorize(tx);
                  await mark(tx, caught);
                  throw new Error('SYNTHETIC_ABORT_BEFORE_FINALIZE');
                }),
                /SYNTHETIC_ABORT_BEFORE_FINALIZE/,
              );
              // Swallowing a callback failure cannot satisfy its retained obligation.
            }),
            unavailable,
          );
          assert.equal(await markerExists(caught), false);
        },
      );

      await t.test(
        'collectors are scoped to the exact PoolClient, including while another transaction is active',
        async () => {
          let checks = 0;
          await inTransaction(
            f.pool,
            async (outer) => {
              await withDiscussionMediaMutation(outer, identity, async () => {
                await discussionAncestorAuthorization(
                  outer,
                  { rootId },
                  async () => {
                    assert.equal(
                      collectDiscussionAncestorMedia(outer, parent, images),
                      true,
                    );
                    await inTransaction(
                      f.pool,
                      async (other) => {
                        assert.notEqual(other, outer);
                        assert.equal(
                          collectDiscussionAncestorMedia(other, parent, images),
                          false,
                        );
                        await withDiscussionMediaMutation(
                          other,
                          { other: true },
                          async () => {
                            await discussionAncestorAuthorization(
                              other,
                              { rootId },
                              async () => {
                                assert.equal(
                                  collectDiscussionAncestorMedia(
                                    other,
                                    parent,
                                    images,
                                  ),
                                  true,
                                );
                                return rootId;
                              },
                              (value) => value,
                            );
                          },
                        );
                        assert.equal(
                          collectDiscussionAncestorMedia(other, parent, images),
                          false,
                        );
                      },
                      { isolationLevel: 'read committed' },
                    );
                    checks++;
                    return rootId;
                  },
                  (value) => value,
                );
              });
              assert.equal(
                collectDiscussionAncestorMedia(outer, parent, images),
                false,
              );
            },
            { isolationLevel: 'read committed' },
          );
          assert.equal(
            checks,
            2,
            'Initial and final authorization each run in their own collector context',
          );
        },
      );

      for (const consumer of [
        'ordinary-epoch',
        'ordinary-binding-read',
      ] as const)
        await t.test(
          `${consumer} keeps its pre-write mandatory proof even inside a discussion mutation`,
          async () => {
            const id = randomUUID();
            await assert.rejects(
              transaction((tx) =>
                withDiscussionMediaMutation(tx, identity, async () => {
                  await authorize(tx);
                  assert.equal(
                    collectDiscussionAncestorMedia(tx, parent, images),
                    false,
                  );
                  if (consumer === 'ordinary-epoch')
                    await new MediaRequiredProof().capture(tx);
                  else
                    await new MediaAssetRepository(
                      new MediaOwnerProofRegistry([]),
                    ).verifyContentBindings(parent, images, tx);
                  await mediaWrite(tx);
                  await mark(tx, id);
                }),
              ),
              unavailable,
            );
            assert.equal(await markerExists(id), false);
          },
        );

      await t.test(
        'existing transaction deadlines survive expected writes and final ancestor reauthorization',
        async () => {
          const id = randomUUID();
          await assert.rejects(
            transaction((tx) =>
              withDiscussionMediaMutation(tx, identity, async () => {
                await authorize(tx);
                registerTransactionDeadline(
                  tx,
                  Date.now() - 1,
                  'MEDIA_UNAVAILABLE',
                );
                await mediaWrite(tx);
                await mark(tx, id);
              }),
            ),
            unavailable,
          );
          assert.equal(await markerExists(id), false);
        },
      );

      for (const atCommit of [false, true])
        await t.test(
          `${atCommit ? 'deferred-trigger' : 'later ordinary'} Media SQL after finalization rejects commit`,
          async () => {
            const id = randomUUID();
            await assert.rejects(
              transaction(async (tx) => {
                await withDiscussionMediaMutation(tx, identity, async () => {
                  await authorize(tx);
                  await mediaWrite(tx);
                });
                await mark(tx, id, atCommit);
                if (!atCommit) await mediaWrite(tx);
              }),
              unavailable,
            );
            assert.equal(await markerExists(id), false);
          },
        );

      await t.test(
        'the final Media table fence rejects a separate in-flight writer even before its epoch changes',
        async () => {
          const writer = await f.pool.connect();
          const id = randomUUID();
          try {
            await writer.query('BEGIN');
            await writer.query(
              'LOCK TABLE whaleu_media.assets IN ROW EXCLUSIVE MODE',
            );
            await assert.rejects(
              transaction((tx) =>
                withDiscussionMediaMutation(tx, identity, async () => {
                  await authorize(tx);
                  await mediaWrite(tx);
                  await mark(tx, id);
                }),
              ),
              unavailable,
            );
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
          assert.equal(await markerExists(id), false);
        },
      );

      for (const changed of ['target', 'scope', 'typed-parent-set'] as const)
        await t.test(
          `final ${changed} drift is rejected instead of accepting a new authorization identity`,
          async () => {
            const id = randomUUID();
            let final = false;
            await assert.rejects(
              transaction((tx) =>
                withDiscussionMediaMutation(tx, identity, async () => {
                  await discussionAncestorAuthorization(
                    tx,
                    { rootId, targetId },
                    async () => {
                      await new MediaAssetRepository(
                        new MediaOwnerProofRegistry([]),
                      ).verifyContentBindings(parent, images, tx);
                      // Deliberately reuse the UUID with another kind. Losing that typed
                      // entry must fail even when the visible callback result is equal.
                      if (changed !== 'typed-parent-set' || !final)
                        assert.equal(
                          collectDiscussionAncestorMedia(
                            tx,
                            { ...parent, resourceKind: 'reply' },
                            images,
                          ),
                          true,
                        );
                      return {
                        rootId,
                        targetId:
                          changed === 'target' && final
                            ? randomUUID()
                            : targetId,
                        scope:
                          changed === 'scope' && final
                            ? 'changed-scope'
                            : 'original-scope',
                      };
                    },
                    (value) => JSON.stringify(value),
                  );
                  await mediaWrite(tx);
                  await mark(tx, id);
                  final = true;
                }),
              ),
              unavailable,
            );
            assert.equal(await markerExists(id), false);
          },
        );

      for (const changed of [
        'content-review',
        'asset-safety',
        'target-tombstone',
      ] as const)
        await t.test(
          `full final business authorization rejects a same-transaction ${changed} change`,
          async () => {
            const id = randomUUID();
            await assert.rejects(
              transaction((tx) =>
                withDiscussionMediaMutation(tx, identity, async () => {
                  await authorize(tx);
                  if (changed === 'content-review') {
                    const approval = (
                      await tx.query<{ decision_id: string }>(
                        "SELECT decision_id FROM whaleu_community.content_approval_bindings WHERE content_kind='comment' AND content_id=$1",
                        [rootId],
                      )
                    ).rows[0]!;
                    const eventId = randomUUID();
                    await tx.query(
                      `INSERT INTO whaleu_community.content_approval_events
              (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
              VALUES($1,$2,'held','complete','accepted','synthetic-review-owner','synthetic-final-proof-change',clock_timestamp())`,
                      [eventId, approval.decision_id],
                    );
                    await tx.query(
                      'UPDATE whaleu_community.content_approval_heads SET event_id=$1 WHERE decision_id=$2',
                      [eventId, approval.decision_id],
                    );
                  } else if (changed === 'asset-safety') {
                    const asset = (
                      await tx.query<{
                        manifest_digest: string;
                        policy_revision: string;
                        revision: string;
                      }>(
                        'SELECT a.manifest_digest,a.policy_revision,h.revision FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$1 FOR UPDATE OF h',
                        [images[0]!.assetId],
                      )
                    ).rows[0]!;
                    const eventId = randomUUID(),
                      revision = String(BigInt(asset.revision) + 1n);
                    await tx.query(
                      `INSERT INTO whaleu_media.asset_safety_events
              (id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
              VALUES($1::uuid,$2::uuid,$3::bigint,'held',$4,$5,'registered-synthetic-media',($1::uuid)::text,'{}',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`,
                      [
                        eventId,
                        images[0]!.assetId,
                        revision,
                        asset.manifest_digest,
                        asset.policy_revision,
                      ],
                    );
                    await tx.query(
                      'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
                      [images[0]!.assetId, revision, eventId],
                    );
                  } else {
                    await tx.query(
                      'UPDATE whaleu_community.replies SET deleted_at=clock_timestamp() WHERE id=$1',
                      [targetId],
                    );
                  }
                  await mediaWrite(tx);
                  await mark(tx, id);
                }),
              ),
              denied,
            );
            assert.equal(await markerExists(id), false);
            // A new managed transaction must see the original live authority again;
            // rollback restored both the business source and its attached obligations.
            await transaction((tx) =>
              withDiscussionMediaMutation(tx, identity, async () => {
                await authorize(tx);
              }),
            );
          },
        );
    } finally {
      await f.close();
    }
  },
);
