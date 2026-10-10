import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';

test(
  'original publication cancellation owner enforces the actor budget under concurrent distinct keys and retains exact retries',
  { timeout: 60000 },
  async () => {
    const f = await directoryRuntimeFixture();
    try {
      const actor = await f.actor();
      const { inTransaction } = await import('../../src/database/database.js');
      const { CommunityMediaBatchPublicationProof } =
        await import('../../src/community/media/batch-publication-proof.js');
      const owner = new CommunityMediaBatchPublicationProof();
      const references = Array.from({ length: 129 }, () => ({
        clientRequestId: randomUUID(),
        operation: 'publish_post' as const,
        intentHash: 'b'.repeat(64),
      }));
      await inTransaction(f.pool, async (tx) => {
        for (const reference of references.slice(0, 127))
          assert.equal(
            (await owner.fenceNonCreated(actor.accountId, reference, tx))
              .outcome,
            'cancelled',
          );
      });
      const results = await Promise.allSettled(
        references
          .slice(127)
          .map((reference) =>
            inTransaction(f.pool, (tx) =>
              owner.fenceNonCreated(actor.accountId, reference, tx),
            ),
          ),
      );
      assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      const rejected = results.find((result) => result.status === 'rejected');
      assert.ok(rejected?.status === 'rejected');
      assert.equal(rejected.reason.code, 'MEDIA_RATE_LIMITED');
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::integer AS n FROM whaleu_community.publication_cancel_fences WHERE account_id=$1',
            [actor.accountId],
          )
        ).rows[0]?.n,
        128,
      );
      assert.equal(
        (
          await inTransaction(f.pool, (tx) =>
            owner.fenceNonCreated(actor.accountId, references[0]!, tx),
          )
        ).outcome,
        'cancelled',
      );
      await assert.rejects(
        inTransaction(f.pool, (tx) =>
          owner.fenceNonCreated(
            actor.accountId,
            { ...references[0]!, intentHash: 'c'.repeat(64) },
            tx,
          ),
        ),
        (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'REQUEST_CONFLICT',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::integer AS n FROM whaleu_community.publication_requests WHERE account_id=$1',
            [actor.accountId],
          )
        ).rows[0]?.n,
        0,
        'Budget fences never fabricate publication or Review receipts',
      );
    } finally {
      await f.close();
    }
  },
);
