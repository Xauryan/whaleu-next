import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import type { AdminDiscussionRemovalTarget } from './contracts.js';
import { communityCountProofOwner } from '../count-epochs.js';
interface IdentityFact {
  actor: string;
  sessionId: string;
  tokenHash: string;
  fingerprint: string;
}
export interface InputFact {
  actor: string;
  grantId: string | null;
  target: AdminDiscussionRemovalTarget;
  facts: unknown;
  requestId: string | null;
}
const code = 'ADMIN_DISCUSSION_REMOVAL_UNAVAILABLE' as const;
async function identityState(
  input: Omit<IdentityFact, 'fingerprint'>,
  tx: PoolClient,
): Promise<string> {
  const row = (
    await tx.query<{ fingerprint: string; current: boolean }>(
      'SELECT whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts($1,$2,$3)) fingerprint,whaleu_profile.moderation_identity_current($1,$2,$3) current',
      [input.actor, input.sessionId, input.tokenHash],
    )
  ).rows[0];
  if (!row || row.current !== true) throw new ApplicationError(code);
  return row.fingerprint;
}
const identityProof: RequiredTransactionProof<IdentityFact> = {
  maximumFacts: 1,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      await read.query(
        'LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if ((await identityState(fact, read)) !== fact.fingerprint)
          throw new ApplicationError(code);
    }),
};
/** Capture immediately after the presented token was authenticated, before any
 * request/content/subject wait. Later enrollment must never replace this fact. */
export async function retainAdminDiscussionRemovalIdentity(
  input: Omit<IdentityFact, 'fingerprint'>,
  tx: PoolClient,
): Promise<void> {
  const row = (
    await tx.query<{ token_until: string; session_until: string }>(
      `SELECT t.expires_at::text token_until,s.absolute_expires_at::text session_until FROM whaleu_identity.access_tokens t JOIN whaleu_identity.sessions s ON s.id=t.session_id WHERE t.token_hash=$1 AND s.id=$2 AND s.account_id=$3`,
      [input.tokenHash, input.sessionId, input.actor],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('AUTHENTICATION_REQUIRED');
  registerTransactionExactDeadline(tx, row.token_until, 'ACCESS_TOKEN_EXPIRED');
  registerTransactionExactDeadline(
    tx,
    row.session_until,
    'ACCESS_TOKEN_EXPIRED',
  );
  enableRequiredTransactionProof(tx, identityProof);
  registerRequiredTransactionFact(
    tx,
    identityProof,
    'identity',
    Object.freeze({ ...input, fingerprint: await identityState(input, tx) }),
  );
}
/** Observe once before source waits. The immutable observation is enrolled only
 * after the canonical owners have locked its exact source and deadlines. */
export async function observeAdminDiscussionRemovalInputs(
  input: Omit<InputFact, 'facts'>,
  tx: PoolClient,
): Promise<InputFact> {
  const row = (
    await tx.query<{ facts: unknown }>(
      'SELECT whaleu_community.admin_discussion_removal_input_facts($1,$2,$3,$4) facts',
      [input.actor, input.grantId, input.target.kind, input.target.id],
    )
  ).rows[0];
  if (!row) throw new ApplicationError(code);
  return Object.freeze({ ...input, facts: row.facts });
}
const inputProof: RequiredTransactionProof<InputFact> = {
  maximumFacts: 2,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      const initial = facts.find((fact) => fact.grantId === null);
      const selected = facts.find((fact) => fact.grantId !== null);
      if (
        facts.length !== 2 ||
        !initial ||
        !selected ||
        initial.actor !== selected.actor ||
        initial.target.kind !== selected.target.kind ||
        initial.target.id !== selected.target.id ||
        initial.requestId !== selected.requestId
      )
        throw new ApplicationError(code);
      if (!(await communityCountProofOwner.fence(read)))
        throw new ApplicationError(code);
      await read.query(
        'LOCK TABLE whaleu_community.discovery_count_epochs,whaleu_authorization.role_grants,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions IN SHARE MODE NOWAIT',
      );
      for (const fact of facts) {
        const result = (
          await read.query<{ current: boolean }>(
            'SELECT whaleu_community.admin_discussion_removal_inputs_current($1,$2,$3,$4,$5,$6) current',
            [
              fact.actor,
              fact.grantId,
              fact.target.kind,
              fact.target.id,
              fact.facts,
              fact.requestId,
            ],
          )
        ).rows[0];
        if (result?.current !== true) throw new ApplicationError(code);
      }
      // The source matcher admits one trigger-proven transition, not generic
      // tombstone visibility. Deadlines and all other canonical owner facts remain.
      for (const [sql, values] of [
        [
          'SELECT whaleu_profile.moderation_actor_current($1,clock_timestamp()) current',
          [selected.actor],
        ],
        [
          'SELECT whaleu_community.admin_discussion_removal_supported($1,$2,$3,$4) current',
          [
            selected.actor,
            selected.target.kind,
            selected.target.id,
            selected.requestId !== null,
          ],
        ],
        [
          'SELECT EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_target($3,$4) t WHERE whaleu_profile.moderation_grant_allowed($1,$2,t.region_id)) current',
          [
            selected.actor,
            selected.grantId,
            selected.target.kind,
            selected.target.id,
          ],
        ],
      ] as const) {
        if (
          (await read.query<{ current: boolean }>(sql, [...values])).rows[0]
            ?.current !== true
        )
          throw new ApplicationError(code);
      }
    }),
};
export async function retainAdminDiscussionRemovalInputs(
  input: InputFact,
  tx: PoolClient,
): Promise<void> {
  const deadlines = await tx.query<{ until: string | null }>(
    `SELECT expires_at::text until FROM whaleu_authorization.role_grants WHERE id=$1
    UNION ALL SELECT a.expires_at::text FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=$2
    UNION ALL SELECT d.visibility_until::text FROM whaleu_community.profile_moderation_nodes($3,$4) n JOIN whaleu_community.content_approval_bindings b ON b.content_kind=n.kind AND b.content_id=n.id JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id
    UNION ALL SELECT p.valid_until::text FROM whaleu_community.profile_moderation_nodes($3,$4) n JOIN whaleu_community.content_approval_bindings b ON b.content_kind=n.kind AND b.content_id=n.id JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id`,
    [input.grantId, input.actor, input.target.kind, input.target.id],
  );
  for (const row of deadlines.rows)
    registerTransactionExactDeadline(tx, row.until, code);
  enableRequiredTransactionProof(tx, inputProof);
  registerRequiredTransactionFact(
    tx,
    inputProof,
    input.grantId ?? 'initial-inputs',
    input,
  );
}
const commandProof: RequiredTransactionProof<{
  actor: string;
  requestId: string;
}> = {
  maximumFacts: 1,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      for (const fact of facts) {
        const result = await read.query(
          'SELECT whaleu_community.admin_discussion_removal_assert_complete(q) FROM whaleu_community.admin_discussion_removal_commands q WHERE actor_id=$1 AND request_id=$2',
          [fact.actor, fact.requestId],
        );
        if (result.rowCount !== 1) throw new ApplicationError(code);
      }
    }),
};
export function retainAdminDiscussionRemovalCommand(
  actor: string,
  requestId: string,
  tx: PoolClient,
): void {
  enableRequiredTransactionProof(tx, commandProof);
  registerRequiredTransactionFact(
    tx,
    commandProof,
    'command',
    Object.freeze({ actor, requestId }),
  );
}
