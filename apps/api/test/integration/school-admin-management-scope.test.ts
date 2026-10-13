import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { schoolAdminManagementFixture } from '../support/school-admin-management-fixture.js';
import {
  appendIdentitySelection,
  appendTopologyRevision,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
import type { AssertionRecord } from '../../src/verification/contracts.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';
import type { TopologySnapshotData } from '../../src/campus/community-policy/fact-validation.js';

test(
  'school administration eligibility uses accepted same-group topology and reconciled physical inventory independently of identity choice',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor();
    await f.grant(admin);
    const target = await f.actor({ identity: false, phone: 'unavailable' });
    let view = await f.management(admin, target.profileId);
    assert.equal(view.eligibility.status, 'known');
    assert.equal(view.eligibility.defaultRegionId, null);
    assert.equal(view.actions.appoint, true);
    assert.deepEqual(
      view.eligibility.regions.map((r) => r.id).sort(),
      [f.scope.home.regionId, f.scope.related.regionId].sort(),
    );
    await appendIdentitySelection(
      f.pool,
      target.accountId,
      target.facts,
      f.scope,
      f.scope.foreign.campusId,
    );
    view = await f.management(admin, target.profileId);
    assert.equal(view.eligibility.status, 'known');
    assert.equal(view.eligibility.defaultRegionId, null);
    assert.equal(view.actions.appoint, true);
    await appendIdentitySelection(
      f.pool,
      target.accountId,
      target.facts,
      f.scope,
      f.scope.related.campusId,
    );
    view = await f.management(admin, target.profileId);
    assert.equal(view.eligibility.defaultRegionId, f.scope.related.regionId);
    const first = await f.apply(
      admin,
      target.profileId,
      'appoint',
      f.scope.home.regionId,
    );
    assert.equal(first.receipt.outcome, 'applied');
    assert.equal(
      (await f.management(admin, target.profileId)).eligibility.defaultRegionId,
      f.scope.home.regionId,
      'existing fixed grant takes priority over identity choice',
    );
    await appendIdentitySelection(
      f.pool,
      target.accountId,
      target.facts,
      f.scope,
      f.scope.related.campusId,
    );
    assert.equal(
      (await f.grants(target)).find((g) => g.revoked_at === null)
        ?.operating_region_id,
      f.scope.home.regionId,
    );
    const newTarget = await f.actor({ identity: false });
    const rejectedTopology: [
      string,
      (topology: TopologySnapshotData) => void,
    ][] = [
      ['duplicate group', (s) => s.groups.push({ ...s.groups[0]! })],
      ['duplicate region', (s) => s.regions.push({ ...s.regions[0]! })],
      [
        'duplicate assignment',
        (s) => s.assignments.push({ ...s.assignments[0]! }),
      ],
      [
        'inactive origin group',
        (s) => {
          s.groups[0]!.isActive = false;
        },
      ],
      [
        'missing origin group evidence',
        (s) => {
          s.groups[0]!.coverage = 'missing';
        },
      ],
      [
        'conflicting assignment',
        (s) => {
          s.assignments[0]!.coverage = 'conflicting';
        },
      ],
      [
        'origin institution mismatch',
        (s) => {
          s.regions[0]!.institutionId = randomUUID();
        },
      ],
      [
        'unreviewed active campus',
        (s) => {
          s.assignments = s.assignments.filter(
            (a) => a.campusId !== f.scope.related.campusId,
          );
        },
      ],
      [
        'reviewed campus missing',
        (s) => {
          s.assignments.push({ ...s.assignments[0]!, campusId: randomUUID() });
        },
      ],
      [
        'same-institution excluded group still requires complete inventory',
        (s) => {
          s.assignments.find(
            (a) => a.campusId === f.scope.foreign.campusId,
          )!.coverage = 'missing';
        },
      ],
    ];
    for (const [name, patch] of rejectedTopology)
      await t.test(name, async () => {
        const next = structuredClone(f.scope.topology);
        patch(next);
        await appendTopologyRevision(f.pool, next);
        const invalid = await f.management(admin, newTarget.profileId);
        assert.equal(
          invalid.eligibility.status,
          'unavailable',
          JSON.stringify(invalid),
        );
        assert.deepEqual(invalid.eligibility.regions, []);
        assert.equal(invalid.actions.appoint, false);
        const body = f.command(invalid, 'appoint', f.scope.home.regionId),
          result = await f.send(admin, body);
        assert.ok(result.status >= 400 || result.body.outcome === 'rejected');
        assert.equal((await f.grants(newTarget)).length, 0);
        await appendTopologyRevision(f.pool, f.scope.topology);
      });
    await t.test(
      'unknown accepted coverage never falls back to origin singleton',
      async () => {
        await appendTopologyRevision(f.pool, f.scope.topology, {
          provenanceState: 'unknown',
        });
        const unknown = await f.management(admin, newTarget.profileId);
        assert.equal(unknown.eligibility.status, 'unavailable');
        assert.deepEqual(unknown.eligibility.regions, []);
        await appendTopologyRevision(f.pool, f.scope.topology);
      },
    );
    await t.test(
      'physical remap and same-value tuple ABA stale the displayed command',
      async () => {
        const before = await f.management(admin, newTarget.profileId);
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_campus.campuses SET full_name=full_name WHERE id=$1',
            [f.scope.related.campusId],
          ),
        );
        const stale = await f.send(
          admin,
          f.command(before, 'appoint', f.scope.home.regionId),
        );
        assert.equal(stale.status, 200, JSON.stringify(stale.body));
        assert.equal(stale.body.code, 'SCHOOL_ADMIN_MANAGEMENT_STALE');
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=$2 WHERE campus_id=$1',
            [f.scope.related.campusId, f.scope.foreign.regionId],
          ),
        );
        assert.equal(
          (await f.management(admin, newTarget.profileId)).eligibility.status,
          'unavailable',
        );
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=$2 WHERE campus_id=$1',
            [f.scope.related.campusId, f.scope.related.regionId],
          ),
        );
      },
    );
    await t.test(
      'a proven empty physical eligible set is known and never auto-appointed',
      async () => {
        const empty = structuredClone(f.scope.topology);
        for (const a of empty.assignments) a.isActive = false;
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_campus.campuses SET is_active=false WHERE institution_id=$1',
            [f.scope.institutionId],
          ),
        );
        await appendTopologyRevision(f.pool, empty);
        const state = await f.management(admin, newTarget.profileId);
        assert.equal(state.eligibility.status, 'known');
        assert.deepEqual(state.eligibility.regions, []);
        assert.equal(state.actions.appoint, false);
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_campus.campuses SET is_active=true WHERE institution_id=$1',
            [f.scope.institutionId],
          ),
        );
        await appendTopologyRevision(f.pool, f.scope.topology);
      },
    );
    await t.test(
      'accepted singleton remains an explicit selection and no grant is created by GET',
      async () => {
        const singleton = structuredClone(f.scope.topology);
        singleton.regions.find(
          (r) => r.regionId === f.scope.related.regionId,
        )!.groupId = singleton.regions.find(
          (r) => r.regionId === f.scope.foreign.regionId,
        )!.groupId;
        await appendTopologyRevision(f.pool, singleton);
        const state = await f.management(admin, newTarget.profileId);
        assert.deepEqual(
          state.eligibility.regions.map((r) => r.id),
          [f.scope.home.regionId],
        );
        assert.equal((await f.grants(newTarget)).length, 0);
        await appendTopologyRevision(f.pool, f.scope.topology);
      },
    );
    await t.test(
      'revocation remains possible with broken topology and no current affiliation',
      async () => {
        await appendTopologyRevision(f.pool, f.scope.topology, {
          coverageState: 'missing',
        });
        await f.certify(target.accountId, {
          affiliation: 'unavailable',
          identity: false,
        });
        const state = await f.management(admin, target.profileId);
        assert.equal(state.actions.revoke, true);
        assert.equal(
          (await f.apply(admin, target.profileId, 'revoke')).receipt.outcome,
          'applied',
        );
      },
    );
  },
);

test(
  'expired, missing, unverified, source-conflicting and inactive target identities cannot receive school authority',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor();
    await f.grant(admin);
    for (const options of [
      { affiliation: 'unverified' as const, identity: false },
      { affiliation: 'unavailable' as const, identity: false },
      { expiresAt: new Date(Date.now() - 1000), identity: false },
    ]) {
      const target = await f.actor(options),
        view = await f.management(admin, target.profileId);
      assert.equal(view.actions.appoint, false);
      const result = await f.send(
        admin,
        f.command(view, 'appoint', f.scope.home.regionId),
      );
      assert.ok(result.status >= 400 || result.body.outcome === 'rejected');
      assert.equal((await f.grants(target)).length, 0);
    }
    const temporary = await f.actor({
      expiresAt: new Date(Date.now() + 120000),
      identity: false,
    });
    assert.equal(
      (
        await f.apply(
          admin,
          temporary.profileId,
          'appoint',
          f.scope.home.regionId,
        )
      ).receipt.outcome,
      'applied',
    );
    const inactive = await f.actor();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
        [inactive.accountId],
      ),
    );
    const denied = await f.managementResponse(admin, inactive.profileId);
    assert.ok(denied.status >= 400 || denied.body.actions.appoint === false);
    const mismatch = await f.actor();
    const otherInstitution = randomUUID();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "INSERT INTO whaleu_campus.institutions(id,name) VALUES($1,'Synthetic different school')",
        [otherInstitution],
      ),
    );
    for (const override of [
      { assertion_state: 'revoked' },
      { coverage_state: 'conflict' },
      { provenance_state: 'unknown' },
      { source_account_id: admin.accountId },
      { source_issuer_institution_id: otherInstitution },
      { method: 'phone_provider' },
    ] satisfies Partial<AssertionRecord>[]) {
      const subject = await f.actor({ identity: false });
      await setSyntheticSnapshot(f.pool, subject.accountId, [
        syntheticAssertion(
          subject.accountId,
          f.scope.institutionId,
          'affiliation',
          { origin_region_id: f.scope.home.regionId, ...override },
        ),
      ]);
      const state = await f.management(admin, subject.profileId);
      assert.equal(state.actions.appoint, false, JSON.stringify(override));
      const response = await f.send(
        admin,
        f.command(state, 'appoint', f.scope.home.regionId),
      );
      assert.ok(
        response.status >= 400 || response.body.outcome === 'rejected',
        JSON.stringify(override),
      );
      assert.equal((await f.grants(subject)).length, 0);
    }
    await setRuntimeVerification(
      f.pool,
      mismatch.accountId,
      otherInstitution,
      f.scope.home.regionId,
      'verified',
      'unavailable',
    );
    const result = await f.management(admin, mismatch.profileId);
    assert.equal(result.actions.appoint, false);
    const before = (
      await f.pool.query('SELECT count(*)::int n FROM whaleu_profile.profiles')
    ).rows[0]!.n;
    assert.ok((await f.managementResponse(admin, randomUUID())).status >= 400);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_profile.profiles',
        )
      ).rows[0]!.n,
      before,
    );
  },
);
