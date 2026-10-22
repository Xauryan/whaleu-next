import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { IdentityService } from '../../identity/identity.service.js';
import { hashToken, requireToken } from '../../identity/tokens.js';
import { sessionEpoch } from '../../identity/session-epoch.js';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';
import { retainAcceptanceSession } from './acceptance-proof.js';
import {
  acceptDeletionSchema,
  deletionStatusSchema,
  cancelDeletionSchema,
  REAL_DELETION_PROTOCOL,
  type AcceptDeletion,
  type CancelDeletion,
  type DeletionStatusCommand,
  type RealDeletionReceipt,
} from './contracts.js';
import {
  preparationRow,
  retainPreparation,
  type PreparationRow,
} from './preparation-repository.js';
import { retainRequestSchema } from './request-qualification.js';
import { retainPreparationSchema } from './qualification.js';
import {
  cancellationIntentHash,
  equalRecoveryHash,
  preparationIntentHash,
  preparationRecoveryHash,
} from './recovery.js';
import type {
  ReauthenticationScope,
  RequestProviderReauthentication,
  VerifiedRequestProvider,
} from './reauthentication.js';

const missing = () => new ApplicationError('REAL_DELETION_SCOPE_UNAVAILABLE');
const unavailable = () => new ApplicationError('REAL_DELETION_UNAVAILABLE');
interface RequestRow {
  id: string;
  account_id: string;
  generation: string;
  previous_epoch: string;
  revoked_epoch: string;
  intent_hash: string;
  recovery_hash: string;
  phase: 'cooling' | 'cancelled';
  revision: string;
  accepted_at: Date;
  cancel_before: Date;
  cancel_before_exact: string;
  prepared_at: Date;
  preparation_expires_at: Date;
}
async function requestRow(
  tx: PoolClient,
  id: string,
): Promise<RequestRow | null> {
  return (
    (
      await tx.query<RequestRow>(
        `SELECT r.*,r.cancel_before::text cancel_before_exact,p.created_at prepared_at,p.expires_at preparation_expires_at FROM whaleu_real_deletion.requests r JOIN whaleu_real_deletion.preparations p ON p.intent_id=r.id WHERE r.id=$1`,
        [id],
      )
    ).rows[0] ?? null
  );
}
function receipt(row: RequestRow): RealDeletionReceipt {
  return Object.freeze({
    protocol: REAL_DELETION_PROTOCOL,
    intentId: row.id,
    phase: row.phase,
    revision: row.revision,
    preparedAt: row.prepared_at.toISOString(),
    preparationExpiresAt: row.preparation_expires_at.toISOString(),
    acceptedAt: row.accepted_at.toISOString(),
    cancelBefore: row.cancel_before.toISOString(),
    completedAt: null,
  });
}
interface ReceiptFact {
  request: string;
  account: string;
  intent: string;
  recovery: string;
  phase: string;
  revision: string;
}
const receiptProof: RequiredTransactionProof<ReceiptFact> = {
  maximumFacts: 1,
  failureCode: 'REAL_DELETION_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'REAL_DELETION_SCOPE_UNAVAILABLE', async (read) => {
      const f = facts[0];
      if (!f || facts.length !== 1) throw missing();
      await read.query(
        'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE NOWAIT',
        [f.account],
      );
      await read.query(
        'SELECT id FROM whaleu_real_deletion.requests WHERE id=$1 FOR SHARE NOWAIT',
        [f.request],
      );
      const rows = (
        await read.query<{ valid: boolean }>(
          'SELECT account_id=$2 AND intent_hash=$3 AND recovery_hash=$4 AND phase=$5 AND revision=$6 valid FROM whaleu_real_deletion.requests WHERE id=$1',
          [f.request, f.account, f.intent, f.recovery, f.phase, f.revision],
        )
      ).rows;
      if (rows.length !== 1 || rows[0]?.valid !== true) throw missing();
    }),
};
async function retainReceipt(
  tx: PoolClient,
  row: RequestRow,
): Promise<RealDeletionReceipt> {
  await tx.query(
    'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE NOWAIT',
    [row.account_id],
  );
  await tx.query(
    'SELECT id FROM whaleu_real_deletion.requests WHERE id=$1 FOR SHARE NOWAIT',
    [row.id],
  );
  const current = await requestRow(tx, row.id);
  if (
    !current ||
    current.account_id !== row.account_id ||
    current.intent_hash !== row.intent_hash ||
    current.recovery_hash !== row.recovery_hash
  )
    throw missing();
  enableRequiredTransactionProof(tx, receiptProof);
  registerRequiredTransactionFact(
    tx,
    receiptProof,
    current.id,
    Object.freeze({
      request: current.id,
      account: current.account_id,
      intent: current.intent_hash,
      recovery: current.recovery_hash,
      phase: current.phase,
      revision: current.revision,
    }),
  );
  return receipt(current);
}
function assertPreparationScope(
  row: PreparationRow | null,
  command: AcceptDeletion | CancelDeletion | DeletionStatusCommand,
): asserts row is PreparationRow {
  if (
    !row ||
    !equalRecoveryHash(
      row.recovery_hash,
      preparationRecoveryHash(
        row.account_id,
        {
          version: 1,
          intentId: row.intent_id,
          expectedGeneration: row.base_generation,
          consent: row.consent,
        },
        command.recoverySecret,
      ),
    )
  )
    throw missing();
  if (
    'consent' in command &&
    (row.intent_hash !==
      preparationIntentHash({
        version: command.version,
        intentId: command.intentId,
        expectedGeneration: command.expectedGeneration,
        consent: command.consent,
      }) ||
      row.base_generation !== command.expectedGeneration)
  )
    throw missing();
}
/** Same provider+app+subject fence as ordinary login, before any account lock.
 * Never derive the lock from a client-supplied provider field. */
export async function fenceRequestProvider(
  tx: PoolClient,
  scope: ReauthenticationScope,
): Promise<void> {
  const locked = (
    await tx.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) locked',
      [JSON.stringify(['wechat', scope.appId, scope.subject])],
    )
  ).rows;
  if (locked.length !== 1 || locked[0]?.locked !== true) throw unavailable();
}
interface AcceptanceAuthorityFact {
  request: string;
  account: string;
  attempt: string;
  intent: string;
  recovery: string;
  captures: readonly { epoch: string; digest: string; keyCheck: string }[];
}
const acceptanceAuthorityProof: RequiredTransactionProof<AcceptanceAuthorityFact> =
  {
    maximumFacts: 1,
    failureCode: 'REAL_DELETION_SCOPE_UNAVAILABLE',
    validate: (facts, tx) =>
      boundedOwnerProof(tx, 'REAL_DELETION_SCOPE_UNAVAILABLE', async (read) => {
        const f = facts[0];
        if (!f || facts.length !== 1) throw missing();
        const rows = (
          await read.query<{ valid: boolean }>(
            `SELECT r.account_id=$2 AND r.reauthentication_id=$3 AND r.intent_hash=$4 AND r.recovery_hash=$5
   AND r.phase='cooling' AND r.revision=1 AND r.accepted_transaction=pg_current_xact_id()
   AND p.intent_hash=r.intent_hash AND p.recovery_hash=r.recovery_hash AND p.expires_at>clock_timestamp()
   AND a.verification_transaction=pg_current_xact_id() AND a.expires_at>clock_timestamp()
   AND whaleu_real_deletion_admission.current_receipt(r.id,r.account_id,r.generation,r.previous_epoch)
   AND (SELECT coalesce(jsonb_agg(jsonb_build_object('epoch',c.key_epoch,'digest',c.identity_digest,'keyCheck',c.key_check) ORDER BY c.key_epoch COLLATE "C"),'[]'::jsonb) FROM (SELECT * FROM whaleu_real_deletion.provider_captures WHERE attempt_id=r.reauthentication_id ORDER BY key_epoch COLLATE "C" LIMIT 9) c)=$6::jsonb valid
   FROM whaleu_real_deletion.requests r JOIN whaleu_real_deletion.preparations p ON p.intent_id=r.id JOIN whaleu_real_deletion.reauthentication_attempts a ON a.id=r.reauthentication_id WHERE r.id=$1`,
            [
              f.request,
              f.account,
              f.attempt,
              f.intent,
              f.recovery,
              JSON.stringify(f.captures),
            ],
          )
        ).rows;
        if (rows.length !== 1 || rows[0]?.valid !== true) throw missing();
      }),
  };
/** Exact immutable accepted command replay. This must be queried BEFORE a fresh
 * provider exchange; the capability never grants sessions, account lists or PII. */
export async function acceptedRequestReceipt(
  tx: PoolClient,
  raw: unknown,
): Promise<RealDeletionReceipt | null> {
  const command = Object.freeze(acceptDeletionSchema.parse(raw));
  await retainRequestSchema(tx);
  const existing = await requestRow(tx, command.intentId);
  if (!existing) return null;
  const prepared = await preparationRow(tx, command.intentId);
  assertPreparationScope(prepared, command);
  if (
    existing.intent_hash !== prepared.intent_hash ||
    !equalRecoveryHash(existing.recovery_hash, prepared.recovery_hash)
  )
    throw missing();
  // Rows are immutable except monotonic phase/revision. A replay reports only the
  // stored exact command, not continued account authorization or a live session.
  return retainReceipt(tx, existing);
}
/** Private request-only status survives preparation expiry and disabled new
 * acceptance. The exact secret never grants account lists or ordinary sessions. */
export async function requestStatusReceipt(
  tx: PoolClient,
  raw: unknown,
): Promise<RealDeletionReceipt | null> {
  const command = Object.freeze(deletionStatusSchema.parse(raw));
  await retainRequestSchema(tx);
  const existing = await requestRow(tx, command.intentId);
  if (!existing) return null;
  const prepared = await preparationRow(tx, command.intentId);
  assertPreparationScope(prepared, command);
  if (!equalRecoveryHash(existing.recovery_hash, prepared.recovery_hash))
    throw missing();
  return retainReceipt(tx, existing);
}
interface PreparationCapabilityFact {
  intent: string;
  account: string;
  intentHash: string;
  recoveryHash: string;
}
const preparationCapabilityProof: RequiredTransactionProof<PreparationCapabilityFact> =
  {
    maximumFacts: 1,
    failureCode: 'REAL_DELETION_SCOPE_UNAVAILABLE',
    validate: (facts, tx) =>
      boundedOwnerProof(tx, 'REAL_DELETION_SCOPE_UNAVAILABLE', async (read) => {
        const fact = facts[0];
        if (!fact || facts.length !== 1) throw missing();
        await read.query(
          'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE NOWAIT',
          [fact.account],
        );
        const current = await preparationRow(read, fact.intent);
        if (
          !current ||
          current.account_id !== fact.account ||
          current.intent_hash !== fact.intentHash ||
          current.recovery_hash !== fact.recoveryHash
        )
          throw missing();
      }),
  };
/** Authenticate immutable capability before any request discovery or mode/bearer
 * decision. Uses existing preparation-only privileges. Current lifecycle/expiry
 * are deliberately NOT authorization here: a legitimately accepted request must
 * recover after its original preparation TTL. The caller retains current
 * preparation proof only for a not-yet-accepted intent, or full request proof for
 * an accepted receipt. This proof lives through the same managed transaction. */
export async function authenticatePreparationCapability(
  tx: PoolClient,
  raw: AcceptDeletion | DeletionStatusCommand,
): Promise<PreparationRow> {
  const command = Object.freeze(
    'consent' in raw
      ? acceptDeletionSchema.parse(raw)
      : deletionStatusSchema.parse(raw),
  );
  await retainPreparationSchema(tx);
  const row = await preparationRow(tx, command.intentId);
  assertPreparationScope(row, command);
  await tx.query(
    'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE NOWAIT',
    [row.account_id],
  );
  const current = await preparationRow(tx, command.intentId);
  if (
    !current ||
    current.account_id !== row.account_id ||
    current.intent_hash !== row.intent_hash ||
    current.recovery_hash !== row.recovery_hash
  )
    throw missing();
  enableRequiredTransactionProof(tx, preparationCapabilityProof);
  registerRequiredTransactionFact(
    tx,
    preparationCapabilityProof,
    command.intentId,
    Object.freeze({
      intent: command.intentId,
      account: row.account_id,
      intentHash: row.intent_hash,
      recoveryHash: row.recovery_hash,
    }),
  );
  return Object.freeze(current);
}
/** Transactional core only, not a production activation switch. A qualified real
 * admission receipt must already have been produced by its owner in THIS TX.
 * Current production admission is write-closed, so this cannot accept in normal
 * deployment. HTTP activation is deliberately not wired until recovery+owners.
 */
export async function commitRealAcceptance(
  tx: PoolClient,
  input: {
    command: unknown;
    accessHash: string;
    scope: ReauthenticationScope;
    verified: VerifiedRequestProvider;
  },
  reauthentication: RequestProviderReauthentication,
): Promise<RealDeletionReceipt> {
  const command = Object.freeze(acceptDeletionSchema.parse(input.command));
  const accessHash = input.accessHash,
    scope = Object.freeze({ ...input.scope }),
    verified = input.verified;
  if (!/^[a-f0-9]{64}$/.test(accessHash)) throw missing();
  const replay = await acceptedRequestReceipt(tx, command);
  if (replay) return replay;
  await fenceRequestProvider(tx, scope);
  const session = await retainAcceptanceSession(tx, {
    requestId: command.intentId,
    accountId: scope.accountId,
    expectedGeneration: command.expectedGeneration,
    accessHash,
  });
  const prepared = await preparationRow(tx, command.intentId);
  assertPreparationScope(prepared, command);
  if (
    !prepared.current ||
    prepared.account_id !== scope.accountId ||
    prepared.session_id !== session.sessionId ||
    prepared.next_generation !== scope.generation ||
    prepared.app_id !== scope.appId ||
    scope.requestId !== prepared.intent_id ||
    scope.purpose !== 'acceptance'
  )
    throw missing();
  const mapping = (
    await tx.query<{ account_id: string }>(
      `SELECT account_id FROM whaleu_identity.provider_identities WHERE provider='wechat' AND app_id=$1 AND subject=$2 AND account_id=$3 FOR SHARE NOWAIT`,
      [scope.appId, scope.subject, scope.accountId],
    )
  ).rows;
  if (mapping.length !== 1) throw missing();
  const attempts = (
    await tx.query<{ live: boolean; expires_exact: string }>(
      `SELECT (intent_id=$2 AND account_id=$3 AND generation=$4 AND previous_epoch=$5 AND session_id=$6 AND token_hash=$7 AND app_id=$8 AND purpose='acceptance' AND verified_at IS NULL AND expires_at>clock_timestamp()) live,expires_at::text expires_exact FROM whaleu_real_deletion.reauthentication_attempts WHERE id=$1 FOR UPDATE NOWAIT`,
      [
        scope.attemptId,
        scope.requestId,
        scope.accountId,
        scope.generation,
        session.previousEpoch,
        session.sessionId,
        accessHash,
        scope.appId,
      ],
    )
  ).rows;
  const admission = (
    await tx.query<{ current: boolean; expires_exact: string }>(
      `SELECT whaleu_real_deletion_admission.current_receipt(request_id,account_id,generation,previous_epoch) current,valid_until::text expires_exact FROM whaleu_real_deletion_admission.receipts WHERE request_id=$1 AND account_id=$2 AND generation=$3 AND previous_epoch=$4 FOR SHARE NOWAIT`,
      [
        scope.requestId,
        scope.accountId,
        scope.generation,
        session.previousEpoch,
      ],
    )
  ).rows;
  if (
    attempts.length !== 1 ||
    attempts[0]?.live !== true ||
    admission.length !== 1 ||
    admission[0]?.current !== true
  )
    throw missing();
  for (const exact of [
    prepared.expires_at_exact,
    attempts[0].expires_exact,
    admission[0].expires_exact,
  ])
    registerTransactionExactDeadline(
      tx,
      exact,
      'REAL_DELETION_SCOPE_UNAVAILABLE',
    );
  const provider = reauthentication.consume(verified, scope);
  await tx.query(
    'UPDATE whaleu_real_deletion.reauthentication_attempts SET verified_at=clock_timestamp(),verification_transaction=pg_current_xact_id() WHERE id=$1',
    [scope.attemptId],
  );
  for (const capture of provider.digests)
    await tx.query(
      'INSERT INTO whaleu_real_deletion.provider_captures(attempt_id,key_epoch,key_check,identity_digest) VALUES($1,$2,$3,$4)',
      [scope.attemptId, capture.epoch, capture.keyCheck, capture.digest],
    );
  await tx.query(
    `INSERT INTO whaleu_real_deletion.requests(id,account_id,generation,previous_epoch,revoked_epoch,intent_hash,recovery_hash,reauthentication_id,admission_id,accepting_session_id,accepting_token_hash,phase,revision,accepted_at,cancel_before)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$1,$9,$10,'cooling',1,clock_timestamp(),clock_timestamp())`,
    [
      scope.requestId,
      scope.accountId,
      scope.generation,
      session.previousEpoch,
      session.nextEpoch,
      prepared.intent_hash,
      prepared.recovery_hash,
      scope.attemptId,
      session.sessionId,
      accessHash,
    ],
  );
  const created = await requestRow(tx, scope.requestId);
  if (!created) throw unavailable();
  enableRequiredTransactionProof(tx, acceptanceAuthorityProof);
  registerRequiredTransactionFact(
    tx,
    acceptanceAuthorityProof,
    scope.requestId,
    Object.freeze({
      request: scope.requestId,
      account: scope.accountId,
      attempt: scope.attemptId,
      intent: prepared.intent_hash,
      recovery: prepared.recovery_hash,
      captures: provider.digests,
    }),
  );
  return receipt(created);
}
interface CancellationFact {
  command: string;
  request: string;
  account: string;
  generation: string;
  epoch: string;
  revision: string;
  intent: string;
  recovery: string;
}
const cancellationProof: RequiredTransactionProof<CancellationFact> = {
  maximumFacts: 1,
  failureCode: 'REAL_DELETION_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'REAL_DELETION_SCOPE_UNAVAILABLE', async (read) => {
      const f = facts[0];
      if (!f || facts.length !== 1) throw missing();
      const rows = (
        await read.query<{ valid: boolean }>(
          `SELECT c.request_id=$2 AND r.account_id=$3 AND r.generation=$4 AND r.revoked_epoch=$5 AND c.expected_revision=$6 AND r.revision=$6::bigint+1
  AND c.intent_hash=$7 AND c.recovery_hash=$8 AND c.mutation_transaction=pg_current_xact_id() AND c.cancelled_at=r.cancelled_at
  AND r.phase='cancelled' AND a.lifecycle='active' AND a.real_deletion_request_id=r.id AND a.deletion_request_id IS NULL AND a.lifecycle_generation=r.generation AND a.session_revocation_epoch=r.revoked_epoch valid
  FROM whaleu_real_deletion.cancellations c JOIN whaleu_real_deletion.requests r ON r.id=c.request_id JOIN whaleu_identity.accounts a ON a.id=r.account_id WHERE c.command_id=$1`,
          [
            f.command,
            f.request,
            f.account,
            f.generation,
            f.epoch,
            f.revision,
            f.intent,
            f.recovery,
          ],
        )
      ).rows;
      if (rows.length !== 1 || rows[0]?.valid !== true) throw missing();
    }),
};
/** Purpose-only cancellation. No ordinary session is minted, restored or required.
 * A lost response retries exact command/revision/intent before current state. */
export async function cancelRealRequest(
  tx: PoolClient,
  raw: unknown,
): Promise<RealDeletionReceipt> {
  const command = Object.freeze(cancelDeletionSchema.parse(raw)),
    intent = cancellationIntentHash(command);
  await retainRequestSchema(tx);
  const prepared = await preparationRow(tx, command.intentId);
  assertPreparationScope(prepared, command);
  const old = (
    await tx.query<{
      request_id: string;
      expected_revision: string;
      intent_hash: string;
      recovery_hash: string;
    }>(
      'SELECT request_id,expected_revision,intent_hash,recovery_hash FROM whaleu_real_deletion.cancellations WHERE command_id=$1',
      [command.commandId],
    )
  ).rows[0];
  if (old) {
    if (
      old.request_id !== command.intentId ||
      old.expected_revision !== command.expectedRevision ||
      old.intent_hash !== intent ||
      !equalRecoveryHash(old.recovery_hash, prepared.recovery_hash)
    )
      throw missing();
    const completed = await requestRow(tx, old.request_id);
    if (!completed || completed.phase !== 'cancelled') throw unavailable();
    return retainReceipt(tx, completed);
  }
  await tx.query(
    'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE NOWAIT',
    [prepared.account_id],
  );
  await tx.query(
    'SELECT id FROM whaleu_real_deletion.requests WHERE id=$1 FOR UPDATE NOWAIT',
    [command.intentId],
  );
  const current = await requestRow(tx, command.intentId);
  if (
    !current ||
    current.phase !== 'cooling' ||
    current.revision !== command.expectedRevision ||
    !equalRecoveryHash(current.recovery_hash, prepared.recovery_hash)
  )
    throw missing();
  registerTransactionExactDeadline(
    tx,
    current.cancel_before_exact,
    'REAL_DELETION_SCOPE_UNAVAILABLE',
  );
  await tx.query(
    `INSERT INTO whaleu_real_deletion.cancellations(command_id,request_id,expected_revision,intent_hash,recovery_hash,cancelled_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())`,
    [
      command.commandId,
      command.intentId,
      command.expectedRevision,
      intent,
      prepared.recovery_hash,
    ],
  );
  enableRequiredTransactionProof(tx, cancellationProof);
  registerRequiredTransactionFact(
    tx,
    cancellationProof,
    command.commandId,
    Object.freeze({
      command: command.commandId,
      request: current.id,
      account: current.account_id,
      generation: current.generation,
      epoch: current.revoked_epoch,
      revision: command.expectedRevision,
      intent,
      recovery: prepared.recovery_hash,
    }),
  );
  const cancelled = await requestRow(tx, command.intentId);
  if (!cancelled || cancelled.phase !== 'cancelled') throw unavailable();
  return receipt(cancelled);
}

interface AttemptFact {
  id: string;
  request: string;
  account: string;
  generation: string;
  epoch: string;
  session: string;
  token: string;
}
const attemptProof: RequiredTransactionProof<AttemptFact> = {
  maximumFacts: 1,
  failureCode: 'REAL_DELETION_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'REAL_DELETION_SCOPE_UNAVAILABLE', async (read) => {
      const f = facts[0];
      if (!f || facts.length !== 1) throw missing();
      const rows = (
        await read.query<{ valid: boolean }>(
          `SELECT a.intent_id=$2 AND a.account_id=$3 AND a.generation=$4 AND a.previous_epoch=$5 AND a.session_id=$6 AND a.token_hash=$7
  AND a.verification_transaction IS NULL AND a.verified_at IS NULL AND a.expires_at>clock_timestamp() AND a.creation_transaction=pg_current_xact_id()
  AND p.expires_at>clock_timestamp() AND p.base_generation=x.lifecycle_generation AND p.next_generation=a.generation
  AND x.status='active' AND x.lifecycle='active' AND x.session_revocation_epoch=a.previous_epoch valid
  FROM whaleu_real_deletion.reauthentication_attempts a JOIN whaleu_real_deletion.preparations p ON p.intent_id=a.intent_id JOIN whaleu_identity.accounts x ON x.id=a.account_id WHERE a.id=$1`,
          [
            f.id,
            f.request,
            f.account,
            f.generation,
            f.epoch,
            f.session,
            f.token,
          ],
        )
      ).rows;
      if (rows.length !== 1 || rows[0]?.valid !== true) throw missing();
    }),
};
/** First committed phase, before network. The returned provider subject is an
 * internal ephemeral scope, never an HTTP response or persisted request field.
 * Call acceptedRequestReceipt before this function to recover committed attempts.
 * A fresh production owner must pass preflight BEFORE even this first phase is
 * exposed by HTTP; current prepare-only routes never call it. */
export async function beginRealReauthentication(
  tx: PoolClient,
  raw: unknown,
  access: string,
  identity: IdentityService,
): Promise<ReauthenticationScope> {
  const command = Object.freeze(acceptDeletionSchema.parse(raw));
  const token = hashToken(requireToken(access, 'access'));
  await retainRequestSchema(tx);
  const discovery = await preparationRow(tx, command.intentId);
  assertPreparationScope(discovery, command);
  const mappings = (
    await tx.query<{ subject: string }>(
      `SELECT subject FROM whaleu_identity.provider_identities WHERE account_id=$1 AND provider='wechat' AND app_id=$2 LIMIT 2`,
      [discovery.account_id, discovery.app_id],
    )
  ).rows;
  if (mappings.length !== 1) throw missing();
  const scope: ReauthenticationScope = Object.freeze({
    purpose: 'acceptance',
    attemptId: randomUUID(),
    requestId: discovery.intent_id,
    accountId: discovery.account_id,
    generation: discovery.next_generation,
    appId: discovery.app_id,
    subject: mappings[0]!.subject,
  });
  await fenceRequestProvider(tx, scope);
  await tx.query(
    'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE NOWAIT',
    [scope.accountId],
  );
  const authenticated = await identity.session(access, tx);
  const current = await preparationRow(tx, scope.requestId);
  assertPreparationScope(current, command);
  if (
    authenticated.accountId !== scope.accountId ||
    authenticated.sessionId !== current.session_id ||
    current.intent_hash !== discovery.intent_hash ||
    current.recovery_hash !== discovery.recovery_hash ||
    current.next_generation !== scope.generation ||
    current.app_id !== scope.appId
  )
    throw missing();
  await retainPreparation(tx, current);
  const epochs = (
    await tx.query<{ epoch: string }>(
      'SELECT session_revocation_epoch::text epoch FROM whaleu_identity.accounts WHERE id=$1',
      [scope.accountId],
    )
  ).rows;
  if (epochs.length !== 1) throw missing();
  const epoch = sessionEpoch(epochs[0]!.epoch);
  await tx.query(
    `INSERT INTO whaleu_real_deletion.reauthentication_attempts(id,intent_id,account_id,generation,previous_epoch,session_id,token_hash,app_id,purpose,expires_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,'acceptance',clock_timestamp())`,
    [
      scope.attemptId,
      scope.requestId,
      scope.accountId,
      scope.generation,
      epoch,
      authenticated.sessionId,
      token,
      scope.appId,
    ],
  );
  const attempt = (
    await tx.query<{ expires_exact: string }>(
      'SELECT expires_at::text expires_exact FROM whaleu_real_deletion.reauthentication_attempts WHERE id=$1',
      [scope.attemptId],
    )
  ).rows[0];
  if (!attempt) throw unavailable();
  registerTransactionExactDeadline(
    tx,
    attempt.expires_exact,
    'REAL_DELETION_SCOPE_UNAVAILABLE',
  );
  enableRequiredTransactionProof(tx, attemptProof);
  registerRequiredTransactionFact(
    tx,
    attemptProof,
    scope.attemptId,
    Object.freeze({
      id: scope.attemptId,
      request: scope.requestId,
      account: scope.accountId,
      generation: scope.generation,
      epoch,
      session: authenticated.sessionId,
      token,
    }),
  );
  return scope;
}
