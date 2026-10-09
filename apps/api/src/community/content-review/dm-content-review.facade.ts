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
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import type { Decision } from '../community-policy.js';
import { approvalProjection } from './approval.repository.js';
import { canonicalEqual, canonicalJson } from './contracts.js';
import { canonicalDmEnvelope, dmApprovalDigest } from './dm-contracts.js';
import type {
  AcceptedDmApproval,
  DmContentEnvelope,
  DmMessageDescriptor,
} from './dm-contracts.js';
import {
  dmBindingMatches,
  validateDmApprovalRow,
} from './dm-approval-validation.js';
import type {
  DmApprovalBinding,
  DmApprovalRow,
} from './dm-approval-validation.js';
interface TimedRow extends DmApprovalRow {
  now: Date;
  exact_time: boolean;
}
type Fact =
  | { kind: 'epoch'; fingerprint: string }
  | { kind: 'time'; id: string; consume: boolean; exact: boolean }
  | { kind: 'binding'; id: string; fingerprint: string };
const joins = `FROM whaleu_community.dm_approval_decisions d JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id JOIN whaleu_community.dm_approval_heads h ON h.decision_id=d.id JOIN whaleu_community.dm_approval_events e ON e.id=h.event_id AND e.decision_id=d.id LEFT JOIN whaleu_community.dm_review_issuers i ON i.issuer=d.issuer AND i.policy_revision_id=d.policy_revision_id`;
const trusted = `coalesce(i.active AND i.coverage='complete' AND i.provenance='accepted' AND i.purpose='send_private_message' AND i.valid_from<=d.evaluated_at AND (i.valid_until IS NULL OR i.valid_until>instant.now) AND e.issuer=d.issuer,false)`;
const exact = (consume: string) =>
  `coalesce(isfinite(d.evaluated_at) AND d.evaluated_at<=instant.now AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR p.valid_until>instant.now) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant.now AND d.consume_until>d.evaluated_at AND (NOT ${consume} OR d.result<>'allow' OR e.state<>'allow' OR d.consume_until>instant.now) AND ((d.visibility_model='durable' AND d.visibility_until IS NULL) OR (d.visibility_model='until' AND d.visibility_until>instant.now)) AND ${trusted},false)`;
async function epoch(tx: PoolClient) {
  const rows = (
    await tx.query<{ singleton: boolean; version: number; epoch: string }>(
      'SELECT singleton,version,epoch::text FROM whaleu_community.dm_review_epoch',
    )
  ).rows;
  if (
    rows.length !== 1 ||
    rows[0]?.singleton !== true ||
    rows[0].version !== 1 ||
    !/^(0|[1-9][0-9]*)$/.test(rows[0].epoch) ||
    BigInt(rows[0].epoch) > 9223372036854775807n
  )
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  return ownerFingerprint(rows);
}
async function binding(
  id: string,
  tx: PoolClient,
): Promise<DmApprovalBinding | null> {
  return (
    (
      await tx.query<DmApprovalBinding>(
        'SELECT message_id,conversation_id,sender_slot,message_seq::text,content_version,decision_id,account_id,operation,envelope_version,digest,envelope FROM whaleu_community.dm_approval_bindings WHERE message_id=$1',
        [id],
      )
    ).rows[0] ?? null
  );
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 520,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.dm_review_epoch,whaleu_community.dm_approval_bindings IN SHARE MODE NOWAIT',
      );
      const fingerprint = await epoch(read);
      if (
        facts.some((f) => f.kind === 'epoch' && f.fingerprint !== fingerprint)
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      const times = facts.filter(
        (f): f is Extract<Fact, { kind: 'time' }> => f.kind === 'time',
      );
      if (times.length) {
        const rows = (
          await read.query<{ ordinal: number; exact_time: boolean }>(
            `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now), wanted AS (SELECT * FROM unnest($1::uuid[],$2::boolean[]) WITH ORDINALITY r(id,consume,ordinal)) SELECT w.ordinal::integer ordinal,coalesce(q.exact_time,false) exact_time FROM wanted w LEFT JOIN LATERAL (SELECT ${exact('w.consume')} exact_time ${joins} CROSS JOIN instant WHERE d.id=w.id) q ON true ORDER BY w.ordinal`,
            [times.map((f) => f.id), times.map((f) => f.consume)],
          )
        ).rows;
        if (
          rows.length !== times.length ||
          rows.some(
            (row, index) =>
              row.ordinal !== index + 1 ||
              row.exact_time !== times[index]!.exact,
          )
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      }
      const bindings = facts.filter(
        (f): f is Extract<Fact, { kind: 'binding' }> => f.kind === 'binding',
      );
      if (bindings.length) {
        const rows = (
          await read.query<{
            ordinal: number;
            value: DmApprovalBinding | null;
          }>(
            `SELECT w.ordinal::integer ordinal,CASE WHEN b.message_id IS NULL THEN NULL ELSE jsonb_build_object('message_id',b.message_id,'conversation_id',b.conversation_id,'sender_slot',b.sender_slot,'message_seq',b.message_seq::text,'content_version',b.content_version,'decision_id',b.decision_id,'account_id',b.account_id,'operation',b.operation,'envelope_version',b.envelope_version,'digest',b.digest,'envelope',b.envelope) END value FROM unnest($1::uuid[]) WITH ORDINALITY w(id,ordinal) LEFT JOIN whaleu_community.dm_approval_bindings b ON b.message_id=w.id ORDER BY w.ordinal`,
            [bindings.map((f) => f.id)],
          )
        ).rows;
        if (
          rows.length !== bindings.length ||
          rows.some(
            (row, index) =>
              row.ordinal !== index + 1 ||
              ownerFingerprint(canonicalJson(row.value)) !==
                bindings[index]!.fingerprint,
          )
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      }
    }),
};
const handles = new WeakMap<
  object,
  { tx: PoolClient; readEpoch: object; used: boolean }
>();
/** Separate exact DM review owner. No rating/post approval can enter this path.
 * Missing trusted issuance remains unavailable in normal AppModule. */
@Injectable()
export class DmContentReviewFacade {
  private async begin(tx: PoolClient) {
    enableRequiredTransactionProof(tx, proof);
    const fingerprint = await epoch(tx);
    registerRequiredTransactionFact(
      tx,
      proof,
      `epoch:${fingerprint}`,
      Object.freeze({ kind: 'epoch', fingerprint }),
    );
  }
  private async row(
    id: string,
    consume: boolean,
    tx: PoolClient,
  ): Promise<TimedRow | null> {
    await tx.query(
      'SELECT decision_id FROM whaleu_community.dm_approval_heads WHERE decision_id=$1 FOR SHARE',
      [id],
    );
    const row =
      (
        await tx.query<TimedRow>(
          `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT ${approvalProjection},instant.now,i.valid_until issuer_valid_until,${trusted} issuer_trusted,${exact('$2::boolean')} exact_time ${joins} CROSS JOIN instant WHERE d.id=$1`,
          [id, consume],
        )
      ).rows[0] ?? null;
    registerRequiredTransactionFact(
      tx,
      proof,
      `time:${id}:${consume}:${row?.exact_time ?? false}`,
      Object.freeze({
        kind: 'time',
        id,
        consume,
        exact: row?.exact_time ?? false,
      }),
    );
    return row;
  }
  private validate(
    row: TimedRow | null,
    consume: boolean,
    tx: PoolClient,
  ): Decision<AcceptedDmApproval> {
    if (!row || row.exact_time !== true) return { kind: 'unavailable' };
    const result = validateDmApprovalRow(row, consume, row.now.getTime());
    registerTransactionDeadline(
      tx,
      result.optionalUntil,
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    return result.decision;
  }
  private retainBinding(
    id: string,
    value: DmApprovalBinding | null,
    tx: PoolClient,
  ) {
    const fingerprint = ownerFingerprint(canonicalJson(value));
    registerRequiredTransactionFact(
      tx,
      proof,
      `binding:${id}:${fingerprint}`,
      Object.freeze({ kind: 'binding', id, fingerprint }),
    );
  }
  async accepted(
    envelope: DmContentEnvelope,
    tx: PoolClient,
  ): Promise<AcceptedDmApproval> {
    await this.begin(tx);
    let canonical: DmContentEnvelope;
    try {
      canonical = canonicalDmEnvelope(envelope);
    } catch {
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
    if (
      !canonicalEqual(canonical, envelope) ||
      !transactionReadEpoch(tx) ||
      !(
        await tx.query(
          'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE',
          [canonical.accountId],
        )
      ).rows[0]
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const candidate = (
      await tx.query<{ id: string }>(
        `SELECT id FROM whaleu_community.dm_approval_decisions WHERE account_id=$1 AND operation='send_private_message' AND envelope_version=1 AND digest=$2 ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
        [canonical.accountId, dmApprovalDigest(canonical)],
      )
    ).rows[0];
    const row = candidate ? await this.row(candidate.id, true, tx) : null;
    const result =
      row && canonicalEqual(row.envelope, canonical)
        ? this.validate(row, true, tx)
        : { kind: 'unavailable' as const };
    if (result.kind === 'deny') throw new ApplicationError('CONTENT_REJECTED');
    if (
      result.kind !== 'allow' ||
      (
        await tx.query(
          'SELECT decision_id FROM whaleu_community.dm_approval_bindings WHERE decision_id=$1',
          [result.value.decisionId],
        )
      ).rows[0]
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    handles.set(result.value, {
      tx,
      readEpoch: transactionReadEpoch(tx)!,
      used: false,
    });
    return result.value;
  }
  async bind(
    approval: AcceptedDmApproval,
    descriptor: DmMessageDescriptor,
    tx: PoolClient,
  ): Promise<void> {
    const handle = handles.get(approval);
    if (
      !handle ||
      handle.used ||
      handle.tx !== tx ||
      handle.readEpoch !== transactionReadEpoch(tx) ||
      !canonicalEqual(approval.envelope, descriptor.envelope)
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const prospective: DmApprovalBinding = {
      message_id: descriptor.messageId,
      conversation_id: descriptor.conversationId,
      sender_slot: descriptor.senderSlot,
      message_seq: descriptor.sequence,
      content_version: 1,
      decision_id: approval.decisionId,
      account_id: approval.envelope.accountId,
      operation: 'send_private_message',
      envelope_version: 1,
      digest: approval.digest,
      envelope: approval.envelope,
    };
    if (!dmBindingMatches(prospective, descriptor))
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const fresh = await this.accepted(descriptor.envelope, tx);
    if (
      fresh.decisionId !== approval.decisionId ||
      fresh.digest !== approval.digest
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_community.dm_approval_bindings(message_id,conversation_id,sender_slot,message_seq,content_version,decision_id,account_id,operation,envelope_version,digest,envelope) VALUES($1,$2,$3,$4,1,$5,$6,'send_private_message',1,$7,$8::jsonb)`,
      [
        descriptor.messageId,
        descriptor.conversationId,
        descriptor.senderSlot,
        descriptor.sequence,
        approval.decisionId,
        approval.envelope.accountId,
        approval.digest,
        canonicalJson(approval.envelope),
      ],
    );
    handle.used = true;
    handles.get(fresh)!.used = true;
    this.retainBinding(descriptor.messageId, prospective, tx);
  }
  async current(
    descriptor: DmMessageDescriptor,
    tx: PoolClient,
  ): Promise<Decision<AcceptedDmApproval>> {
    await this.begin(tx);
    const current = await binding(descriptor.messageId, tx);
    this.retainBinding(descriptor.messageId, current, tx);
    if (!current || !dmBindingMatches(current, descriptor))
      return { kind: 'unavailable' };
    const row = await this.row(current.decision_id, false, tx);
    if (
      !row ||
      row.digest !== current.digest ||
      !canonicalEqual(row.envelope, descriptor.envelope)
    )
      return { kind: 'unavailable' };
    return this.validate(row, false, tx);
  }
}
