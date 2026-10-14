import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { boundHotTransaction } from '../community/hot-score/transaction.js';
import {
  registerTransactionDeadline,
  checkpointTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { OFFICIAL_PROFILE } from './profile.js';
import {
  OfficialAccountOperationsService,
  officialEffectProjection,
} from './service.js';
import type { OfficialManifest } from './manifest.js';
import type { OfficialStoredCommand } from './ledger.js';
import { createOfficialPermit } from './provider.js';
import type { OfficialEffectIdentity, OfficialPrepared } from './provider.js';
class OfficialWorkerStopping extends Error {}
interface Claim {
  effect: OfficialEffectIdentity;
  fence: string;
  leaseUntil: number;
  reconcile: boolean;
  attempts: number;
  command: OfficialStoredCommand;
}
async function boundedPrepare<T>(
  run: Promise<T>,
  deadline = performance.now() + 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Preparation deadline')),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** Explicit cycles only. Unknown work never returns to dispatch admission. */
export class OfficialOperationWorker {
  private stopping = false;
  private readonly running = new Set<Promise<unknown>>();
  constructor(private readonly service: OfficialAccountOperationsService) {}
  stopAdmission() {
    this.stopping = true;
  }
  private async claim(allowReconcile: boolean): Promise<Claim | null> {
    return this.service.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('official:worker-admission:v1',0))",
        );
        if (
          (
            await tx.query(
              'SELECT 1 FROM whaleu_official.effect_states WHERE lease_until>clock_timestamp() LIMIT 2',
            )
          ).rows.length >= 2
        )
          return null;
        // A dispatched expired lease remains unknown; preparation-only stale claims
        // can re-enter under the same effect, bounded total claims and fresh proof.
        const row = (
          await tx.query<
            OfficialEffectIdentity & {
              state: string;
              attempts: number;
            }
          >(
            `SELECT ${officialEffectProjection},s.state,s.attempts FROM whaleu_official.effects e JOIN whaleu_official.effect_states s ON s.effect_id=e.id JOIN whaleu_official.command_states c ON c.command_id=e.command_id WHERE (s.lease_until IS NULL OR s.lease_until<=clock_timestamp()) AND s.next_attempt_at<=clock_timestamp() AND s.claims<33
    AND NOT s.execution_blocked AND s.state IN('pending','preparing','retry_wait','dispatch_unknown','parked_unknown','publish_submitted') AND ($1::boolean OR s.state NOT IN('dispatch_unknown','parked_unknown','publish_submitted'))
    AND NOT EXISTS(SELECT 1 FROM whaleu_official.effects a JOIN whaleu_official.effect_states b ON b.effect_id=a.id WHERE a.account_ref=e.account_ref AND b.lease_until>clock_timestamp())
    AND ((s.state IN('dispatch_unknown','parked_unknown','publish_submitted') AND s.reconciliations<30) OR (s.state IN('pending','preparing','retry_wait') AND s.attempts<3 AND NOT c.cancel_requested AND c.withdrawal='none'))
    AND (e.stage<>'draft_create' OR NOT EXISTS(SELECT 1 FROM whaleu_official.effects material JOIN whaleu_official.effect_states ms ON ms.effect_id=material.id WHERE material.command_id=e.command_id AND material.stage='material' AND ms.state<>'material_confirmed'))
    ORDER BY s.next_attempt_at,e.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`,
            [allowReconcile],
          )
        ).rows[0];
        if (!row) return null;
        const { state, attempts, ...effect } = row,
          reconcile = [
            'dispatch_unknown',
            'parked_unknown',
            'publish_submitted',
          ].includes(state),
          fence = randomUUID();
        const lease = (
          await tx.query<{ lease_until: Date }>(
            `UPDATE whaleu_official.effect_states SET fence=$2,lease_until=clock_timestamp()+interval '30 seconds',claims=claims+1,reconciliations=reconciliations+$3,state=CASE WHEN $3=0 THEN 'preparing' ELSE state END WHERE effect_id=$1 RETURNING lease_until`,
            [effect.effectId, fence, reconcile ? 1 : 0],
          )
        ).rows[0]!;
        const command = (
          await tx.query<OfficialStoredCommand>(
            'SELECT * FROM whaleu_official.commands WHERE id=$1',
            [effect.commandId],
          )
        ).rows[0]!;
        return {
          effect,
          fence,
          leaseUntil: lease.lease_until.getTime(),
          reconcile,
          attempts,
          command,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async session(command: OfficialStoredCommand, tx: PoolClient) {
    if (!command.actor_ref)
      throw new ApplicationError('OFFICIAL_AUTHORITY_REQUIRED');
    if (!(await this.service.identity.activeAccount(command.actor_ref, tx)))
      throw new ApplicationError('AUTHENTICATION_REQUIRED');
    const attachment = (
      await tx.query<{ session_ref: string }>(
        'SELECT session_ref FROM whaleu_official.execution_sessions WHERE command_id=$1 ORDER BY attached_at DESC,id DESC LIMIT 1',
        [command.id],
      )
    ).rows[0];
    const row = attachment
      ? (
          await tx.query<{
            id: string;
            access_expires_at: Date;
            refresh_expires_at: Date;
          }>(
            `SELECT id,access_expires_at,refresh_expires_at FROM whaleu_identity.sessions WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL AND access_expires_at>clock_timestamp() AND refresh_expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp() FOR SHARE`,
            [attachment.session_ref, command.actor_ref],
          )
        ).rows[0]
      : undefined;
    if (!row) throw new ApplicationError('AUTHENTICATION_REQUIRED');
    registerTransactionDeadline(
      tx,
      row.access_expires_at.getTime(),
      'AUTHENTICATION_REQUIRED',
    );
    return {
      accountId: command.actor_ref,
      sessionId: row.id,
      expiresAt: row.access_expires_at.getTime(),
      refreshExpiresAt: row.refresh_expires_at.getTime(),
    };
  }
  private async freshAuthority(command: OfficialStoredCommand, tx: PoolClient) {
    const runtime = this.service.requireRuntime();
    const epoch = (
      await tx.query<{ epoch: string }>(
        'SELECT epoch FROM whaleu_official.fixture_epoch WHERE singleton FOR SHARE',
      )
    ).rows[0];
    if (epoch?.epoch !== runtime.fixtureEpoch)
      throw new ApplicationError('OFFICIAL_RUNTIME_DISABLED');
    if (command.operation === 'daily_draft') {
      if (!command.service_principal_ref)
        throw new ApplicationError('OFFICIAL_AUTHORITY_REQUIRED');
      const authority = await runtime.authority.requireService(
        command.service_principal_ref,
        command.program_id,
        tx,
      );
      if (authority.digest !== command.service_authority_digest)
        throw new ApplicationError('OFFICIAL_AUTHORITY_REQUIRED');
      return authority;
    }
    return runtime.authority.requireManual(
      await this.session(command, tx),
      command.program_id,
      command.operation === 'manual_publish'
        ? 'publish'
        : command.operation === 'manual_draft'
          ? 'manual_create'
          : 'test',
      tx,
    );
  }
  runCycle() {
    const work = this.runClaimCycle();
    this.running.add(work);
    void work.then(
      () => this.running.delete(work),
      () => this.running.delete(work),
    );
    return work;
  }
  async shutdown(): Promise<void> {
    this.stopAdmission();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.running]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 10000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async runClaimCycle(): Promise<{
    claimed: number;
    reconciled: number;
    dispatched: number;
    unknown: number;
  }> {
    const summary = { claimed: 0, reconciled: 0, dispatched: 0, unknown: 0 },
      runtime = this.service.requireRuntime();
    if (this.stopping) return summary;
    await this.service.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const epoch = (
          await tx.query<{ epoch: string }>(
            'SELECT epoch FROM whaleu_official.fixture_epoch WHERE singleton FOR SHARE',
          )
        ).rows[0];
        if (epoch?.epoch !== runtime.fixtureEpoch)
          throw new ApplicationError('OFFICIAL_RUNTIME_DISABLED');
      },
      { isolationLevel: 'read committed' },
    );
    for (let i = 0; i < OFFICIAL_PROFILE.claims && !this.stopping; i++) {
      const claim = await this.claim(summary.reconciled < 3);
      if (!claim) break;
      summary.claimed++;
      if (claim.reconcile) {
        summary.reconciled++;
        try {
          const evidence = await boundedPrepare(
            runtime.provider.reconcile(claim.effect),
          );
          if (evidence)
            await this.service.database.transaction(
              async (tx) => {
                await boundHotTransaction(tx);
                await this.service.ledger.settle(
                  evidence,
                  claim.fence,
                  runtime.provider,
                  tx,
                );
              },
              { isolationLevel: 'read committed' },
            );
          else {
            summary.unknown++;
            await this.release(claim, true);
          }
        } catch {
          summary.unknown++;
          await this.release(claim, true);
        }
        continue;
      }
      let manifest: OfficialManifest, prepared: OfficialPrepared;
      const preparationDeadline = performance.now() + 5000;
      try {
        manifest = await this.service.database.transaction(
          async (tx) => {
            await boundHotTransaction(tx);
            const authority = await this.freshAuthority(claim.command, tx),
              value = (await runtime.payloads.getByCommand(
                claim.command.id,
                tx,
              )) as OfficialManifest;
            await runtime.manifests.requireCurrent(
              value,
              authority,
              await this.service.configRow(claim.command.program_id, tx),
              tx,
              claim.command.fresh_until.toISOString(),
            );
            return value;
          },
          { isolationLevel: 'read committed' },
        );
        const asset = manifest.assets.find(
          (a) =>
            a.appearanceId === claim.effect.assetAppearanceId &&
            a.purpose === claim.effect.purpose,
        );
        const bytes =
          claim.effect.stage === 'material'
            ? asset && runtime.media
              ? await boundedPrepare(
                  runtime.media.prepare(asset),
                  preparationDeadline,
                )
              : null
            : Buffer.from(manifest.rendered, 'utf8');
        if (!bytes) throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
        const draft =
          claim.effect.stage === 'publish_submit'
            ? await this.service.database.transaction(
                async (tx) => {
                  await boundHotTransaction(tx);
                  const intent = claim.command.intent;
                  if (!('draftRef' in intent))
                    throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
                  const effect = (
                    await tx.query<OfficialEffectIdentity>(
                      `SELECT ${officialEffectProjection} FROM whaleu_official.effects e JOIN whaleu_official.command_states s ON s.command_id=e.command_id JOIN whaleu_official.commands c ON c.id=s.command_id WHERE s.draft_ref=$1 AND c.actor_ref=$2 AND c.operation='manual_draft' AND s.state='draft_confirmed' AND s.withdrawal='none' AND e.stage='draft_create'`,
                      [intent.draftRef, claim.command.actor_ref],
                    )
                  ).rows[0];
                  if (!effect)
                    throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
                  return effect;
                },
                { isolationLevel: 'read committed' },
              )
            : undefined;
        prepared = await boundedPrepare(
          runtime.provider.prepare(claim.effect, bytes, draft),
          preparationDeadline,
        );
      } catch (error) {
        if (error instanceof OfficialWorkerStopping)
          await this.blockExecution(claim, false);
        else if (
          error instanceof ApplicationError &&
          error.code === 'AUTHENTICATION_REQUIRED'
        )
          await this.blockExecution(claim);
        else await this.suppress(claim);
        continue;
      }
      const attemptId = randomUUID();
      if (this.stopping) {
        await this.blockExecution(claim, false);
        continue;
      }
      if (performance.now() >= preparationDeadline) {
        await this.suppress(claim);
        continue;
      }
      // Shared durable fence is armed before final authorization, never afterward.
      runtime.provider.arm(
        claim.effect,
        attemptId,
        claim.fence,
        claim.leaseUntil,
      );
      try {
        const authorized = await this.service.database.transaction(
          async (tx) => {
            await boundHotTransaction(tx);
            if (this.stopping) throw new OfficialWorkerStopping();
            const authority = await this.freshAuthority(claim.command, tx);
            await runtime.manifests.requireCurrent(
              manifest,
              authority,
              await this.service.configRow(claim.command.program_id, tx),
              tx,
              claim.command.fresh_until.toISOString(),
            );
            const state = (
              await tx.query<{ attempts: number; lease_until: Date }>(
                `SELECT s.attempts,s.lease_until FROM whaleu_official.effect_states s JOIN whaleu_official.effects e ON e.id=s.effect_id JOIN whaleu_official.command_states c ON c.command_id=e.command_id WHERE s.effect_id=$1 AND s.fence=$2 AND s.state='preparing' AND s.lease_until>clock_timestamp()+interval '1 second' AND NOT c.cancel_requested AND c.withdrawal='none' FOR UPDATE OF s,c`,
                [claim.effect.effectId, claim.fence],
              )
            ).rows[0];
            if (!state || state.attempts >= 3)
              throw new ApplicationError('OFFICIAL_EFFECT_NOT_RESUMABLE');
            await tx.query(
              `INSERT INTO whaleu_official.attempts(id,effect_id,ordinal,fence,claimed_at,lease_until,authority_digest,prepared_hash,dispatch_boundary_at,logical_key) VALUES($1,$2,$3,$4,clock_timestamp(),$5,$6,$7,clock_timestamp(),$8)`,
              [
                attemptId,
                claim.effect.effectId,
                state.attempts + 1,
                claim.fence,
                state.lease_until,
                authority.digest,
                prepared.preparedHash,
                claim.effect.logicalKey,
              ],
            );
            await tx.query(
              "UPDATE whaleu_official.effect_states SET state='dispatch_unknown',attempts=attempts+1,updated_at=clock_timestamp() WHERE effect_id=$1",
              [claim.effect.effectId],
            );
            // Reserve the complete fixed permit interval inside every captured
            // business/authority deadline. DB time is mapped conservatively from
            // before the clock query; later proof/commit time consumes the permit.
            const sampledAt = performance.now();
            const dbNow = (
              await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
            ).rows[0]!.now.getTime();
            const remaining =
              Math.min(...checkpointTransactionDeadlines(tx).values()) -
              dbNow -
              (performance.now() - sampledAt);
            if (remaining <= OFFICIAL_PROFILE.permitMs)
              throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
            // Creation time is before COMMIT; commit consumes this 100ms budget.
            return createOfficialPermit(
              claim.effect,
              attemptId,
              claim.fence,
              authority.digest,
              state.lease_until.getTime(),
            );
          },
          { isolationLevel: 'read committed' },
        );
        if (this.stopping) throw new OfficialWorkerStopping();
        const evidence = prepared.dispatch(authorized);
        summary.dispatched++;
        await this.service.database.transaction(
          async (tx) => {
            await boundHotTransaction(tx);
            await this.service.ledger.settle(
              evidence,
              claim.fence,
              runtime.provider,
              tx,
            );
          },
          { isolationLevel: 'read committed' },
        );
      } catch (error) {
        summary.unknown++;
        if (error instanceof OfficialWorkerStopping)
          await this.blockExecution(claim, false);
        else if (
          error instanceof ApplicationError &&
          error.code === 'AUTHENTICATION_REQUIRED'
        )
          await this.blockExecution(claim);
        else await this.suppress(claim);
        await this.release(claim, true);
      }
    }
    await this.service.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        await runtime.payloads.purge(tx);
      },
      { isolationLevel: 'read committed' },
    );
    return summary;
  }
  private async blockExecution(claim: Claim, blocked = true) {
    await this.service.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        await tx.query(
          "UPDATE whaleu_official.effect_states SET state='pending',execution_blocked=$3,lease_until=NULL,updated_at=clock_timestamp() WHERE effect_id=$1 AND fence=$2 AND state='preparing'",
          [claim.effect.effectId, claim.fence, blocked],
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async suppress(claim: Claim) {
    await this.service.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const changed = await tx.query(
          "UPDATE whaleu_official.effect_states SET state='suppressed_unsent',lease_until=NULL,updated_at=clock_timestamp() WHERE effect_id=$1 AND fence=$2 AND state='preparing'",
          [claim.effect.effectId, claim.fence],
        );
        if (changed.rowCount) {
          await tx.query(
            "UPDATE whaleu_official.effect_states s SET state='suppressed_unsent',updated_at=clock_timestamp() FROM whaleu_official.effects e WHERE e.id=s.effect_id AND e.command_id=$1 AND s.state IN('pending','retry_wait')",
            [claim.command.id],
          );
          await this.service.ledger.syncState(claim.command.id, tx);
        }
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async release(claim: Claim, unknown: boolean) {
    await this.service.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        await tx.query(
          `UPDATE whaleu_official.effect_states SET lease_until=NULL,state=CASE WHEN state='publish_submitted' THEN state WHEN $3 AND reconciliations>=30 THEN 'parked_unknown' ELSE state END,next_attempt_at=clock_timestamp()+interval '5 seconds',updated_at=clock_timestamp() WHERE effect_id=$1 AND fence=$2`,
          [claim.effect.effectId, claim.fence, unknown],
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
}
