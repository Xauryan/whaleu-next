import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import request from 'supertest';
import type { Response } from 'supertest';
import type { PoolClient } from 'pg';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import {
  appendIdentitySelection,
  appendTopologyRevision,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';

function denied(response: Pick<Response, 'status' | 'body'>, code?: string) {
  assert.ok(response.status >= 400, JSON.stringify(response.body));
  if ('headers' in response) {
    const headers = response.headers as Record<string, string>;
    assert.equal(headers['cache-control'], 'no-store');
    assert.equal(headers['vary'], 'Authorization');
  }
  assert.deepEqual(Object.keys(response.body), ['error']);
  if (code) assert.equal(response.body.error.code, code);
  assert.ok(!JSON.stringify(response.body).includes('qqGroupNumber'));
}

test(
  'activity ordinary AppModule requires every current canonical member authority even for real admins',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    const http = f.app.getHttpServer();
    const context = (actor?: { accessToken: string }) => {
      const read = request(http).get('/v1/activities/context');
      return actor
        ? read.set('Authorization', `Bearer ${actor.accessToken}`)
        : read;
    };
    const observer = observeDirectoryQueries(f.app);
    try {
      await t.test(
        'required session rejects missing, malformed and invalid tokens without guest fallback',
        async () => {
          denied(await context(), 'AUTHENTICATION_REQUIRED');
          for (const token of ['invalid', `wu_a_${'a'.repeat(43)}`])
            denied(
              await context({ accessToken: token }),
              'AUTHENTICATION_REQUIRED',
            );
        },
      );
      const reader = await f.actor();
      await t.test(
        'identity context is canonical current home with no implicit selection write',
        async () => {
          const before = await f.snapshot();
          const response = await context(reader);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.deepEqual(response.body, {
            regionId: f.scope.home.regionId,
            visitHistory: 'unavailable',
          });
          assert.equal(response.headers['cache-control'], 'no-store');
          assert.equal(response.headers['vary'], 'Authorization');
          assert.deepEqual(
            await f.snapshot(),
            before,
            'Context GET must be pure',
          );
        },
      );
      for (const fact of ['phone', 'affiliation'] as const) {
        for (const state of [
          'unverified',
          'unavailable',
          'revoked',
          'expired',
        ] as const) {
          await t.test(
            `${fact} ${state} fails closed under canonical assertions`,
            async () => {
              const actor = await createRuntimeActor(f.app);
              const affiliation = syntheticAssertion(
                actor.accountId,
                f.scope.institutionId,
                'affiliation',
                { origin_region_id: f.scope.home.regionId },
              );
              const phone = syntheticAssertion(
                actor.accountId,
                f.scope.institutionId,
                'phone',
              );
              const snapshot = await setSyntheticSnapshot(
                f.pool,
                actor.accountId,
                [affiliation, phone]
                  .filter(
                    (row) => state !== 'unavailable' || row.fact_kind !== fact,
                  )
                  .map((row) =>
                    row.fact_kind === fact && state !== 'unavailable'
                      ? { ...row, assertion_state: state }
                      : row,
                  ),
              );
              if (fact === 'phone') {
                await appendIdentitySelection(
                  f.pool,
                  actor.accountId,
                  {
                    assertionId: affiliation.id,
                    snapshotId: snapshot.snapshotId,
                    institutionId: f.scope.institutionId,
                    originRegionId: f.scope.home.regionId,
                    validUntil: affiliation.expires_at!.getTime(),
                  },
                  f.scope,
                );
              }
              denied(await context(actor));
            },
          );
        }
      }
      await t.test(
        'missing, conflicting, expired and stale identity-campus selections fail closed',
        async () => {
          const missing = await f.actor({ identity: false });
          denied(await context(missing));
          const conflicting = await f.actor();
          await appendIdentitySelection(
            f.pool,
            conflicting.accountId,
            conflicting.facts,
            f.scope,
            f.scope.home.campusId,
            'selected',
            { provenanceState: 'conflicting' },
          );
          denied(await context(conflicting));
          const expired = await f.actor();
          await appendIdentitySelection(
            f.pool,
            expired.accountId,
            expired.facts,
            f.scope,
            f.scope.home.campusId,
            'selected',
            { validUntil: Date.now() - 1000 },
          );
          denied(await context(expired));
          const stale = await f.actor();
          await f.certify(stale.accountId, { identity: false });
          denied(await context(stale));
        },
      );
      await t.test(
        'known restrictions, missing safety coverage and blocked accounts return no body',
        async () => {
          for (const patch of [
            'actions_allowed=false',
            "restriction_coverage='missing'",
            "provenance='unknown',block_coverage='missing',restriction_coverage='missing'",
            "valid_until=clock_timestamp()-interval '1 second'",
          ]) {
            const actor = await f.actor();
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                `UPDATE whaleu_safety.account_heads SET ${patch} WHERE account_id=$1`,
                [actor.accountId],
              ),
            );
            denied(await context(actor));
          }
          const actor = await f.actor();
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
              [actor.accountId],
            ),
          );
          denied(await context(actor), 'ACCOUNT_BLOCKED');
        },
      );
      for (const role of [
        'school_admin',
        'super_admin',
        'developer',
      ] as const) {
        await t.test(
          `${role} has no Stage 1 phone, affiliation or home-region exception`,
          async () => {
            const actor = await f.actor();
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic-activity-only')",
                [
                  randomUUID(),
                  actor.accountId,
                  role,
                  role === 'school_admin' ? f.scope.related.regionId : null,
                ],
              ),
            );
            assert.equal((await context(actor)).status, 200);
            for (const regionId of [
              f.scope.related.regionId,
              f.scope.foreign.regionId,
            ])
              denied(
                await request(http)
                  .get(`/v1/regions/${regionId}/activities`)
                  .query({ window: 'all' })
                  .set('Authorization', `Bearer ${actor.accessToken}`),
                'ACTIVITY_SCOPE_UNAVAILABLE',
              );
            await f.certify(actor.accountId, { phone: 'unverified' });
            denied(await context(actor), 'PHONE_VERIFICATION_REQUIRED');
            await f.certify(actor.accountId, { affiliation: 'unverified' });
            denied(await context(actor), 'AFFILIATION_VERIFICATION_REQUIRED');
          },
        );
      }
      await t.test(
        'actual selected related campus becomes home; browsing or origin alone never does',
        async () => {
          const actor = await f.actor({ campusId: f.scope.related.campusId });
          assert.deepEqual((await context(actor)).body, {
            regionId: f.scope.related.regionId,
            visitHistory: 'unavailable',
          });
          denied(
            await request(http)
              .get(`/v1/regions/${f.scope.home.regionId}/activities`)
              .query({ window: 'all' })
              .set('Authorization', `Bearer ${actor.accessToken}`),
            'ACTIVITY_SCOPE_UNAVAILABLE',
          );
        },
      );
      await t.test(
        'session revocation committed during session lock wait cannot emit old context',
        async () => {
          const actor = await f.actor();
          const tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
              [actor.sessionId],
            );
            const pending = context(actor).then((response) => response);
            await f.waitForLock('whaleu_identity.sessions');
            await tx.query('COMMIT');
            denied(await pending, 'SESSION_REVOKED');
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'exclusive safety transition before read is observed after the shared gate wait',
        async () => {
          const actor = await f.actor();
          const tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await lockSafetyPolicy(tx, true);
            await tx.query(
              'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
              [actor.accountId],
            );
            const pending = context(actor).then((response) => response);
            await f.waitForLock('pg_advisory_xact_lock_shared');
            await tx.query('COMMIT');
            denied(await pending, 'SAFETY_ACTION_RESTRICTED');
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'phone deadline crossing after successful authority invalidates the complete response',
        async () => {
          const actor = await createRuntimeActor(f.app);
          const affiliation = syntheticAssertion(
            actor.accountId,
            f.scope.institutionId,
            'affiliation',
            { origin_region_id: f.scope.home.regionId },
          );
          const phone = syntheticAssertion(
            actor.accountId,
            f.scope.institutionId,
            'phone',
            { expires_at: new Date(Date.now() + 650) },
          );
          const snapshot = await setSyntheticSnapshot(f.pool, actor.accountId, [
            affiliation,
            phone,
          ]);
          await appendIdentitySelection(
            f.pool,
            actor.accountId,
            {
              assertionId: affiliation.id,
              snapshotId: snapshot.snapshotId,
              institutionId: f.scope.institutionId,
              originRegionId: f.scope.home.regionId,
              validUntil: affiliation.expires_at!.getTime(),
            },
            f.scope,
          );
          let delayed = false;
          observer.setHook(async ({ sql }) => {
            if (!delayed && sql.includes('community_identity_selections')) {
              delayed = true;
              await sleep(800);
            }
          });
          try {
            denied(await context(actor), 'VERIFICATION_UNAVAILABLE');
            assert.ok(delayed);
          } finally {
            observer.setHook(null);
          }
        },
      );
      await t.test(
        'finite safety validity crossing before transaction commit invalidates all fields',
        async () => {
          const actor = await f.actor();
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_safety.account_heads SET valid_until=clock_timestamp()+interval '650 milliseconds' WHERE account_id=$1",
              [actor.accountId],
            ),
          );
          let delayed = false;
          observer.setHook(async ({ sql }) => {
            if (!delayed && sql.includes('community_identity_selections')) {
              delayed = true;
              await sleep(800);
            }
          });
          try {
            denied(await context(actor), 'SAFETY_UNAVAILABLE');
            assert.ok(delayed);
          } finally {
            observer.setHook(null);
          }
        },
      );
      await t.test(
        'identity change committed while shared policy gate is waiting emits only new home',
        async () => {
          const actor = await f.actor();
          let blocker: PoolClient | undefined;
          try {
            blocker = await f.pool.connect();
            await blocker.query('BEGIN');
            await lockSafetyPolicy(blocker, true);
            const change = appendIdentitySelection(
              f.pool,
              actor.accountId,
              actor.facts,
              f.scope,
              f.scope.related.campusId,
            );
            await f.waitForLock('pg_advisory_xact_lock(');
            const pending = context(actor).then((response) => response);
            await f.waitForLock('pg_advisory_xact_lock_shared');
            await blocker.query('COMMIT');
            await change;
            const first = await pending;
            assert.equal(first.status, 200, JSON.stringify(first.body));
            assert.deepEqual(first.body, {
              regionId: f.scope.related.regionId,
              visitHistory: 'unavailable',
            });
            assert.deepEqual((await context(actor)).body, {
              regionId: f.scope.related.regionId,
              visitHistory: 'unavailable',
            });
          } finally {
            if (blocker) {
              await blocker.query('ROLLBACK');
              blocker.release();
            }
          }
        },
      );
      await t.test(
        'shared directory budget counts rejected eligible-session attempts and emits no-store private 429',
        async () => {
          const actor = await f.actor({ phone: 'unverified' });
          for (let i = 0; i < 120; i++)
            denied(await context(actor), 'PHONE_VERIFICATION_REQUIRED');
          const throttled = await context(actor);
          denied(throttled, 'RATE_LIMITED');
          assert.equal(throttled.status, 429);
          assert.equal(throttled.headers['retry-after'], '60');
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_runtime.request_throttle_counters WHERE total_hits=121',
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'topology revision invalidates selections rather than broadening regions',
        async () => {
          await appendTopologyRevision(f.pool, f.scope.topology);
          denied(await context(reader));
        },
      );
    } finally {
      observer.restore();
      await f.close();
    }
  },
);
