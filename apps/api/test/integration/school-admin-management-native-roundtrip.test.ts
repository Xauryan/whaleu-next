/** Emitted native App/Page/WXML -> ordinary AppModule -> isolated synthetic PG. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import {
  schoolAdminManagementFixture,
  type SchoolAdminTestCommand,
} from '../support/school-admin-management-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { schoolAdminManagementIntentHash } from '../../src/authorization/school-admin-management/evidence.js';
import { schoolAdminManagementCommandSchema } from '../../src/authorization/school-admin-management/contracts.js';

test(
  'emitted native appointment, reassign, revoke, title retention, cold active-only recovery, cancel races, edit recovery and storage/lifecycle barriers',
  { timeout: 300000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      stranger = await f.actor();
    let superGrant = await f.grant(admin);
    await f.grant(admin, 'developer');
    const targets = {
      primary: await f.actor({ identity: false }),
      cancelled: await f.actor(),
      applyWinner: await f.actor(),
      stale: await f.actor(),
      late: await f.actor(),
      storage: await f.actor(),
    };
    const read = (path: string, actor = admin) =>
      request(f.http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const credentials = (a: typeof admin) => ({
      accountId: a.accountId,
      sessionId: a.sessionId,
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      refreshExpiresAt: a.refreshExpiresAt,
    });
    const primaryCosmetics = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object(
    'appearance',(SELECT to_jsonb(a) FROM whaleu_experience.appearance a WHERE owner_id=$1),
    'balance',(SELECT to_jsonb(b) FROM whaleu_experience.account_states b WHERE owner_id=$1)) value`,
          [targets.primary.accountId],
        )
      ).rows[0]!['value'];
    const before = await primaryCosmetics();
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/school-admin-management-native-child.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
      },
    );
    t.after(() => {
      if (child.connected) child.disconnect();
      if (child.exitCode === null) child.kill();
    });
    child.stdout?.resume();
    let logs = '';
    child.stderr?.on('data', (data) => {
      logs += String(data);
    });
    const done = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        let finished = false;
        const checkpoint = async (value: Record<string, unknown>) => {
          const body = value['command'] as SchoolAdminTestCommand;
          switch (value['name']) {
            case 'appointment-lost-revoke-super': {
              assert.equal(
                value['requestHash'],
                schoolAdminManagementIntentHash(
                  admin.accountId,
                  schoolAdminManagementCommandSchema.parse(body),
                ),
              );
              const recovered = await f.recovery(admin, body.clientRequestId);
              assert.equal(
                recovered.status,
                200,
                JSON.stringify(recovered.body),
              );
              assert.equal(recovered.body.receipt.outcome, 'applied');
              await withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
                  [superGrant],
                ),
              );
              const auth = await read('/v1/me/authorization');
              assert.equal(auth.status, 200);
              assert.equal(auth.body.role, 'developer');
              assert.equal(auth.body.schoolAdminManagement, false);
              assert.equal(
                (await f.managementResponse(admin, targets.primary.profileId))
                  .status,
                403,
              );
              break;
            }
            case 'restore-super':
              superGrant = await f.grant(admin);
              break;
            case 'revoked-title-retained': {
              const grants = await f.grants(targets.primary);
              assert.equal(grants.length, 2);
              assert.ok(grants.every((g) => g['revoked_at'] !== null));
              assert.equal(
                grants[0]!['operating_region_id'],
                f.scope.home.regionId,
              );
              assert.equal(
                grants[1]!['operating_region_id'],
                f.scope.related.regionId,
              );
              const owned = await f.pool.query(
                "SELECT title_key,origin FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='role_admin'",
                [targets.primary.accountId],
              );
              assert.equal(owned.rowCount, 1);
              assert.equal(
                owned.rows[0]!['origin'],
                'school_admin_appointment',
              );
              assert.deepEqual(
                await primaryCosmetics(),
                before,
                'No baseline/appearance/auto-equip created',
              );
              const authorization = await read(
                '/v1/me/authorization',
                targets.primary,
              );
              assert.equal(authorization.body.role, 'member');
              const notices = await read(
                '/v1/me/system-notices',
                targets.primary,
              );
              assert.equal(notices.status, 200);
              assert.equal(notices.body.items.length, 0);
              break;
            }
            case 'cancelled-late-original': {
              const response = await f.send(admin, body);
              assert.equal(response.status, 200, JSON.stringify(response.body));
              assert.equal(
                response.body.code,
                'SCHOOL_ADMIN_MANAGEMENT_CANCELLED',
              );
              assert.equal((await f.grants(targets.cancelled)).length, 0);
              break;
            }
            case 'change-target-version': {
              const previous = await f.management(
                admin,
                targets.stale.profileId,
              );
              assert.equal(previous.stateVersion, value['version']);
              await f.certify(targets.stale.accountId, { identity: false });
              assert.notEqual(
                (await f.management(admin, targets.stale.profileId))
                  .stateVersion,
                previous.stateVersion,
              );
              break;
            }
            default:
              throw Error(
                `Unexpected native checkpoint: ${String(value['name'])}`,
              );
          }
          child.send({
            event: 'continue',
            name: value['name'],
            checkpointId: value['checkpointId'],
          });
        };
        child.on('message', (raw) => {
          const value = raw as Record<string, unknown>;
          if (value['event'] === 'checkpoint')
            void checkpoint(value).catch(reject);
          else if (value['event'] === 'failure') {
            finished = true;
            reject(Error(String(value['message'])));
          } else if (value['event'] === 'done') {
            finished = true;
            resolve(value);
          }
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (!finished)
            reject(Error(`School-admin native exit ${code}: ${logs}`));
        });
        child.send({
          port: (f.http.address() as { port: number }).port,
          admin: credentials(admin),
          stranger: credentials(stranger),
          targets: Object.fromEntries(
            Object.entries(targets).map(([name, a]) => [name, a.profileId]),
          ),
          missingProfileId: randomUUID(),
          regions: {
            home: f.scope.home.regionId,
            related: f.scope.related.regionId,
            foreign: f.scope.foreign.regionId,
          },
        });
      },
    );
    const ids = done['requestIds'] as Record<string, string>;
    for (const [name, outcome, code] of [
      ['first', 'applied', undefined],
      ['reassigned', 'applied', undefined],
      ['unchanged', 'unchanged', undefined],
      ['revoked', 'applied', undefined],
      ['cancelled', 'rejected', 'SCHOOL_ADMIN_MANAGEMENT_CANCELLED'],
      ['appliedWinner', 'applied', undefined],
      ['stale', 'rejected', 'SCHOOL_ADMIN_MANAGEMENT_STALE'],
      ['late', 'applied', undefined],
      ['storage', 'applied', undefined],
    ] as const) {
      const result = await f.recovery(admin, ids[name]!);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.receipt.outcome, outcome, name);
      assert.equal(result.body.receipt.code, code, name);
      const foreign = await f.recovery(stranger, ids[name]!);
      assert.equal(foreign.status, 200);
      assert.equal(foreign.body.state, 'not_recorded');
    }
    assert.equal((await f.grants(targets.stale)).length, 0);
    assert.equal((await f.grants(targets.cancelled)).length, 0);
    for (const a of [
      targets.primary,
      targets.applyWinner,
      targets.late,
      targets.storage,
    ]) {
      const notice = await read('/v1/me/system-notices', a);
      assert.equal(notice.status, 200);
      assert.equal(notice.body.items.length, 0);
    }
    assert.ok(Number(done['httpCalls']) >= 40);
    // Five explicit native GETs: committed cold recovery, unresolved absence,
    // cold cancel recovery, late callback recovery and failed-cleanup recovery.
    // Cancel/apply winner resolution uses POST and must not add an implicit GET.
    assert.equal(Number(done['receiptReads']), 5);
    t.diagnostic(
      `Emitted school-admin journey: ${String(done['httpCalls'])} loopback HTTP exchanges, ${String(done['receiptReads'])} receipt reads; no provider/device acceptance claimed.`,
    );
  },
);
