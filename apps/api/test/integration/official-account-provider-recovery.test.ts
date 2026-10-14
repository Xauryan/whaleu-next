import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { officialAccountFixture } from '../support/official-account-fixture.js';
import { FileSyntheticOfficialProvider } from '../../src/official-account-operations/provider.js';
import type {
  OfficialSyntheticProvider,
  OfficialProviderEvidence,
} from '../../src/official-account-operations/provider.js';
test(
  'accepted then lost ACK reconciles exact durable key after adapter restart; cancellation never hides unknown',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const base = f.runtime.provider;
      let sends = 0;
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
              sends++;
              prepared.dispatch(permit);
              throw new Error('Synthetic lost acknowledgement');
            },
          };
        },
      };
      Object.defineProperty(f.runtime, 'provider', {
        value: lost,
        writable: true,
        configurable: true,
      });
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
      await f.service.createDraft(f.world.author.accessToken, intent);
      await f.worker.runCycle();
      assert.equal(sends, 1);
      const unknown = await f.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (unknown.state !== 'recorded') throw Error('No receipt');
      assert.equal(unknown.status.state, 'dispatch_unknown');
      const cancelled = await f.service.cancel(
        f.world.author.accessToken,
        intent.requestId,
        { intent },
      );
      assert.ok('status' in cancelled);
      if ('status' in cancelled) {
        assert.equal(cancelled.status.state, 'dispatch_unknown');
        assert.equal(cancelled.status.cancelRequested, true);
      }
      const restarted = new FileSyntheticOfficialProvider(
        f.directory,
        f.runtime.fixtureEpoch,
      );
      Object.defineProperty(f.runtime, 'provider', { value: restarted });
      await sleep(5100);
      await f.worker.runCycle();
      const recovered = await f.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (recovered.state !== 'recorded') throw Error('No receipt');
      assert.equal(recovered.status.state, 'draft_confirmed');
      assert.equal(recovered.status.cancelRequested, true);
      assert.equal(sends, 1);
      assert.equal(
        (await f.pool.query('SELECT id FROM whaleu_official.attempts')).rows
          .length,
        1,
      );
      assert.deepEqual(recovered.receipt, unknown.receipt);
    } finally {
      await f.close();
    }
  },
);

const receiptKey =
  'PUBLIC TEST VALUE ONLY: synthetic-official-v1 effect receipts';
function signFixtureEvidence(
  value: Omit<OfficialProviderEvidence, 'proofHash'>,
): OfficialProviderEvidence {
  return {
    ...value,
    proofHash: createHmac('sha256', receiptKey)
      .update(JSON.stringify(value))
      .digest('hex'),
  };
}

test(
  'authentic receipts with a changed parent or purpose cannot mutate any parent history',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const intents = [];
      for (let i = 0; i < 2; i++) {
        const p = await f.service.preview(f.world.author.accessToken, {
          programId: f.programId,
          kind: 'test',
          expectedConfigRevision: f.revision,
        });
        const intent = {
          requestId: randomUUID(),
          programId: f.programId,
          previewId: p.previewId,
          manifestHash: p.manifestHash,
          expectedConfigRevision: f.revision,
          acknowledgement: 'synthetic_draft_only',
        };
        await f.service.createDraft(f.world.author.accessToken, intent);
        intents.push(intent);
      }
      const parents = (
          await f.pool.query<{ id: string }>(
            'SELECT id FROM whaleu_official.commands ORDER BY id',
          )
        ).rows.map((x) => x.id),
        base = f.runtime.provider;
      let changed = 0;
      const corrupt: OfficialSyntheticProvider = {
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
              const { proofHash, ...receipt } = prepared.dispatch(permit);
              assert.match(proofHash, /^[a-f0-9]{64}$/);
              const effect =
                ++changed === 1
                  ? {
                      ...receipt.effect,
                      commandId: parents.find(
                        (x) => x !== receipt.effect.commandId,
                      )!,
                    }
                  : { ...receipt.effect, purpose: 'manual_draft' };
              const evidence = signFixtureEvidence({ ...receipt, effect });
              assert.equal(base.verify(evidence), true);
              return evidence;
            },
          };
        },
      };
      Object.defineProperty(f.runtime, 'provider', { value: corrupt });
      await f.worker.runCycle();
      assert.equal(changed, 2);
      assert.equal(
        (await f.pool.query('SELECT id FROM whaleu_official.evidence'))
          .rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT command_id FROM whaleu_official.command_states WHERE state='draft_confirmed' OR draft_ref IS NOT NULL",
          )
        ).rowCount,
        0,
      );
      for (const intent of intents) {
        const status = await f.service.status(
          f.world.author.accessToken,
          intent.requestId,
        );
        if (status.state !== 'recorded') throw Error('Lost original');
        assert.equal(status.status.state, 'dispatch_unknown');
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'authoritative synthetic nonacceptance retries at most three attempts under one effect key',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const base = f.runtime.provider,
        keys: string[] = [];
      const reject: OfficialSyntheticProvider = {
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
              keys.push(permit.effect.logicalKey);
              return signFixtureEvidence({
                effect: permit.effect,
                attemptId: permit.attemptId,
                kind: 'not_accepted',
                receiptRef: null,
                acceptedAt: null,
              });
            },
          };
        },
      };
      Object.defineProperty(f.runtime, 'provider', { value: reject });
      const p = await f.service.preview(f.world.author.accessToken, {
        programId: f.programId,
        kind: 'test',
        expectedConfigRevision: f.revision,
      });
      const intent = {
        requestId: randomUUID(),
        programId: f.programId,
        previewId: p.previewId,
        manifestHash: p.manifestHash,
        expectedConfigRevision: f.revision,
        acknowledgement: 'synthetic_draft_only',
      };
      await f.service.createDraft(f.world.author.accessToken, intent);
      await f.worker.runCycle();
      await sleep(1100);
      await f.worker.runCycle();
      await sleep(5100);
      await f.worker.runCycle();
      await f.worker.runCycle();
      assert.equal(keys.length, 3);
      assert.equal(new Set(keys).size, 1);
      const attempts = (
        await f.pool.query<{ ordinal: number; logical_key: string }>(
          'SELECT ordinal,logical_key FROM whaleu_official.attempts ORDER BY ordinal',
        )
      ).rows;
      assert.deepEqual(
        attempts.map((x) => x.ordinal),
        [1, 2, 3],
      );
      assert.ok(attempts.every((x) => x.logical_key === keys[0]));
      const status = await f.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      if (status.state !== 'recorded') throw Error('Missing receipt');
      assert.equal(status.status.state, 'suppressed');
      assert.equal(status.status.draftRef, null);
    } finally {
      await f.close();
    }
  },
);
