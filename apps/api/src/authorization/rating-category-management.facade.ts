import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { resolveRatingCategoryManagementInventory } from '../campus/rating-scoped-context.facade.js';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';

export const RATING_CATEGORY_MANAGEMENT_CAMPUS_GRANT_LIMIT = 1000;
const id = z.uuid().refine((value) => value === value.toLowerCase());
declare const authorityBrand: unique symbol;
/** Category-only authority. Exact-campus grants never become ActiveGrant,
 * school_admin, identity-view authority, or ordinary publication authority. */
export interface RatingCategoryManagementAuthority {
  readonly [authorityBrand]: true;
  readonly accountId: string;
  readonly global: boolean;
  readonly regionIds: readonly string[];
  readonly exactCampusIds: readonly string[];
  /** Current active physical campuses covered by the union of real grants. */
  readonly campusIds: readonly string[];
  readonly inventoryFingerprint: string;
  readonly fingerprint: string;
  readonly validUntil: number | null;
}
interface CaptureRow {
  source: 'role' | 'campus';
  id: string;
  role: 'developer' | 'super_admin' | 'school_admin' | null;
  regionId: string | null;
  campusId: string | null;
  approvedByAccountId: string;
  approvalReference: string;
  validFrom: Date;
  preciseFrom: string;
  expiresAt: Date | null;
  preciseUntil: string | null;
  isFuture: boolean;
  valid: boolean;
}
const handles = new WeakMap<object, { tx: PoolClient; epoch: object }>();
function unavailable(): never {
  throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function assertRatingCategoryManagementAuthority(
  authority: RatingCategoryManagementAuthority,
  tx: PoolClient,
): void {
  const handle = handles.get(authority);
  if (!handle || handle.tx !== tx || handle.epoch !== transactionReadEpoch(tx))
    unavailable();
}
/** No any-of: every affected physical campus is required, including removals.
 * An empty campus list only denotes the independent global domain when the
 * caller explicitly requests global authority. */
export function requireRatingCategoryManagementAuthority(
  authority: RatingCategoryManagementAuthority,
  exactCampusIds: readonly string[],
  globalRequired: boolean,
  tx: PoolClient,
): void {
  assertRatingCategoryManagementAuthority(authority, tx);
  if (
    typeof globalRequired !== 'boolean' ||
    !Array.isArray(exactCampusIds) ||
    exactCampusIds.length > 1000 ||
    new Set(exactCampusIds).size !== exactCampusIds.length ||
    exactCampusIds.some((campusId) => !id.safeParse(campusId).success) ||
    (!globalRequired && exactCampusIds.length === 0)
  )
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  if (
    (globalRequired && !authority.global) ||
    exactCampusIds.some((campusId) => !authority.campusIds.includes(campusId))
  )
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
/** The same statement captures active authority and the next possible change.
 * In particular, an empty active set is a bounded absence fact, not permission. */
async function capture(
  accountId: string,
  tx: PoolClient,
): Promise<CaptureRow[]> {
  const rows = (
    await tx.query<CaptureRow>(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),
      role_active AS MATERIALIZED (
        SELECT 'role'::text source,id,role,operating_region_id region_id,NULL::uuid campus_id,
          approved_by_account_id,approval_reference,valid_from,expires_at,false is_future
        FROM whaleu_authorization.role_grants CROSS JOIN instant
        WHERE account_id=$1 AND revoked_at IS NULL AND valid_from<=instant.now
          AND (expires_at IS NULL OR expires_at>instant.now) ORDER BY id LIMIT 4
      ), campus_active AS MATERIALIZED (
        SELECT 'campus'::text source,id,NULL::text role,NULL::uuid region_id,campus_id,
          approved_by_account_id,approval_reference,valid_from,expires_at,false is_future
        FROM whaleu_authorization.rating_category_campus_grants CROSS JOIN instant
        WHERE account_id=$1 AND revoked_at IS NULL AND valid_from<=instant.now
          AND (expires_at IS NULL OR expires_at>instant.now) ORDER BY id LIMIT 1001
      ), future AS MATERIALIZED (
        SELECT * FROM (
          SELECT 'role'::text source,id,role,operating_region_id region_id,NULL::uuid campus_id,
            approved_by_account_id,approval_reference,valid_from,expires_at,true is_future
          FROM whaleu_authorization.role_grants CROSS JOIN instant
          WHERE account_id=$1 AND revoked_at IS NULL AND valid_from>instant.now
          UNION ALL
          SELECT 'campus'::text source,id,NULL::text role,NULL::uuid region_id,campus_id,
            approved_by_account_id,approval_reference,valid_from,expires_at,true is_future
          FROM whaleu_authorization.rating_category_campus_grants CROSS JOIN instant
          WHERE account_id=$1 AND revoked_at IS NULL AND valid_from>instant.now
        ) f ORDER BY valid_from,source,id LIMIT 1
      ), captured AS MATERIALIZED (
        SELECT * FROM role_active UNION ALL SELECT * FROM campus_active UNION ALL SELECT * FROM future
      ) SELECT source,id,role,region_id AS "regionId",campus_id AS "campusId",
        approved_by_account_id AS "approvedByAccountId",approval_reference AS "approvalReference",
        valid_from AS "validFrom",valid_from::text AS "preciseFrom",
        expires_at AS "expiresAt",expires_at::text AS "preciseUntil",is_future AS "isFuture",
        (isfinite(valid_from) AND (expires_at IS NULL OR (isfinite(expires_at) AND expires_at>valid_from))) valid
      FROM captured ORDER BY is_future,source,id`,
      [accountId],
    )
  ).rows;
  const active = rows.filter((row) => row.isFuture === false);
  if (
    active.filter((row) => row.source === 'role').length > 3 ||
    active.filter((row) => row.source === 'campus').length >
      RATING_CATEGORY_MANAGEMENT_CAMPUS_GRANT_LIMIT ||
    rows.filter((row) => row.isFuture === true).length > 1 ||
    rows.some(
      (row) =>
        !id.safeParse(row.id).success ||
        !id.safeParse(row.approvedByAccountId).success ||
        typeof row.approvalReference !== 'string' ||
        row.approvalReference.trim().length === 0 ||
        row.approvalReference.length > 200 ||
        !(row.validFrom instanceof Date) ||
        !Number.isFinite(row.validFrom.getTime()) ||
        typeof row.preciseFrom !== 'string' ||
        row.preciseFrom.length === 0 ||
        (row.expiresAt !== null &&
          (!(row.expiresAt instanceof Date) ||
            !Number.isFinite(row.expiresAt.getTime()) ||
            typeof row.preciseUntil !== 'string')) ||
        (row.expiresAt === null && row.preciseUntil !== null) ||
        typeof row.isFuture !== 'boolean' ||
        row.valid !== true ||
        !(row.source === 'campus'
          ? row.role === null &&
            row.regionId === null &&
            id.safeParse(row.campusId).success
          : row.source === 'role' &&
            row.campusId === null &&
            ((row.role === 'school_admin' &&
              id.safeParse(row.regionId).success) ||
              ((row.role === 'developer' || row.role === 'super_admin') &&
                row.regionId === null))),
    ) ||
    new Set(rows.map((row) => `${row.source}:${row.id}`)).size !==
      rows.length ||
    new Set(
      active.filter((row) => row.source === 'role').map((row) => row.role),
    ).size !== active.filter((row) => row.source === 'role').length ||
    new Set(
      active
        .filter((row) => row.source === 'campus')
        .map((row) => row.campusId),
    ).size !== active.filter((row) => row.source === 'campus').length
  )
    unavailable();
  return rows;
}
const proof: RequiredTransactionProof<{
  accountId: string;
  fingerprint: string;
}> = {
  maximumFacts: 4,
  failureCode: 'AUTHORIZATION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'AUTHORIZATION_UNAVAILABLE', async (read) => {
      // These real owner tables are the fence: inserts, revocations, deletes and
      // future activations cannot evade an epoch on a Ratings-owned table.
      await read.query(
        'LOCK TABLE whaleu_authorization.role_grants,whaleu_authorization.rating_category_campus_grants IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if (
          ownerFingerprint(await capture(fact.accountId, read)) !==
          fact.fingerprint
        )
          unavailable();
    }),
};
@Injectable()
export class RatingCategoryManagementAuthorityFacade {
  async resolve(
    accountId: string,
    tx: PoolClient,
  ): Promise<RatingCategoryManagementAuthority> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch || !id.safeParse(accountId).success) unavailable();
    enableRequiredTransactionProof(tx, proof);
    // Lock all unrevoked bounded facts first, then use a fresh common instant.
    // Final table fences also cover phantoms and a completely empty account.
    for (const [table, limit] of [
      ['role_grants', 4],
      ['rating_category_campus_grants', 1001],
    ] as const) {
      const locked = await tx.query(
        `SELECT id FROM whaleu_authorization.${table} WHERE account_id=$1 AND revoked_at IS NULL ORDER BY id LIMIT ${limit} FOR SHARE`,
        [accountId],
      );
      if (locked.rows.length >= limit) unavailable();
    }
    const rows = await capture(accountId, tx);
    const fingerprint = ownerFingerprint(rows);
    registerRequiredTransactionFact(
      tx,
      proof,
      `${accountId}:${fingerprint}`,
      Object.freeze({ accountId, fingerprint }),
    );
    const active = rows.filter((row) => !row.isFuture);
    const global = active.some(
      (row) =>
        row.source === 'role' &&
        (row.role === 'developer' || row.role === 'super_admin'),
    );
    const regionIds = active
      .filter((row) => row.source === 'role' && row.role === 'school_admin')
      .map((row) => row.regionId!)
      .sort();
    const exactCampusIds = active
      .filter((row) => row.source === 'campus')
      .map((row) => row.campusId!)
      .sort();
    const deadlines = rows.flatMap((row) =>
      row.isFuture
        ? [row.validFrom.getTime()]
        : row.expiresAt
          ? [row.expiresAt.getTime()]
          : [],
    );
    const grantValidUntil = deadlines.length ? Math.min(...deadlines) : null;
    registerTransactionDeadline(
      tx,
      grantValidUntil,
      'AUTHORIZATION_UNAVAILABLE',
    );
    const inventory = await resolveRatingCategoryManagementInventory(tx);
    const campusIds = inventory.mappings
      .filter(
        (mapping) =>
          mapping.isActive &&
          (global ||
            regionIds.includes(mapping.regionId) ||
            exactCampusIds.includes(mapping.campusId)),
      )
      .map((mapping) => mapping.campusId)
      .sort();
    const validUntil =
      grantValidUntil === null
        ? inventory.validUntil
        : inventory.validUntil === null
          ? grantValidUntil
          : Math.min(grantValidUntil, inventory.validUntil);
    const value = {
      accountId,
      global,
      regionIds,
      exactCampusIds,
      campusIds,
      inventoryFingerprint: inventory.fingerprint,
      validUntil,
      fingerprint: ownerFingerprint([
        'rating-category-management-authority:v1',
        accountId,
        fingerprint,
        inventory.fingerprint,
        campusIds,
      ]),
    };
    if (transactionReadEpoch(tx) !== epoch) unavailable();
    const result = freeze(
      value,
    ) as unknown as RatingCategoryManagementAuthority;
    handles.set(result, { tx, epoch });
    return result;
  }
  require(
    authority: RatingCategoryManagementAuthority,
    exactCampusIds: readonly string[],
    globalRequired: boolean,
    tx: PoolClient,
  ): void {
    requireRatingCategoryManagementAuthority(
      authority,
      exactCampusIds,
      globalRequired,
      tx,
    );
  }
}
