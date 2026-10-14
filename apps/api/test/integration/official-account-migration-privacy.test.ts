import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { officialAccountFixture } from '../support/official-account-fixture.js';
import { restoreOfficialFixture } from '../support/official-account-restore.js';
import { OfficialDailyEnrollment } from '../../src/official-account-operations/schedule.js';
import { OfficialOperationWorker } from '../../src/official-account-operations/worker.js';
import type { OfficialSyntheticProvider } from '../../src/official-account-operations/provider.js';
import {
  OfficialCallbackBoundary,
  OfficialCallbackProjectionWorker,
  createSyntheticCallbackRuntimeForTest,
  registerSyntheticCallbackFixture,
} from '../../src/official-account-operations/callback-ledger.js';
import {
  canonicalCallbackBody,
  syntheticCallbackSignature,
} from '../../src/official-account-operations/callback-auth.js';
import type { SyntheticCallbackEnvelope } from '../../src/official-account-operations/callback-auth.js';

test(
  'preview allowlist omits identities and payload erasure retains immutable receipt/effect tombstones',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      await f.publish('A synthetic public excerpt.');
      const preview = await f.service.preview(
        f.world.author.accessToken,
        { programId: f.programId, expectedConfigRevision: f.revision },
        true,
      );
      assert.doesNotMatch(
        JSON.stringify(preview),
        /"(?:nickname|avatar|studentId|phone|unionSubject|officialSubject|ownerId|actorId|score|source_request_id)"/,
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
      await f.worker.runCycle();
      await f.database.transaction((tx) => f.runtime.payloads.purge(tx));
      const payloads = (
        await f.pool.query(
          'SELECT ciphertext,nonce,tag,purged_at FROM whaleu_official.payloads WHERE command_id=(SELECT id FROM whaleu_official.commands WHERE actor_ref=$1 AND request_id=$2)',
          [f.world.author.accountId, intent.requestId],
        )
      ).rows;
      assert.ok(payloads.length);
      assert.ok(
        payloads.every(
          (p) =>
            p.ciphertext === null &&
            p.nonce === null &&
            p.tag === null &&
            p.purged_at,
        ),
      );
      const recovered = await f.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (recovered.state !== 'recorded') throw Error('No receipt');
      assert.deepEqual(recovered.receipt, admitted.receipt);
      await assert.rejects(() =>
        f.pool.query(
          'DELETE FROM whaleu_official.commands WHERE actor_ref=$1 AND request_id=$2',
          [f.world.author.accountId, intent.requestId],
        ),
      );
      await assert.rejects(() =>
        f.pool.query('TRUNCATE whaleu_official.evidence'),
      );
      // New fresh publication confirmation reconstructs current readable literal
      // fields and frozen counts, rather than retaining old article plaintext.
      assert.ok(recovered.status.draftRef);
      const confirmation = await f.service.publishPreview(
        f.world.author.accessToken,
        { draftRef: recovered.status.draftRef },
      );
      assert.equal(confirmation.manifestHash, preview.manifestHash);
    } finally {
      await f.close();
    }
  },
);

test(
  'coherent isolated database and adapter restore retains original effects, slots and callback revocation',
  { timeout: 480000 },
  async () => {
    const f = await officialAccountFixture();
    let restored:
      Awaited<ReturnType<typeof restoreOfficialFixture>> | undefined;
    try {
      await f.ready();
      const due = new Date();
      due.setUTCHours(0, 0, 0, 0);
      const slot = await new OfficialDailyEnrollment(f.service, () =>
        due.getTime(),
      ).admitDueSlot(f.programId, due.toISOString());
      assert.equal(slot.state, 'no_eligible_content');
      const preview = await f.service.preview(f.world.author.accessToken, {
        programId: f.programId,
        kind: 'test',
        expectedConfigRevision: f.revision,
      });
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
      );
      const base = f.runtime.provider;
      const lost: OfficialSyntheticProvider = {
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
              prepared.dispatch(permit);
              throw new Error(
                'Synthetic acceptance ACK lost before fixture snapshot',
              );
            },
          };
        },
      };
      Object.defineProperty(f.runtime, 'provider', { value: lost });
      await f.worker.runCycle();
      const before = await f.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (before.state !== 'recorded')
        throw new Error('Missing original receipt');
      assert.equal(before.status.state, 'dispatch_unknown');
      await f.service.cancel(f.world.author.accessToken, intent.requestId, {
        intent,
      });
      const callbackRuntime = createSyntheticCallbackRuntimeForTest(),
        registrationId = randomUUID();
      await registerSyntheticCallbackFixture(f.database, callbackRuntime, {
        accountRef: f.accountRef,
        registrationId,
        miniAppRef: randomUUID(),
        unionNamespace: randomUUID(),
        revision: 'a'.repeat(64),
        epochs: [
          {
            epoch: 1,
            validFrom: Date.now() - 10000,
            expiresAt: Date.now() + 600000,
          },
        ],
      });
      const event: SyntheticCallbackEnvelope = {
        profile: 'synthetic-official-v1',
        accountRef: f.accountRef,
        keyEpoch: 1,
        eventId: randomUUID(),
        officialSubject: `synthetic:official:${randomUUID()}`,
        kind: 'unsubscribe',
        sequence: 2,
        occurredAt: Date.now() - 1000,
        issuedAt: Date.now(),
      };
      const send = (boundary: OfficialCallbackBoundary) => {
        const current = { ...event, issuedAt: Date.now() },
          rawBody = canonicalCallbackBody(current);
        return boundary.receive(registrationId, {
          rawBody,
          contentType: 'application/json',
          signature: syntheticCallbackSignature(
            'POST',
            registrationId,
            rawBody,
            1,
          ),
        });
      };
      await send(new OfficialCallbackBoundary(f.database, callbackRuntime));
      await new OfficialCallbackProjectionWorker(
        f.database,
        callbackRuntime,
      ).runOnce();
      // No writer/worker is running across the complete DB snapshot and adapter copy.
      restored = await restoreOfficialFixture(f);
      const recovered = await restored.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (recovered.state !== 'recorded')
        throw new Error('Restore lost original receipt');
      assert.deepEqual(recovered.receipt, admitted.receipt);
      assert.equal(recovered.status.state, 'dispatch_unknown');
      assert.equal(recovered.status.cancelRequested, true);
      assert.deepEqual(
        (await restored.service.createDraft(f.world.author.accessToken, intent))
          .receipt,
        admitted.receipt,
      );
      const restoredSlot = await new OfficialDailyEnrollment(
        restored.service,
        () => due.getTime(),
      ).admitDueSlot(f.programId, due.toISOString());
      assert.deepEqual(restoredSlot, slot);
      const newCallbackRuntime = createSyntheticCallbackRuntimeForTest();
      assert.equal(
        (
          await send(
            new OfficialCallbackBoundary(restored.database, newCallbackRuntime),
          )
        ).status,
        200,
      );
      assert.equal(
        await new OfficialCallbackProjectionWorker(
          restored.database,
          newCallbackRuntime,
        ).runOnce(),
        0,
      );
      const follow = (
        await restored.pool.query(
          'SELECT state FROM whaleu_official_callbacks.follow WHERE account_ref=$1 AND official_subject=$2',
          [f.accountRef, event.officialSubject],
        )
      ).rows[0]!;
      assert.equal(follow.state, 'unfollowed');
      assert.equal(
        (
          await restored.pool.query(
            'SELECT count(*)::int n FROM whaleu_official_callbacks.jobs',
          )
        ).rows[0]!.n,
        1,
      );
      await new Promise((resolve) => setTimeout(resolve, 5100));
      const result = await new OfficialOperationWorker(
        restored.service,
      ).runCycle();
      assert.equal(result.dispatched, 0);
      const confirmed = await restored.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (confirmed.state !== 'recorded')
        throw new Error('Reconcile lost original receipt');
      assert.equal(confirmed.status.state, 'draft_confirmed');
      assert.equal(
        (
          await restored.pool.query(
            'SELECT count(*)::int n FROM whaleu_official.attempts',
          )
        ).rows[0]!.n,
        1,
      );
      assert.equal(
        (
          await restored.pool.query(
            'SELECT count(*)::int n FROM whaleu_official.effects',
          )
        ).rows[0]!.n,
        1,
      );
      assert.equal(
        (
          await restored.pool.query(
            'SELECT count(*)::int n FROM whaleu_official.slots',
          )
        ).rows[0]!.n,
        1,
      );
    } finally {
      try {
        await restored?.close();
      } finally {
        await f.close();
      }
    }
  },
);
