import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CampusRatingCategoryScopeFacade } from '../src/campus/rating-category-scope.facade.js';
import type { TopologySnapshotData } from '../src/campus/community-policy/fact-validation.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
function fixture() {
  const institutionId = randomUUID(),
    groupId = randomUUID(),
    regionId = randomUUID(),
    otherRegionId = randomUUID();
  const campusIds = [randomUUID(), randomUUID()].sort(),
    otherCampusId = randomUUID();
  const topology: TopologySnapshotData = {
    version: 1,
    groups: [{ groupId, coverage: 'complete', isActive: true }],
    regions: [regionId, otherRegionId].map((regionId) => ({
      regionId,
      institutionId,
      groupId,
      coverage: 'complete',
      isActive: true,
    })),
    assignments: [
      ...campusIds.map((campusId) => ({
        campusId,
        institutionId,
        regionId,
        coverage: 'complete' as const,
        isActive: true,
      })),
      {
        campusId: otherCampusId,
        institutionId,
        regionId: otherRegionId,
        coverage: 'complete',
        isActive: true,
      },
    ],
  };
  const state = {
    now: Date.parse('2026-10-09T00:00:00Z'),
    fenceConflict: false,
    statements: [] as string[],
    snapshot: {
      id: randomUUID(),
      revision: 1,
      valid: true,
      topology,
      valid_until: null as Date | null,
      precise_until: null as string | null,
      effective_at: '2026-10-08 00:00:00+00',
    },
    institutions: [{ id: institutionId, state_version: '1' }],
    regions: [regionId, otherRegionId]
      .sort()
      .map((id) => ({ id, is_active: true, state_version: '1' })),
    campuses: [...campusIds, otherCampusId].sort().map((id) => ({
      id,
      institution_id: institutionId,
      is_active: true,
      state_version: '1',
    })),
    assignments: topology.assignments
      .map((row) => ({
        campus_id: row.campusId,
        operating_region_id: row.regionId,
        state_version: '1',
      }))
      .sort((a, b) => a.campus_id.localeCompare(b.campus_id)),
  };
  const tx = {
    async query(sql: string) {
      state.statements.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '5s',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.startsWith('LOCK TABLE')) {
        if (state.fenceConflict) throw new Error('55P03');
        return { rows: [] };
      }
      if (
        sql.startsWith('SELECT set_config') ||
        sql.startsWith('SET CONSTRAINTS')
      )
        return { rows: [] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(state.now) }] };
      if (sql.includes('WITH instant AS MATERIALIZED'))
        return { rows: [structuredClone(state.snapshot)] };
      if (sql.includes("WHERE scope_key='community' FOR SHARE"))
        return { rows: [{ snapshot_id: state.snapshot.id }] };
      if (sql.includes('FROM whaleu_campus.operating_regions'))
        return { rows: structuredClone(state.regions) };
      if (sql.includes('FROM whaleu_campus.institutions'))
        return { rows: structuredClone(state.institutions) };
      if (sql.includes('FROM whaleu_campus.campuses'))
        return { rows: structuredClone(state.campuses) };
      if (sql.includes('FROM whaleu_campus.campus_region_assignments'))
        return { rows: structuredClone(state.assignments) };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    state,
    tx,
    topology,
    institutionId,
    regionId,
    otherRegionId,
    campusIds,
    otherCampusId,
  };
}
const unavailable = (error: unknown) =>
  error instanceof ApplicationError &&
  error.code === 'IDENTITY_CAMPUS_UNAVAILABLE';
test('category scope uses every exact canonical campus and never aliases region/institution IDs', async () => {
  const f = fixture();
  try {
    const facade = new CampusRatingCategoryScopeFacade(),
      local = await facade.scope(f.regionId, f.tx);
    assert.deepEqual(local.campusIds, f.campusIds);
    assert.deepEqual(local.regions, [
      { regionId: f.regionId, campusIds: f.campusIds },
    ]);
    const global = await facade.scope(null, f.tx);
    assert.deepEqual(
      global.campusIds,
      [...f.campusIds, f.otherCampusId].sort(),
    );
    assert.equal(global.regions.length, 2);
    await checkTransactionDeadlines(f.tx);
    const statements = f.state.statements.slice(
      f.state.statements.indexOf('SET CONSTRAINTS ALL IMMEDIATE'),
    );
    assert.ok(
      statements.some(
        (sql) =>
          sql.startsWith('LOCK TABLE whaleu_campus.community_topology_heads') &&
          sql.endsWith('IN SHARE MODE NOWAIT'),
      ),
    );
    assert.equal(
      statements.some((sql) => /FOR (SHARE|UPDATE)/.test(sql)),
      false,
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('category scope rejects unknown, incomplete and contradictory physical/source mappings', async (t) => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      'unknown provenance',
      (f) => {
        f.state.snapshot.valid = false;
      },
    ],
    [
      'source duplicate campus',
      (f) => {
        f.topology.assignments.push({ ...f.topology.assignments[0]! });
      },
    ],
    [
      'physical missing campus',
      (f) => {
        f.state.campuses = f.state.campuses.filter(
          (row) => row.id !== f.campusIds[0],
        );
      },
    ],
    [
      'unknown active campus',
      (f) => {
        f.state.campuses.push({
          id: randomUUID(),
          institution_id: f.institutionId,
          is_active: true,
          state_version: '2',
        });
      },
    ],
    [
      'moved campus not revised source',
      (f) => {
        f.state.assignments.find(
          (row) => row.campus_id === f.campusIds[0],
        )!.operating_region_id = f.otherRegionId;
      },
    ],
    [
      'false institution mapping',
      (f) => {
        f.topology.assignments[0]!.institutionId = randomUUID();
      },
    ],
    [
      'conflicting campus',
      (f) => {
        f.topology.assignments[0]!.coverage = 'conflicting';
      },
    ],
    [
      'missing full region group',
      (f) => {
        f.topology.groups = [];
      },
    ],
    [
      'undeclared active physical region',
      (f) => {
        f.state.regions.push({
          id: randomUUID(),
          is_active: true,
          state_version: '2',
        });
      },
    ],
    [
      'empty campus inventory',
      (f) => {
        f.state.campuses = [];
        f.state.assignments = [];
        f.topology.assignments = [];
      },
    ],
    [
      'budget overflow',
      (f) => {
        f.state.campuses = Array.from({ length: 1001 }, () => ({
          id: randomUUID(),
          institution_id: f.institutionId,
          is_active: true,
          state_version: '2',
        }));
      },
    ],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, async () => {
      const f = fixture();
      try {
        mutate(f);
        await assert.rejects(
          new CampusRatingCategoryScopeFacade().scope(null, f.tx),
          unavailable,
        );
      } finally {
        clearTransactionDeadlines(f.tx);
      }
    });
});
test('category scope retains final exact source, inventory phantom, NOWAIT fence and expiry proof', async (t) => {
  for (const mode of [
    'topology',
    'physical',
    'phantom',
    'fence',
    'deadline',
  ] as const)
    await t.test(mode, async () => {
      const f = fixture();
      try {
        if (mode === 'deadline') {
          f.state.snapshot.valid_until = new Date(f.state.now + 100);
          f.state.snapshot.precise_until =
            f.state.snapshot.valid_until.toISOString();
        }
        await new CampusRatingCategoryScopeFacade().scope(null, f.tx);
        if (mode === 'topology') f.state.snapshot.id = randomUUID();
        if (mode === 'physical') f.state.assignments[0]!.state_version = '2';
        if (mode === 'phantom')
          f.state.campuses.push({
            id: randomUUID(),
            institution_id: f.institutionId,
            is_active: true,
            state_version: '3',
          });
        if (mode === 'fence') f.state.fenceConflict = true;
        if (mode === 'deadline') f.state.now += 101;
        await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
      } finally {
        clearTransactionDeadlines(f.tx);
      }
    });
});
