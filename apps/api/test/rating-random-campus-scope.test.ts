import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  CampusRatingRandomScopeFacade,
  RATING_RANDOM_SCOPE_CAMPUS_LIMIT,
  RATING_RANDOM_SCOPE_REGION_LIMIT,
} from '../src/campus/rating-random-scope.facade.js';
import type { TopologySnapshotData } from '../src/campus/community-policy/fact-validation.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  checkTransactionDeadlines,
  clearTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

const instant = Date.parse('2026-10-09T12:00:00.123Z');
function fixture() {
  const institutionId = randomUUID(),
    otherInstitutionId = randomUUID();
  const topology: TopologySnapshotData = {
    version: 1,
    groups: [],
    regions: [],
    assignments: [],
  };
  const state = {
    now: instant,
    fenceConflict: false,
    statements: [] as string[],
    snapshot: {
      id: randomUUID(),
      revision: 1,
      valid: true,
      valid_until: null as Date | null,
      effective_at: '2026-10-09 11:00:00+00',
      precise_until: null as string | null,
      topology,
    },
    campuses: [] as {
      id: string;
      institution_id: string;
      is_active: boolean;
      state_version: string;
    }[],
    regions: [] as { id: string; is_active: boolean; state_version: string }[],
    assignments: [] as {
      campus_id: string;
      operating_region_id: string;
      state_version: string;
    }[],
    institutions: [
      { id: institutionId, state_version: '10' },
      { id: otherInstitutionId, state_version: '11' },
    ],
  };
  function addCampus(institution = institutionId, active = true) {
    const campusId = randomUUID(),
      regionId = randomUUID(),
      groupId = randomUUID();
    topology.groups.push({ groupId, coverage: 'complete', isActive: active });
    topology.regions.push({
      regionId,
      institutionId: institution,
      groupId,
      coverage: 'complete',
      isActive: active,
    });
    topology.assignments.push({
      campusId,
      institutionId: institution,
      regionId,
      coverage: 'complete',
      isActive: active,
    });
    state.campuses.push({
      id: campusId,
      institution_id: institution,
      is_active: active,
      state_version: '12',
    });
    state.regions.push({
      id: regionId,
      is_active: active,
      state_version: '13',
    });
    state.assignments.push({
      campus_id: campusId,
      operating_region_id: regionId,
      state_version: '14',
    });
    return { campusId, regionId, groupId };
  }
  const selected = addCampus(),
    sibling = addCampus(),
    foreign = addCampus(otherInstitutionId);
  const tx = {
    async query(sql: string, values: unknown[] = []) {
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
      if (sql.includes('FROM whaleu_campus.campuses')) {
        const [institution, ids] = values as [string, string[]];
        return {
          rows: structuredClone(
            state.campuses
              .filter(
                (r) => r.institution_id === institution || ids.includes(r.id),
              )
              .sort((a, b) => a.id.localeCompare(b.id)),
          ),
        };
      }
      if (sql.includes('FROM whaleu_campus.campus_region_assignments')) {
        const [ids] = values as [string[]];
        return {
          rows: structuredClone(
            state.assignments
              .filter((r) => ids.includes(r.campus_id))
              .sort((a, b) => a.campus_id.localeCompare(b.campus_id)),
          ),
        };
      }
      if (sql.includes('FROM whaleu_campus.operating_regions')) {
        const [ids] = values as [string[]];
        return {
          rows: structuredClone(
            state.regions
              .filter((r) => ids.includes(r.id))
              .sort((a, b) => a.id.localeCompare(b.id)),
          ),
        };
      }
      if (sql.includes('FROM whaleu_campus.institutions'))
        return {
          rows: structuredClone(
            state.institutions.filter((r) => r.id === values[0]),
          ),
        };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    state,
    tx,
    selected,
    sibling,
    foreign,
    institutionId,
    otherInstitutionId,
    addCampus,
    topology,
  };
}
const unavailable = (error: unknown) =>
  error instanceof ApplicationError &&
  error.code === 'IDENTITY_CAMPUS_UNAVAILABLE';

test('native random scope includes all same-institution groups, deduplicates regions and excludes other institutions', async () => {
  const f = fixture();
  // A sibling campus can share an explicitly reviewed operating region.
  const shared = f.addCampus();
  f.topology.assignments.find((r) => r.campusId === shared.campusId)!.regionId =
    f.sibling.regionId;
  f.state.assignments.find(
    (r) => r.campus_id === shared.campusId,
  )!.operating_region_id = f.sibling.regionId;
  f.topology.regions = f.topology.regions.filter(
    (r) => r.regionId !== shared.regionId,
  );
  f.state.regions = f.state.regions.filter((r) => r.id !== shared.regionId);
  const inactive = f.addCampus(f.institutionId, false);
  try {
    const result = await new CampusRatingRandomScopeFacade().resolve(
      f.selected.campusId,
      f.tx,
    );
    assert.equal(result.institutionId, f.institutionId);
    assert.deepEqual(
      result.regionIds,
      [f.selected.regionId, f.sibling.regionId].sort(),
    );
    assert.equal(result.regionIds.includes(f.foreign.regionId), false);
    assert.equal(result.regionIds.includes(inactive.regionId), false);
    await checkTransactionDeadlines(f.tx);
    const final = f.state.statements.slice(
      f.state.statements.indexOf('SET CONSTRAINTS ALL IMMEDIATE'),
    );
    const fence = final.find((sql) => sql.startsWith('LOCK TABLE'))!;
    for (const table of [
      'community_topology_heads',
      'community_topology_snapshots',
      'operating_regions',
      'institutions',
      'campuses',
      'campus_region_assignments',
    ])
      assert.ok(fence.includes(`whaleu_campus.${table}`));
    assert.ok(fence.endsWith('IN SHARE MODE NOWAIT'));
    assert.equal(
      final.some((sql) => /FOR (SHARE|UPDATE)/.test(sql)),
      false,
    );
    const exact = final.find((sql) =>
      sql.includes('WITH instant AS MATERIALIZED'),
    )!;
    assert.ok(exact.includes('s.effective_at<=instant.now'));
    assert.ok(exact.includes('s.valid_until>instant.now'));
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('scope refuses incomplete, conflicting, noncanonical and physically unreconciled inventory', async (t) => {
  const changes: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      'unaccepted/current source',
      (f) => {
        f.state.snapshot.valid = false;
      },
    ],
    [
      'missing institution',
      (f) => {
        f.state.institutions = [];
      },
    ],
    [
      'missing selected campus',
      (f) => {
        f.state.campuses = f.state.campuses.filter(
          (r) => r.id !== f.selected.campusId,
        );
      },
    ],
    [
      'inactive selected campus',
      (f) => {
        f.state.campuses[0]!.is_active = false;
      },
    ],
    [
      'unreviewed active sibling',
      (f) => {
        f.state.campuses.push({
          id: randomUUID(),
          institution_id: f.institutionId,
          is_active: true,
          state_version: '20',
        });
      },
    ],
    [
      'removed snapshot sibling',
      (f) => {
        f.state.campuses = f.state.campuses.filter(
          (r) => r.id !== f.sibling.campusId,
        );
      },
    ],
    [
      'foreign physical sibling',
      (f) => {
        f.state.campuses[1]!.institution_id = f.otherInstitutionId;
      },
    ],
    [
      'missing physical assignment',
      (f) => {
        f.state.assignments = f.state.assignments.filter(
          (r) => r.campus_id !== f.sibling.campusId,
        );
      },
    ],
    [
      'remapped physical assignment',
      (f) => {
        f.state.assignments[1]!.operating_region_id = f.foreign.regionId;
      },
    ],
    [
      'inactive physical region',
      (f) => {
        f.state.regions[1]!.is_active = false;
      },
    ],
    [
      'missing physical region',
      (f) => {
        f.state.regions = f.state.regions.filter(
          (r) => r.id !== f.sibling.regionId,
        );
      },
    ],
    [
      'incomplete assignment',
      (f) => {
        f.topology.assignments[1]!.coverage = 'missing';
      },
    ],
    [
      'incomplete sibling group',
      (f) => {
        f.topology.groups[1]!.coverage = 'missing';
      },
    ],
    [
      'inactive sibling group',
      (f) => {
        f.topology.groups[1]!.isActive = false;
      },
    ],
    [
      'conflicting sibling region',
      (f) => {
        f.topology.regions[1]!.coverage = 'conflicting';
      },
    ],
    [
      'foreign reviewed assignment',
      (f) => {
        f.topology.assignments[1]!.institutionId = f.otherInstitutionId;
      },
    ],
    [
      'duplicate assignment',
      (f) => {
        f.topology.assignments.push({ ...f.topology.assignments[1]! });
      },
    ],
    [
      'inactive declared row missing physically',
      (f) => {
        const inactive = f.addCampus(f.institutionId, false);
        f.state.campuses = f.state.campuses.filter(
          (r) => r.id !== inactive.campusId,
        );
      },
    ],
    [
      'orphan incomplete institution region',
      (f) => {
        f.topology.regions.push({
          ...f.topology.regions[1]!,
          regionId: randomUUID(),
          coverage: 'missing',
        });
      },
    ],
  ];
  for (const [label, change] of changes)
    await t.test(label, async () => {
      const f = fixture();
      try {
        change(f);
        await assert.rejects(
          new CampusRatingRandomScopeFacade().resolve(
            f.selected.campusId,
            f.tx,
          ),
          unavailable,
        );
      } finally {
        clearTransactionDeadlines(f.tx);
      }
    });
});

test('known inactive omitted inventory is allowed, unknown topology outside the institution is ignored', async () => {
  const f = fixture();
  f.state.campuses.push({
    id: randomUUID(),
    institution_id: f.institutionId,
    is_active: false,
    state_version: '20',
  });
  f.topology.groups.find((r) => r.groupId === f.foreign.groupId)!.coverage =
    'missing';
  f.topology.regions.find((r) => r.regionId === f.foreign.regionId)!.coverage =
    'missing';
  try {
    const result = await new CampusRatingRandomScopeFacade().resolve(
      f.selected.campusId,
      f.tx,
    );
    assert.deepEqual(
      result.regionIds,
      [f.selected.regionId, f.sibling.regionId].sort(),
    );
    await checkTransactionDeadlines(f.tx);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('accepted orphan region does not expand the active physical campus pool', async () => {
  const f = fixture(),
    orphan = f.addCampus();
  f.topology.assignments = f.topology.assignments.filter(
    (r) => r.campusId !== orphan.campusId,
  );
  f.state.campuses = f.state.campuses.filter((r) => r.id !== orphan.campusId);
  f.state.assignments = f.state.assignments.filter(
    (r) => r.campus_id !== orphan.campusId,
  );
  try {
    const result = await new CampusRatingRandomScopeFacade().resolve(
      f.selected.campusId,
      f.tx,
    );
    assert.deepEqual(
      result.regionIds,
      [f.selected.regionId, f.sibling.regionId].sort(),
    );
    assert.equal(result.regionIds.includes(orphan.regionId), false);
    await checkTransactionDeadlines(f.tx);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('an inactive physical campus does not add its otherwise active reviewed region', async () => {
  const f = fixture(),
    inactive = f.addCampus();
  f.state.campuses.find((row) => row.id === inactive.campusId)!.is_active =
    false;
  f.topology.assignments.find(
    (row) => row.campusId === inactive.campusId,
  )!.isActive = false;
  try {
    const result = await new CampusRatingRandomScopeFacade().resolve(
      f.selected.campusId,
      f.tx,
    );
    assert.deepEqual(
      result.regionIds,
      [f.selected.regionId, f.sibling.regionId].sort(),
    );
    assert.equal(result.regionIds.includes(inactive.regionId), false);
    await checkTransactionDeadlines(f.tx);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('final proof rejects new physical inventory, ABA row versions, head replacement, expiry and fence conflicts', async (t) => {
  const changes: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      'new active campus',
      (f) => {
        f.state.campuses.push({
          id: randomUUID(),
          institution_id: f.institutionId,
          is_active: true,
          state_version: '20',
        });
      },
    ],
    [
      'new inactive campus changes complete inventory',
      (f) => {
        f.state.campuses.push({
          id: randomUUID(),
          institution_id: f.institutionId,
          is_active: false,
          state_version: '20',
        });
      },
    ],
    [
      'campus changed and restored',
      (f) => {
        f.state.campuses[1]!.state_version = '25';
      },
    ],
    [
      'assignment changed and restored',
      (f) => {
        f.state.assignments[1]!.state_version = '25';
      },
    ],
    [
      'region changed and restored',
      (f) => {
        f.state.regions[1]!.state_version = '25';
      },
    ],
    [
      'institution changed and restored',
      (f) => {
        f.state.institutions[0]!.state_version = '25';
      },
    ],
    [
      'equivalent new topology head',
      (f) => {
        f.state.snapshot.id = randomUUID();
        f.state.snapshot.revision++;
      },
    ],
    [
      'expired exact source',
      (f) => {
        f.state.snapshot.valid = false;
      },
    ],
    [
      'later transaction expiry',
      (f) => {
        f.state.now = instant + 1;
      },
    ],
    [
      'conflicting source table writer',
      (f) => {
        f.state.fenceConflict = true;
      },
    ],
  ];
  for (const [label, change] of changes)
    await t.test(label, async () => {
      const f = fixture();
      f.state.snapshot.valid_until = new Date(instant + 1);
      f.state.snapshot.precise_until = '2026-10-09 12:00:00.124+00';
      try {
        await new CampusRatingRandomScopeFacade().resolve(
          f.selected.campusId,
          f.tx,
        );
        change(f);
        await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
      } finally {
        clearTransactionDeadlines(f.tx);
      }
    });
});

test('scope admission bounds and invalid native IDs fail closed, never truncate', async () => {
  for (const mode of ['campuses', 'regions', 'uppercase', 'legacy'] as const) {
    const f = fixture();
    let campusId: string = f.selected.campusId;
    if (mode === 'campuses') {
      while (
        f.state.campuses.filter((r) => r.institution_id === f.institutionId)
          .length <= RATING_RANDOM_SCOPE_CAMPUS_LIMIT
      )
        f.state.campuses.push({
          id: randomUUID(),
          institution_id: f.institutionId,
          is_active: false,
          state_version: '20',
        });
    }
    if (mode === 'regions') {
      while (
        f.topology.regions.filter((r) => r.institutionId === f.institutionId)
          .length <= RATING_RANDOM_SCOPE_REGION_LIMIT
      )
        f.topology.regions.push({
          ...f.topology.regions[0]!,
          regionId: randomUUID(),
        });
    }
    if (mode === 'uppercase') campusId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    if (mode === 'legacy') campusId = '10001';
    try {
      await assert.rejects(
        new CampusRatingRandomScopeFacade().resolve(campusId, f.tx),
        unavailable,
      );
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});
