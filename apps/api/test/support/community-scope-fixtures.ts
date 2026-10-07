/** Disposable integration facts only. No runtime provider, seed, CLI or route. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PublicationAffiliationMetadata } from '../../src/campus/community-policy/contracts.js';
import type { TopologySnapshotData } from '../../src/campus/community-policy/fact-validation.js';
import {
  inTransaction,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';

export interface CommunityScopeFixture {
  institutionId: string;
  topologySnapshotId: string;
  topology: TopologySnapshotData;
  home: { campusId: string; regionId: string; spaceId: string };
  related: { campusId: string; regionId: string; spaceId: string };
  foreign: { campusId: string; regionId: string; spaceId: string };
  global: { spaceId: string };
}
export interface ScopeFactPatch {
  coverageState?: 'complete' | 'missing' | 'conflicting';
  provenanceState?: 'accepted' | 'unknown' | 'conflicting';
  effectiveAt?: Date;
  validUntil?: number | null;
}
export interface RegionPolicyPatch extends ScopeFactPatch {
  unverifiedPostEnabled?: boolean;
  unverifiedCommentEnabled?: boolean;
  unverifiedCategories?: string[];
  relatedSyncEnabled?: boolean;
}

/** Refuse non-disposable/non-loopback databases before any test mutation. */
export async function withCommunityScopeWriter<T>(
  pool: Pool,
  operation: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction(pool, async (tx) => {
    // Check the connection this Pool actually opened, not a separately supplied
    // environment URL. A container's inet_server_addr() may be its bridge IP
    // even when this client connects through an explicitly loopback-published port.
    const peer = (
      tx as PoolClient & {
        connection?: { stream?: { remoteAddress?: string } };
      }
    ).connection?.stream?.remoteAddress;
    assert.ok(
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(tx.host) &&
        peer !== undefined &&
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer),
      'Scope fixtures require an actual loopback TCP connection',
    );
    const database = (
      await tx.query<{
        database: string;
        version: number;
      }>(
        `SELECT current_database() AS database,
         current_setting('server_version_num')::integer AS version`,
      )
    ).rows[0]!;
    assert.equal(
      database.database,
      'whaleu_test',
      'Scope fixtures require the disposable whaleu_test database',
    );
    assert.ok(
      supportedPostgresVersion(database.version),
      'Scope fixtures require PostgreSQL 18.6+ (18.x)',
    );
    // Required FIRST policy/authority lock for every canonical fixture writer.
    await lockSafetyPolicy(tx, true);
    return operation(tx);
  });
}

function validity(patch: ScopeFactPatch) {
  return [
    patch.coverageState ?? 'complete',
    patch.provenanceState ?? 'accepted',
    patch.effectiveAt ?? new Date(Date.now() - 60_000),
    patch.validUntil == null ? 'policy_exempt' : 'at',
    patch.validUntil == null ? null : new Date(patch.validUntil),
  ];
}

async function appendTopology(
  tx: PoolClient,
  topology: TopologySnapshotData,
  patch: ScopeFactPatch = {},
) {
  await tx.query(
    "INSERT INTO whaleu_campus.community_topology_heads(scope_key) VALUES ('community') ON CONFLICT DO NOTHING",
  );
  const head = (
    await tx.query<{ revision: number }>(
      "SELECT revision FROM whaleu_campus.community_topology_heads WHERE scope_key='community' FOR UPDATE",
    )
  ).rows[0]!;
  const id = randomUUID();
  const revision = head.revision + 1;
  await tx.query(
    `INSERT INTO whaleu_campus.community_topology_snapshots
       (id,revision,topology,coverage_state,provenance_state,effective_at,expiry_kind,valid_until,source_reference,policy_reference)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,'synthetic-community-topology','synthetic-community-policy-v1')`,
    [id, revision, JSON.stringify(topology), ...validity(patch)],
  );
  await tx.query(
    "UPDATE whaleu_campus.community_topology_heads SET revision=$1,snapshot_id=$2 WHERE scope_key='community'",
    [revision, id],
  );
  return id;
}

/** Same institution deliberately does not imply the same school-subject group. */
export async function seedCommunityScope(
  pool: Pool,
): Promise<CommunityScopeFixture> {
  return withCommunityScopeWriter(pool, async (tx) => {
    const institutionId = randomUUID();
    const entry = () => ({
      campusId: randomUUID(),
      regionId: randomUUID(),
      spaceId: randomUUID(),
    });
    const home = entry(),
      related = entry(),
      foreign = entry();
    const global = { spaceId: randomUUID() };
    const groupId = randomUUID(),
      foreignGroupId = randomUUID();
    await tx.query(
      'INSERT INTO whaleu_campus.institutions(id,name) VALUES($1,$2)',
      [institutionId, 'Synthetic community institution'],
    );
    for (const [name, location] of [
      ['home', home],
      ['related', related],
      ['foreign', foreign],
    ] as const) {
      await tx.query(
        'INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,$2,true)',
        [location.regionId, `Synthetic ${name} region`],
      );
      await tx.query(
        "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES($1,$2,$3,'synthetic',true)",
        [location.campusId, institutionId, `Synthetic ${name} campus`],
      );
      await tx.query(
        'INSERT INTO whaleu_campus.campus_region_assignments(campus_id,operating_region_id) VALUES($1,$2)',
        [location.campusId, location.regionId],
      );
      await tx.query(
        "INSERT INTO whaleu_community.spaces(id,kind,operating_region_id,name,is_active) VALUES($1,'regional',$2,$3,true)",
        [location.spaceId, location.regionId, `Synthetic ${name} community`],
      );
    }
    await tx.query(
      "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic global community',true)",
      [global.spaceId],
    );
    const topology: TopologySnapshotData = {
      version: 1,
      groups: [groupId, foreignGroupId].map((id) => ({
        groupId: id,
        coverage: 'complete',
        isActive: true,
      })),
      regions: [home, related, foreign].map((location) => ({
        regionId: location.regionId,
        institutionId,
        groupId: location === foreign ? foreignGroupId : groupId,
        coverage: 'complete',
        isActive: true,
      })),
      assignments: [home, related, foreign].map((location) => ({
        campusId: location.campusId,
        institutionId,
        regionId: location.regionId,
        coverage: 'complete',
        isActive: true,
      })),
    };
    const topologySnapshotId = await appendTopology(tx, topology);
    return {
      institutionId,
      topologySnapshotId,
      topology,
      home,
      related,
      foreign,
      global,
    };
  });
}

export async function appendTopologyRevision(
  pool: Pool,
  topology: TopologySnapshotData,
  patch: ScopeFactPatch = {},
): Promise<string> {
  return withCommunityScopeWriter(pool, (tx) =>
    appendTopology(tx, topology, patch),
  );
}

export async function appendIdentitySelection(
  pool: Pool,
  accountId: string,
  affiliation: PublicationAffiliationMetadata,
  scope: Pick<CommunityScopeFixture, 'topologySnapshotId' | 'home'>,
  campusId: string | null = scope.home.campusId,
  selectionState: 'selected' | 'selection_required' = 'selected',
  patch: ScopeFactPatch = {},
): Promise<string> {
  return withCommunityScopeWriter(pool, async (tx) => {
    await tx.query(
      "SELECT revision FROM whaleu_campus.community_topology_heads WHERE scope_key='community' FOR UPDATE",
    );
    await tx.query(
      'INSERT INTO whaleu_campus.community_identity_heads(account_id) VALUES($1) ON CONFLICT DO NOTHING',
      [accountId],
    );
    const head = (
      await tx.query<{ revision: number }>(
        'SELECT revision FROM whaleu_campus.community_identity_heads WHERE account_id=$1 FOR UPDATE',
        [accountId],
      )
    ).rows[0]!;
    const id = randomUUID(),
      revision = head.revision + 1;
    await tx.query(
      `INSERT INTO whaleu_campus.community_identity_selections
        (id,account_id,revision,selection_state,campus_id,affiliation_assertion_id,affiliation_snapshot_id,topology_snapshot_id,
         coverage_state,provenance_state,effective_at,expiry_kind,valid_until,source_reference,policy_reference)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'synthetic-identity-selection','synthetic-community-policy-v1')`,
      [
        id,
        accountId,
        revision,
        selectionState,
        selectionState === 'selection_required' ? null : campusId,
        affiliation.assertionId,
        affiliation.snapshotId,
        scope.topologySnapshotId,
        ...validity(patch),
      ],
    );
    await tx.query(
      'UPDATE whaleu_campus.community_identity_heads SET revision=$2,selection_id=$3 WHERE account_id=$1',
      [accountId, revision, id],
    );
    return id;
  });
}

export async function setRegionPolicy(
  pool: Pool,
  regionId: string,
  patch: RegionPolicyPatch = {},
): Promise<string> {
  return withCommunityScopeWriter(pool, async (tx) => {
    await tx.query(
      'SELECT id FROM whaleu_campus.operating_regions WHERE id=$1 FOR UPDATE',
      [regionId],
    );
    await tx.query(
      'INSERT INTO whaleu_community.region_policy_heads(region_id) VALUES($1) ON CONFLICT DO NOTHING',
      [regionId],
    );
    const head = (
      await tx.query<{ revision: number; revision_id: string | null }>(
        'SELECT revision,revision_id FROM whaleu_community.region_policy_heads WHERE region_id=$1 FOR UPDATE',
        [regionId],
      )
    ).rows[0]!;
    const previous = head.revision_id
      ? (
          await tx.query<{
            unverified_post_enabled: boolean;
            unverified_comment_enabled: boolean;
            unverified_categories: string[];
            related_sync_enabled: boolean;
          }>(
            'SELECT unverified_post_enabled,unverified_comment_enabled,unverified_categories,related_sync_enabled FROM whaleu_community.region_policy_revisions WHERE id=$1',
            [head.revision_id],
          )
        ).rows[0]
      : undefined;
    const id = randomUUID(),
      revision = head.revision + 1;
    await tx.query(
      `INSERT INTO whaleu_community.region_policy_revisions
        (id,region_id,revision,unverified_post_enabled,unverified_comment_enabled,unverified_categories,related_sync_enabled,
         coverage_state,provenance_state,effective_at,expiry_kind,valid_until,source_reference,policy_reference)
       VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11,$12,'synthetic-region-policy','synthetic-community-policy-v1')`,
      [
        id,
        regionId,
        revision,
        patch.unverifiedPostEnabled ??
          previous?.unverified_post_enabled ??
          false,
        patch.unverifiedCommentEnabled ??
          previous?.unverified_comment_enabled ??
          false,
        patch.unverifiedCategories ?? previous?.unverified_categories ?? [],
        patch.relatedSyncEnabled ?? previous?.related_sync_enabled ?? false,
        ...validity(patch),
      ],
    );
    await tx.query(
      'UPDATE whaleu_community.region_policy_heads SET revision=$2,revision_id=$3 WHERE region_id=$1',
      [regionId, revision, id],
    );
    return id;
  });
}
