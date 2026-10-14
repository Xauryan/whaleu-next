import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../http/application-error.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { boundHotTransaction } from '../community/hot-score/transaction.js';
import { OfficialAccountOperationsService } from './service.js';
import type { OfficialStoredCommand } from './ledger.js';
import { officialDigest, officialUuid } from './profile.js';
/** No scheduler or HTTP endpoint. Caller provides only accepted program + canonical
 * midnight; the fixture business clock never replaces DB authority/lease clocks. */
export class OfficialDailyEnrollment {
  constructor(
    private readonly service: OfficialAccountOperationsService,
    private readonly businessNow: () => number = () => Date.now(),
  ) {}
  async admitDueSlot(programId: string, dueAt: string) {
    officialUuid.parse(programId);
    const due = new Date(dueAt),
      now = this.businessNow();
    if (
      !Number.isSafeInteger(now) ||
      !Number.isFinite(due.getTime()) ||
      due.toISOString() !== dueAt ||
      due.getUTCHours() ||
      due.getUTCMinutes() ||
      due.getUTCSeconds() ||
      due.getUTCMilliseconds()
    )
      throw new ApplicationError('OFFICIAL_SLOT_POLICY_CONFLICT');
    return this.service.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const runtime = this.service.requireRuntime();
        const principals = (
          await tx.query<{ principal_ref: string }>(
            `SELECT principal_ref FROM whaleu_official.capabilities WHERE program_id=$1 AND principal_kind='service' AND action='daily_draft' AND revoked_at IS NULL ORDER BY id LIMIT 2`,
            [programId],
          )
        ).rows;
        if (principals.length !== 1)
          throw new ApplicationError('OFFICIAL_AUTHORITY_REQUIRED');
        const authority = await runtime.authority.requireService(
            principals[0]!.principal_ref,
            programId,
            tx,
          ),
          p = authority.program;
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('official:slot:'||$1||':'||$2,0))",
          [p.account_ref, programId],
        );
        let slot = (
          await tx.query<{
            id: string;
            state: string;
            selection_attempts: number;
            next_attempt_at: Date;
          }>(
            `SELECT id,state,selection_attempts,next_attempt_at FROM whaleu_official.slots WHERE account_ref=$1 AND program_id=$2 AND local_date=$3 FOR UPDATE`,
            [p.account_ref, programId, dueAt.slice(0, 10)],
          )
        ).rows[0];
        if (
          slot &&
          !['pending_selection', 'source_unavailable'].includes(slot.state)
        ) {
          if (slot.state === 'admitted') {
            const command = (
              await tx.query<{ id: string }>(
                "SELECT id FROM whaleu_official.commands WHERE slot_id=$1 AND account_ref=$2 AND program_id=$3 AND operation='daily_draft'",
                [slot.id, p.account_ref, programId],
              )
            ).rows[0];
            if (!command)
              throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
            return {
              slotId: slot.id,
              state: slot.state,
              commandRef: command.id,
            };
          }
          return { slotId: slot.id, state: slot.state };
        }
        if (!slot) {
          const id = randomUUID(),
            state =
              now < due.getTime() || now >= due.getTime() + 300000
                ? 'expired_unavailable'
                : 'pending_selection';
          slot = (
            await tx.query<{
              id: string;
              state: string;
              selection_attempts: number;
              next_attempt_at: Date;
            }>(
              `INSERT INTO whaleu_official.slots(id,account_ref,program_id,local_date,zone,due_at,policy_revision,state,next_attempt_at) VALUES($1,$2,$3,$4,'Etc/UTC',$5,$6,$7,clock_timestamp()) RETURNING id,state,selection_attempts,next_attempt_at`,
              [
                id,
                p.account_ref,
                programId,
                dueAt.slice(0, 10),
                dueAt,
                officialDigest([
                  'synthetic-official-v1',
                  'Etc/UTC',
                  '00:00:00',
                ]),
                state,
              ],
            )
          ).rows[0]!;
          if (state === 'expired_unavailable') return { slotId: id, state };
        }
        if (now >= due.getTime() + 300000 || slot.selection_attempts >= 3) {
          await tx.query(
            "UPDATE whaleu_official.slots SET state='expired_unavailable' WHERE id=$1",
            [slot.id],
          );
          return { slotId: slot.id, state: 'expired_unavailable' };
        }
        const permitted =
          (
            await tx.query(
              'SELECT 1 WHERE $1::timestamptz<=clock_timestamp()',
              [slot.next_attempt_at],
            )
          ).rowCount === 1;
        if (!permitted) return { slotId: slot.id, state: slot.state };
        const checkpoint = checkpointTransactionDeadlines(tx);
        await tx.query('SAVEPOINT official_daily_select');
        let built;
        try {
          built = await runtime.manifests.build(
            authority,
            await this.service.configRow(programId, tx),
            'daily_hot',
            30,
            tx,
          );
        } catch {
          await tx.query('ROLLBACK TO SAVEPOINT official_daily_select');
          restoreTransactionDeadlines(tx, checkpoint);
          await tx.query('RELEASE SAVEPOINT official_daily_select');
          const state =
            slot.selection_attempts >= 2
              ? 'expired_unavailable'
              : 'source_unavailable';
          await tx.query(
            `UPDATE whaleu_official.slots SET state=$2,selection_attempts=selection_attempts+1,next_attempt_at=clock_timestamp()+CASE WHEN selection_attempts=0 THEN interval '1 second' ELSE interval '5 seconds' END WHERE id=$1`,
            [slot.id, state],
          );
          return { slotId: slot.id, state };
        }
        await tx.query('RELEASE SAVEPOINT official_daily_select');
        if (!built.manifest.sources.length) {
          await tx.query(
            "UPDATE whaleu_official.slots SET state='no_eligible_content',selection_attempts=selection_attempts+1 WHERE id=$1",
            [slot.id],
          );
          return { slotId: slot.id, state: 'no_eligible_content' };
        }
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('official:intake:'||$1,0))",
          [p.account_ref],
        );
        const pending = (
          await tx.query(
            `SELECT c.id FROM whaleu_official.commands c JOIN whaleu_official.command_states s ON s.command_id=c.id WHERE c.account_ref=$1 AND s.state IN('pending','preparing','dispatch_unknown','parked_unknown','publish_submitted') LIMIT 20`,
            [p.account_ref],
          )
        ).rows;
        if (pending.length >= 20)
          throw new ApplicationError('OFFICIAL_CAPACITY');
        const id = randomUUID(),
          manifest = built.manifest,
          intent = {
            slotId: slot.id,
            programId,
            accountRef: p.account_ref,
            dueAt,
            manifestHash: manifest.manifestHash,
          },
          receipt = {
            slotId: slot.id,
            commandRef: id,
            operation: 'daily_draft',
            intentHash: officialDigest(intent),
          };
        const command = (
          await tx.query<OfficialStoredCommand>(
            `INSERT INTO whaleu_official.commands(id,slot_id,account_ref,program_id,service_principal_ref,service_authority_digest,operation,intent_hash,intent,manifest_hash,rendered_hash,fresh_until,receipt) VALUES($1,$2,$3,$4,$11,$12,'daily_draft',$5,$6,$7,$8,$9,$10) RETURNING *`,
            [
              id,
              slot.id,
              p.account_ref,
              programId,
              receipt.intentHash,
              JSON.stringify(intent),
              manifest.manifestHash,
              manifest.renderedHash,
              manifest.expiresAt,
              JSON.stringify(receipt),
              principals[0]!.principal_ref,
              authority.digest,
            ],
          )
        ).rows[0]!;
        await tx.query(
          'INSERT INTO whaleu_official.command_states(command_id) VALUES($1)',
          [id],
        );
        await this.service.ledger.effects(command, manifest, tx);
        await runtime.payloads.put(
          manifest,
          { previewId: null, commandId: id, expiresAt: manifest.expiresAt },
          tx,
        );
        await tx.query(
          "UPDATE whaleu_official.slots SET state='admitted',selection_attempts=selection_attempts+1 WHERE id=$1",
          [slot.id],
        );
        return { slotId: slot.id, state: 'admitted', commandRef: id };
      },
      { isolationLevel: 'read committed' },
    );
  }
}
