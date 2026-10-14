import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { officialAccountFixture } from '../support/official-account-fixture.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { OfficialSourceSelector } from '../../src/official-account-operations/selection.js';
import { OfficialWithdrawalMaintainer } from '../../src/official-account-operations/withdrawal.js';
import { boundHotTransaction } from '../../src/community/hot-score/transaction.js';
test(
  'manual newest prefix includes old school content, excludes future, and exact owned draft publish is separate',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const old = await f.world.dated(
          new Date(Date.now() - 48 * 3600000).toISOString(),
        ),
        recent = await f.world.dated(
          new Date(Date.now() - 10000).toISOString(),
        ),
        future = await f.world.dated(
          new Date(Date.now() + 3600000).toISOString(),
        );
      for (const post of [old, recent, future]) await f.eligibility(post.id);
      const selector = new OfficialSourceSelector(f.source);
      const selected = await f.database.transaction(
        async (tx) => {
          await boundHotTransaction(tx);
          return selector.select(
            {
              schoolSpaceId: f.world.scope.home.spaceId,
              citySpaceId: null,
              kind: 'manual_newest',
            },
            tx,
          );
        },
        { isolationLevel: 'read committed' },
      );
      assert.deepEqual(
        selected.facts.map((p) => p.postId),
        [recent.id, old.id],
      );
      const preview = await f.service.preview(
        f.world.author.accessToken,
        { programId: f.programId, expectedConfigRevision: f.revision },
        true,
      );
      assert.equal(preview.eligibleCount, 2);
      const before = (
        await f.pool.query('SELECT id FROM whaleu_official.effects')
      ).rows.length;
      assert.equal(before, 0);
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
      assert.equal(admitted.status.state, 'pending');
      await f.worker.runCycle();
      const result = await f.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      assert.equal(result.state, 'recorded');
      if (result.state !== 'recorded') throw Error('No receipt');
      assert.equal(result.status.state, 'draft_confirmed');
      assert.ok(result.status.draftRef);
      const provider = f.runtime.provider;
      Object.defineProperty(f.runtime, 'provider', {
        value: {
          profile: provider.profile,
          arm: provider.arm.bind(provider),
          prepare: provider.prepare.bind(provider),
          verify: provider.verify.bind(provider),
          reconcile: provider.reconcile.bind(provider),
          contentHash: async () => 'b'.repeat(64),
        },
      });
      await assert.rejects(
        () =>
          f.service.publishPreview(f.world.author.accessToken, {
            draftRef: result.status.draftRef,
          }),
        (error) =>
          error instanceof ApplicationError &&
          error.code === 'OFFICIAL_PREVIEW_STALE',
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT id FROM whaleu_official.effects WHERE stage='publish_submit'",
          )
        ).rowCount,
        0,
      );
      Object.defineProperty(f.runtime, 'provider', { value: provider });
      const confirmation = await f.service.publishPreview(
        f.world.author.accessToken,
        { draftRef: result.status.draftRef },
      );
      const publish = {
        requestId: randomUUID(),
        draftRef: confirmation.draftRef,
        confirmationId: confirmation.confirmationId,
        confirmationRevision: confirmation.revision,
        manifestHash: confirmation.manifestHash,
        acknowledgement: 'publish_exact_synthetic_article',
      };
      const accepted = await f.service.publish(
        f.world.author.accessToken,
        publish,
      );
      assert.equal(accepted.status.state, 'pending');
      await f.worker.runCycle();
      const submitted = await f.service.status(
        f.world.author.accessToken,
        publish.requestId,
      );
      assert.equal(submitted.state, 'recorded');
      if (submitted.state === 'recorded')
        assert.equal(submitted.status.state, 'publish_submitted');
      await assert.rejects(() =>
        f.service.publish(f.world.author.accessToken, {
          ...publish,
          requestId: randomUUID(),
        }),
      );
      await assert.rejects(() =>
        f.service.publishPreview(f.world.reader.accessToken, {
          draftRef: result.status.draftRef,
        }),
      );
      await f.pool.query(
        'UPDATE whaleu_official.export_eligibility SET revoked_at=clock_timestamp() WHERE post_id=$1',
        [recent.id],
      );
      const commands = (
        await f.pool.query<{ id: string }>(
          'SELECT id FROM whaleu_official.commands WHERE request_id=ANY($1::uuid[])',
          [[intent.requestId, publish.requestId]],
        )
      ).rows;
      assert.equal(
        (
          await new OfficialWithdrawalMaintainer(f.service).runCycle(
            commands.map((x) => x.id),
          )
        ).withdrawn,
        2,
      );
      const withdrawn = await f.service.status(
        f.world.author.accessToken,
        publish.requestId,
      );
      if (withdrawn.state !== 'recorded')
        throw Error('Missing original publish receipt');
      assert.equal(withdrawn.status.state, 'publish_submitted');
      assert.equal(
        withdrawn.status.withdrawal,
        'local_withdrawn_remote_unverified',
      );
    } finally {
      await f.close();
    }
  },
);
