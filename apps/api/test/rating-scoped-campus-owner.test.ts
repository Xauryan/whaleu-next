import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  CampusRatingScopedContextFacade,
  assertRatingScopedCampusProof,
} from '../src/campus/rating-scoped-context.facade.js';
import { CampusCommunityPolicyService } from '../src/campus/community-policy/campus-community-policy.service.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `92000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.UTC(2026, 9, 9),
  institution = id(1),
  campusA = id(2),
  campusB = id(3),
  campusC = id(4),
  regionA = id(5),
  regionB = id(6),
  groupA = id(7),
  groupB = id(8),
  snapshot = id(9);
const affiliation = {
  assertionId: id(11),
  snapshotId: id(12),
  institutionId: institution,
  originRegionId: regionA,
  validUntil: now + 100000,
};
function fixture(
  options: {
    missing?: boolean;
    phantom?: boolean;
    empty?: boolean;
    foreign?: boolean;
    future?: boolean;
    many?: number;
  } = {},
) {
  const regions = [
    { id: regionA, is_active: true, state_version: '1' },
    { id: regionB, is_active: true, state_version: '1' },
  ];
  const campuses = options.empty
    ? []
    : options.many
      ? Array.from({ length: options.many }, (_, index) => ({
          id: index === 0 ? campusA : id(100 + index),
          institution_id: institution,
          is_active: true,
          state_version: '1',
        }))
      : [
          {
            id: campusA,
            institution_id: institution,
            is_active: true,
            state_version: '1',
          },
          {
            id: campusB,
            institution_id: institution,
            is_active: true,
            state_version: '1',
          },
          {
            id: campusC,
            institution_id: institution,
            is_active: false,
            state_version: '1',
          },
        ];
  const assignments = campuses.map((c) => ({
    campus_id: c.id,
    operating_region_id: c.id === campusB ? regionB : regionA,
    state_version: '1',
  }));
  const topology = {
    version: 1,
    groups: [
      { groupId: groupA, coverage: 'complete', isActive: true },
      { groupId: groupB, coverage: 'complete', isActive: true },
    ],
    regions: [
      {
        regionId: regionA,
        institutionId: institution,
        groupId: groupA,
        coverage: 'complete',
        isActive: true,
      },
      {
        regionId: regionB,
        institutionId: institution,
        groupId: options.foreign ? groupB : groupA,
        coverage: 'complete',
        isActive: true,
      },
    ],
    assignments: campuses.map((c) => ({
      campusId: c.id,
      institutionId: institution,
      regionId: c.id === campusB ? regionB : regionA,
      coverage: 'complete',
      isActive: c.is_active,
    })),
  };
  if (options.phantom)
    campuses.push({
      id: id(99),
      institution_id: institution,
      is_active: true,
      state_version: '1',
    });
  let changed = false,
    lockFailure = false,
    clock = now;
  const calls: string[] = [];
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
              capacity: 16,
            },
          ],
        };
      if (sql.includes('set_config') || sql === 'SET CONSTRAINTS ALL IMMEDIATE')
        return { rows: [] };
      if (sql.startsWith('LOCK TABLE')) {
        if (lockFailure) throw Error('lock unavailable');
        return { rows: [] };
      }
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
      if (sql.includes('community_identity_heads'))
        return {
          rows: options.missing
            ? []
            : [
                {
                  head: { selection_id: id(13) },
                  selection: { id: id(13), changed },
                },
              ],
        };
      if (sql.includes('community_topology_heads'))
        return {
          rows: options.missing
            ? []
            : [
                {
                  id: snapshot,
                  revision: 1,
                  topology,
                  valid_until: new Date(now + 100000),
                  precise_until: 'future',
                  next_activation: options.future ? new Date(now + 1000) : null,
                  valid: !options.future,
                  head: { snapshot_id: snapshot },
                  snapshot: { id: snapshot, revision: 1, topology },
                },
              ],
        };
      if (sql.includes('operating_regions')) return { rows: regions };
      if (sql.includes('FROM whaleu_campus.institutions'))
        return { rows: [{ id: institution, state_version: '1' }] };
      if (sql.includes('campus_region_assignments'))
        return { rows: assignments };
      if (sql.includes('FROM whaleu_campus.campuses'))
        return { rows: campuses };
      if (sql.includes('clock_timestamp() AS now'))
        return { rows: [{ now: new Date(clock) }] };
      assert.fail(`Unexpected SQL ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const policy = {
    resolve: async () => ({
      status: 'valid',
      campusId: campusA,
      institutionId: institution,
      identityRegionId: regionA,
      originRegionId: regionA,
      selectionId: id(13),
      topologySnapshotId: snapshot,
      relation: 'home',
      validUntil: now + 100000,
    }),
  } as unknown as CampusCommunityPolicyService;
  return {
    tx,
    calls,
    owner: new CampusRatingScopedContextFacade(policy),
    regions,
    campuses,
    assignments,
    topology,
    mutate: () => {
      changed = true;
    },
    block: () => {
      lockFailure = true;
    },
    advanceClock: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}
test('institution random includes every authorized active sibling plus independent global', async () => {
  const f = fixture();
  const p = await f.owner.resolveRandomCandidates(
    { accountId: id(10), affiliation },
    { kind: 'institution_with_global', anchorCampusId: campusA },
    f.tx,
  );
  assert.deepEqual(p.campusIds, [campusA, campusB]);
  assert.deepEqual(p.scopeKeys, [
    `campus:${campusA}`,
    `campus:${campusB}`,
    'global',
  ]);
  assert.deepEqual(p.authorization, [
    { campusId: campusA, decision: 'allow' },
    { campusId: campusB, decision: 'allow' },
  ]);
  assert.equal(p.identity?.campusId, campusA);
  assert.equal(p.view?.campusId, campusA);
  assert.equal(p.topologyState, 'complete');
  assert.equal(p.mappings.length, 3);
  assertRatingScopedCampusProof(p, f.tx);
  assert.throws(() => assertRatingScopedCampusProof({ ...p }, f.tx));
  await checkTransactionDeadlines(f.tx);
  assert(
    f.calls.some(
      (sql) => sql.startsWith('LOCK TABLE') && sql.endsWith('NOWAIT'),
    ),
  );
});
test('navigation is exact one campus, global needs no affiliation or selected identity', async () => {
  const f = fixture();
  const p = await f.owner.resolveNavigation(
    { accountId: id(10), affiliation },
    { kind: 'campus', campusId: campusA },
    f.tx,
  );
  assert.deepEqual(p.scopeKeys, [`campus:${campusA}`]);
  assert.equal(p.authorizationMode, 'ordinary');
  const empty = fixture({ missing: true });
  const g = await empty.owner.resolveNavigation(
    { accountId: id(10), affiliation: null },
    { kind: 'global' },
    empty.tx,
  );
  assert.deepEqual(g.scopeKeys, ['global']);
  assert.equal(g.identity, null);
  assert.equal(g.view, null);
  assert.equal(g.topologyState, 'unknown');
  assert.equal(g.topologySnapshotId, null);
  await checkTransactionDeadlines(empty.tx);
  await assert.rejects(() =>
    empty.owner.resolveNavigation(
      { accountId: id(10), affiliation: null },
      { kind: 'campus', campusId: campusA },
      empty.tx,
    ),
  );
});
test('physical campus phantom and zero-campus compatibility are unavailable, never truncated or vacuous', async () => {
  const phantom = fixture({ phantom: true });
  await assert.rejects(() =>
    phantom.owner.resolveRandomCandidates(
      { accountId: id(10), affiliation },
      { kind: 'institution_with_global', anchorCampusId: campusA },
      phantom.tx,
    ),
  );
  const empty = fixture({ empty: true });
  await assert.rejects(() =>
    empty.owner.resolveLegacyCompatDomain(
      { kind: 'region_compat', regionId: regionA },
      empty.tx,
    ),
  );
});
test('identity mutation and an in-flight owner writer fail final fixed capacity NOWAIT proof', async () => {
  for (const block of [false, true]) {
    const f = fixture();
    await f.owner.resolveNavigation(
      { accountId: id(10), affiliation },
      { kind: 'campus', campusId: campusA },
      f.tx,
    );
    if (block) f.block();
    else f.mutate();
    await assert.rejects(
      () => checkTransactionDeadlines(f.tx),
      (e) =>
        e instanceof ApplicationError &&
        e.code === 'IDENTITY_CAMPUS_UNAVAILABLE',
    );
  }
});
test('managed fixed region proof remains preview-only and never widens to another region', async () => {
  const f = fixture();
  const grant = {
    kind: 'fixed' as const,
    regionId: regionA,
    fingerprint: 'f'.repeat(64),
    grant: {
      id: id(50),
      role: 'school_admin' as const,
      operatingRegionId: regionA,
      validUntil: now + 100000,
    },
  };
  const p = await f.owner.resolveManagedNavigation(
    { accountId: id(10), affiliation: null },
    { kind: 'campus', campusId: campusA },
    grant,
    f.tx,
  );
  assert.equal(p.authorizationMode, 'managed_preview');
  assert.equal(p.identity, null);
  await assert.rejects(() =>
    f.owner.resolveManagedNavigation(
      { accountId: id(10), affiliation: null },
      { kind: 'campus', campusId: campusB },
      grant,
      f.tx,
    ),
  );
  await assert.rejects(() =>
    f.owner.resolveManagedNavigation(
      { accountId: id(10), affiliation: null },
      { kind: 'global' },
      grant,
      f.tx,
    ),
  );
});

test('one inaccessible institution campus rejects the aggregate without dropping that campus', async () => {
  const f = fixture({ foreign: true });
  await assert.rejects(
    () =>
      f.owner.resolveRandomCandidates(
        { accountId: id(10), affiliation },
        { kind: 'institution_with_global', anchorCampusId: campusA },
        f.tx,
      ),
    (error) =>
      error instanceof ApplicationError &&
      error.code === 'RATING_SCOPE_UNAVAILABLE',
  );
  await assert.rejects(() =>
    f.owner.resolveNavigation(
      { accountId: id(10), affiliation },
      { kind: 'campus', campusId: campusB },
      f.tx,
    ),
  );
  const global = await f.owner.resolveRandomCandidates(
    { accountId: id(10), affiliation: null },
    { kind: 'global' },
    f.tx,
  );
  assert.deepEqual(global.scopeKeys, ['global']);
});
test('related navigation keeps identity, view and origin independent', async () => {
  const f = fixture();
  const p = await f.owner.resolveNavigation(
    { accountId: id(10), affiliation },
    { kind: 'campus', campusId: campusB },
    f.tx,
  );
  assert.equal(p.identity?.campusId, campusA);
  assert.equal(p.identity?.regionId, regionA);
  assert.equal(p.view?.campusId, campusB);
  assert.equal(p.view?.regionId, regionB);
  assert.equal(p.origin?.regionId, regionA);
  assert(
    Object.isFrozen(p) &&
      Object.isFrozen(p.view) &&
      Object.isFrozen(p.mappings),
  );
  const foreignTx = fixture().tx;
  assert.throws(() => assertRatingScopedCampusProof(p, foreignTx));
  const checkpoint = checkpointTransactionDeadlines(f.tx);
  restoreTransactionDeadlines(f.tx, checkpoint);
  assert.throws(() => assertRatingScopedCampusProof(p, f.tx));
});
test('region compatibility enumerates exact current campuses and independent global never borrows them', async () => {
  const f = fixture();
  const p = await f.owner.resolveLegacyCompatDomain(
    { kind: 'region_compat', regionId: regionA },
    f.tx,
  );
  assert.deepEqual(p.campusIds, [campusA]);
  assert.deepEqual(p.scopeKeys, [`campus:${campusA}`]);
  assert.equal(p.authorizationMode, 'none');
  assert.equal(p.identity, null);
  assert.equal(p.view, null);
  const global = await f.owner.resolveLegacyCompatDomain(
    { kind: 'global_compat' },
    f.tx,
  );
  assert.deepEqual(global.campusIds, []);
  assert.deepEqual(global.scopeKeys, ['global']);
  await checkTransactionDeadlines(f.tx);
});
test('complete physical inventory rejects omissions, duplicates, inactive mismatches and unknown group policy', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.assignments.pop();
    },
    (f: ReturnType<typeof fixture>) => {
      f.topology.assignments.pop();
    },
    (f: ReturnType<typeof fixture>) => {
      f.topology.assignments.push({ ...f.topology.assignments[0]! });
    },
    (f: ReturnType<typeof fixture>) => {
      f.topology.assignments[2]!.isActive = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.topology.groups[0]!.coverage = 'missing';
    },
    (f: ReturnType<typeof fixture>) => {
      f.regions[0]!.is_active = false;
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(() =>
      f.owner.resolveNavigation(
        { accountId: id(10), affiliation },
        { kind: 'campus', campusId: campusA },
        f.tx,
      ),
    );
  }
});
test('future topology activation bounds otherwise independent unknown-global observation', async () => {
  const f = fixture({ future: true });
  const p = await f.owner.resolveNavigation(
    { accountId: id(10), affiliation: null },
    { kind: 'global' },
    f.tx,
  );
  assert.equal(p.topologyState, 'unknown');
  assert.equal(p.validUntil, now + 1000);
  f.advanceClock(1000);
  await assert.rejects(
    () => checkTransactionDeadlines(f.tx),
    (error) =>
      error instanceof ApplicationError &&
      error.code === 'IDENTITY_CAMPUS_UNAVAILABLE',
  );
});
test('institution admission supports 1000 campuses plus global and rejects 1001 without truncation', async () => {
  const f = fixture({ many: 1000 });
  const p = await f.owner.resolveRandomCandidates(
    { accountId: id(10), affiliation },
    { kind: 'institution_with_global', anchorCampusId: campusA },
    f.tx,
  );
  assert.equal(p.campusIds.length, 1000);
  assert.equal(p.scopeKeys.length, 1001);
  assert.equal(p.scopeKeys.at(-1), 'global');
  const over = fixture({ many: 1001 });
  await assert.rejects(() =>
    over.owner.resolveRandomCandidates(
      { accountId: id(10), affiliation },
      { kind: 'institution_with_global', anchorCampusId: campusA },
      over.tx,
    ),
  );
});
test('fixed grant discriminator and region payload must agree before campus mapping', async () => {
  const f = fixture();
  const grant = {
    kind: 'fixed' as const,
    regionId: regionA,
    fingerprint: 'f'.repeat(64),
    grant: {
      id: id(50),
      role: 'school_admin' as const,
      operatingRegionId: regionB,
      validUntil: now + 100000,
    },
  };
  await assert.rejects(() =>
    f.owner.resolveManagedNavigation(
      { accountId: id(10), affiliation: null },
      { kind: 'campus', campusId: campusA },
      grant,
      f.tx,
    ),
  );
});
