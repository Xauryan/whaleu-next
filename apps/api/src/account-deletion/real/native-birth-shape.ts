import type { PoolClient } from 'pg';
import { z } from 'zod';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import { ApplicationError } from '../../http/application-error.js';

const scopeSchema = z.strictObject({
  accountId: z.uuid(),
  sessionId: z.uuid(),
  appId: z.string().regex(/^wx[a-f0-9]{16}$/),
  subject: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
export type NativeBirthScope = z.infer<typeof scopeSchema>;
/** This deliberately is NOT an admission receipt. It proves only the native
 * creation-shaped12 relations/13 rows; all other owners, schema qualification,
 * future writers, and retired readers still require independent authority. */
export interface NativeBirthShapeReport {
  readonly kind: 'native-birth-shape-only';
  readonly accountId: string;
  readonly sessionId: string;
  readonly rows: 13;
  readonly relations: 12;
  readonly requiresCompleteOwnerCoverage: true;
}
/** Explicit account-local, bounded row sets. No fixture_accounts, baseline JSON,
 * whole-database empty predicate, UUID substring matching, or provider hash.
 * Provider identifiers are transient query values only, never returned/persisted.
 * The caller must already own provider -> account locks and real owner fences. */
export const nativeBirthShapeSql = `
WITH a AS MATERIALIZED(SELECT status,lifecycle,lifecycle_generation,session_revocation_epoch,local_creation_transaction,deletion_request_id,real_deletion_request_id FROM whaleu_identity.accounts WHERE id=$1),
 mappings AS MATERIALIZED(SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1 LIMIT 2),
 sessions AS MATERIALIZED(SELECT id,issued_revocation_epoch,revoked_at,revoke_reason,access_expires_at,refresh_expires_at,absolute_expires_at FROM whaleu_identity.sessions WHERE account_id=$1 LIMIT 2),
 access AS MATERIALIZED(SELECT t.session_id,t.expires_at FROM whaleu_identity.access_tokens t JOIN sessions s ON s.id=t.session_id LIMIT 2),
 refresh AS MATERIALIZED(SELECT t.session_id,t.consumed_at FROM whaleu_identity.refresh_tokens t JOIN sessions s ON s.id=t.session_id LIMIT 2),
 owners AS MATERIALIZED(SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 LIMIT 2),
 baselines AS MATERIALIZED(SELECT origin,opening_balance,opening_signin_day,opening_streak,history_coverage,entitlement_coverage,rule_version FROM whaleu_experience.baselines WHERE owner_id=$1 LIMIT 2),
 states AS MATERIALIZED(SELECT balance,last_signin_day,streak,revision FROM whaleu_experience.account_states WHERE owner_id=$1 LIMIT 2),
 entitlements AS MATERIALIZED(SELECT title_key,origin,earned_at,settlement_id,redemption_request_id,creation_transaction,maintenance_actor_id,maintenance_request_id,school_admin_actor_id,school_admin_request_id FROM whaleu_experience.entitlements WHERE owner_id=$1 LIMIT 3),
 appearance AS MATERIALIZED(SELECT title_key,color_id,revision FROM whaleu_experience.appearance WHERE owner_id=$1 LIMIT 2),
 safety_heads AS MATERIALIZED(SELECT block_coverage,restriction_coverage,provenance,actions_allowed,valid_until FROM whaleu_safety.account_heads WHERE account_id=$1 LIMIT 2),
 safety_events AS MATERIALIZED(SELECT kind,relationship_id,revision FROM whaleu_safety.events WHERE account_id=$1 LIMIT 2)
SELECT
 (SELECT count(*)=1 AND bool_and(status='active' AND lifecycle='active' AND lifecycle_generation=0 AND session_revocation_epoch=0 AND local_creation_transaction IS NOT NULL AND deletion_request_id IS NULL AND real_deletion_request_id IS NULL) FROM a)
 AND (SELECT count(*)=1 AND bool_and(provider='wechat' AND app_id=$3 AND subject=$4) FROM mappings)
 AND (SELECT count(*)=1 AND bool_and(id=$2 AND issued_revocation_epoch=0 AND revoked_at IS NULL AND revoke_reason IS NULL AND refresh_expires_at=access_expires_at+interval '604200 seconds' AND absolute_expires_at=access_expires_at+interval '2591400 seconds') FROM sessions)
 AND (SELECT count(*)=1 AND bool_and(t.session_id=$2 AND t.expires_at=s.access_expires_at) FROM access t JOIN sessions s ON s.id=t.session_id)
 AND (SELECT count(*)=1 AND bool_and(session_id=$2 AND consumed_at IS NULL) FROM refresh)
 AND (SELECT count(*)=1 FROM owners)
 AND (SELECT count(*)=1 AND bool_and(origin='native_account_creation' AND opening_balance=0 AND opening_signin_day IS NULL AND opening_streak=0 AND history_coverage='complete' AND entitlement_coverage='complete' AND rule_version='local-experience-v1') FROM baselines)
 AND (SELECT count(*)=1 AND bool_and(balance=0 AND last_signin_day IS NULL AND streak=0 AND revision=0) FROM states)
 AND (SELECT count(*)=2 AND count(DISTINCT title_key)=2 AND bool_and(title_key IN('default_jingxiaoyu','level_1') AND origin='registration' AND isfinite(earned_at) AND settlement_id IS NULL AND redemption_request_id IS NULL AND creation_transaction IS NULL AND maintenance_actor_id IS NULL AND maintenance_request_id IS NULL AND school_admin_actor_id IS NULL AND school_admin_request_id IS NULL) FROM entitlements)
 AND (SELECT count(*)=1 AND bool_and(title_key IS NULL AND color_id IS NULL AND revision=0) FROM appearance)
 AND (SELECT count(*)=1 AND bool_and(block_coverage='complete' AND restriction_coverage='complete' AND provenance='native_account_creation' AND actions_allowed AND valid_until IS NULL) FROM safety_heads)
 AND (SELECT count(*)=1 AND bool_and(kind='native_account_created' AND relationship_id IS NULL AND revision IS NULL) FROM safety_events)
 AND NOT EXISTS(SELECT 1 FROM whaleu_identity.legacy_account_mappings WHERE account_id=$1 LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM whaleu_verification.account_heads WHERE account_id=$1 LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM whaleu_verification.assertions WHERE account_id=$1 LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM whaleu_verification.snapshots WHERE account_id=$1 LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM whaleu_verification.events WHERE account_id=$1 LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM whaleu_verification.native_enrollments WHERE account_id=$1 LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM whaleu_verification.relevant_fact_generations WHERE account_id=$1 LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM whaleu_official.pending_causes WHERE kind='dependency' AND dependency_kind='account' AND target_id=$1 LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM whaleu_official.cause_conversions WHERE kind='dependency' AND dependency_kind='account' AND target_id=$1 LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM whaleu_official.dependency_events WHERE kind='account' AND target_id=$1 LIMIT 1) valid
`;
export async function inspectNativeBirthShape(
  tx: PoolClient,
  input: NativeBirthScope,
): Promise<NativeBirthShapeReport> {
  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success)
    throw new ApplicationError('REAL_DELETION_SCOPE_UNAVAILABLE');
  const scope = Object.freeze(parsed.data);
  await boundedOwnerProof(tx, 'REAL_DELETION_UNAVAILABLE', async (read) => {
    const rows = (
      await read.query<{ valid: boolean }>(nativeBirthShapeSql, [
        scope.accountId,
        scope.sessionId,
        scope.appId,
        scope.subject,
      ])
    ).rows;
    if (rows.length !== 1 || rows[0]?.valid !== true)
      throw new ApplicationError('REAL_DELETION_SCOPE_UNAVAILABLE');
  });
  return Object.freeze({
    kind: 'native-birth-shape-only',
    accountId: scope.accountId,
    sessionId: scope.sessionId,
    rows: 13,
    relations: 12,
    requiresCompleteOwnerCoverage: true,
  });
}
