import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import request from 'supertest';
import type { Response } from 'supertest';
import type { PoolClient, QueryResult } from 'pg';
import {
  errandRuntimeFixture,
  seedErrandFeature,
  syntheticErrandRestriction,
} from '../support/errand-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { SafetyErrandFacade } from '../../src/safety/errand.facade.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  HttpErrandAdminCommandsGateway,
} = require('../../../wechat/src/errands/admin-command-gateway.ts');
const {
  decodeErrandNotice,
} = require('../../../wechat/src/errands/admin-notice-contract.ts');
const applied = (r: Response) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, 'applied', JSON.stringify(r.body));
  return r.body as {
    restrictionId: string;
    eventId: string;
    requestId: string;
    occurredAt: string;
  };
};
test(
  'Safety errand relational ledger, accepted baseline continuity, exact time and future-head reconciliation',
  { timeout: 120000 },
  async (t) => {
    const f = await errandRuntimeFixture();
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    try {
      const admin = await f.actor();
      const grant = async (actor: Actor) =>
        withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',NULL,$2,'Synthetic Safety ledger test')",
            [randomUUID(), actor.accountId],
          ),
        );
      await grant(admin);
      const subject = async () => {
        const actor = await f.actor();
        const profile = await f
          .auth(request(f.http).patch('/v1/me/profile'), actor)
          .send({ expectedRevision: 0, nickname: 'SafetySubject' });
        assert.equal(profile.status, 200, JSON.stringify(profile.body));
        const row = (
          await f.pool.query<{ public_id: string }>(
            'SELECT public_id FROM whaleu_profile.profiles WHERE account_id=$1',
            [actor.accountId],
          )
        ).rows[0]!;
        return { ...actor, profileId: row.public_id };
      };
      const issue = (
        targetProfileId: string,
        action = 'all',
        clientRequestId = randomUUID(),
        duration: unknown = { kind: 'permanent' },
      ) =>
        f
          .auth(request(f.http).post('/v1/admin/errand-restrictions'), admin)
          .send({
            clientRequestId,
            targetProfileId,
            action,
            reason: 'Synthetic fresh restriction',
            duration,
          });
      const release = (id: string) =>
        f
          .auth(
            request(f.http).post(`/v1/admin/errand-restrictions/${id}/release`),
            admin,
          )
          .send({
            clientRequestId: randomUUID(),
            reason: 'Synthetic exact release',
          });
      const list = (profileId: string, query: Record<string, unknown> = {}) =>
        f
          .auth(request(f.http).get('/v1/admin/errand-restrictions'), admin)
          .query({ targetProfileId: profileId, ...query });
      const current = async (accountId: string) =>
        (
          await f.pool.query<{
            id: string;
            restrictions: unknown[];
            valid_until: Date | null;
          }>(
            `SELECT s.* FROM whaleu_safety.errand_feature_heads h JOIN whaleu_safety.errand_feature_snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1`,
            [accountId],
          )
        ).rows[0]!;
      await t.test(
        'SQL exact microsecond ends and future starts, strict nullable keys, no timestamp normalization',
        async () => {
          const fact = {
            ...syntheticErrandRestriction('all'),
            startsAt: '2026-01-01T00:00:00.000000Z',
            endsAt: '2026-01-01T00:00:00.000002Z',
          };
          const exact = (
            await f.pool.query<{
              before: boolean;
              equal: boolean;
              future: boolean;
            }>(
              `SELECT whaleu_safety.errand_restriction_effective($1,'2026-01-01T00:00:00.000001Z') before,whaleu_safety.errand_restriction_effective($1,'2026-01-01T00:00:00.000002Z') equal,whaleu_safety.errand_restriction_fact_valid($2,'2026-01-01T00:00:00.000000Z') future`,
              [
                JSON.stringify(fact),
                JSON.stringify({
                  ...fact,
                  startsAt: '2026-01-01T00:00:00.000001Z',
                }),
              ],
            )
          ).rows[0]!;
          assert.deepEqual(exact, {
            before: true,
            equal: false,
            future: false,
          });
          const invalid: unknown[] = [
            null,
            42,
            [],
            'bad fact',
            { ...fact, endsAt: 42 },
            { ...fact, id: fact.id.replaceAll('-', '') },
            { ...fact, id: '{' + fact.id + '}' },
            { ...fact, id: 'aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa' },
            { ...fact, issuer: '\u00a0\u2000\ufeff' },
            { ...fact, reason: '🙂'.repeat(251) },
            { ...fact, releasedAt: {} },
            { ...fact, startsAt: '2026-01-01T00:00:00.0000001Z' },
            { ...fact, startsAt: '2025-12-31T23:59:60Z' },
          ];
          for (const key of ['endsAt', 'releasedAt']) {
            const value: Record<string, unknown> = { ...fact, extra: null };
            delete value[key];
            invalid.push(value);
          }
          for (const value of invalid)
            assert.equal(
              (
                await f.pool.query<{ valid: boolean }>(
                  "SELECT whaleu_safety.errand_restriction_fact_valid($1,'2026-01-01T00:00:00.000001Z') valid",
                  [JSON.stringify(value)],
                )
              ).rows[0]!.valid,
              false,
            );
        },
      );
      await t.test(
        'controlled DB instant: actual E1 owner enforces end-1microsecond/equality/end+1microsecond and rejects future start',
        async () => {
          const user = await subject();
          const times = (
            await f.pool.query<{
              before: string;
              end: string;
              after: string;
            }>(`WITH instant AS (SELECT clock_timestamp()+interval '1 hour' ending)
 SELECT to_char((ending-interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') before,
 to_char(ending AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "end",
 to_char((ending+interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') after FROM instant`)
          ).rows[0]!;
          const fact = {
            ...syntheticErrandRestriction('all'),
            endsAt: times.end,
          };
          await seedErrandFeature(f.pool, user.accountId, [fact]);
          const probe = (action: 'publish' | 'accept', checkedAt: string) =>
            inTransaction(
              f.pool,
              async (tx) => {
                await lockSafetyPolicy(tx);
                const original = tx.query,
                  run = original.bind(tx) as (
                    sql: string,
                    values?: unknown[],
                  ) => Promise<QueryResult>;
                let substituted = false;
                tx.query = ((sql: string, values?: unknown[]) => {
                  if (
                    sql.includes(
                      'WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)',
                    )
                  ) {
                    substituted = true;
                    return run(
                      sql.replace(
                        'SELECT clock_timestamp() now',
                        'SELECT $4::timestamptz now',
                      ),
                      [...(values ?? []), checkedAt],
                    );
                  }
                  return run(sql, values);
                }) as PoolClient['query'];
                try {
                  await f.app
                    .get(SafetyErrandFacade)
                    .requireFeature(user.accountId, action, tx);
                } finally {
                  tx.query = original;
                  assert.equal(substituted, true);
                }
              },
              { isolationLevel: 'read committed' },
            );
          for (const action of ['publish', 'accept'] as const) {
            await assert.rejects(
              probe(action, times.before),
              (error: unknown) =>
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 'ERRAND_ACTION_RESTRICTED',
            );
            await probe(action, times.end);
            await probe(action, times.after);
          }
          await seedErrandFeature(f.pool, user.accountId, [
            { ...fact, startsAt: times.after, endsAt: null },
          ]);
          for (const action of ['publish', 'accept'] as const)
            await assert.rejects(
              probe(action, times.end),
              (error: unknown) =>
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 'SAFETY_UNAVAILABLE',
            );
        },
      );
      await t.test(
        'legacy UTF16 baseline boundary and causally proven255-codepoint local Unicode coexist',
        async () => {
          const user = await subject(),
            baseline = {
              ...syntheticErrandRestriction('publish'),
              reason: '🙂'.repeat(250),
            };
          await seedErrandFeature(f.pool, user.accountId, [baseline]);
          const unicodeInput = {
            clientRequestId: randomUUID(),
            targetProfileId: user.profileId,
            action: 'accept',
            reason: '🙂'.repeat(255),
            duration: { kind: 'permanent' },
          };
          const transport = new DirectoryHttpTransport(f.port),
            sessions = new SessionStore();
          sessions.completeLogin(sessions.beginLogin(), admin);
          const auth = new AuthService(
            sessions,
            new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
            {
              login: async () => {
                throw new Error('No provider calls');
              },
            },
            systemClock,
          );
          const gateway = new HttpErrandAdminCommandsGateway(
              new ApiClient(directoryNativeOrigin, transport, sessions, auth),
            ),
            cancel = new Cancellation();
          const unicodeIntent = { operation: 'issue', payload: unicodeInput };
          const receipt = await gateway.command(unicodeIntent, cancel);
          assert.equal(receipt.outcome, 'applied');
          const history = await gateway.history(
            receipt.restrictionId,
            null,
            cancel,
          );
          assert.equal(history.restriction.reason, '🙂'.repeat(255));
          for (const action of ['publish', 'accept'] as const)
            await assert.rejects(
              inTransaction(f.pool, async (tx) => {
                await lockSafetyPolicy(tx);
                await f.app
                  .get(SafetyErrandFacade)
                  .requireFeature(user.accountId, action, tx);
              }),
              (error: unknown) =>
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 'ERRAND_ACTION_RESTRICTED',
            );
          const page = {
            body: await gateway.restrictions(
              { targetProfileId: user.profileId, state: 'all' },
              null,
              cancel,
            ),
          };
          assert.equal(
            page.body.items.find(
              (row: { restrictionId: string }) =>
                row.restrictionId === receipt.restrictionId,
            ).reason,
            '🙂'.repeat(255),
          );
          assert.equal(
            page.body.items.find(
              (row: { restrictionId: string }) =>
                row.restrictionId === baseline.id,
            ).reason,
            '🙂'.repeat(250),
          );
          const copied = await subject();
          await seedErrandFeature(
            f.pool,
            copied.accountId,
            (await current(user.accountId)).restrictions,
          );
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              await lockSafetyPolicy(tx);
              await f.app
                .get(SafetyErrandFacade)
                .requireFeature(copied.accountId, 'accept', tx);
            }),
            (error: unknown) =>
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'SAFETY_UNAVAILABLE',
          );
          const forged = await issue(copied.profileId, 'accept');
          assert.equal(
            forged.body.error?.code,
            'SAFETY_UNAVAILABLE',
            JSON.stringify(forged.body),
          );
          const next = await gateway.command(
            {
              operation: 'issue',
              payload: {
                ...unicodeInput,
                clientRequestId: randomUUID(),
                action: 'all',
                reason: 'Later native command',
              },
            },
            cancel,
          );
          assert.equal(next.outcome, 'applied');
          const released = await gateway.command(
            {
              operation: 'release',
              restrictionId: receipt.restrictionId,
              payload: {
                clientRequestId: randomUUID(),
                reason: '🙂'.repeat(255),
              },
            },
            cancel,
          );
          assert.equal(released.outcome, 'applied');
          assert.equal(
            (await gateway.history(receipt.restrictionId, null, cancel))
              .restriction.state,
            'released',
          );
          assert.deepEqual(
            await gateway.command(unicodeIntent, cancel),
            receipt,
          );
          assert.deepEqual(
            await gateway.receipt(unicodeIntent, cancel),
            receipt,
          );
          const delivered = await f.auth(
            request(f.http).get('/v1/me/errand-notices'),
            user,
          );
          assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
          for (const notice of delivered.body.items)
            assert.deepEqual(decodeErrandNotice(notice), notice);
          assert.ok(
            delivered.body.items.some(
              (notice: { reason: string }) =>
                notice.reason === '🙂'.repeat(255),
            ),
          );
          const bad = await subject(),
            head = await seedErrandFeature(f.pool, bad.accountId, [
              {
                ...syntheticErrandRestriction('publish'),
                reason: '🙂'.repeat(251),
              },
            ]);
          const denied = await issue(bad.profileId, 'accept');
          assert.equal(
            denied.body.error?.code,
            'SAFETY_UNAVAILABLE',
            JSON.stringify(denied.body),
          );
          assert.equal((await current(bad.accountId)).id, head);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_safety.errand_restriction_definitions WHERE subject_id=$1',
                [bad.accountId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'baseline enrollment preserves independent actions, provenance, coverage and unknown original operator',
        async () => {
          const user = await subject(),
            baselinePublish = syntheticErrandRestriction('publish'),
            baselineAll = syntheticErrandRestriction('all');
          const deadline = new Date(Date.now() + 3600000);
          await seedErrandFeature(
            f.pool,
            user.accountId,
            [baselinePublish, baselineAll],
            { validUntil: deadline },
          );
          const first = applied(await issue(user.profileId, 'accept'));
          const snapshot = await current(user.accountId);
          assert.equal(snapshot.valid_until!.getTime(), deadline.getTime());
          assert.equal(snapshot.restrictions.length, 3);
          assert.ok(
            snapshot.restrictions.some(
              (v) => JSON.stringify(v) === JSON.stringify(baselinePublish),
            ) ||
              JSON.stringify(snapshot.restrictions).includes(
                baselinePublish.id,
              ),
          );
          const raw = (
            await f.pool.query(
              'SELECT terms,actor_id,source_order_id FROM whaleu_safety.errand_restriction_definitions WHERE id=$1',
              [baselinePublish.id],
            )
          ).rows[0]!;
          assert.deepEqual(raw.terms, baselinePublish);
          assert.equal(raw.actor_id, null);
          assert.equal(raw.source_order_id, null);
          const second = applied(await issue(user.profileId, 'accept'));
          const rows = await list(user.profileId);
          assert.equal(rows.status, 200, JSON.stringify(rows.body));
          assert.deepEqual(rows.body.recordedTotal, {
            status: 'known',
            value: '4',
          });
          assert.equal(rows.body.historyCoverage, 'unknown_before_boundary');
          assert.equal(
            rows.body.items.find(
              (x: { restrictionId: string }) =>
                x.restrictionId === first.restrictionId,
            ).state,
            'superseded',
          );
          assert.equal(
            rows.body.items.find(
              (x: { restrictionId: string }) =>
                x.restrictionId === first.restrictionId,
            ).terminal.replacementRestrictionId,
            second.restrictionId,
          );
          const baselineHistory = await f.auth(
            request(f.http).get(
              `/v1/admin/errand-restrictions/${baselinePublish.id}/history`,
            ),
            admin,
          );
          assert.equal(
            baselineHistory.status,
            200,
            JSON.stringify(baselineHistory.body),
          );
          assert.equal(
            baselineHistory.body.events[0].kind,
            'observed_baseline',
          );
          assert.deepEqual(baselineHistory.body.events[0].operator, {
            status: 'unknown',
          });
          assert.equal(baselineHistory.body.events[0].reason, null);
          applied(await release(baselineAll.id));
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              await lockSafetyPolicy(tx);
              await f.app
                .get(SafetyErrandFacade)
                .requireFeature(user.accountId, 'publish', tx);
            }),
            (error: unknown) =>
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'ERRAND_ACTION_RESTRICTED',
          );
          const before = await current(user.accountId);
          await assert.rejects(seedErrandFeature(f.pool, user.accountId, []));
          assert.equal((await current(user.accountId)).id, before.id);
          await assert.rejects(
            seedErrandFeature(f.pool, user.accountId, [
              ...before.restrictions,
              baselineAll,
            ]),
          );
          assert.equal((await current(user.accountId)).id, before.id);
          await grant(user); // Role promotion never fabricates release or bypasses enforcement.
          applied(await release(second.restrictionId));
          const again = await release(second.restrictionId);
          assert.equal(again.body.code, 'ERRAND_RESTRICTION_NOT_ACTIVE');
        },
      );
      await t.test(
        'first release can enroll accepted baseline identity without inventing issuance',
        async () => {
          const user = await subject(),
            baseline = syntheticErrandRestriction('all');
          await seedErrandFeature(f.pool, user.accountId, [baseline]);
          applied(await release(baseline.id));
          assert.deepEqual((await current(user.accountId)).restrictions, []);
          const events = (
            await f.pool.query(
              'SELECT kind FROM whaleu_safety.errand_restriction_events WHERE restriction_id=$1 ORDER BY sequence',
              [baseline.id],
            )
          ).rows;
          assert.deepEqual(
            events.map((x) => x.kind),
            ['observed_baseline', 'manually_released'],
          );
          const history = await f.auth(
            request(f.http).get(
              `/v1/admin/errand-restrictions/${baseline.id}/history`,
            ),
            admin,
          );
          assert.equal(history.body.events[0].kind, 'manually_released');
          await seedErrandFeature(f.pool, user.accountId, [], {
            coverage: 'missing',
          });
          const repeated = await release(baseline.id);
          assert.equal(
            repeated.body.code,
            'ERRAND_RESTRICTION_NOT_ACTIVE',
            JSON.stringify(repeated.body),
          );
        },
      );
      await t.test(
        'unavailable malformed or future baseline aborts every tentative ledger and receipt effect',
        async () => {
          const baseline = syntheticErrandRestriction('publish');
          const missing: Record<string, unknown> = {
            ...baseline,
            unknown: null,
          };
          delete missing['endsAt'];
          for (const restrictions of [
            [null],
            [42],
            [[]],
            [
              {
                ...baseline,
                startsAt: new Date(Date.now() + 3600000).toISOString(),
              },
            ],
            [missing],
            [{ ...baseline, releasedAt: 42 }],
          ]) {
            const user = await subject(),
              key = randomUUID();
            const head = await seedErrandFeature(
              f.pool,
              user.accountId,
              restrictions,
            );
            const response = await issue(user.profileId, 'accept', key);
            assert.equal(
              response.body.error?.code,
              'SAFETY_UNAVAILABLE',
              JSON.stringify(response.body),
            );
            assert.equal((await current(user.accountId)).id, head);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_safety.errand_restriction_definitions WHERE subject_id=$1',
                  [user.accountId],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_safety.errand_restriction_requests WHERE request_id=$1',
                  [key],
                )
              ).rowCount,
              0,
            );
          }
        },
      );
      await t.test(
        '256 effective capacity fails closed, same-action supersession retains more than256 historical definitions',
        async () => {
          const user = await subject(),
            baseline = Array.from({ length: 256 }, () =>
              syntheticErrandRestriction('publish'),
            );
          const head = await seedErrandFeature(
              f.pool,
              user.accountId,
              baseline,
            ),
            key = randomUUID();
          const over = await issue(user.profileId, 'accept', key);
          assert.equal(
            over.body.error?.code,
            'SAFETY_UNAVAILABLE',
            JSON.stringify(over.body),
          );
          assert.equal((await current(user.accountId)).id, head);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_safety.errand_restriction_definitions WHERE subject_id=$1',
                [user.accountId],
              )
            ).rowCount,
            0,
          );
          applied(await issue(user.profileId, 'publish'));
          assert.equal((await current(user.accountId)).restrictions.length, 1);
          const ids = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = await list(user.profileId, {
              limit: 50,
              ...(cursor ? { cursor } : {}),
            });
            assert.equal(page.status, 200, JSON.stringify(page.body));
            assert.deepEqual(page.body.recordedTotal, {
              status: 'known',
              value: '257',
            });
            for (const row of page.body.items) {
              assert.equal(ids.has(row.restrictionId), false);
              ids.add(row.restrictionId);
            }
            cursor = page.body.nextCursor ?? undefined;
          } while (cursor);
          assert.equal(ids.size, 257);
        },
      );
      await t.test(
        'duration arithmetic preserves supported large durations and rejects overflow without a receipt',
        async () => {
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              await tx.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
              await tx.query(
                'SELECT whaleu_safety.errand_restriction_end(\'9999-12-31T23:00:00Z\'::timestamptz,\'{"kind":"finite","unit":"hours","value":1}\'::jsonb)',
              );
            }),
            (error: unknown) =>
              typeof error === 'object' &&
              error !== null &&
              'constraint' in error &&
              error.constraint === 'errand_restriction_duration_invalid',
          );
          await inTransaction(f.pool, async (tx) => {
            await tx.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
            const valid = (
              await tx.query<{ valid: boolean }>(
                'SELECT whaleu_safety.errand_restriction_end(\'9999-12-31T22:00:00Z\'::timestamptz,\'{"kind":"finite","unit":"hours","value":1}\'::jsonb)=\'9999-12-31T23:00:00Z\'::timestamptz valid',
              )
            ).rows[0]!.valid;
            assert.equal(valid, true);
          });
          const user = await subject();
          applied(
            await issue(user.profileId, 'all', randomUUID(), {
              kind: 'finite',
              unit: 'days',
              value: 366,
            }),
          );
          const key = randomUUID(),
            response = await issue(user.profileId, 'all', key, {
              kind: 'finite',
              unit: 'days',
              value: Number.MAX_SAFE_INTEGER,
            });
          assert.equal(response.status, 400, JSON.stringify(response.body));
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_safety.errand_restriction_requests WHERE request_id=$1',
                [key],
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
