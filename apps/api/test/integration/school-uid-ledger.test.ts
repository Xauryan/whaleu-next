import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { schoolUidFixture } from '../support/school-uid-fixture.js';

test(
  'concurrent native approvals allocate distinct school-local strings; MAX does not retract assignment or same-school no-op',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const a = await f.actor(),
      b = await f.actor(),
      pa = await f.profile(a);
    await f.profile(b);
    const aa = await f.submit(a),
      ab = await f.submit(b);
    await Promise.all([f.approve(f.admin, aa), f.approve(f.admin, ab)]);
    const ua = await f.own(a),
      ub = await f.own(b);
    assert.equal(ua.status, 'assigned');
    assert.equal(ub.status, 'assigned');
    if (ua.status !== 'assigned' || ub.status !== 'assigned')
      throw Error('missingUID');
    assert.deepEqual([ua.uid, ub.uid].sort(), ['1', '2']);
    await f.admit(f.home, '9223372036854775807');
    assert.deepEqual(await f.own(a), ua);
    const noOp = await f.correct(f.admin, pa, f.scope.related.campusId);
    assert.equal(noOp.receipt.outcome, 'unchanged');
    assert.deepEqual(await f.own(a), ua);
    await f.admit(f.destination, '9223372036854775807');
    const preview = await f.management(f.admin, pa, f.destination.campusId);
    assert.ok(preview.destination);
    const { randomUUID } = await import('node:crypto');
    const result = await f.send(f.admin, {
      version: 1,
      action: 'correct_school',
      clientRequestId: randomUUID(),
      targetProfileId: pa,
      expectedStateVersion: preview.stateVersion,
      destinationCampusId: f.destination.campusId,
      expectedDestinationVersion: preview.destination.destinationVersion,
    });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error.code, 'SCHOOL_UID_EXHAUSTED');
    assert.deepEqual(await f.own(a), ua);
  },
);
