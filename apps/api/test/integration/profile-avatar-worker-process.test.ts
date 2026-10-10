import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import request from 'supertest';
import {
  syntheticProfileRuntimeFixture,
  profileOk,
  selectProfileAvatar,
  waitForProfileDeadline,
} from '../support/media/profile-runtime-fixture.js';
import type { ProfileActor } from '../support/media/profile-runtime-fixture.js';
import {
  profileMediaStatusSchema,
  profileMediaGrantSchema,
} from '../../src/media/contracts-profile.js';
import { sha256 } from '../../src/media/processing/protocol.js';

type Stage = 'seal' | 'process' | 'review';
type Cut = 'sealed' | 'display-written' | 'review-ready' | null;
function event(
  child: ChildProcess,
  expected: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clean();
      reject(new Error(`Profile worker checkpoint timeout: ${expected}`));
    }, 30000);
    timer.unref();
    const message = (value: unknown) => {
      if (typeof value !== 'object' || value === null || !('event' in value))
        return;
      if (value.event === 'failure') {
        clean();
        reject(new Error(JSON.stringify(value)));
      } else if (value.event === expected) {
        clean();
        resolve(value as Record<string, unknown>);
      }
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      clean();
      reject(
        new Error(
          `Profile worker exited before ${expected}: ${code}/${signal}`,
        ),
      );
    };
    const clean = () => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exited);
    };
    child.on('message', message);
    child.once('exit', exited);
  });
}
const exitOf = (
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise((resolve) =>
        child.once('exit', (code, signal) => resolve({ code, signal })),
      );
async function kill(child: ChildProcess) {
  const exited = exitOf(child);
  assert.equal(child.kill('SIGKILL'), true);
  assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
}

test(
  'Profile-only worker process crashes and obsolete generations retain exact effects, scope and receipts',
  { timeout: 360000 },
  async (t) => {
    const sharp = (await import('sharp')).default,
      bytes = await sharp({
        create: { width: 36, height: 28, channels: 3, background: '#386f4d' },
      })
        .png()
        .toBuffer();
    const fixtures = [{ sha256: sha256(bytes), verdict: 'allow' as const }],
      f = await syntheticProfileRuntimeFixture(fixtures),
      children: ChildProcess[] = [];
    try {
      const databaseUrl = process.env['TEST_DATABASE_URL'];
      assert.ok(databaseUrl);
      const storageRoot = await f.storage.processRoot(),
        http = f.app.getHttpServer();
      const queued = async (actor: ProfileActor) => {
        const input = {
            protocol: 'profile-media-v1' as const,
            clientRequestId: randomUUID(),
            expectedRevision: 0,
            slot: 'avatar' as const,
            declaration: {
              mime: 'image/png' as const,
              bytes: bytes.length,
              sha256: sha256(bytes),
            },
          },
          auth = `Bearer ${actor.accessToken}`;
        const prepare = await request(http)
          .post('/v1/me/profile/avatar-edits')
          .set('Authorization', auth)
          .send(input);
        profileOk(prepare);
        const status = profileMediaStatusSchema.parse(prepare.body);
        const grantResponse = await request(http)
          .post(`/v1/me/profile/avatar-edits/${status.editId}/grant`)
          .set('Authorization', auth)
          .send({});
        profileOk(grantResponse);
        const grant = profileMediaGrantSchema.parse(grantResponse.body);
        profileOk(
          await request(http)
            .post(
              `/v1/me/profile/avatar-edits/${status.editId}/uploads/${grant.grantId}`,
            )
            .set('Authorization', auth)
            .attach('file', bytes, {
              filename: 'ignored',
              contentType: 'image/png',
            }),
        );
        profileOk(
          await request(http)
            .post(`/v1/me/profile/avatar-edits/${status.editId}/finalize`)
            .set('Authorization', auth)
            .send({}),
        );
        return { input, status, auth };
      };
      const spawn = (
        intentId: string,
        stages: readonly Stage[],
        cut: Cut = null,
        expectStale = false,
      ) => {
        const child = fork(
          fileURLToPath(
            new URL(
              '../support/media/profile-worker-process.ts',
              import.meta.url,
            ),
          ),
          [],
          {
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          },
        );
        child.stderr?.resume();
        children.push(child);
        const ready = event(child, cut ? 'checkpoint' : 'worker-complete');
        child.send({
          command: 'start',
          databaseUrl,
          storageRoot,
          fixtures,
          intentId,
          stages,
          cut,
          expectStale,
        });
        return { child, ready };
      };
      const run = async (intentId: string, stages: readonly Stage[]) => {
        const worker = spawn(intentId, stages),
          answer = await worker.ready;
        assert.deepEqual(await exitOf(worker.child), { code: 0, signal: null });
        return answer['results'];
      };
      const status = async (prepared: Awaited<ReturnType<typeof queued>>) => {
        const response = await request(http)
          .get(
            `/v1/me/profile/avatar-edit-requests/${prepared.input.clientRequestId}`,
          )
          .set('Authorization', prepared.auth);
        profileOk(response);
        assert.equal(response.body.state, 'recorded');
        return profileMediaStatusSchema.parse(response.body.status);
      };
      for (const cut of ['sealed', 'display-written'] as const)
        await t.test(
          `SIGKILL after ${cut} replays persisted locators after the actual lease expires`,
          async () => {
            const actor = await f.actor(),
              prepared = await queued(actor),
              stage = cut === 'sealed' ? 'seal' : 'process',
              crashing = spawn(
                prepared.status.intentId,
                cut === 'sealed' ? ['seal'] : ['seal', 'process'],
                cut,
              );
            assert.equal((await crashing.ready)['point'], cut);
            const attempts = (
              await f.pool.query(
                'SELECT id,provider,environment,staging_bucket,staging_key,source_version,sealed_bucket,sealed_key,sealed_version FROM whaleu_media.object_attempts WHERE intent_id=$1 ORDER BY id',
                [prepared.status.intentId],
              )
            ).rows;
            const derived = (
              await f.pool.query<{
                id: string;
                variant_name: string;
                provider: string;
                environment: string;
                bucket: string;
                object_key: string;
                object_version: string;
              }>(
                'SELECT id,variant_name,provider,environment,bucket,object_key,object_version FROM whaleu_media.derived_object_attempts WHERE intent_id=$1 ORDER BY variant_name',
                [prepared.status.intentId],
              )
            ).rows;
            if (cut === 'display-written') {
              assert.equal(derived.length, 2);
              for (const object of derived)
                assert.ok(
                  (
                    await f.storage.measure({
                      provider: object.provider,
                      environment: object.environment,
                      bucket: object.bucket,
                      key: object.object_key,
                      version: object.object_version,
                    })
                  ).bytes > 0,
                );
            }
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_media.assets WHERE intent_id=$1',
                  [prepared.status.intentId],
                )
              ).rowCount,
              0,
            );
            const lease = (
              await f.pool.query<{
                lease_until: Date;
                lease_token: string;
                expected_generation: string;
                generation: string;
                actor_id: string;
                protocol_version: number;
              }>(
                "SELECT j.lease_until,j.lease_token,j.expected_generation,i.generation,i.actor_id,i.protocol_version FROM whaleu_media.jobs j JOIN whaleu_media.upload_intents i ON i.id=j.intent_id WHERE j.intent_id=$1 AND j.kind=$2 AND j.status='leased'",
                [prepared.status.intentId, stage],
              )
            ).rows[0]!;
            assert.equal(lease.actor_id, actor.accountId);
            assert.equal(lease.protocol_version, 5);
            assert.equal(lease.expected_generation, lease.generation);
            assert.match(lease.lease_token, /^[0-9a-f-]{36}$/);
            await kill(crashing.child);
            assert.deepEqual(await run(prepared.status.intentId, [stage]), [
              { stage, claimed: false },
            ]);
            // Wait on the persisted real PG lease. Never backdate a lease or advance
            // generation manually to make a crashed worker immediately claimable.
            await waitForProfileDeadline(f.pool, lease.lease_until);
            const stages: readonly Stage[] =
              cut === 'sealed'
                ? ['seal', 'process', 'review']
                : ['process', 'review'];
            assert.deepEqual(
              await run(prepared.status.intentId, stages),
              stages.map((stage) => ({ stage, claimed: true })),
            );
            assert.deepEqual(
              (
                await f.pool.query(
                  'SELECT id,provider,environment,staging_bucket,staging_key,source_version,sealed_bucket,sealed_key,sealed_version FROM whaleu_media.object_attempts WHERE intent_id=$1 ORDER BY id',
                  [prepared.status.intentId],
                )
              ).rows,
              attempts,
            );
            if (cut === 'display-written')
              assert.deepEqual(
                (
                  await f.pool.query(
                    'SELECT id,variant_name,provider,environment,bucket,object_key,object_version FROM whaleu_media.derived_object_attempts WHERE intent_id=$1 ORDER BY variant_name',
                    [prepared.status.intentId],
                  )
                ).rows,
                derived,
              );
            const ready = await status(prepared);
            assert.equal(ready.status, 'ready_unbound');
            if (ready.status !== 'ready_unbound')
              throw new Error(
                'Crash recovery did not yield exact Profile source',
              );
            assert.equal(ready.editId, prepared.status.editId);
            assert.equal(ready.requestHash, prepared.status.requestHash);
            const selected = await selectProfileAvatar(f, actor, {
              protocol: 'profile-media-v1',
              clientRequestId: randomUUID(),
              expectedRevision: 0,
              source: {
                kind: 'custom',
                editId: ready.editId,
                assetId: ready.assetId,
              },
            });
            const history = await status(prepared);
            assert.equal(history.status, 'bound_history');
            if (history.status === 'bound_history')
              assert.deepEqual(history.command, selected.receipt);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_media.scope_consumptions WHERE scope_resource_id=$1',
                  [ready.editId],
                )
              ).rowCount,
              1,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_media.assets WHERE intent_id=$1',
                  [prepared.status.intentId],
                )
              ).rowCount,
              1,
            );
          },
        );
      await t.test(
        'review-ready COMMIT survives worker SIGKILL without another safety event or lost Profile edit',
        async () => {
          const actor = await f.actor(),
            prepared = await queued(actor),
            worker = spawn(
              prepared.status.intentId,
              ['seal', 'process', 'review'],
              'review-ready',
            );
          assert.equal((await worker.ready)['point'], 'review-ready');
          const before = (
            await f.pool.query(
              'SELECT e.* FROM whaleu_media.asset_safety_events e JOIN whaleu_media.assets a ON a.id=e.asset_id WHERE a.intent_id=$1 ORDER BY e.id',
              [prepared.status.intentId],
            )
          ).rows;
          assert.equal(before.length, 1);
          await kill(worker.child);
          assert.deepEqual(await run(prepared.status.intentId, ['review']), [
            { stage: 'review', claimed: false },
          ]);
          assert.equal((await status(prepared)).status, 'ready_unbound');
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT e.* FROM whaleu_media.asset_safety_events e JOIN whaleu_media.assets a ON a.id=e.asset_id WHERE a.intent_id=$1 ORDER BY e.id',
                [prepared.status.intentId],
              )
            ).rows,
            before,
          );
          const response = await request(http)
            .post('/v1/me/profile/avatar-edits')
            .set('Authorization', prepared.auth)
            .send(prepared.input);
          profileOk(response);
          assert.equal(response.body.intentId, prepared.status.intentId);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.avatar_edits WHERE actor_id=$1',
                [actor.accountId],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'cancelled Profile generation rejects an old worker completion and retains every planned object for GC',
        async () => {
          const actor = await f.actor(),
            prepared = await queued(actor),
            worker = spawn(
              prepared.status.intentId,
              ['seal', 'process'],
              'display-written',
              true,
            );
          assert.equal((await worker.ready)['point'], 'display-written');
          const before = (
            await f.pool.query<{ generation: string }>(
              'SELECT generation FROM whaleu_media.upload_intents WHERE id=$1',
              [prepared.status.intentId],
            )
          ).rows[0]!;
          const cancellation = await request(http)
            .post(
              `/v1/me/profile/avatar-edit-requests/${prepared.input.clientRequestId}/cancel`,
            )
            .set('Authorization', prepared.auth)
            .send({
              protocol: 'profile-media-v1',
              requestHash: prepared.status.requestHash,
            });
          profileOk(cancellation);
          assert.equal(cancellation.body.status.status, 'terminal');
          const rejected = event(worker.child, 'worker-rejected'),
            exited = exitOf(worker.child);
          worker.child.send({ command: 'continue' });
          assert.equal((await rejected)['reason'], 'stale-generation');
          assert.deepEqual(await exited, { code: 0, signal: null });
          const after = (
            await f.pool.query<{ generation: string; state: string }>(
              'SELECT generation,state FROM whaleu_media.upload_intents WHERE id=$1',
              [prepared.status.intentId],
            )
          ).rows[0]!;
          assert.equal(
            BigInt(after.generation),
            BigInt(before.generation) + 1n,
          );
          assert.equal(after.state, 'cancelled');
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.assets WHERE intent_id=$1',
                [prepared.status.intentId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.scope_consumptions WHERE scope_resource_id=$1',
                [prepared.status.editId],
              )
            ).rowCount,
            0,
          );
          const retained = (
            await f.pool.query(
              `SELECT d.id,c.state FROM whaleu_media.derived_object_attempts d JOIN whaleu_media.cleanup_obligations c ON c.derived_attempt_id=d.id WHERE d.intent_id=$1 ORDER BY d.id`,
              [prepared.status.intentId],
            )
          ).rows;
          assert.equal(retained.length, 2);
          assert.ok(
            retained.every((row) =>
              ['pending', 'retryable', 'retained'].includes(row.state),
            ),
          );
          assert.deepEqual(
            await run(prepared.status.intentId, ['process', 'review']),
            [
              { stage: 'process', claimed: false },
              { stage: 'review', claimed: false },
            ],
          );
          const replay = await request(http)
            .post('/v1/me/profile/avatar-edits')
            .set('Authorization', prepared.auth)
            .send(prepared.input);
          profileOk(replay);
          assert.equal(replay.body.status, 'terminal');
          assert.equal(replay.body.intentId, prepared.status.intentId);
        },
      );
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      await f.close();
    }
  },
);
