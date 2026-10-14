import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { DatabaseService, inTransaction } from '../../src/database/database.js';
import { applySyntheticInventory } from '../../src/school-uid/inventory.js';
import {
  schoolUidFixture,
  syntheticUidInventory,
} from '../support/school-uid-fixture.js';
import type { SchoolIdentityCommand } from '../../src/school-identity/contracts.js';
test(
  'actual native enrollment and approved student cause issue once; correction A-B-A preserves reservations; deferred completion keeps original approval',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      profile = await f.profile(owner),
      application = await f.submit(owner);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.account_coverage WHERE account_id=$1',
          [owner.accountId],
        )
      ).rows[0].n,
      0,
    );
    const decision = await f.approve(f.admin, application);
    const uidA = await f.own(owner);
    assert.equal(uidA.status, 'assigned');
    if (uidA.status !== 'assigned') throw Error('UID missing');
    assert.equal(uidA.uid, '1');
    assert.equal(uidA.formattedUid, '000001');
    const repeat = await request(f.app.getHttpServer())
      .post(
        `/v1/student-verification-review/regions/${f.home.regionId}/applications/${application.id}/decision`,
      )
      .set('Authorization', `Bearer ${f.admin.accessToken}`)
      .send(decision.body);
    assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
    assert.deepEqual(repeat.body, decision.response.body);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.allocations WHERE account_id=$1',
          [owner.accountId],
        )
      ).rows[0].n,
      1,
    );
    const b = await f.correct(f.admin, profile, f.destination.campusId);
    assert.equal(b.receipt.outcome, 'applied');
    const uidB = await f.own(owner);
    assert.equal(uidB.status, 'assigned');
    if (uidB.status !== 'assigned') throw Error('UID B missing');
    assert.equal(uidB.uid, '1');
    assert.equal(uidB.school.code, f.destination.schoolCode);
    const replay = await f.send(f.admin, b.command);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, b.receipt);
    const lookup = await request(f.app.getHttpServer())
      .get('/v1/admin/school-uids/lookup')
      .set('Authorization', `Bearer ${f.admin.accessToken}`)
      .query({ schoolCode: f.home.schoolCode, uid: '000001' });
    assert.equal(lookup.status, 200, JSON.stringify(lookup.body));
    assert.deepEqual(lookup.body, { status: 'unavailable' });
    assert.equal(
      (await f.correct(f.admin, profile, f.home.campusId)).receipt.outcome,
      'applied',
    );
    const uidNew = await f.own(owner);
    assert.equal(uidNew.status, 'assigned');
    if (uidNew.status !== 'assigned') throw Error('UID return missing');
    assert.equal(uidNew.uid, '2');
    assert.equal(
      (await f.correct(f.admin, profile, f.scope.related.campusId)).receipt
        .outcome,
      'unchanged',
    );
    const waiting = await f.actor(),
      waitingProfile = await f.profile(waiting),
      waitingApp = await f.submit(waiting, f.deferred);
    await f.approve(f.admin, waitingApp);
    assert.deepEqual(await f.own(waiting), { status: 'unavailable' });
    await f.admit(f.deferred);
    const view = await f.management(f.admin, waitingProfile);
    assert.equal(view.actions.completeUid, true);
    const command: SchoolIdentityCommand = {
      version: 1,
      action: 'complete_uid',
      clientRequestId: randomUUID(),
      targetProfileId: waitingProfile,
      expectedStateVersion: view.stateVersion,
    };
    const done = await f.send(f.admin, command);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.outcome, 'applied');
    assert.equal((await f.own(waiting)).status, 'assigned');
    assert.equal(
      (
        await f.pool.query(
          'SELECT outcome FROM whaleu_school_uid.issuance_decisions d JOIN whaleu_verification.student_decisions s ON s.id=d.student_decision_id WHERE s.account_id=$1',
          [waiting.accountId],
        )
      ).rows[0].outcome,
      'deferred_unavailable',
    );
  },
);

test(
  'same-institution unchanged with unavailable current UID does not invent coverage, an assignment or Verification effects',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      profile = await f.profile(owner);
    await f.approve(f.admin, await f.submit(owner, f.deferred));
    assert.deepEqual(await f.own(owner), { status: 'unavailable' });
    const state = async () =>
      (
        await f.pool.query(
          `SELECT
    (SELECT to_jsonb(h) FROM whaleu_verification.account_heads h WHERE h.account_id=$1) verification,
    (SELECT to_jsonb(h) FROM whaleu_school_uid.account_heads h WHERE h.account_id=$1) uid,
    (SELECT count(*)::int FROM whaleu_school_uid.allocations WHERE account_id=$1) allocations,
    (SELECT count(*)::int FROM whaleu_school_uid.account_coverage WHERE account_id=$1) coverage`,
          [owner.accountId],
        )
      ).rows[0];
    const before = await state();
    assert.equal(before.allocations, 0);
    const unchanged = await f.correct(f.admin, profile, f.deferred.campusId);
    assert.equal(unchanged.receipt.outcome, 'unchanged');
    assert.deepEqual(await f.own(owner), { status: 'unavailable' });
    assert.deepEqual(await state(), before);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.admission_heads WHERE institution_id=$1',
          [f.deferred.institutionId],
        )
      ).rows[0].n,
      0,
    );
    // Known native absence also permits a real transfer out of an unadmitted
    // old school when the destination namespace is explicitly admitted.
    const transferring = await f.actor(),
      transferringProfile = await f.profile(transferring);
    await f.approve(f.admin, await f.submit(transferring, f.deferred));
    assert.equal(
      (await f.correct(f.admin, transferringProfile, f.destination.campusId))
        .receipt.outcome,
      'applied',
    );
    const transferred = await f.own(transferring);
    assert.equal(transferred.status, 'assigned');
    if (transferred.status !== 'assigned') throw Error('Missing transfer UID');
    assert.equal(transferred.school.code, f.destination.schoolCode);
    assert.equal(transferred.uid, '1');

    // Absence is a retained observation, not a wildcard for a later admission.
    const view = await f.management(f.admin, profile, f.destination.campusId);
    assert.ok(view.destination);
    const command: SchoolIdentityCommand = {
      version: 1,
      action: 'correct_school',
      clientRequestId: randomUUID(),
      targetProfileId: profile,
      expectedStateVersion: view.stateVersion,
      destinationCampusId: f.destination.campusId,
      expectedDestinationVersion: view.destination.destinationVersion,
    };
    const database = f.app.get(DatabaseService),
      original = database.transaction,
      run = original.bind(database);
    let hit = false;
    database.transaction = (work, options) =>
      run(async (tx) => {
        const raw = tx.query,
          query = raw.bind(tx);
        tx.query = (async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          if (
            !hit &&
            sql.startsWith('INSERT INTO whaleu_school_uid.commands')
          ) {
            hit = true;
            // Intentionally noncooperating inventory writer. Its owner retains
            // test/loopback checks, without the already-held outer Safety gate.
            await inTransaction(f.pool, (separate) =>
              applySyntheticInventory(
                syntheticUidInventory(f.deferred),
                f.deferred.institutionId,
                separate,
              ),
            );
          }
          return result;
        }) as PoolClient['query'];
        try {
          return await work(tx);
        } finally {
          tx.query = raw;
        }
      }, options);
    try {
      const changed = await f.send(f.admin, command);
      assert.equal(changed.status, 503, JSON.stringify(changed.body));
    } finally {
      database.transaction = original;
    }
    assert.ok(hit);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.admission_heads WHERE institution_id=$1',
          [f.deferred.institutionId],
        )
      ).rows[0].n,
      1,
      'the competing old-school admission committed',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.allocations WHERE institution_id=$1',
          [f.destination.institutionId],
        )
      ).rows[0].n,
      1,
      'failed correction cannot consume a destination allocation',
    );
    assert.deepEqual(await state(), before);
    assert.deepEqual(await f.own(owner), { status: 'unavailable' });
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.commands WHERE actor_id=$1 AND request_id=$2',
          [f.admin.accountId, command.clientRequestId],
        )
      ).rows[0].n,
      0,
    );
  },
);
