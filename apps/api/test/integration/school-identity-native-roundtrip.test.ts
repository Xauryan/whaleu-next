import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import { schoolUidFixture } from '../support/school-uid-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

test(
  'real emitted school UID enrollment, review, lookup, atomic correction, original-key recovery and deferred completion',
  { timeout: 300000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/school-identity-native-worker.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
        env: { ...process.env },
      },
    );
    let logs = '';
    child.stdout?.on('data', (v) => (logs += String(v)));
    child.stderr?.on('data', (v) => (logs += String(v)));
    t.after(() => {
      if (!child.killed) child.kill();
    });
    const checkpoints: string[] = [];
    let firstCorrectionCount: number | null = null;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          assert.ok(raw && typeof raw === 'object' && 'event' in raw);
          const m = raw as Record<string, unknown>;
          if (m['event'] === 'failure')
            throw Error(String(m['message']) + '\n' + logs);
          if (m['event'] === 'checkpoint') {
            const name = String(m['name']);
            checkpoints.push(name);
            if (name === 'process-images') {
              for (const kind of ['seal', 'process', 'review'] as const)
                assert.equal(await f.worker.runOne(kind), true);
            } else if (name === 'pending') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_school_uid.account_coverage WHERE account_id=$1',
                    [m['accountId']],
                  )
                ).rows[0].n,
                0,
              );
            } else if (name === 'approved') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_school_uid.issuance_decisions u JOIN whaleu_verification.student_decisions d ON d.id=u.student_decision_id WHERE d.application_id=$1',
                    [m['applicationId']],
                  )
                ).rows[0].n,
                1,
              );
            } else if (name === 'identity-selected') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_campus.community_identity_selections WHERE account_id=$1',
                    [m['accountId']],
                  )
                ).rows[0].n,
                1,
              );
            } else if (name === 'uid_native_unavailable') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_school_uid.allocations WHERE account_id=$1',
                    [m['accountId']],
                  )
                ).rows[0].n,
                1,
              );
              const current = (
                await f.pool.query(
                  'SELECT a.issuer_institution_id FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.affiliation_assertion_id WHERE h.account_id=$1',
                  [m['accountId']],
                )
              ).rows[0];
              assert.equal(current.issuer_institution_id, f.home.institutionId);
              const command = m['command'] as { clientRequestId: string };
              const status = await request(f.app.getHttpServer())
                .get(
                  `/v1/admin/school-identities/requests/${command.clientRequestId}`,
                )
                .set('Authorization', `Bearer ${f.admin.accessToken}`);
              assert.equal(status.status, 200);
              assert.deepEqual(status.body, { state: 'not_recorded' });
            } else if (name === 'uid_native_corrected') {
              firstCorrectionCount = (
                await f.pool.query(
                  'SELECT count(*)::int n FROM whaleu_school_uid.allocations WHERE account_id=$1',
                  [m['accountId']],
                )
              ).rows[0].n;
              assert.equal(firstCorrectionCount, 2);
              await withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
                  [f.adminGrant, f.admin.accountId],
                ),
              );
            } else if (name === 'uid_native_recovered') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_school_uid.allocations WHERE account_id=$1',
                    [m['accountId']],
                  )
                ).rows[0].n,
                firstCorrectionCount,
              );
              await f.grant();
            } else if (name === 'uid_native_cancelled') {
              const result = await request(f.app.getHttpServer())
                .post('/v1/admin/school-identities/commands')
                .set('Authorization', `Bearer ${f.admin.accessToken}`)
                .send(m['command'] as Record<string, unknown>);
              assert.equal(result.status, 200, JSON.stringify(result.body));
              assert.equal(result.body.code, 'SCHOOL_IDENTITY_CANCELLED');
            } else if (name === 'uid_native_returned') {
              const allocations = (
                await f.pool.query<{ uid: string; institution_id: string }>(
                  'SELECT uid::text,institution_id FROM whaleu_school_uid.allocations WHERE account_id=$1 ORDER BY allocated_at,id',
                  [m['accountId']],
                )
              ).rows;
              assert.equal(allocations.length, 3);
              assert.deepEqual(
                allocations.map((a) => a.institution_id),
                [
                  f.home.institutionId,
                  f.destination.institutionId,
                  f.home.institutionId,
                ],
              );
              assert.deepEqual(
                allocations.map((a) => a.uid),
                ['1', '1', '2'],
              );
            } else if (name === 'uid_native_deferred') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT outcome FROM whaleu_school_uid.issuance_decisions u JOIN whaleu_verification.student_decisions d ON d.id=u.student_decision_id WHERE d.application_id=$1',
                    [m['applicationId']],
                  )
                ).rows[0].outcome,
                'deferred_unavailable',
              );
              await f.admit(f.deferred);
            } else if (name === 'uid_native_completed') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_school_uid.allocations WHERE account_id=$1',
                    [m['accountId']],
                  )
                ).rows[0].n,
                1,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_verification.student_decisions WHERE application_id=$1',
                    [m['applicationId']],
                  )
                ).rows[0].n,
                1,
              );
            } else throw Error('Unknown checkpoint ' + name);
            child.send({ event: 'continue', name });
          } else if (m['event'] === 'done') {
            for (const required of [
              'uid_native_corrected',
              'uid_native_recovered',
              'uid_native_returned',
              'uid_native_deferred',
              'uid_native_completed',
            ])
              assert.ok(checkpoints.includes(required), required);
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.once('exit', (code) => {
        if (!done) reject(Error(`Native child exit ${code}: ${logs}`));
      });
      child.send({
        port: f.port,
        png: f.png.toString('base64'),
        home: f.home,
        destination: f.destination,
        deferred: f.deferred,
      });
    });
  },
);
