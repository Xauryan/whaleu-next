import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseService } from '../../src/database/database.js';
import {
  canonicalCallbackBody,
  syntheticCallbackSignature,
  syntheticChallengeBytes,
} from '../../src/official-account-operations/callback-auth.js';
import type { SyntheticCallbackEnvelope } from '../../src/official-account-operations/callback-auth.js';
import {
  OfficialCallbackBoundary,
  OfficialCallbackProjectionWorker,
  createSyntheticCallbackRuntimeForTest,
  registerSyntheticCallbackFixture,
} from '../../src/official-account-operations/callback-ledger.js';
import { OfficialCallbackMappingOwner } from '../../src/official-account-operations/callback-mapping.js';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';

test(
  'synthetic callback durable ledger, ordered projection, rotation and tombstones',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    try {
      await assert.rejects(() =>
        f.pool.query('TRUNCATE whaleu_official_callbacks.events CASCADE'),
      );
      const db = f.app.get(DatabaseService),
        runtime = createSyntheticCallbackRuntimeForTest();
      const boundary = new OfficialCallbackBoundary(db, runtime),
        worker = new OfficialCallbackProjectionWorker(db, runtime);
      const registry = async (
        epochs?: { epoch: 1 | 2; validFrom: number; expiresAt: number }[],
      ) => {
        const now = Date.now(),
          r = {
            accountRef: randomUUID(),
            registrationId: randomUUID(),
            miniAppRef: randomUUID(),
            unionNamespace: randomUUID(),
            revision: 'a'.repeat(64),
            epochs: epochs ?? [
              {
                epoch: 1 as const,
                validFrom: now - 10000,
                expiresAt: now + 300000,
              },
              {
                epoch: 2 as const,
                validFrom: now - 10000,
                expiresAt: now + 300000,
              },
            ],
          };
        await registerSyntheticCallbackFixture(db, runtime, r);
        return r;
      };
      const envelope = (
        accountRef: string,
        overrides: Partial<SyntheticCallbackEnvelope> = {},
      ): SyntheticCallbackEnvelope => ({
        profile: 'synthetic-official-v1',
        accountRef,
        keyEpoch: 1,
        eventId: randomUUID(),
        officialSubject: `synthetic:official:${randomUUID()}`,
        kind: 'subscribe',
        sequence: 1,
        occurredAt: Date.now() - 1000,
        issuedAt: Date.now(),
        ...overrides,
      });
      const send = (
        registrationId: string,
        e: SyntheticCallbackEnvelope,
        b = boundary,
      ) => {
        const rawBody = canonicalCallbackBody(e);
        return b.receive(registrationId, {
          rawBody,
          contentType: 'application/json',
          signature: syntheticCallbackSignature(
            'POST',
            registrationId,
            rawBody,
            e.keyEpoch as 1 | 2,
          ),
        });
      };
      const follow = async (account: string, subject: string) =>
        (
          await f.pool.query(
            'SELECT * FROM whaleu_official_callbacks.follow WHERE account_ref=$1 AND official_subject=$2',
            [account, subject],
          )
        ).rows[0];
      await t.test(
        'ACK follows event+obligation commit; concurrent and restarted replays emit one job',
        async () => {
          const r = await registry(),
            e = envelope(r.accountRef);
          const results = await Promise.all([
            send(r.registrationId, e),
            send(r.registrationId, e),
          ]);
          assert.ok(results.every((v) => v.status === 200));
          assert.deepEqual(results[0]!.body, {
            profile: e.profile,
            eventId: e.eventId,
            status: 'received',
          });
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_official_callbacks.jobs WHERE account_ref=$1',
                [r.accountRef],
              )
            ).rows[0]!.n,
            1,
          );
          assert.equal(
            await follow(r.accountRef, e.officialSubject),
            undefined,
          );
          assert.equal(
            (
              await send(
                r.registrationId,
                { ...e, keyEpoch: 2, issuedAt: Date.now() },
                new OfficialCallbackBoundary(db, runtime),
              )
            ).status,
            200,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_official_callbacks.admissions WHERE account_ref=$1',
                [r.accountRef],
              )
            ).rows[0]!.n,
            2,
          );
          const alias = { ...r, registrationId: randomUUID() };
          await registerSyntheticCallbackFixture(db, runtime, alias);
          assert.equal(
            (await send(alias.registrationId, { ...e, keyEpoch: 2 })).status,
            200,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_official_callbacks.jobs WHERE account_ref=$1',
                [r.accountRef],
              )
            ).rows[0]!.n,
            1,
          );
          await worker.runOnce();
          assert.equal(
            (await follow(r.accountRef, e.officialSubject)).state,
            'followed',
          );
          assert.equal(
            await new OfficialCallbackProjectionWorker(db, runtime).runOnce(),
            0,
          );
          // A committed event/follow tombstone cannot be partially reset, even
          // when CASCADE would otherwise remove downstream replay protection.
          for (const table of [
            'events',
            'jobs',
            'admissions',
            'follow',
            'mapping_proofs',
            'mini_assertions',
            'synthetic_acceptances',
          ])
            await assert.rejects(() =>
              f.pool.query(
                `TRUNCATE whaleu_official_callbacks.${table} CASCADE`,
              ),
            );
          const restartedRuntime = createSyntheticCallbackRuntimeForTest();
          assert.equal(
            (
              await send(
                r.registrationId,
                { ...e, keyEpoch: 2, issuedAt: Date.now() },
                new OfficialCallbackBoundary(db, restartedRuntime),
              )
            ).status,
            200,
          );
          assert.equal(
            await new OfficialCallbackProjectionWorker(
              db,
              restartedRuntime,
            ).runOnce(),
            0,
          );
          assert.equal(
            (await follow(r.accountRef, e.officialSubject)).state,
            'followed',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_official_callbacks.events WHERE account_ref=$1',
                [r.accountRef],
              )
            ).rows[0]!.n,
            1,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_official_callbacks.jobs WHERE account_ref=$1',
                [r.accountRef],
              )
            ).rows[0]!.n,
            1,
          );
        },
      );
      await t.test(
        'old subscribe cannot reactivate unsubscribe; equal semantics no-op and conflicts quarantine',
        async () => {
          const r = await registry(),
            e = envelope(r.accountRef, { sequence: 10, kind: 'unsubscribe' });
          await send(r.registrationId, e);
          await worker.runOnce();
          await send(r.registrationId, {
            ...e,
            eventId: randomUUID(),
            sequence: 9,
            kind: 'subscribe',
          });
          await worker.runOnce();
          let row = await follow(r.accountRef, e.officialSubject);
          assert.equal(row.state, 'unfollowed');
          assert.equal(row.revocation_watermark, '10');
          const generation = row.generation;
          await send(r.registrationId, { ...e, eventId: randomUUID() });
          await worker.runOnce();
          row = await follow(r.accountRef, e.officialSubject);
          assert.equal(row.generation, generation);
          await send(r.registrationId, {
            ...e,
            eventId: randomUUID(),
            kind: 'subscribe',
          });
          await worker.runOnce();
          row = await follow(r.accountRef, e.officialSubject);
          assert.equal(row.state, 'unknown');
          assert.equal(row.mapping_state, 'quarantined');
          assert.equal(row.revocation_watermark, '10');
        },
      );
      await t.test(
        'logical event collision commits minimal conflict and quarantines old and new subjects',
        async () => {
          const r = await registry(),
            e = envelope(r.accountRef);
          await send(r.registrationId, e);
          await worker.runOnce();
          const other = `synthetic:official:${randomUUID()}`;
          assert.equal(
            (await send(r.registrationId, { ...e, officialSubject: other }))
              .status,
            409,
          );
          assert.equal(
            (await follow(r.accountRef, e.officialSubject)).state,
            'unknown',
          );
          assert.equal(
            (await follow(r.accountRef, other)).mapping_state,
            'quarantined',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_official_callbacks.conflicts WHERE account_ref=$1',
                [r.accountRef],
              )
            ).rows[0]!.n,
            1,
          );
          assert.equal((await send(r.registrationId, e)).status, 200);
        },
      );
      await t.test(
        'challenge has no binding effects, wrong account/expired epoch/clock uniformly unauthorized',
        async () => {
          const now = Date.now(),
            r = await registry([
              { epoch: 1, validFrom: now - 20000, expiresAt: now - 10000 },
              { epoch: 2, validFrom: now - 20000, expiresAt: now + 300000 },
            ]);
          const q = {
              accountRef: r.accountRef,
              keyEpoch: 2,
              challenge: 'b'.repeat(32),
              issuedAt: Date.now(),
            },
            raw = syntheticChallengeBytes(q);
          const result = await boundary.challenge(
            r.registrationId,
            { ...q, keyEpoch: '2', issuedAt: String(q.issuedAt) },
            syntheticCallbackSignature('GET', r.registrationId, raw, 2),
          );
          assert.deepEqual(result, {
            status: 200,
            body: { profile: 'synthetic-official-v1', challenge: q.challenge },
          });
          assert.equal(
            (await send(r.registrationId, envelope(r.accountRef))).status,
            401,
          );
          assert.equal(
            (
              await send(
                r.registrationId,
                envelope(randomUUID(), { keyEpoch: 2 }),
              )
            ).status,
            401,
          );
          assert.equal(
            (
              await send(
                r.registrationId,
                envelope(r.accountRef, {
                  keyEpoch: 2,
                  issuedAt: Date.now() - 301000,
                  occurredAt: 0,
                }),
              )
            ).status,
            401,
          );
          assert.equal(
            (
              await send(
                r.registrationId,
                envelope(r.accountRef, {
                  keyEpoch: 2,
                  issuedAt: Date.now() + 301000,
                }),
              )
            ).status,
            401,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_official_callbacks.follow WHERE account_ref=$1',
                [r.accountRef],
              )
            ).rows[0]!.n,
            0,
          );
        },
      );
      await t.test(
        'invalid requests debit persistent bucket; arbitrary unknown IDs share bounded storage',
        async () => {
          const r = await registry();
          for (let i = 0; i < 10; i++)
            assert.equal(
              (
                await boundary.receive(r.registrationId, {
                  rawBody: Buffer.from('invalid'),
                  contentType: 'application/json',
                })
              ).status,
              400,
            );
          const throttled = await boundary.receive(r.registrationId, {
            rawBody: Buffer.from('invalid'),
          });
          assert.equal(throttled.status, 429);
          assert.equal(throttled.retryAfter, 60);
          for (let i = 0; i < 10; i++)
            await boundary.receive(randomUUID(), {
              rawBody: Buffer.from('invalid'),
              contentType: 'application/json',
            });
          assert.equal(
            (
              await boundary.receive(randomUUID(), {
                rawBody: Buffer.from('invalid'),
              })
            ).status,
            429,
          );
          assert.equal(
            (
              await f.pool.query(
                "SELECT count(*)::int n FROM whaleu_official_callbacks.rate_buckets WHERE bucket='unknown'",
              )
            ).rows[0]!.n,
            1,
          );
        },
      );
      await t.test(
        'failure before commit has no success ACK and projection rollback preserves obligation',
        async () => {
          const r = await registry(),
            e = envelope(r.accountRef);
          const failing = new OfficialCallbackBoundary(
            {
              transaction: async () => {
                throw new Error('private body or DB detail');
              },
            },
            runtime,
          );
          assert.deepEqual(await send(r.registrationId, e, failing), {
            status: 503,
            body: { error: 'callback_unavailable' },
            retryAfter: 5,
          });
          await send(r.registrationId, e);
          await f.pool
            .query(`CREATE FUNCTION whaleu_official_callbacks.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$;
        CREATE TRIGGER test_fail BEFORE UPDATE ON whaleu_official_callbacks.jobs FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.test_fail()`);
          await assert.rejects(worker.runOnce());
          assert.equal(
            await follow(r.accountRef, e.officialSubject),
            undefined,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT processed_at FROM whaleu_official_callbacks.jobs WHERE account_ref=$1',
                [r.accountRef],
              )
            ).rows[0]!.processed_at,
            null,
          );
          await f.pool.query(
            'DROP TRIGGER test_fail ON whaleu_official_callbacks.jobs; DROP FUNCTION whaleu_official_callbacks.test_fail()',
          );
          await worker.runOnce();
        },
      );
      await t.test(
        'account deletion and immutable tombstones deny reactivation or history reset',
        async () => {
          const r = await registry(),
            e = envelope(r.accountRef);
          await send(r.registrationId, e);
          await worker.runOnce();
          await new OfficialCallbackMappingOwner(db, runtime).deleteAccount(
            r.accountRef,
          );
          assert.equal(
            (await send(r.registrationId, { ...e, keyEpoch: 2 })).status,
            401,
          );
          await assert.rejects(
            f.pool.query(
              'DELETE FROM whaleu_official_callbacks.events WHERE account_ref=$1',
              [r.accountRef],
            ),
          );
          await assert.rejects(
            f.pool.query(
              'DELETE FROM whaleu_official_callbacks.follow WHERE account_ref=$1',
              [r.accountRef],
            ),
          );
          await assert.rejects(
            f.pool.query(
              'UPDATE whaleu_official_callbacks.accounts SET deleted=false WHERE account_ref=$1',
              [r.accountRef],
            ),
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
