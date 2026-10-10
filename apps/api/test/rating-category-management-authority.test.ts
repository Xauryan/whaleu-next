import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  RatingCategoryManagementAuthorityFacade,
  assertRatingCategoryManagementAuthority,
} from '../src/authorization/rating-category-management.facade.js';
import {
  CampusRatingScopedContextFacade,
  assertRatingScopedCampusProof,
} from '../src/campus/rating-scoped-context.facade.js';
import type { CampusCommunityPolicyService } from '../src/campus/community-policy/campus-community-policy.service.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `97000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.UTC(2026, 9, 10),
  account = id(1),
  institution = id(2),
  campusA = id(3),
  campusB = id(4),
  campusC = id(5),
  regionA = id(6),
  regionB = id(7),
  group = id(8),
  topologyId = id(9);
function grant(
  kind: 'global' | 'region' | 'campus',
  campusId = campusA,
  future = false,
) {
  return {
    source: kind === 'campus' ? 'campus' : 'role',
    id: id(
      kind === 'global'
        ? 10
        : kind === 'region'
          ? 11
          : campusId === campusA
            ? 12
            : 13,
    ),
    role:
      kind === 'global'
        ? 'super_admin'
        : kind === 'region'
          ? 'school_admin'
          : null,
    regionId: kind === 'region' ? regionA : null,
    campusId: kind === 'campus' ? campusId : null,
    approvedByAccountId: id(20),
    approvalReference: 'Explicit owner approval',
    validFrom: new Date(now + (future ? 1000 : -1000)),
    preciseFrom: future ? '2026-10-10 00:00:01+00' : '2026-10-09 23:59:59+00',
    expiresAt: new Date(now + 10000),
    preciseUntil: '2026-10-10 00:00:10+00',
    isFuture: future,
    valid: true,
  };
}
function fixture(initial: ReturnType<typeof grant>[] = []) {
  let rows = initial,
    clock = now,
    blocked = false;
  const calls: string[] = [];
  const physical = [campusA, campusB, campusC].map((campusId) => ({
    id: campusId,
    institution_id: institution,
    is_active: true,
    state_version: '1',
  }));
  const assignments = physical.map((campus) => ({
    campus_id: campus.id,
    operating_region_id: campus.id === campusC ? regionB : regionA,
    state_version: '1',
  }));
  const topology = {
    version: 1,
    groups: [{ groupId: group, coverage: 'complete', isActive: true }],
    regions: [regionA, regionB].map((regionId) => ({
      regionId,
      institutionId: institution,
      groupId: group,
      coverage: 'complete',
      isActive: true,
    })),
    assignments: assignments.map((assignment) => ({
      campusId: assignment.campus_id,
      institutionId: institution,
      regionId: assignment.operating_region_id,
      coverage: 'complete',
      isActive: true,
    })),
  };
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              capacity: 16,
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('set_config') || sql === 'SET CONSTRAINTS ALL IMMEDIATE')
        return { rows: [] };
      if (sql.startsWith('LOCK TABLE')) {
        if (blocked && sql.includes('whaleu_authorization'))
          throw Error('owner writer');
        return { rows: [] };
      }
      if (sql.includes('role_active AS MATERIALIZED')) return { rows };
      if (sql.startsWith('SELECT id FROM whaleu_authorization.'))
        return {
          rows: rows
            .filter((row) =>
              sql.includes('rating_category_campus_grants')
                ? row.source === 'campus'
                : row.source === 'role',
            )
            .map((row) => ({ id: row.id })),
        };
      if (sql.includes('FROM whaleu_campus.discovery_count_epochs'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: '1',
          })),
        };
      if (sql.includes('generate_series(0,127)'))
        return { rows: Array.from({ length: 128 }, () => ({ locked: true })) };
      if (sql.includes('pg_try_advisory_xact_lock(1464356103,128)'))
        return { rows: [{ locked: true }] };
      if (sql.includes('community_topology_heads'))
        return {
          rows: [
            {
              id: topologyId,
              revision: 1,
              topology,
              valid_until: new Date(now + 100000),
              precise_until: '2026-10-10 00:01:40+00',
              next_activation: null,
              valid: true,
              head: { snapshot_id: topologyId },
              snapshot: { id: topologyId, revision: 1, topology },
            },
          ],
        };
      if (sql.includes('FROM whaleu_campus.operating_regions'))
        return {
          rows: [regionA, regionB].map((regionId) => ({
            id: regionId,
            is_active: true,
            state_version: '1',
          })),
        };
      if (sql.includes('FROM whaleu_campus.institutions'))
        return { rows: [{ id: institution, state_version: '1' }] };
      if (sql.includes('FROM whaleu_campus.campus_region_assignments'))
        return { rows: assignments };
      if (sql.includes('FROM whaleu_campus.campuses'))
        return { rows: physical };
      if (sql.includes('clock_timestamp() AS now'))
        return { rows: [{ now: new Date(clock) }] };
      assert.fail(`Unexpected SQL ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    tx,
    calls,
    physical,
    assignments,
    topology,
    owner: new RatingCategoryManagementAuthorityFacade(),
    campus: new CampusRatingScopedContextFacade(
      {} as CampusCommunityPolicyService,
    ),
    replace: (next: typeof rows) => {
      rows = next;
    },
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    block: () => {
      blocked = true;
    },
  };
}
test('exact category campus grant cannot borrow another campus in its region or global authority', async () => {
  const f = fixture([grant('campus')]);
  const a = await f.owner.resolve(account, f.tx);
  assert.equal(a.global, false);
  assert.deepEqual(a.regionIds, []);
  assert.deepEqual(a.exactCampusIds, [campusA]);
  assert.deepEqual(a.campusIds, [campusA]);
  f.owner.require(a, [campusA], false, f.tx);
  for (const ids of [[campusB], [campusA, campusB], [campusC], []])
    assert.throws(() => f.owner.require(a, ids, false, f.tx));
  assert.throws(() => f.owner.require(a, [], true, f.tx));
  const p = await f.campus.resolveCategoryManagementDomain(
    { accountId: account },
    { kind: 'campus', campusId: campusA },
    a,
    f.tx,
  );
  assertRatingScopedCampusProof(p, f.tx);
  assert.equal(p.authorizationMode, 'category_management');
  assert.equal(p.authorizationFingerprint, a.fingerprint);
  assert.deepEqual(p.scopeKeys, [`campus:${campusA}`]);
  assert.equal(p.mappings.length, 3);
  assert.equal(p.identity, null);
  await assert.rejects(() =>
    f.campus.resolveCategoryManagementDomain(
      { accountId: account },
      { kind: 'campus', campusId: campusB },
      a,
      f.tx,
    ),
  );
  await checkTransactionDeadlines(f.tx);
});
test('region, exact campus and global real sources compose with all-of physical inventory', async () => {
  const f = fixture([grant('region'), grant('campus', campusC)]);
  const a = await f.owner.resolve(account, f.tx);
  assert.deepEqual(a.regionIds, [regionA]);
  assert.deepEqual(a.exactCampusIds, [campusC]);
  assert.deepEqual(a.campusIds, [campusA, campusB, campusC]);
  f.owner.require(a, [campusA, campusB, campusC], false, f.tx);
  assert.throws(() => f.owner.require(a, [campusA, campusA], false, f.tx));
  assert.throws(() => f.owner.require(a, [id(99)], false, f.tx));
  const g = fixture([grant('global')]);
  const ga = await g.owner.resolve(account, g.tx);
  g.owner.require(ga, [campusA, campusB, campusC], true, g.tx);
  const p = await g.campus.resolveCategoryManagementDomain(
    { accountId: account },
    { kind: 'global' },
    ga,
    g.tx,
  );
  assert.deepEqual(p.scopeKeys, ['global']);
  assert.equal(p.authorizationMode, 'category_management');
  await checkTransactionDeadlines(g.tx);
});
test('authority cannot be copied, reused after checkpoint, or assigned to another actor or transaction', async () => {
  const f = fixture([grant('global')]);
  const a = await f.owner.resolve(account, f.tx);
  assertRatingCategoryManagementAuthority(a, f.tx);
  assert(Object.isFrozen(a) && Object.isFrozen(a.campusIds));
  assert.throws(() => assertRatingCategoryManagementAuthority({ ...a }, f.tx));
  assert.throws(() => assertRatingCategoryManagementAuthority(a, fixture().tx));
  await assert.rejects(() =>
    f.campus.resolveCategoryManagementDomain(
      { accountId: id(99) },
      { kind: 'global' },
      a,
      f.tx,
    ),
  );
  restoreTransactionDeadlines(f.tx, checkpointTransactionDeadlines(f.tx));
  assert.throws(() => assertRatingCategoryManagementAuthority(a, f.tx));
});
test('grant absence, revocation, new insertion, provenance changes and source writers invalidate final proof', async () => {
  for (const mode of [
    'absence_insert',
    'revocation',
    'provenance',
    'block',
  ] as const) {
    const f = fixture(mode === 'absence_insert' ? [] : [grant('campus')]);
    const a = await f.owner.resolve(account, f.tx);
    if (mode === 'absence_insert') {
      assert.deepEqual(a.campusIds, []);
      f.replace([grant('campus')]);
    } else if (mode === 'revocation') f.replace([]);
    else if (mode === 'provenance')
      f.replace([
        { ...grant('campus'), approvalReference: 'Changed approval' },
      ]);
    else f.block();
    await assert.rejects(
      () => checkTransactionDeadlines(f.tx),
      (error) =>
        error instanceof ApplicationError &&
        error.code === 'AUTHORIZATION_UNAVAILABLE',
    );
  }
});
test('expiry and earliest future grant activation bound otherwise unchanged observed authority', async () => {
  for (const future of [false, true]) {
    const f = fixture([grant('campus', campusA, future)]);
    const a = await f.owner.resolve(account, f.tx);
    assert.equal(a.validUntil, now + (future ? 1000 : 10000));
    assert.deepEqual(a.campusIds, future ? [] : [campusA]);
    f.advance(future ? 1000 : 10000);
    await assert.rejects(
      () => checkTransactionDeadlines(f.tx),
      (error) =>
        error instanceof ApplicationError &&
        error.code === 'AUTHORIZATION_UNAVAILABLE',
    );
  }
});
test('unknown, changed and inactive physical inventory is never permission or a partial subset', async () => {
  const f = fixture([grant('campus')]);
  const a = await f.owner.resolve(account, f.tx);
  f.assignments[0]!.operating_region_id = regionB;
  await assert.rejects(() =>
    f.campus.resolveCategoryManagementDomain(
      { accountId: account },
      { kind: 'campus', campusId: campusA },
      a,
      f.tx,
    ),
  );
  await assert.rejects(() => checkTransactionDeadlines(f.tx));
  const inactive = fixture([grant('campus')]);
  inactive.physical[0]!.is_active = false;
  inactive.topology.assignments[0]!.isActive = false;
  const ia = await inactive.owner.resolve(account, inactive.tx);
  assert.deepEqual(ia.campusIds, []);
  assert.throws(() =>
    inactive.owner.require(ia, [campusA], false, inactive.tx),
  );
});
test('malformed, fake-region campus grants, missing provenance and duplicate grants fail closed', async () => {
  for (const rows of [
    [{ ...grant('campus'), approvalReference: ' ' }],
    [{ ...grant('campus'), regionId: regionA }],
    [{ ...grant('campus'), valid: false }],
    [grant('campus'), { ...grant('campus'), id: id(99) }],
  ]) {
    const f = fixture(rows);
    await assert.rejects(() => f.owner.resolve(account, f.tx));
  }
});
test('unrevoked grant overflow fails closed before any truncated authority is returned', async () => {
  const f = fixture(
    Array.from({ length: 1001 }, (_, index) => ({
      ...grant('campus'),
      id: id(100 + index),
      campusId: id(2000 + index),
    })),
  );
  await assert.rejects(() => f.owner.resolve(account, f.tx));
});
test('management batch reads complete inventory once and returns one branded exact proof per unique selector', async () => {
  const f = fixture([grant('global')]);
  const a = await f.owner.resolve(account, f.tx),
    before = f.calls.length;
  const proofs = await f.campus.resolveCategoryManagementDomains(
    { accountId: account },
    [
      { kind: 'global' },
      { kind: 'campus', campusId: campusA },
      { kind: 'campus', campusId: campusB },
    ],
    a,
    f.tx,
  );
  assert.equal(proofs.length, 3);
  assert(Object.isFrozen(proofs));
  for (const proof of proofs) {
    assertRatingScopedCampusProof(proof, f.tx);
    assert.equal(proof.authorizationMode, 'category_management');
    assert.equal(proof.authorizationFingerprint, a.fingerprint);
  }
  const reads = f.calls.slice(before);
  assert.equal(
    reads.filter((sql) =>
      sql.includes('FROM whaleu_campus.community_topology_heads'),
    ).length,
    1,
  );
  assert.equal(
    reads.filter((sql) => sql.includes('FROM whaleu_campus.campuses')).length,
    1,
  );
  assert.equal(
    reads.filter((sql) =>
      sql.includes('FROM whaleu_campus.discovery_count_epochs'),
    ).length,
    1,
  );
  assert.equal(
    reads.filter((sql) => sql.includes('community_identity_heads')).length,
    0,
  );
  assert.equal(proofs[0]!.mappings, proofs[1]!.mappings);
  await checkTransactionDeadlines(f.tx);
});
test('management batch rejects empty, duplicate, over-capacity, and partially unauthorized domains', async () => {
  const f = fixture([grant('campus')]),
    a = await f.owner.resolve(account, f.tx);
  for (const selectors of [
    [],
    [
      { kind: 'campus' as const, campusId: campusA },
      { kind: 'campus' as const, campusId: campusA },
    ],
    [
      { kind: 'campus' as const, campusId: campusA },
      { kind: 'campus' as const, campusId: campusB },
    ],
    Array.from({ length: 1002 }, (_, index) => ({
      kind: 'campus' as const,
      campusId: id(100 + index),
    })),
  ])
    await assert.rejects(() =>
      f.campus.resolveCategoryManagementDomains(
        { accountId: account },
        selectors,
        a,
        f.tx,
      ),
    );
});
test('management batch supports 1000 exact campuses plus global under unchanged owner proof capacity', async () => {
  const f = fixture([grant('global')]);
  for (let index = 0; index < 997; index++) {
    const campusId = id(100 + index);
    f.physical.push({
      id: campusId,
      institution_id: institution,
      is_active: true,
      state_version: '1',
    });
    f.assignments.push({
      campus_id: campusId,
      operating_region_id: regionA,
      state_version: '1',
    });
    f.topology.assignments.push({
      campusId,
      institutionId: institution,
      regionId: regionA,
      coverage: 'complete',
      isActive: true,
    });
  }
  const a = await f.owner.resolve(account, f.tx);
  const proofs = await f.campus.resolveCategoryManagementDomains(
    { accountId: account },
    [
      { kind: 'global' },
      ...a.campusIds.map((campusId) => ({ kind: 'campus' as const, campusId })),
    ],
    a,
    f.tx,
  );
  assert.equal(proofs.length, 1001);
  assert.deepEqual(
    proofs.flatMap((proof) => proof.campusIds),
    a.campusIds,
  );
  await checkTransactionDeadlines(f.tx);
});
