import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { punishmentViewSchema } from './contracts.js';
import type {
  PunishmentReference,
  PunishmentSelection,
  PunishmentView,
} from './contracts.js';

export interface PunishmentReleaseContext {
  actorId: string;
  sessionId: string;
  tokenHash: string;
  grantId: string;
  requestId: string;
  causeId: string;
}
export interface PunishmentIssueContext extends Omit<
  PunishmentReleaseContext,
  'causeId'
> {
  subjectId: string;
  sourceKind: 'post' | 'comment' | 'reply';
  sourceId: string;
  sourceEventId: string;
  recordedAt: string;
}
interface ReadFact {
  punishmentId: string;
  version: string;
  openAppealId: string | null;
}
const code = 'SAFETY_MODERATION_UNAVAILABLE' as const;
const readProof: RequiredTransactionProof<ReadFact> = {
  maximumFacts: 256,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      await read.query(`LOCK TABLE whaleu_safety.account_punishments,whaleu_safety.account_punishment_heads,
      whaleu_safety.account_punishment_terminals,whaleu_safety.account_appeal_open_cases,whaleu_safety.account_appeals,whaleu_safety.account_appeal_decisions IN SHARE MODE NOWAIT`);
      const rows = (
        await read.query<{
          id: string;
          version: string;
          openAppealId: string | null;
        }>(
          'SELECT id,whaleu_safety.account_punishment_version(id) version,whaleu_safety.account_punishment_open_appeal(id) AS "openAppealId" FROM whaleu_safety.account_punishments WHERE id=ANY($1::uuid[])',
          [facts.map((fact) => fact.punishmentId)],
        )
      ).rows;
      if (
        facts.some(
          (fact) =>
            !rows.some(
              (row) =>
                row.id === fact.punishmentId &&
                row.version === fact.version &&
                row.openAppealId === fact.openAppealId,
            ),
        )
      )
        throw new ApplicationError(code);
    }),
};
@Injectable()
export class AccountPunishmentOwner {
  /** For a mutation owner's retained CAS proof only; never substitutes for view()
   * on a standalone read or erases an already-enrolled read observation. */
  async observe(punishmentId: string, tx: PoolClient): Promise<PunishmentView> {
    const row = (
      await tx.query<{ view: unknown }>(
        'SELECT whaleu_safety.account_punishment_view($1) view',
        [punishmentId],
      )
    ).rows[0];
    if (!row?.view) throw new ApplicationError('SAFETY_MODERATION_NOT_FOUND');
    return punishmentViewSchema.parse(row.view);
  }
  /** Read only; callers retain their own Identity/Authorization source proofs. */
  async view(punishmentId: string, tx: PoolClient): Promise<PunishmentView> {
    const row = (
      await tx.query<{ view: unknown; version: string }>(
        'SELECT whaleu_safety.account_punishment_view($1) view,whaleu_safety.account_punishment_version($1) version',
        [punishmentId],
      )
    ).rows[0];
    if (!row?.view) throw new ApplicationError('SAFETY_MODERATION_NOT_FOUND');
    const view = punishmentViewSchema.parse(row.view);
    enableRequiredTransactionProof(tx, readProof);
    registerRequiredTransactionFact(
      tx,
      readProof,
      punishmentId,
      Object.freeze({
        punishmentId,
        version: row.version,
        openAppealId: view.openAppealId,
      }),
    );
    if (view.state === 'active' && view.endsAt)
      registerTransactionExactDeadline(tx, view.endsAt, code);
    return view;
  }
  async observeOwned(
    subjectId: string,
    reference: PunishmentReference,
    tx: PoolClient,
  ): Promise<PunishmentView> {
    const row = (
      await tx.query<{ id: string }>(
        'SELECT id FROM whaleu_safety.account_punishments WHERE subject_id=$1 AND id=$2 AND kind=$3 AND revision=$4::bigint',
        [subjectId, reference.punishmentId, reference.kind, reference.revision],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('SAFETY_MODERATION_NOT_FOUND');
    return this.observe(row.id, tx);
  }
  async viewOwned(
    subjectId: string,
    reference: PunishmentReference,
    tx: PoolClient,
  ): Promise<PunishmentView> {
    const row = (
      await tx.query<{ id: string }>(
        'SELECT id FROM whaleu_safety.account_punishments WHERE subject_id=$1 AND id=$2 AND kind=$3 AND revision=$4::bigint',
        [subjectId, reference.punishmentId, reference.kind, reference.revision],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('SAFETY_MODERATION_NOT_FOUND');
    return this.view(row.id, tx);
  }
  async isEffective(
    reference: PunishmentReference,
    tx: PoolClient,
  ): Promise<boolean> {
    return (
      (
        await tx.query<{ effective: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM whaleu_safety.account_punishments p
       JOIN whaleu_safety.account_punishment_heads h ON h.punishment_id=p.id
       WHERE p.id=$1 AND p.kind=$2 AND p.revision=$3::bigint AND p.starts_at<=clock_timestamp()
       AND (p.ends_at IS NULL OR p.ends_at>clock_timestamp())
       AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals t WHERE t.punishment_id=p.id)) effective`,
          [reference.punishmentId, reference.kind, reference.revision],
        )
      ).rows[0]?.effective === true
    );
  }
  /** The immutable content-command trigger already generated this row. A caller
   * cannot initiate punishment by presenting an arbitrary subject ID here. */
  async issueExact(
    context: PunishmentIssueContext,
    selection: PunishmentSelection,
    tx: PoolClient,
  ) {
    const row = (
      await tx.query<{
        punishmentId: string;
        kind: PunishmentReference['kind'];
        revision: string;
        eventId: string;
        recordedAt: string;
      }>(
        `SELECT id "punishmentId",kind,revision::text,id "eventId",
       to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "recordedAt"
       FROM whaleu_safety.account_punishments WHERE actor_id=$1 AND request_id=$2 AND subject_id=$3
       AND session_id=$4 AND token_hash=$5 AND grant_id=$6 AND source_kind=$7 AND source_id=$8 AND source_event_id=$9
       AND recorded_at=$10::timestamptz AND kind=$11 AND expected_revision=$12::bigint AND duration=$13::jsonb AND reason=$14
       AND mutation_transaction=pg_current_xact_id()`,
        [
          context.actorId,
          context.requestId,
          context.subjectId,
          context.sessionId,
          context.tokenHash,
          context.grantId,
          context.sourceKind,
          context.sourceId,
          context.sourceEventId,
          context.recordedAt,
          selection.kind,
          selection.expectedRevision,
          selection.duration,
          selection.reason,
        ],
      )
    ).rows[0];
    if (!row) throw new ApplicationError(code);
    return row;
  }
  /** Decision/release command triggers are the only writers. This verifies the
   * exact terminal generated by that caller's immutable cause. */
  async releaseExact(
    context: PunishmentReleaseContext,
    reference: PunishmentReference,
    reason: string,
    cause: 'manually_released' | 'appeal_released',
    tx: PoolClient,
  ) {
    const row = (
      await tx.query<{ eventId: string; recordedAt: string }>(
        `SELECT t.event_id "eventId",to_char(t.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "recordedAt"
       FROM whaleu_safety.account_punishment_terminals t JOIN whaleu_safety.account_punishments p ON p.id=t.punishment_id
       WHERE p.id=$1 AND p.kind=$2 AND p.revision=$3::bigint AND t.actor_id=$4 AND t.session_id=$5 AND t.token_hash=$6
       AND t.grant_id=$7 AND t.source_request_id=$8 AND t.cause_id=$9 AND t.reason=$10 AND t.cause=$11
       AND t.mutation_transaction=pg_current_xact_id()`,
        [
          reference.punishmentId,
          reference.kind,
          reference.revision,
          context.actorId,
          context.sessionId,
          context.tokenHash,
          context.grantId,
          context.requestId,
          context.causeId,
          reason,
          cause,
        ],
      )
    ).rows[0];
    if (!row) throw new ApplicationError(code);
    return row;
  }
}
