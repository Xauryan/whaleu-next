import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CampusCommunityPolicyService } from '../src/campus/community-policy/campus-community-policy.service.js';
import { RegionalCommunityPolicyService } from '../src/campus/community-policy/regional-community-policy.service.js';
import type {
  PolicyProvenance,
  PublicationAffiliationMetadata,
} from '../src/campus/community-policy/contracts.js';
import { parseTopology } from '../src/campus/community-policy/fact-validation.js';
import type { TopologySnapshotData } from '../src/campus/community-policy/fact-validation.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';

/** Isolated owner-unit mocks only. Real normal-AppModule evidence lives in the
 * separate disposable PostgreSQL runtime acceptance suite. */
function fixture() {
  const accountId = randomUUID(),
    institutionId = randomUUID(),
    home = randomUUID(),
    related = randomUUID(),
    foreign = randomUUID(),
    campusId = randomUUID(),
    group = randomUUID(),
    other = randomUUID(),
    topologyId = randomUUID(),
    selectionId = randomUUID();
  const affiliation: PublicationAffiliationMetadata = {
    assertionId: randomUUID(),
    snapshotId: randomUUID(),
    institutionId,
    originRegionId: home,
    validUntil: null,
  };
  const topology: TopologySnapshotData = {
    version: 1,
    groups: [group, other].map((groupId) => ({
      groupId,
      coverage: 'complete',
      isActive: true,
    })),
    regions: [home, related, foreign].map((regionId) => ({
      regionId,
      institutionId,
      groupId: regionId === foreign ? other : group,
      coverage: 'complete',
      isActive: true,
    })),
    assignments: [
      {
        campusId,
        institutionId,
        regionId: home,
        coverage: 'complete',
        isActive: true,
      },
    ],
  };
  const provenance: PolicyProvenance = {
    coverage_state: 'complete',
    provenance_state: 'accepted',
    source_reference: 'synthetic',
    policy_reference: 'synthetic-v1',
    effective_at: new Date(Date.now() - 60_000),
    expiry_kind: 'policy_exempt',
    valid_until: null,
  };
  const state = {
    now: Date.now(),
    noTopology: false,
    noSelection: false,
    topology: { id: topologyId, topology, ...provenance },
    selection: {
      id: selectionId,
      selection_state: 'selected' as 'selected' | 'selection_required',
      campus_id: campusId as string | null,
      affiliation_assertion_id: affiliation.assertionId,
      affiliation_snapshot_id: affiliation.snapshotId,
      topology_snapshot_id: topologyId,
      ...provenance,
    },
    physical: {
      institution_id: institutionId,
      operating_region_id: home,
      is_active: true,
    },
    inactive: null as string | null,
    policy: {
      id: randomUUID(),
      unverified_post_enabled: false,
      unverified_comment_enabled: true,
      unverified_categories: ['discussion', 'trading', 'unknown_imported'],
      related_sync_enabled: false,
      ...provenance,
    },
  };
  const queries: string[] = [];
  const tx = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push(sql);
      let rows: unknown[];
      if (sql.includes('community_topology_heads'))
        rows = state.noTopology
          ? []
          : [{ snapshot_id: topologyId, revision: 1 }];
      else if (sql.includes('community_topology_snapshots'))
        rows = [state.topology];
      else if (sql.includes('community_identity_heads'))
        rows = state.noSelection
          ? []
          : [{ selection_id: selectionId, revision: 1 }];
      else if (sql.includes('community_identity_selections'))
        rows = [state.selection];
      else if (sql.includes('region_policy_heads'))
        rows = [{ revision_id: state.policy.id, revision: 1 }];
      else if (sql.includes('region_policy_revisions')) rows = [state.policy];
      else if (sql.includes('whaleu_campus.campuses')) rows = [state.physical];
      else if (sql.includes('operating_regions'))
        rows = (Array.isArray(params[0]) ? params[0] : [params[0]]).map(
          (id: unknown) => ({ id, is_active: id !== state.inactive }),
        );
      else if (sql.includes('clock_timestamp'))
        rows = [{ now: new Date(state.now) }];
      else if (sql.includes('SET CONSTRAINTS')) rows = [];
      else throw new Error(sql);
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  return {
    accountId,
    affiliation,
    home,
    related,
    foreign,
    campusId,
    topology,
    state,
    tx,
    queries,
  };
}
const service = new CampusCommunityPolicyService();
const resolve = (
  f: ReturnType<typeof fixture>,
  target: string | null = f.home,
) => service.resolve(f.accountId, f.affiliation, target, f.tx);

test('campus owner knows home, related, foreign and global with same institution', async () => {
  const f = fixture();
  for (const [target, relation] of [
    [f.home, 'home'],
    [f.related, 'related'],
    [f.foreign, 'foreign'],
    [null, 'global'],
  ] as const) {
    const result = await resolve(f, target);
    assert.ok(result.status === 'valid');
    assert.equal(result.relation, relation);
  }
});
test('campus sameGroup is independent of account selection', async () => {
  const f = fixture();
  f.state.noSelection = true;
  const related = await service.sameGroup(f.home, f.related, f.tx);
  assert.ok(related.status === 'known');
  assert.equal(related.sameGroup, true);
  const foreign = await service.sameGroup(f.home, f.foreign, f.tx);
  assert.ok(foreign.status === 'known');
  assert.equal(foreign.sameGroup, false);
  assert.equal(
    f.queries.some((x) => x.includes('identity')),
    false,
  );
});
test('missing selection is unavailable; explicit current missing choice is selection_required', async () => {
  const f = fixture();
  f.state.noSelection = true;
  assert.equal((await resolve(f)).status, 'unavailable');
  f.state.noSelection = false;
  f.state.selection.selection_state = 'selection_required';
  f.state.selection.campus_id = null;
  assert.equal((await resolve(f)).status, 'selection_required');
});
test('exact verification and topology replacement invalidate old selection', async () => {
  for (const field of [
    'affiliation_assertion_id',
    'affiliation_snapshot_id',
    'topology_snapshot_id',
  ] as const) {
    const f = fixture();
    f.state.selection[field] = randomUUID();
    assert.equal((await resolve(f)).status, 'unavailable');
  }
});
test('moved, inactive or institution-mismatched physical campus never authorizes', async () => {
  for (const patch of [
    { operating_region_id: randomUUID() },
    { institution_id: randomUUID() },
    { is_active: false },
  ]) {
    const f = fixture();
    Object.assign(f.state.physical, patch);
    assert.equal((await resolve(f)).status, 'unavailable');
  }
});
test('related origin allows identity campus; same institution alone never does', async () => {
  const f = fixture();
  f.affiliation.originRegionId = f.related;
  assert.equal((await resolve(f)).status, 'valid');
  f.affiliation.originRegionId = f.foreign;
  assert.equal((await resolve(f)).status, 'unavailable');
});
test('unknown, missing and conflicting region coverage never becomes foreign', async () => {
  const f = fixture();
  assert.equal((await resolve(f, randomUUID())).status, 'unavailable');
  for (const coverage of ['missing', 'conflicting'] as const) {
    f.topology.regions[1]!.coverage = coverage;
    assert.equal((await resolve(f, f.related)).status, 'unavailable');
  }
});
test('duplicate region, assignment or group rejects malformed topology', () => {
  const f = fixture();
  for (const key of ['groups', 'regions', 'assignments'] as const) {
    const candidate = {
      ...f.topology,
      [key]: [...f.topology[key], f.topology[key][0]!],
    };
    assert.equal(parseTopology(candidate), null);
  }
});
test('unknown, expired and future policy provenance are unavailable', async () => {
  for (const patch of [
    { provenance_state: 'unknown' },
    { expiry_kind: 'unknown' },
    { effective_at: new Date(Date.now() + 60_000) },
    { expiry_kind: 'at', valid_until: new Date(Date.now() - 1) },
  ]) {
    const f = fixture();
    Object.assign(f.state.topology, patch);
    assert.equal((await resolve(f)).status, 'unavailable');
  }
});
test('explicit disabled switch is known; unsupported categories never grant writes', async () => {
  const f = fixture();
  const result = await new RegionalCommunityPolicyService().resolve(
    f.home,
    f.tx,
  );
  assert.ok(result.status === 'known');
  assert.equal(result.unverifiedPostEnabled, false);
  assert.equal(result.unverifiedCommentEnabled, true);
  assert.deepEqual(result.unverifiedCategories, ['discussion']);
  assert.equal(result.relatedSyncEnabled, false);
});
test('selection deadline is registered for final post-deferred-wait validation', async () => {
  const f = fixture();
  f.state.selection.expiry_kind = 'at';
  f.state.selection.valid_until = new Date(f.state.now + 1000);
  startTransactionDeadlines(f.tx);
  assert.equal((await resolve(f)).status, 'valid');
  f.state.now += 1001;
  await assert.rejects(
    () => checkTransactionDeadlines(f.tx),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'COMMUNITY_UNAVAILABLE',
  );
  assert.equal(f.queries.at(-2), 'SET CONSTRAINTS ALL IMMEDIATE');
});
test('inactive target and empty topology remain unavailable', async () => {
  const f = fixture();
  f.state.inactive = f.foreign;
  assert.equal((await resolve(f, f.foreign)).status, 'unavailable');
  f.state.noTopology = true;
  assert.equal(
    (await service.sameGroup(f.home, f.related, f.tx)).status,
    'unavailable',
  );
});
test('malformed non-Date timestamps and PostgreSQL infinity resolve unavailable', async () => {
  for (const malformed of [
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    'future',
    new Date(Number.NaN),
  ]) {
    const f = fixture();
    Object.assign(f.state.topology, { effective_at: malformed });
    assert.equal((await resolve(f)).status, 'unavailable');
    Object.assign(f.state.topology, {
      effective_at: new Date(f.state.now - 60_000),
      expiry_kind: 'at',
      valid_until: malformed,
    });
    assert.equal((await resolve(f)).status, 'unavailable');
  }
});
