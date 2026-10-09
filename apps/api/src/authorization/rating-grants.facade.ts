import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import type { ActiveGrant } from './contracts.js';
interface GrantCaptureRow {
  id: string;
  role: ActiveGrant['role'] | null;
  operatingRegionId: string | null;
  expiresAt: Date | null;
  validFrom: Date | null;
  preciseFrom: string | null;
  isFuture: boolean;
}
interface Fact {
  accountId: string;
  fingerprint: string;
}
/** One statement/instant is essential: separate active/future reads can both
 * miss a scheduled grant when its activation occurs between their clocks. */
async function capture(accountId: string, tx: PoolClient) {
  const rows = (
    await tx.query<GrantCaptureRow>(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),
     active AS MATERIALIZED (
       SELECT id,role,operating_region_id,expires_at
       FROM whaleu_authorization.role_grants CROSS JOIN instant
       WHERE account_id=$1 AND revoked_at IS NULL AND valid_from<=instant.now
         AND (expires_at IS NULL OR expires_at>instant.now)
       ORDER BY id LIMIT 4
     ), future AS MATERIALIZED (
       SELECT id,valid_from FROM whaleu_authorization.role_grants CROSS JOIN instant
       WHERE account_id=$1 AND revoked_at IS NULL AND valid_from>instant.now
       ORDER BY valid_from,id LIMIT 1
     )
     SELECT id,role,operating_region_id AS "operatingRegionId",expires_at AS "expiresAt",
       NULL::timestamptz AS "validFrom",NULL::text AS "preciseFrom",false AS "isFuture" FROM active
     UNION ALL
     SELECT id,NULL::text,NULL::uuid,NULL::timestamptz,valid_from,valid_from::text,true FROM future
     ORDER BY "isFuture",id`,
      [accountId],
    )
  ).rows;
  const active = rows.filter((row) => row.isFuture === false);
  const future = rows.filter((row) => row.isFuture === true);
  if (
    active.length > 3 ||
    future.length > 1 ||
    active.length + future.length !== rows.length ||
    active.some(
      (g) =>
        !(
          (g.role === 'school_admin' && g.operatingRegionId !== null) ||
          ((g.role === 'developer' || g.role === 'super_admin') &&
            g.operatingRegionId === null)
        ),
    )
  )
    throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
  const grants: ActiveGrant[] = active.map(
    ({ id, role, operatingRegionId, expiresAt }) => ({
      id,
      role: role!,
      operatingRegionId,
      validUntil: expiresAt?.getTime() ?? null,
    }),
  );
  const upcoming = future[0];
  if (
    upcoming &&
    (!(upcoming.validFrom instanceof Date) ||
      !Number.isFinite(upcoming.validFrom.getTime()) ||
      typeof upcoming.preciseFrom !== 'string')
  )
    throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
  const next = upcoming
    ? {
        id: upcoming.id,
        validFrom: upcoming.validFrom!,
        preciseFrom: upcoming.preciseFrom!,
      }
    : null;
  return { grants, next };
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 4,
  failureCode: 'AUTHORIZATION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'AUTHORIZATION_UNAVAILABLE', async (source) => {
      await source.query(
        'LOCK TABLE whaleu_authorization.role_grants IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if (
          ownerFingerprint(await capture(fact.accountId, source)) !==
          fact.fingerprint
        )
          throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
    }),
};
export type RatingGrantScope =
  | { kind: 'ordinary'; fingerprint: string }
  | { kind: 'global'; grant: ActiveGrant; fingerprint: string }
  | {
      kind: 'fixed';
      grant: ActiveGrant;
      regionId: string;
      fingerprint: string;
    };
export function ratingGrantScope(
  grants: readonly ActiveGrant[],
  fingerprint: string,
): RatingGrantScope {
  const schools = grants.filter((g) => g.role === 'school_admin');
  if (schools.length > 1)
    throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
  const global =
    grants.find(
      (g) => g.role === 'developer' && g.operatingRegionId === null,
    ) ??
    grants.find(
      (g) => g.role === 'super_admin' && g.operatingRegionId === null,
    );
  if (global) return { kind: 'global', grant: global, fingerprint };
  if (schools[0])
    return {
      kind: 'fixed',
      grant: schools[0],
      regionId: schools[0].operatingRegionId!,
      fingerprint,
    };
  return { kind: 'ordinary', fingerprint };
}
/** Exact active grants, including proof of absence. Never a chosen region. */
@Injectable()
export class RatingAuthorizationFacade {
  async scope(accountId: string, tx: PoolClient): Promise<RatingGrantScope> {
    enableRequiredTransactionProof(tx, proof);
    const locked = await tx.query(
      `SELECT id FROM whaleu_authorization.role_grants WHERE account_id=$1 AND revoked_at IS NULL AND valid_from<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY id LIMIT 4 FOR SHARE`,
      [accountId],
    );
    if (locked.rows.length > 3)
      throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
    const observed = await capture(accountId, tx),
      fingerprint = ownerFingerprint(observed);
    registerRequiredTransactionFact(
      tx,
      proof,
      `${accountId}:${fingerprint}`,
      Object.freeze({ accountId, fingerprint }),
    );
    registerTransactionDeadline(
      tx,
      observed.next?.validFrom.getTime() ?? null,
      'AUTHORIZATION_UNAVAILABLE',
    );
    const result = ratingGrantScope(observed.grants, fingerprint);
    if (result.kind !== 'ordinary')
      registerTransactionDeadline(
        tx,
        result.grant.validUntil,
        'AUTHORIZATION_UNAVAILABLE',
      );
    return result;
  }
}
