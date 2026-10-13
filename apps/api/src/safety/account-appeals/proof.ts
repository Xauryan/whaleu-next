import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
const code = 'SAFETY_MODERATION_UNAVAILABLE' as const;
interface IdentityFact {
  actor: string;
  sessionId: string;
  tokenHash: string;
  fingerprint: string;
}
async function identityFingerprint(
  input: Omit<IdentityFact, 'fingerprint'>,
  tx: PoolClient,
): Promise<string> {
  const row = (
    await tx.query<{ fingerprint: string; current: boolean }>(
      'SELECT whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts($1,$2,$3)) fingerprint,whaleu_safety.account_appeal_identity_current($1,$2,$3) current',
      [input.actor, input.sessionId, input.tokenHash],
    )
  ).rows[0];
  if (!row || !row.current) throw new ApplicationError(code);
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
        if ((await identityFingerprint(fact, read)) !== fact.fingerprint)
          throw new ApplicationError(code);
    }),
};
export async function retainAppealIdentity(
  input: Omit<IdentityFact, 'fingerprint'>,
  tx: PoolClient,
): Promise<void> {
  const row = (
    await tx.query<{
      token_until: string;
      session_until: string;
      access_until: string;
    }>(
      'SELECT t.expires_at::text token_until,s.absolute_expires_at::text session_until,s.access_expires_at::text access_until FROM whaleu_identity.access_tokens t JOIN whaleu_identity.sessions s ON s.id=t.session_id WHERE t.token_hash=$1 AND s.id=$2 AND s.account_id=$3',
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
  registerTransactionExactDeadline(
    tx,
    row.access_until,
    'ACCESS_TOKEN_EXPIRED',
  );
  enableRequiredTransactionProof(tx, identityProof);
  registerRequiredTransactionFact(
    tx,
    identityProof,
    'identity',
    Object.freeze({
      ...input,
      fingerprint: await identityFingerprint(input, tx),
    }),
  );
}
interface ReadFact {
  scope: string;
  fingerprint: string;
  actor: string;
  grant: string | null;
}
async function readFingerprint(
  scope: string,
  actor: string,
  grant: string | null,
  tx: PoolClient,
): Promise<string> {
  return (
    await tx.query<{ fingerprint: string }>(
      'SELECT whaleu_safety.account_appeal_read_fingerprint($1,$2,$3) fingerprint',
      [scope, actor, grant],
    )
  ).rows[0]!.fingerprint;
}
const readProof: RequiredTransactionProof<ReadFact> = {
  maximumFacts: 2,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      await read.query(`LOCK TABLE whaleu_safety.discovery_count_epochs,whaleu_safety.account_moderation_epochs,whaleu_safety.account_appeals,
      whaleu_safety.account_appeal_decisions,whaleu_safety.account_appeal_open_cases,
      whaleu_safety.account_punishments,whaleu_safety.account_punishment_heads,whaleu_safety.account_punishment_terminals IN SHARE MODE NOWAIT`);
      if (facts.some((fact) => fact.grant !== null))
        await read.query(
          'LOCK TABLE whaleu_safety.account_heads,whaleu_authorization.role_grants,whaleu_authorization.account_punishment_authority_epoch IN SHARE MODE NOWAIT',
        );
      for (const fact of facts) {
        if (
          (await readFingerprint(fact.scope, fact.actor, fact.grant, read)) !==
          fact.fingerprint
        )
          throw new ApplicationError(code);
        if (
          fact.grant &&
          !(
            await read.query<{ current: boolean }>(
              'SELECT whaleu_safety.account_appeal_admin_current($1,$2) current',
              [fact.actor, fact.grant],
            )
          ).rows[0]?.current
        )
          throw new ApplicationError(code);
      }
    }),
};
export async function retainAppealRead(
  scope: string,
  actor: string,
  grant: string | null,
  tx: PoolClient,
): Promise<void> {
  enableRequiredTransactionProof(tx, readProof);
  registerRequiredTransactionFact(
    tx,
    readProof,
    scope,
    Object.freeze({
      scope,
      actor,
      grant,
      fingerprint: await readFingerprint(scope, actor, grant, tx),
    }),
  );
}
const commandProof: RequiredTransactionProof<{
  actor: string;
  request: string;
}> = {
  maximumFacts: 1,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      for (const fact of facts) {
        const result = await read.query(
          'SELECT whaleu_safety.account_appeal_assert_complete(q) FROM whaleu_safety.account_appeal_commands q WHERE actor_id=$1 AND request_id=$2',
          [fact.actor, fact.request],
        );
        if (result.rowCount !== 1) throw new ApplicationError(code);
      }
    }),
};
export function retainAppealCommand(
  actor: string,
  request: string,
  tx: PoolClient,
): void {
  enableRequiredTransactionProof(tx, commandProof);
  registerRequiredTransactionFact(
    tx,
    commandProof,
    'command',
    Object.freeze({ actor, request }),
  );
}
