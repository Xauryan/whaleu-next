import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
export async function lockOrganization(
  id: string,
  tx: PoolClient,
  write = true,
) {
  await tx.query(
    `SELECT pg_advisory_xact_lock${write ? '' : '_shared'}(hashtextextended('whaleu:organization:v1:'||$1,0))`,
    [id],
  );
}
interface Fact {
  kind: 'organization' | 'account' | 'epoch';
  id: string;
  fingerprint: string;
}
async function state(kind: Fact['kind'], id: string, tx: PoolClient) {
  if (kind === 'epoch')
    return ownerFingerprint(
      (
        await tx.query(
          'SELECT revision FROM whaleu_organizations.native_directory_epoch WHERE singleton',
        )
      ).rows,
    );
  if (kind === 'organization')
    return ownerFingerprint(
      (
        await tx.query(
          `SELECT to_jsonb(o) org,o.xmin::text ov,
 (SELECT jsonb_agg(jsonb_build_object('id',g.id,'account',g.account_id,'role',g.role,'from',g.valid_from,'until',g.expires_at,'version',g.version,'source',g.source_event_id,'xmin',g.xmin::text) ORDER BY g.id) FROM whaleu_organizations.organization_grants g WHERE g.organization_id=o.id AND g.revoked_at IS NULL) grants,
 (SELECT jsonb_agg(jsonb_build_object('account',p.account_id,'id',p.public_id,'nickname',p.nickname,'version',p.xmin::text) ORDER BY p.account_id) FROM whaleu_profile.profiles p WHERE p.account_id IN (SELECT account_id FROM whaleu_organizations.organization_grants WHERE organization_id=o.id AND revoked_at IS NULL)) profiles
 FROM whaleu_organizations.organizations o WHERE o.id=$1`,
          [id],
        )
      ).rows,
    );
  // Metadata and versions only: never copy phone values or student numbers.
  return ownerFingerprint(
    (
      await tx.query(
        `SELECT a.id,a.status,a.xmin::text av,
 h.snapshot_id,h.xmin::text hv,s.xmin::text sv,ph.id phone,ph.xmin::text pv,af.id affiliation,af.xmin::text fv,
 to_jsonb(sh) safety,sh.xmin::text safety_version,
 ch.selection_id,ch.revision selection_revision,ch.xmin::text chv,cs.xmin::text csv,
 th.snapshot_id topology,th.revision topology_revision,th.xmin::text thv,ts.xmin::text tsv,
 c.id campus,c.xmin::text cv,i.xmin::text iv,ca.xmin::text cav,r.xmin::text rv,
 (SELECT jsonb_agg(jsonb_build_object('id',g.id,'role',g.role,'region',g.operating_region_id,'from',g.valid_from,'until',g.expires_at,'revoked',g.revoked_at,'version',g.xmin::text) ORDER BY g.id) FROM whaleu_authorization.role_grants g WHERE g.account_id=a.id) grants
 FROM whaleu_identity.accounts a
 LEFT JOIN whaleu_verification.account_heads h ON h.account_id=a.id LEFT JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id
 LEFT JOIN whaleu_verification.assertions ph ON ph.id=s.phone_assertion_id LEFT JOIN whaleu_verification.assertions af ON af.id=s.affiliation_assertion_id
 LEFT JOIN whaleu_safety.account_heads sh ON sh.account_id=a.id
 LEFT JOIN whaleu_campus.community_identity_heads ch ON ch.account_id=a.id LEFT JOIN whaleu_campus.community_identity_selections cs ON cs.id=ch.selection_id
 LEFT JOIN whaleu_campus.community_topology_heads th ON th.scope_key='community' LEFT JOIN whaleu_campus.community_topology_snapshots ts ON ts.id=th.snapshot_id
 LEFT JOIN whaleu_campus.campuses c ON c.id=cs.campus_id LEFT JOIN whaleu_campus.institutions i ON i.id=c.institution_id LEFT JOIN whaleu_campus.campus_region_assignments ca ON ca.campus_id=c.id LEFT JOIN whaleu_campus.operating_regions r ON r.id=ca.operating_region_id
 WHERE a.id=$1`,
        [id],
      )
    ).rows,
  );
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 96,
  failureCode: 'ORGANIZATION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'ORGANIZATION_UNAVAILABLE', async (read) => {
      if (facts.some((f) => f.kind === 'account'))
        await read.query(
          'LOCK TABLE whaleu_identity.accounts,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,whaleu_safety.account_heads,whaleu_authorization.role_grants,whaleu_campus.community_identity_heads,whaleu_campus.community_identity_selections,whaleu_campus.community_topology_heads,whaleu_campus.community_topology_snapshots,whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions IN SHARE MODE NOWAIT',
        );
      if (facts.some((f) => f.kind === 'organization'))
        await read.query(
          'LOCK TABLE whaleu_organizations.organizations,whaleu_organizations.organization_events,whaleu_organizations.organization_grants,whaleu_profile.profiles IN SHARE MODE NOWAIT',
        );
      if (facts.some((f) => f.kind === 'epoch'))
        await read.query(
          'LOCK TABLE whaleu_organizations.native_directory_epoch IN SHARE MODE NOWAIT',
        );
      for (const f of facts)
        if ((await state(f.kind, f.id, read)) !== f.fingerprint)
          throw new ApplicationError('ORGANIZATION_UNAVAILABLE');
    }),
};
async function retain(kind: Fact['kind'], id: string, tx: PoolClient) {
  enableRequiredTransactionProof(tx, proof);
  const fingerprint = await state(kind, id, tx);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${kind}:${id}:${fingerprint}`,
    Object.freeze({ kind, id, fingerprint }),
  );
}
export const requireOrganizationCurrent = (id: string, tx: PoolClient) =>
  retain('organization', id, tx);
export const requireOrganizationAccountCurrent = (id: string, tx: PoolClient) =>
  retain('account', id, tx);
export const requireOrganizationDirectoryCurrent = (tx: PoolClient) =>
  retain('epoch', 'native', tx);
