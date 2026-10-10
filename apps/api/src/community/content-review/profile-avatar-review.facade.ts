import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import {
  avatarReviewEnvelopeSchema,
  avatarReviewDigest,
} from '../../profile/avatar/contracts.js';
import type { AvatarReviewEnvelope } from '../../profile/avatar/contracts.js';
import { approvalProjection } from './approval.repository.js';
import { validateApprovalMetadata } from './approval-metadata.js';
import type { ApprovalMetadata } from './approval-metadata.js';
import { canonicalEqual } from './contracts.js';
interface Row extends ApprovalMetadata {
  current_time_valid: boolean;
  id: string;
  account_id: string;
  digest: string;
  envelope: unknown;
}
interface Fact {
  actor: string;
  digest: string;
  fingerprint: string;
  appearanceId?: string;
  bindingFingerprint?: string;
}
async function bindingState(appearanceId: string, tx: PoolClient) {
  return (
    (
      await tx.query(
        'SELECT b.*,b.xmin::text state_version,coalesce(b.bound_at>=d.evaluated_at AND b.bound_at<=clock_timestamp(),false) bound_time_valid FROM whaleu_community.profile_avatar_approval_bindings b JOIN whaleu_community.profile_avatar_approval_decisions d ON d.id=b.decision_id WHERE appearance_id=$1',
        [appearanceId],
      )
    ).rows[0] ?? null
  );
}
async function currentRow(
  actor: string,
  digest: string,
  tx: PoolClient,
): Promise<Row | null> {
  return (
    (
      await tx.query<Row>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),candidate AS MATERIALIZED (SELECT id FROM whaleu_community.profile_avatar_approval_decisions WHERE account_id=$1 AND digest=$2 ORDER BY evaluated_at DESC,id DESC LIMIT 1)
    SELECT ${approvalProjection},d.xmin::text decision_state_version,p.xmin::text policy_state_version,h.xmin::text head_state_version,e.xmin::text event_state_version,
      coalesce(d.evaluated_at<=instant.now AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR p.valid_until>instant.now) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant.now AND (d.visibility_model='durable' OR d.visibility_until>instant.now),false) current_time_valid FROM candidate c JOIN whaleu_community.profile_avatar_approval_decisions d ON d.id=c.id
    LEFT JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
    LEFT JOIN whaleu_community.profile_avatar_approval_heads h ON h.decision_id=d.id
    LEFT JOIN whaleu_community.profile_avatar_approval_events e ON e.id=h.event_id AND e.decision_id=d.id CROSS JOIN instant`,
        [actor, digest],
      )
    ).rows[0] ?? null
  );
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 128,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.content_approval_policies,whaleu_community.profile_avatar_approval_decisions,whaleu_community.profile_avatar_approval_heads,whaleu_community.profile_avatar_approval_events,whaleu_community.profile_avatar_approval_bindings IN SHARE MODE NOWAIT',
      );
      for (const fact of facts) {
        if (
          ownerFingerprint(await currentRow(fact.actor, fact.digest, read)) !==
            fact.fingerprint ||
          (fact.appearanceId &&
            ownerFingerprint(await bindingState(fact.appearanceId, read)) !==
              fact.bindingFingerprint)
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      }
    }),
};
export interface AcceptedAvatarReview {
  readonly decisionId: string;
  readonly digest: string;
  readonly envelope: AvatarReviewEnvelope;
}
/** Same Review policy metadata, separate exact Profile envelope and consumption. */
@Injectable()
export class ProfileAvatarReviewFacade {
  async accepted(
    raw: AvatarReviewEnvelope,
    tx: PoolClient,
    consume = true,
  ): Promise<AcceptedAvatarReview> {
    const parsed = avatarReviewEnvelopeSchema.safeParse(raw);
    if (!parsed.success)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const envelope = parsed.data,
      digest = avatarReviewDigest(envelope);
    enableRequiredTransactionProof(tx, proof);
    const row = await currentRow(envelope.accountId, digest, tx);
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]!.now.getTime();
    if (
      !row ||
      row.current_time_valid !== true ||
      !canonicalEqual(envelope, row.envelope)
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const result = validateApprovalMetadata(
      row,
      consume,
      now,
      'MEDIA_UNAVAILABLE',
    );
    if (result.decision.kind === 'deny')
      throw new ApplicationError(result.decision.reason);
    if (result.decision.kind !== 'allow')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      result.optionalUntil,
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    registerRequiredTransactionFact(
      tx,
      proof,
      `${envelope.accountId}:${digest}:${row.id}:${ownerFingerprint(row)}`,
      Object.freeze({
        actor: envelope.accountId,
        digest,
        fingerprint: ownerFingerprint(row),
      }),
    );
    if (
      consume &&
      (
        await tx.query(
          'SELECT 1 FROM whaleu_community.profile_avatar_approval_bindings WHERE decision_id=$1',
          [row.id],
        )
      ).rowCount
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return Object.freeze({ decisionId: row.id, digest, envelope });
  }
  async bind(accepted: AcceptedAvatarReview, tx: PoolClient): Promise<void> {
    const fresh = await this.accepted(accepted.envelope, tx);
    if (
      fresh.decisionId !== accepted.decisionId ||
      fresh.digest !== accepted.digest
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    await tx.query(
      'INSERT INTO whaleu_community.profile_avatar_approval_bindings(appearance_id,decision_id,account_id,digest,envelope) VALUES($1,$2,$3,$4,$5::jsonb)',
      [
        accepted.envelope.appearanceId,
        accepted.decisionId,
        accepted.envelope.accountId,
        accepted.digest,
        JSON.stringify(accepted.envelope),
      ],
    );
  }
  async current(
    envelope: AvatarReviewEnvelope,
    tx: PoolClient,
  ): Promise<string> {
    const accepted = await this.accepted(envelope, tx, false);
    const binding = await bindingState(envelope.appearanceId, tx);
    const row = await currentRow(envelope.accountId, accepted.digest, tx);
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]!.now.getTime();
    if (
      !binding ||
      binding.bound_time_valid !== true ||
      binding.decision_id !== accepted.decisionId ||
      binding.digest !== accepted.digest ||
      !canonicalEqual(binding.envelope, envelope) ||
      !(binding.bound_at instanceof Date) ||
      !row ||
      binding.bound_at.getTime() < row.evaluated_at.getTime() ||
      binding.bound_at.getTime() > now
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    registerRequiredTransactionFact(
      tx,
      proof,
      `binding:${envelope.appearanceId}:${ownerFingerprint({ row, binding })}`,
      Object.freeze({
        actor: envelope.accountId,
        digest: accepted.digest,
        fingerprint: ownerFingerprint(row),
        appearanceId: envelope.appearanceId,
        bindingFingerprint: ownerFingerprint(binding),
      }),
    );
    return ownerFingerprint({ row, binding });
  }
}
