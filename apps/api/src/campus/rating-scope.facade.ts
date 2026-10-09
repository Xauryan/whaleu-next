import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
  requiredOwnerEpoch,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { campusCountProofOwner } from './count-epochs.js';
import { CampusCommunityPolicyService } from './community-policy/campus-community-policy.service.js';
import type { PublicationAffiliationMetadata } from './community-policy/contracts.js';
import { readTopology } from './community-policy/records.js';
import {
  parseTopology,
  knownRegion,
} from './community-policy/fact-validation.js';
const navigation = requiredOwnerEpoch(
  campusCountProofOwner,
  'IDENTITY_CAMPUS_UNAVAILABLE',
);
interface Fact {
  accountId: string;
  selectionId: string;
  topologyId: string;
}
const currentPredicate = (a: string) =>
  `${a}.coverage_state='complete' AND ${a}.provenance_state='accepted' AND length(btrim(${a}.source_reference))>0 AND length(btrim(${a}.policy_reference))>0 AND isfinite(${a}.effective_at) AND ${a}.effective_at<=instant.now AND ((${a}.expiry_kind='policy_exempt' AND ${a}.valid_until IS NULL) OR (${a}.expiry_kind='at' AND isfinite(${a}.valid_until) AND ${a}.valid_until>${a}.effective_at AND ${a}.valid_until>instant.now))`;
async function exact(f: Fact, tx: PoolClient) {
  return (
    (
      await tx.query<{ valid: boolean }>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT coalesce(${currentPredicate('s')} AND ${currentPredicate('t')},false) valid FROM whaleu_campus.community_identity_heads h JOIN whaleu_campus.community_identity_selections s ON s.id=h.selection_id AND s.account_id=h.account_id AND s.revision=h.revision JOIN whaleu_campus.community_topology_heads th ON th.scope_key='community' JOIN whaleu_campus.community_topology_snapshots t ON t.id=th.snapshot_id AND t.revision=th.revision CROSS JOIN instant WHERE h.account_id=$1 AND s.id=$2 AND t.id=$3 AND s.topology_snapshot_id=t.id`,
        [f.accountId, f.selectionId, f.topologyId],
      )
    ).rows[0]?.valid === true
  );
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 4,
  failureCode: 'IDENTITY_CAMPUS_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'IDENTITY_CAMPUS_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_campus.community_identity_heads,whaleu_campus.community_topology_heads,whaleu_campus.community_identity_selections,whaleu_campus.community_topology_snapshots IN SHARE MODE NOWAIT',
      );
      for (const f of facts)
        if (!(await exact(f, read)))
          throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    }),
};
const regionSchema = z.strictObject({
  id: z.uuid(),
  label: z.string().refine(
    (s) =>
      s.trim() === s &&
      s.length > 0 &&
      [...s].length <= 200 &&
      [...s].every((c) => {
        const n = c.codePointAt(0)!;
        return (
          n >= 32 && !(n >= 127 && n <= 159) && !(n >= 0xd800 && n <= 0xdfff)
        );
      }),
  ),
  active: z.boolean(),
});
type Region = { id: string; label: string };
export interface RatingRegionContext {
  homeRegion: Region | null;
  regions: (Region & { relation: 'home' | 'related' | 'managed' })[];
  fingerprint: string;
}
/** Current authentication group, never a browser-selected campus/region. */
@Injectable()
export class CampusRatingScopeFacade {
  constructor(
    @Inject(CampusCommunityPolicyService)
    private readonly policy: CampusCommunityPolicyService,
  ) {}
  private async regions(ids: readonly string[] | null, tx: PoolClient) {
    if (ids && ids.length > 200)
      throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    const epoch = await navigation(tx);
    const rows = (
      await tx.query<{ id: string; label: string; active: boolean }>(
        `SELECT id,name label,is_active active FROM whaleu_campus.operating_regions ${ids ? 'WHERE id=ANY($1::uuid[])' : ''} ORDER BY id LIMIT 201 FOR SHARE`,
        ids ? [ids] : [],
      )
    ).rows;
    if (
      rows.length > 200 ||
      (ids && rows.length !== new Set(ids).size) ||
      rows.some((r) => !regionSchema.safeParse(r).success)
    )
      throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    return { rows, fingerprint: ownerFingerprint([epoch, rows]) };
  }
  async managed(
    regionId: string | null,
    tx: PoolClient,
  ): Promise<RatingRegionContext> {
    const result = await this.regions(regionId ? [regionId] : null, tx);
    if (regionId && !result.rows[0]?.active)
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const regions = result.rows
      .filter((r) => r.active)
      .map(({ id, label }) => ({ id, label, relation: 'managed' as const }));
    return { homeRegion: null, regions, fingerprint: result.fingerprint };
  }
  async requireManaged(regionId: string, tx: PoolClient): Promise<string> {
    return (await this.managed(regionId, tx)).fingerprint;
  }
  async ordinary(
    accountId: string,
    affiliation: PublicationAffiliationMetadata,
    regionId: string | null,
    tx: PoolClient,
  ): Promise<RatingRegionContext> {
    enableRequiredTransactionProof(tx, proof);
    const scope = await this.policy.resolve(
      accountId,
      affiliation,
      regionId,
      tx,
    );
    if (scope.status === 'selection_required')
      throw new ApplicationError('IDENTITY_CAMPUS_REQUIRED');
    if (scope.status !== 'valid')
      throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    const fact = Object.freeze({
      accountId,
      selectionId: scope.selectionId,
      topologyId: scope.topologySnapshotId,
    });
    if (!(await exact(fact, tx)))
      throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    registerRequiredTransactionFact(
      tx,
      proof,
      `${accountId}:${scope.selectionId}:${scope.topologySnapshotId}`,
      fact,
    );
    if (scope.relation === 'foreign')
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const snapshot = await readTopology(tx),
      topology = snapshot && parseTopology(snapshot.topology);
    if (!snapshot || snapshot.id !== scope.topologySnapshotId || !topology)
      throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    const home = knownRegion(topology, scope.identityRegionId);
    if (!home) throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    const ids = [...topology.regions.values()]
      .filter(
        (r) => r.groupId === home.groupId && knownRegion(topology, r.regionId),
      )
      .map((r) => r.regionId)
      .sort();
    const result = await this.regions(ids, tx);
    const regions = result.rows
      .filter((r) => r.active)
      .map(({ id, label }) => ({
        id,
        label,
        relation:
          id === home.regionId ? ('home' as const) : ('related' as const),
      }));
    const homeRegion = regions.find((r) => r.id === home.regionId);
    if (!homeRegion || (regionId && !regions.some((r) => r.id === regionId)))
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    return {
      homeRegion: { id: homeRegion.id, label: homeRegion.label },
      regions,
      fingerprint: ownerFingerprint([
        affiliation.assertionId,
        affiliation.snapshotId,
        fact,
        result.fingerprint,
      ]),
    };
  }
}
