import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import type { PoolClient, QueryResult } from 'pg';
import {
  errandRuntimeFixture,
  seedErrandFeature,
} from '../support/errand-runtime-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import { ErrandNotificationsFacade } from '../../src/notifications/errand.facade.js';
import { SafetyErrandManagementFacade } from '../../src/safety/errand-management/facade.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { SafetyErrandFacade } from '../../src/safety/errand.facade.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test(
  'Safety statement writer gate serializes raw event version assignment through commit and rollback',
  { timeout: 120000 },
  async (t) => {
    const f = await errandRuntimeFixture();
    try {
      const actor = await f.actor(),
        grantId = randomUUID();
      await f.pool.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',NULL,$2,'Synthetic sequence serialization')",
        [grantId, actor.accountId],
      );
      const target = async () => {
        const user = await f.actor();
        const profile = await f
          .auth(request(f.http).patch('/v1/me/profile'), user)
          .send({ expectedRevision: 0, nickname: 'SequenceFixture' });
        assert.equal(profile.status, 200, JSON.stringify(profile.body));
        return {
          ...user,
          profileId: (
            await f.pool.query(
              'SELECT public_id FROM whaleu_profile.profiles WHERE account_id=$1',
              [user.accountId],
            )
          ).rows[0]!.public_id as string,
        };
      };
      type Target = Awaited<ReturnType<typeof target>>;
      const users = await Promise.all([
        target(),
        target(),
        target(),
        target(),
        target(),
        target(),
      ]);
      const safety = f.app.get(SafetyErrandManagementFacade),
        authorization = f.app.get(AuthorizationService),
        notices = f.app.get(ErrandNotificationsFacade);
      // No explicit common Safety advisory lock here: the first raw ledger INSERT's
      // BEFORE STATEMENT writer gate must serialize the whole ensuing transaction.
      const write = async (user: Target, tx: PoolClient, override?: string) => {
        const requestId = randomUUID(),
          command = {
            clientRequestId: requestId,
            targetProfileId: user.profileId,
            action: 'all' as const,
            reason: 'Synthetic sequence evidence',
            duration: { kind: 'permanent' as const },
          };
        const intent = { command },
          intentHash = createHash('sha256')
            .update(
              'whaleu:errand-restriction-command:v1\n' +
                canonicalJson({ operation: 'issue', intent }),
            )
            .digest('hex');
        const context = {
          actorId: actor.accountId,
          sessionId: actor.sessionId,
          grantId,
          requestId,
          kind: 'global' as const,
          operation: 'issue' as const,
        };
        await safety.beginGlobalRequest(context, intentHash, intent, tx);
        await authorization.requireGlobalErrandManagement(actor.accountId, tx);
        await authorization.requireUnprotectedErrandTarget(user.accountId, tx);
        const original = tx.query,
          run = original.bind(tx) as (
            sql: string,
            values?: unknown[],
          ) => Promise<QueryResult>;
        let intercepted = false;
        tx.query = ((sql: string, values?: unknown[]) => {
          if (
            override !== undefined &&
            sql.includes(
              'errand_restriction_events(id,restriction_id,kind,command_id,effective_at,recorded_at,reason)',
            ) &&
            sql.includes("'issued'")
          ) {
            intercepted = true;
            assert.match(override, /^[0-9]+$/);
            sql = sql
              .replace(
                'errand_restriction_events(id,',
                'errand_restriction_events(sequence,id,',
              )
              .replace(
                ' VALUES(',
                ` OVERRIDING SYSTEM VALUE VALUES(${override},`,
              );
          }
          return run(sql, values);
        }) as PoolClient['query'];
        let result;
        try {
          result = await safety.issue(
            context,
            {
              subjectId: user.accountId,
              action: 'all',
              reason: command.reason,
              duration: command.duration,
            },
            tx,
          );
        } finally {
          tx.query = original;
        }
        if (override !== undefined) assert.equal(intercepted, true);
        await notices.recordFeature(result.notice, tx);
        await safety.finishGlobalRequest(
          actor.accountId,
          requestId,
          {
            requestId,
            operation: 'issue',
            outcome: 'applied',
            restrictionId: result.restrictionId,
            eventId: result.eventId,
            occurredAt: result.occurredAt,
          },
          tx,
        );
        return (
          await tx.query<{ sequence: string }>(
            'SELECT sequence::text FROM whaleu_safety.errand_restriction_events WHERE id=$1',
            [result.eventId],
          )
        ).rows[0]!.sequence;
      };
      await inTransaction(f.pool, (tx) => write(users[0]!, tx), {
        isolationLevel: 'read committed',
      });
      await inTransaction(f.pool, (tx) => write(users[1]!, tx), {
        isolationLevel: 'read committed',
      });
      const page = async (cursor?: string) =>
        f
          .auth(request(f.http).get('/v1/admin/errand-restrictions'), actor)
          .query({ limit: 1, ...(cursor ? { cursor } : {}) });
      await t.test(
        'independent raw writers cannot commit a low preallocated override without version advancement',
        async () => {
          const initial = await page();
          assert.equal(initial.status, 200, JSON.stringify(initial.body));
          assert.ok(initial.body.nextCursor);
          const first = await f.pool.connect(),
            second = await f.pool.connect(),
            ready = barrier(),
            release = barrier();
          const low = (
            await second.query<{ value: string }>(
              "SELECT nextval(pg_get_serial_sequence('whaleu_safety.errand_restriction_events','sequence'))::text value",
            )
          ).rows[0]!.value;
          const prior = (
            await f.pool.query<{ version: string }>(
              'SELECT max(sequence)::text version FROM whaleu_safety.errand_restriction_events',
            )
          ).rows[0]!.version;
          const pendingFirst = inTransaction(
            { connect: async () => first },
            async (tx) => {
              const value = await write(users[2]!, tx);
              ready.resolve();
              await release.promise;
              return value;
            },
            { isolationLevel: 'read committed' },
          );
          await ready.promise;
          const pendingSecond = inTransaction(
            { connect: async () => second },
            (tx) => write(users[3]!, tx, low),
            { isolationLevel: 'read committed' },
          );
          await f.waitForLock(
            'INSERT INTO whaleu_safety.errand_restriction_requests',
          );
          assert.equal(
            (
              await f.pool.query<{ version: string }>(
                'SELECT max(sequence)::text version FROM whaleu_safety.errand_restriction_events',
              )
            ).rows[0]!.version,
            prior,
            'Uncommitted event allocation is not a visible source change',
          );
          release.resolve();
          const firstSequence = await pendingFirst,
            secondSequence = await pendingSecond;
          assert.ok(BigInt(firstSequence) > BigInt(low));
          assert.ok(BigInt(secondSequence) > BigInt(firstSequence));
          const continued = await page(initial.body.nextCursor);
          assert.equal(
            continued.body.error?.code,
            'DISCOVERY_RESTART_REQUIRED',
            JSON.stringify(continued.body),
          );
        },
      );
      await t.test(
        'rolled-back raw event does not invalidate a complete committed source or leave a phantom version',
        async () => {
          const initial = await page();
          assert.equal(initial.status, 200, JSON.stringify(initial.body));
          assert.ok(initial.body.nextCursor);
          const prior = (
            await f.pool.query<{ version: string }>(
              'SELECT max(sequence)::text version FROM whaleu_safety.errand_restriction_events',
            )
          ).rows[0]!.version;
          const ready = barrier(),
            release = barrier();
          const pending = inTransaction(
            f.pool,
            async (tx) => {
              await write(users[4]!, tx);
              ready.resolve();
              await release.promise;
              throw new Error('Synthetic deliberate rollback');
            },
            { isolationLevel: 'read committed' },
          );
          const rejected = assert.rejects(
            pending,
            /Synthetic deliberate rollback/,
          );
          await ready.promise;
          const continuation = page(initial.body.nextCursor).then(
            (response) => response,
          );
          await f.waitForLock('pg_advisory_xact_lock_shared');
          release.resolve();
          await rejected;
          const continued = await continuation;
          assert.equal(continued.status, 200, JSON.stringify(continued.body));
          assert.equal(
            (
              await f.pool.query<{ version: string }>(
                'SELECT max(sequence)::text version FROM whaleu_safety.errand_restriction_events',
              )
            ).rows[0]!.version,
            prior,
          );
        },
      );
      await t.test(
        'same restriction UUID cannot be silently enrolled for different owner, action or terms',
        async () => {
          const row = (
            await f.pool.query<{ terms: Record<string, unknown> }>(
              'SELECT terms FROM whaleu_safety.errand_restriction_definitions WHERE subject_id=$1',
              [users[0]!.accountId],
            )
          ).rows[0]!;
          const current = (
            await f.pool.query(
              'SELECT snapshot_id FROM whaleu_safety.errand_feature_heads WHERE account_id=$1',
              [users[0]!.accountId],
            )
          ).rows[0]!.snapshot_id;
          for (const fact of [
            { ...row.terms, reason: 'Changed immutable reason' },
            { ...row.terms, action: 'publish' },
          ])
            await assert.rejects(
              seedErrandFeature(f.pool, users[0]!.accountId, [fact]),
            );
          assert.equal(
            (
              await f.pool.query(
                'SELECT snapshot_id FROM whaleu_safety.errand_feature_heads WHERE account_id=$1',
                [users[0]!.accountId],
              )
            ).rows[0]!.snapshot_id,
            current,
          );
          const copied = await seedErrandFeature(f.pool, users[5]!.accountId, [
            row.terms,
          ]);
          for (const action of ['publish', 'accept'] as const)
            await assert.rejects(
              inTransaction(
                f.pool,
                async (tx) => {
                  await lockSafetyPolicy(tx);
                  await f.app
                    .get(SafetyErrandFacade)
                    .requireFeature(users[5]!.accountId, action, tx);
                },
                { isolationLevel: 'read committed' },
              ),
              (error: unknown) =>
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 'SAFETY_UNAVAILABLE',
            );
          const rejected = await f
            .auth(request(f.http).post('/v1/admin/errand-restrictions'), actor)
            .send({
              clientRequestId: randomUUID(),
              targetProfileId: users[5]!.profileId,
              action: 'publish',
              reason: 'Must reject UUID owner conflict',
              duration: { kind: 'permanent' },
            });
          assert.equal(
            rejected.body.error?.code,
            'SAFETY_UNAVAILABLE',
            JSON.stringify(rejected.body),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT snapshot_id FROM whaleu_safety.errand_feature_heads WHERE account_id=$1',
                [users[5]!.accountId],
              )
            ).rows[0]!.snapshot_id,
            copied,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_safety.errand_restriction_definitions WHERE subject_id=$1',
                [users[5]!.accountId],
              )
            ).rowCount,
            0,
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
