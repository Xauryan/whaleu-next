import type { PoolClient } from 'pg';
import { IdentityService } from '../identity/identity.service.js';
import type { SessionView } from '../identity/contracts.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { SafetyRepository } from '../safety/repository.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { ApplicationError } from '../http/application-error.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { officialDigest } from './profile.js';

export type OfficialAction =
  'manage' | 'preview' | 'test' | 'manual_create' | 'publish' | 'daily_draft';
export interface OfficialProgram {
  id: string;
  account_ref: string;
  institution_id: string;
  school_space_id: string;
  city_space_id: string | null;
  region_ids: string[];
  revision: string;
  account_revision: string;
  destination_ref: string;
  label: string;
}
const authorityBrand = Symbol('official-operation-authority');
export interface OfficialAuthority {
  readonly [authorityBrand]: true;
  readonly program: OfficialProgram;
  readonly principalRef: string;
  readonly action: OfficialAction;
  readonly digest: string;
  readonly until: number;
}
interface AuthorityFact {
  programId: string;
  principal: string;
  kind: 'account' | 'service';
  action: OfficialAction;
  digest: string;
}
async function authorityState(
  fact: Omit<AuthorityFact, 'digest'>,
  tx: PoolClient,
) {
  const program = (
    await tx.query(
      `SELECT to_jsonb(p) program,p.xmin::text pv,to_jsonb(a) account,a.xmin::text av FROM whaleu_official.programs p JOIN whaleu_official.accounts a ON a.id=p.account_ref WHERE p.id=$1`,
      [fact.programId],
    )
  ).rows;
  const capabilities = (
    await tx.query(
      `SELECT to_jsonb(c) capability,c.xmin::text cv FROM whaleu_official.capabilities c WHERE program_id=$1 AND principal_ref=$2 AND principal_kind=$3 AND action IN($4,'city_source') ORDER BY id`,
      [fact.programId, fact.principal, fact.kind, fact.action],
    )
  ).rows;
  const topology = (
    await tx.query(
      `SELECT c.id,c.is_active,c.institution_id,a.operating_region_id,r.is_active region_active FROM whaleu_campus.campuses c LEFT JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id LEFT JOIN whaleu_campus.operating_regions r ON r.id=a.operating_region_id WHERE c.institution_id=(SELECT institution_id FROM whaleu_official.programs WHERE id=$1) ORDER BY c.id LIMIT 129`,
      [fact.programId],
    )
  ).rows;
  const spaces = (
    await tx.query(
      `SELECT to_jsonb(s) space,s.xmin::text version FROM whaleu_community.spaces s JOIN whaleu_official.programs p ON s.id=p.school_space_id OR s.id=p.city_space_id WHERE p.id=$1 ORDER BY s.id`,
      [fact.programId],
    )
  ).rows;
  return officialDigest({ program, capabilities, topology, spaces });
}
const authorityProof: RequiredTransactionProof<AuthorityFact> = {
  maximumFacts: 8,
  failureCode: 'OFFICIAL_ACCOUNT_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'OFFICIAL_ACCOUNT_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_official.programs,whaleu_official.accounts,whaleu_official.capabilities,whaleu_campus.campuses,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions,whaleu_community.spaces IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if ((await authorityState(fact, read)) !== fact.digest)
          throw new ApplicationError('OFFICIAL_ACCOUNT_UNAVAILABLE');
    }),
};
export class OfficialOperationAuthority {
  constructor(
    private readonly identity: IdentityService,
    private readonly authorization: AuthorizationService,
    private readonly safety: SafetyRepository,
  ) {}
  authenticate(token: string, tx: PoolClient): Promise<SessionView> {
    return this.identity.session(token, tx);
  }
  async requireManual(
    session: SessionView,
    programId: string,
    action: Exclude<OfficialAction, 'daily_draft'>,
    tx: PoolClient,
  ): Promise<OfficialAuthority> {
    await lockSafetyPolicy(tx);
    if (!(await this.identity.activeAccount(session.accountId, tx)))
      throw new ApplicationError('AUTHENTICATION_REQUIRED');
    await this.safety.restriction(session.accountId, tx);
    const result = await this.requireRegistry(
      session.accountId,
      'account',
      programId,
      action,
      tx,
    );
    const grants = await this.authorization.grants(session.accountId, tx);
    const global = grants.find(
      (g) => g.role === 'super_admin' && g.operatingRegionId === null,
    );
    if (global)
      registerTransactionDeadline(
        tx,
        global.validUntil,
        'OFFICIAL_AUTHORITY_REQUIRED',
      );
    else {
      if (['test', 'manual_create', 'publish'].includes(action))
        throw new ApplicationError('OFFICIAL_AUTHORITY_REQUIRED');
      const fixed = grants.filter(
        (g) => g.role === 'school_admin' && g.operatingRegionId !== null,
      );
      if (
        fixed.length !== 1 ||
        result.program.region_ids.some((r) => r !== fixed[0]!.operatingRegionId)
      )
        throw new ApplicationError('OFFICIAL_AUTHORITY_REQUIRED');
      registerTransactionDeadline(
        tx,
        fixed[0]!.validUntil,
        'OFFICIAL_AUTHORITY_REQUIRED',
      );
    }
    return result;
  }
  async requireService(
    principal: string,
    programId: string,
    tx: PoolClient,
  ): Promise<OfficialAuthority> {
    return this.requireRegistry(
      principal,
      'service',
      programId,
      'daily_draft',
      tx,
    );
  }
  private async requireRegistry(
    principal: string,
    kind: 'account' | 'service',
    programId: string,
    action: OfficialAction,
    tx: PoolClient,
  ): Promise<OfficialAuthority> {
    const program = (
      await tx.query<OfficialProgram>(
        `SELECT p.id,p.account_ref,p.institution_id,p.school_space_id,p.city_space_id,p.region_ids,p.revision,a.revision account_revision,a.destination_ref,a.label FROM whaleu_official.programs p JOIN whaleu_official.accounts a ON a.id=p.account_ref WHERE p.id=$1 AND p.revoked_at IS NULL AND a.revoked_at IS NULL AND a.profile='synthetic-official-v1' FOR SHARE OF p,a`,
        [programId],
      )
    ).rows[0];
    if (!program) throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
    const regions = (
      await tx.query<{ operating_region_id: string | null; active: boolean }>(
        `SELECT a.operating_region_id,(c.is_active AND COALESCE(r.is_active,false)) active FROM whaleu_campus.campuses c LEFT JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id LEFT JOIN whaleu_campus.operating_regions r ON r.id=a.operating_region_id WHERE c.institution_id=$1 LIMIT 129`,
        [program.institution_id],
      )
    ).rows;
    if (
      !regions.length ||
      regions.length > 128 ||
      regions.some((r) => !r.operating_region_id || !r.active) ||
      JSON.stringify(
        [...new Set(regions.map((r) => r.operating_region_id!))].sort(),
      ) !== JSON.stringify([...program.region_ids].sort())
    )
      throw new ApplicationError('OFFICIAL_ACCOUNT_UNAVAILABLE');
    const sourceSpaces = (
      await tx.query<{
        id: string;
        kind: string;
        operating_region_id: string | null;
        is_active: boolean;
      }>(
        'SELECT id,kind,operating_region_id,is_active FROM whaleu_community.spaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [
          [
            program.school_space_id,
            ...(program.city_space_id ? [program.city_space_id] : []),
          ],
        ],
      )
    ).rows;
    const school = sourceSpaces.find((s) => s.id === program.school_space_id),
      citySpace = sourceSpaces.find((s) => s.id === program.city_space_id);
    if (
      !school?.is_active ||
      school.kind !== 'regional' ||
      !school.operating_region_id ||
      !program.region_ids.includes(school.operating_region_id) ||
      (program.city_space_id &&
        (!citySpace?.is_active ||
          citySpace.kind !== 'global' ||
          citySpace.operating_region_id !== null ||
          citySpace.id === school.id))
    )
      throw new ApplicationError('OFFICIAL_ACCOUNT_UNAVAILABLE');
    const caps = (
      await tx.query<{
        action: string;
        expires_at: Date;
        region_ids: string[];
      }>(
        `SELECT action,expires_at,region_ids FROM whaleu_official.capabilities WHERE account_ref=$1 AND program_id=$2 AND principal_ref=$3 AND principal_kind=$4 AND action IN($5,'city_source') AND revoked_at IS NULL AND valid_from<=clock_timestamp() AND expires_at>clock_timestamp() ORDER BY id FOR SHARE`,
        [program.account_ref, programId, principal, kind, action],
      )
    ).rows;
    const eligible = caps.filter(
      (c) =>
        JSON.stringify([...c.region_ids].sort()) ===
        JSON.stringify([...program.region_ids].sort()),
    );
    const cap = eligible.find((c) => c.action === action);
    const city = eligible.find((c) => c.action === 'city_source');
    if (
      !cap ||
      (program.city_space_id &&
        ['preview', 'daily_draft'].includes(action) &&
        !city)
    )
      throw new ApplicationError('OFFICIAL_AUTHORITY_REQUIRED');
    const until = Math.min(
      cap.expires_at.getTime(),
      city?.expires_at.getTime() ?? Infinity,
    );
    registerTransactionDeadline(tx, until, 'OFFICIAL_AUTHORITY_REQUIRED');
    const fact = { programId, principal, kind, action };
    const digest = await authorityState(fact, tx);
    enableRequiredTransactionProof(tx, authorityProof);
    registerRequiredTransactionFact(tx, authorityProof, JSON.stringify(fact), {
      ...fact,
      digest,
    });
    return Object.freeze({
      [authorityBrand]: true as const,
      program,
      principalRef: principal,
      action,
      digest,
      until,
    });
  }
}
