import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  registerTransactionDeadline,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../src/database/transaction-deadlines.js';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import {
  readyBatch,
  sealBatchPost,
  responseOk,
} from '../support/media/batch-fixture.js';
import { seedReviewPolicy } from '../support/community-approval-fixtures.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { MediaAssetRepository } from '../../src/media/asset-repository.js';
import { MediaOwnerProofRegistry } from '../../src/media/owner-proof.js';
import { OfficialWithdrawalMaintainer } from '../../src/official-account-operations/withdrawal.js';
import { OfficialOperationWorker } from '../../src/official-account-operations/worker.js';
import {
  officialAccountFixture,
  attachOfficialFixture,
} from '../support/official-account-fixture.js';
import type { OfficialSyntheticProvider } from '../../src/official-account-operations/provider.js';
test(
  'source purpose withdrawal during async preparation prevents dispatch without rewriting accepted intent',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const post = await f.publish(
        'This exact public source is withdrawn during prepare.',
      );
      const preview = await f.service.preview(
        f.world.author.accessToken,
        { programId: f.programId, expectedConfigRevision: f.revision },
        true,
      );
      const intent = {
        requestId: randomUUID(),
        programId: f.programId,
        previewId: preview.previewId,
        manifestHash: preview.manifestHash,
        expectedConfigRevision: f.revision,
        acknowledgement: 'synthetic_draft_only',
      };
      const command = await f.service.createDraft(
          f.world.author.accessToken,
          intent,
          true,
        ),
        base = f.runtime.provider;
      let sends = 0;
      const withdraw: OfficialSyntheticProvider = {
        profile: base.profile,
        arm: base.arm.bind(base),
        verify: base.verify.bind(base),
        reconcile: base.reconcile.bind(base),
        contentHash: base.contentHash.bind(base),
        prepare: async (...args) => {
          const p = await base.prepare(...args);
          await f.eligibility(post.id, 'deny');
          return {
            ...p,
            dispatch: (permit) => {
              sends++;
              return p.dispatch(permit);
            },
          };
        },
      };
      Object.defineProperty(f.runtime, 'provider', { value: withdraw });
      await f.worker.runCycle();
      assert.equal(sends, 0);
      assert.equal(
        (await f.pool.query('SELECT id FROM whaleu_official.attempts')).rows
          .length,
        0,
      );
      const recovered = await f.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (recovered.state !== 'recorded') throw Error('No receipt');
      assert.deepEqual(recovered.receipt, command.receipt);
    } finally {
      await f.close();
    }
  },
);

test(
  'real Media binding preparation, partial material cancellation, and final withdrawal veto',
  { timeout: 480000 },
  async () => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#315578' },
    })
      .png()
      .toBuffer();
    const media = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    let official: Awaited<ReturnType<typeof attachOfficialFixture>> | undefined;
    try {
      await seedReviewPolicy(media.pool);
      const actor = await media.actor();
      const ready = await readyBatch(media, actor, 1, [
        { mime: 'image/png', bytes },
      ]);
      const sealed = await sealBatchPost(
        media,
        actor,
        ready.status,
        'Exact Media source for official draft',
      );
      const published = await request(media.app.getHttpServer())
        .post('/v1/community/posts')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(sealed.body);
      responseOk(published, 201);
      const postId = published.body.resourceId as string;
      official = await attachOfficialFixture(
        media,
        { scope: media.scope, author: actor },
        media.storage,
      );
      const f = official;
      await f.eligibility(postId);
      const create = async () => {
        const preview = await f.service.preview(
          actor.accessToken,
          { programId: f.programId, expectedConfigRevision: f.revision },
          true,
        );
        const intent = {
          requestId: randomUUID(),
          programId: f.programId,
          previewId: preview.previewId,
          manifestHash: preview.manifestHash,
          expectedConfigRevision: f.revision,
          acknowledgement: 'synthetic_draft_only',
        };
        await f.service.createDraft(actor.accessToken, intent, true);
        return intent;
      };
      const partial = await create(),
        base = f.runtime.provider;
      const stopAfterOne: OfficialSyntheticProvider = {
        profile: base.profile,
        arm: base.arm.bind(base),
        verify: base.verify.bind(base),
        reconcile: base.reconcile.bind(base),
        contentHash: base.contentHash.bind(base),
        prepare: async (...args) => {
          const prepared = await base.prepare(...args);
          return {
            ...prepared,
            dispatch: (permit) => {
              const evidence = prepared.dispatch(permit);
              f.worker.stopAdmission();
              return evidence;
            },
          };
        },
      };
      Object.defineProperty(f.runtime, 'provider', { value: stopAfterOne });
      await f.worker.runCycle();
      await f.service.cancel(actor.accessToken, partial.requestId, {
        intent: partial,
      });
      const cancelled = await f.service.status(
        actor.accessToken,
        partial.requestId,
      );
      if (cancelled.state !== 'recorded')
        throw Error('Missing material receipt');
      assert.equal(cancelled.status.state, 'cancelled');
      assert.equal(cancelled.status.acceptedMaterialCount, 1);
      assert.equal(cancelled.status.draftRef, null);
      Object.defineProperty(f.runtime, 'provider', { value: base });
      const full = await create();
      await new OfficialOperationWorker(f.service).runCycle();
      const confirmed = await f.service.status(
        actor.accessToken,
        full.requestId,
      );
      if (confirmed.state !== 'recorded') throw Error('Missing exact draft');
      assert.equal(confirmed.status.state, 'draft_confirmed');
      assert.equal(confirmed.status.acceptedMaterialCount, 1);
      const withdrawn = await create();
      let sends = 0;
      const revokeDuringPrepare: OfficialSyntheticProvider = {
        profile: base.profile,
        arm: base.arm.bind(base),
        verify: base.verify.bind(base),
        reconcile: base.reconcile.bind(base),
        contentHash: base.contentHash.bind(base),
        prepare: async (...args) => {
          const prepared = await base.prepare(...args);
          await f.database.transaction(
            (tx) =>
              new MediaAssetRepository(new MediaOwnerProofRegistry([])).detach(
                {
                  ownerKind: 'community',
                  resourceKind: 'post',
                  resourceId: postId,
                  contentVersion: 1,
                },
                tx,
              ),
            { isolationLevel: 'read committed' },
          );
          return {
            ...prepared,
            dispatch: (permit) => {
              sends++;
              return prepared.dispatch(permit);
            },
          };
        },
      };
      Object.defineProperty(f.runtime, 'provider', {
        value: revokeDuringPrepare,
      });
      await new OfficialOperationWorker(f.service).runCycle();
      assert.equal(sends, 0);
      const refs = (
        await f.pool.query<{ id: string }>(
          'SELECT id FROM whaleu_official.commands WHERE request_id=ANY($1::uuid[])',
          [[full.requestId, withdrawn.requestId]],
        )
      ).rows;
      assert.equal(
        (
          await new OfficialWithdrawalMaintainer(f.service).runCycle(
            refs.map((x) => x.id),
          )
        ).withdrawn,
        2,
      );
      const afterWithdrawal = await f.service.status(
        actor.accessToken,
        full.requestId,
      );
      if (afterWithdrawal.state !== 'recorded')
        throw Error('Missing accepted draft history');
      assert.equal(afterWithdrawal.status.state, 'draft_confirmed');
      assert.equal(
        afterWithdrawal.status.withdrawal,
        'local_withdrawn_remote_unverified',
      );

      assert.equal(
        (
          await f.pool.query(
            'SELECT a.id FROM whaleu_official.attempts a JOIN whaleu_official.effects e ON e.id=a.effect_id JOIN whaleu_official.commands c ON c.id=e.command_id WHERE c.request_id=$1',
            [withdrawn.requestId],
          )
        ).rowCount,
        0,
      );
    } finally {
      if (official) await official.close();
      else await media.close();
    }
  },
);

test(
  'a delayed final owner proof cannot cross freshness or the fixed dispatch permit',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      await f.publish('Late proof deadline fixture');
      const preview = await f.service.preview(
        f.world.author.accessToken,
        { programId: f.programId, expectedConfigRevision: f.revision },
        true,
      );
      const intent = {
        requestId: randomUUID(),
        programId: f.programId,
        previewId: preview.previewId,
        manifestHash: preview.manifestHash,
        expectedConfigRevision: f.revision,
        acknowledgement: 'synthetic_draft_only',
      };
      await f.service.createDraft(f.world.author.accessToken, intent, true);
      const original = f.runtime.manifests.requireCurrent.bind(
        f.runtime.manifests,
      );
      let reads = 0;
      f.runtime.manifests.requireCurrent = async (...args) => {
        await original(...args);
        if (++reads !== 2) return;
        const tx = args[3],
          now = (
            await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
          ).rows[0]!.now.getTime();
        registerTransactionDeadline(tx, now + 150, 'OFFICIAL_PREVIEW_STALE');
        const delayed: RequiredTransactionProof<string> = {
          maximumFacts: 1,
          failureCode: 'OFFICIAL_PREVIEW_STALE',
          validate: async (_facts, client) => {
            await client.query('SELECT pg_sleep(0.2)');
          },
        };
        enableRequiredTransactionProof(tx, delayed);
        registerRequiredTransactionFact(
          tx,
          delayed,
          'bounded-final-proof',
          'fixture',
        );
      };
      await f.worker.runCycle();
      assert.equal(
        (await f.pool.query('SELECT id FROM whaleu_official.attempts'))
          .rowCount,
        0,
      );
      assert.equal(
        (await f.pool.query('SELECT id FROM whaleu_official.evidence'))
          .rowCount,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'withdrawal settles an abandoned preparation claim before a fresh worker restarts',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const post = await f.publish('abandoned preparation withdrawal');
      const preview = await f.service.preview(
        f.world.author.accessToken,
        { programId: f.programId, expectedConfigRevision: f.revision },
        true,
      );
      const intent = {
        requestId: randomUUID(),
        programId: f.programId,
        previewId: preview.previewId,
        manifestHash: preview.manifestHash,
        expectedConfigRevision: f.revision,
        acknowledgement: 'synthetic_draft_only',
      };
      const admitted = await f.service.createDraft(
        f.world.author.accessToken,
        intent,
        true,
      );
      // Test-only crash seam: run the actual transactional claim and abandon the
      // worker before preparation/dispatch. No direct effect-state fixture seed.
      const claim = await f.worker['claim'](false);
      assert.ok(claim);
      const persisted = (
        await f.pool.query(
          'SELECT state,lease_until,attempts FROM whaleu_official.effect_states WHERE effect_id=$1',
          [claim.effect.effectId],
        )
      ).rows[0]!;
      assert.equal(persisted.state, 'preparing');
      assert.equal(persisted.attempts, 0);
      assert.ok(persisted.lease_until);
      await f.eligibility(post.id, 'deny');
      const command = (
        await f.pool.query<{ id: string }>(
          'SELECT id FROM whaleu_official.commands WHERE actor_ref=$1 AND request_id=$2',
          [f.world.author.accountId, intent.requestId],
        )
      ).rows[0]!;
      const withdrawal = await new OfficialWithdrawalMaintainer(
        f.service,
      ).runCycle([command.id]);
      assert.equal(withdrawal.withdrawn, 1);
      const settled = (
        await f.pool.query(
          'SELECT state,lease_until FROM whaleu_official.effect_states WHERE effect_id=$1',
          [claim.effect.effectId],
        )
      ).rows[0]!;
      assert.equal(settled.state, 'suppressed_unsent');
      assert.equal(settled.lease_until, null);
      assert.equal(
        (await new OfficialOperationWorker(f.service).runCycle()).claimed,
        0,
      );
      assert.equal(
        (await f.pool.query('SELECT id FROM whaleu_official.attempts')).rows
          .length,
        0,
      );
      assert.equal(
        (await f.pool.query('SELECT id FROM whaleu_official.evidence')).rows
          .length,
        0,
      );
      const recovered = await f.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (recovered.state !== 'recorded')
        throw new Error('Missing retained receipt');
      assert.deepEqual(recovered.receipt, admitted.receipt);
      assert.equal(
        recovered.status.withdrawal,
        'local_withdrawn_remote_unverified',
      );
    } finally {
      await f.close();
    }
  },
);
