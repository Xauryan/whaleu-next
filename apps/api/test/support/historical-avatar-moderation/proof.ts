import type { PoolClient } from 'pg';
import { ApplicationError } from '../../../src/http/application-error.js';
import { boundedOwnerProof } from '../../../src/database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../../src/database/transaction-deadlines.js';
import type { AvatarModerationTarget } from '../../../src/profile/avatar-moderation/contracts.js';
interface IdentityFact {
  actor: string;
  sessionId: string;
  tokenHash: string;
  fingerprint: string;
}
export interface InputFact {
  actor: string;
  grantId: string | null;
  target: AvatarModerationTarget;
  fingerprint: string;
}
export interface ProfileFact {
  subject: string;
  fingerprint: string;
  avatar: string;
}
const code = 'PROFILE_AVATAR_MODERATION_UNAVAILABLE' as const;
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
export async function retainAvatarModerationIdentity(
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
/** Observe before canonical source resolution; no unlocked-source deadline is
 * registered here. The supplied observation is enrolled after source locking. */
export async function observeAvatarModerationInputs(
  input: Omit<InputFact, 'fingerprint'>,
  tx: PoolClient,
): Promise<InputFact> {
  const row = (
    await tx.query<{ fingerprint: string }>(
      'SELECT whaleu_profile.moderation_hash(whaleu_profile.avatar_moderation_input_facts($1,$2,$3,$4)) fingerprint',
      [input.actor, input.grantId, input.target.kind, input.target.id],
    )
  ).rows[0];
  if (!row) throw new ApplicationError(code);
  return Object.freeze({ ...input, fingerprint: row.fingerprint });
}
const inputProof: RequiredTransactionProof<InputFact> = {
  maximumFacts: 2,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      const initial = facts.find((fact) => fact.grantId === null),
        selected = facts.find((fact) => fact.grantId !== null);
      if (
        facts.length !== 2 ||
        !initial ||
        !selected ||
        initial.actor !== selected.actor ||
        initial.target.kind !== selected.target.kind ||
        initial.target.id !== selected.target.id
      )
        throw new ApplicationError(code);
      await read.query(
        'LOCK TABLE whaleu_authorization.role_grants,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions IN SHARE MODE NOWAIT',
      );
      // Keep the original 100ms per-statement / 500ms whole-owner budget. Small
      // statements avoid repeatedly planning the combined source/phone closure;
      // every check remains mandatory under the same retained owner fences.
      for (const fact of facts)
        if (
          (await observeAvatarModerationInputs(fact, read)).fingerprint !==
          fact.fingerprint
        )
          throw new ApplicationError(code);
      for (const [sql, values] of [
        [
          'SELECT whaleu_profile.moderation_actor_current($1,clock_timestamp()) current',
          [selected.actor],
        ],
        [
          'SELECT whaleu_community.profile_moderation_supported($1,$2,$3) current',
          [selected.actor, selected.target.kind, selected.target.id],
        ],
        [
          'SELECT EXISTS(SELECT 1 FROM whaleu_community.profile_moderation_target($3,$4) t WHERE whaleu_profile.moderation_grant_allowed($1,$2,t.region_id)) current',
          [
            selected.actor,
            selected.grantId,
            selected.target.kind,
            selected.target.id,
          ],
        ],
      ] as const) {
        const current = (
          await read.query<{ current: boolean }>(sql, [...values])
        ).rows[0]?.current;
        if (current !== true) throw new ApplicationError(code);
      }
    }),
};
/** Original exact inputs are observed once, before acquiring the shared Profile
 * write fence. Only the declared avatar Media transition may change unrelated Media epochs; exact original target facts remain unchanged. */
export async function retainAvatarModerationInputs(
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
    Object.freeze(input),
  );
}
async function profileState(
  subject: string,
  tx: PoolClient,
): Promise<ProfileFact> {
  const row = (
    await tx.query<{ fingerprint: string; avatar: string }>(
      `SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text)) fingerprint,whaleu_profile.moderation_hash(whaleu_profile.moderation_avatar_facts(p.account_id)) avatar FROM whaleu_profile.profiles p WHERE p.account_id=$1`,
      [subject],
    )
  ).rows[0];
  if (!row) throw new ApplicationError(code);
  return { subject, ...row };
}
const profileProof: RequiredTransactionProof<ProfileFact> = {
  maximumFacts: 1,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      for (const fact of facts) {
        const locked = (
          await read.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('whaleu:profile-avatar:actor:v1:'||$1,0)) locked",
            [fact.subject],
          )
        ).rows[0]?.locked;
        if (locked !== true) throw new ApplicationError(code);
        await read.query(
          'SELECT account_id FROM whaleu_profile.profiles WHERE account_id=$1 FOR SHARE NOWAIT',
          [fact.subject],
        );
        const current = await profileState(fact.subject, read);
        if (
          current.fingerprint !== fact.fingerprint ||
          current.avatar !== fact.avatar
        )
          throw new ApplicationError(code);
      }
    }),
};
export async function retainAvatarModerationProfile(
  subject: string,
  tx: PoolClient,
  observed?: ProfileFact,
): Promise<void> {
  if (observed && observed.subject !== subject)
    throw new ApplicationError(code);
  enableRequiredTransactionProof(tx, profileProof);
  registerRequiredTransactionFact(
    tx,
    profileProof,
    'profile',
    Object.freeze(observed ?? (await profileState(subject, tx))),
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
          'SELECT whaleu_profile.avatar_moderation_assert_complete(q) FROM whaleu_profile.avatar_moderation_commands q WHERE actor_id=$1 AND request_id=$2',
          [fact.actor, fact.requestId],
        );
        if (result.rowCount !== 1) throw new ApplicationError(code);
      }
    }),
};
export function retainAvatarModerationCommand(
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
