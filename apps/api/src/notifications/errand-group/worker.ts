import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { ErrandGroupRepository } from './repository.js';
import type { GroupClaim, GroupReason } from './repository.js';
import {
  ERRAND_GROUP_RUNTIME,
  ERRAND_GROUP_SOURCE,
  businessTime,
  groupDestinationSchema,
  groupWindow,
  nativeErrandLocator,
  publicGroupPayloadSchema,
} from './contracts.js';
import type {
  ErrandGroupRuntime,
  ErrandGroupSourcePort,
  GroupDestination,
  GroupPermit,
  GroupStatus,
  SyntheticAck,
} from './contracts.js';
class GroupWindowExpired extends Error {}
/** Preparation/reconciliation can wait; neither is permitted to emit a message. */
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error('Synthetic provider readiness timed out')),
          3000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** Manual bounded synthetic worker. No timer, CLI, environment switch or real
 * transport is installed by AppModule. Local personal notices are independent. */
@Injectable()
export class ErrandGroupWorker {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ErrandGroupRepository)
    private readonly records: ErrandGroupRepository,
    @Inject(ERRAND_GROUP_SOURCE) private readonly source: ErrandGroupSourcePort,
    @Inject(ERRAND_GROUP_RUNTIME)
    private readonly runtime: ErrandGroupRuntime | null,
  ) {}
  async discover(): Promise<number> {
    if (this.runtime?.mode !== 'synthetic-only') return 0;
    const runtime = this.runtime;
    const candidates = await this.db.transaction(
      (tx) => this.records.publicationCandidates(businessTime(runtime), tx),
      { isolationLevel: 'read committed' },
    );
    let found = 0;
    for (const eventId of candidates) {
      try {
        // At most one publication × two stages × sixteen authority facts per
        // commit. No source can consume another source's proof budget or roll
        // back its progress. A bad scope remains closed without starving others.
        found += await this.db.transaction(
          async (tx) => {
            const p = await this.records.discoveryPublication(eventId, tx);
            if (!p) return 0;
            const now = businessTime(runtime);
            let enrolled = 0;
            for (const stage of ['errand', 'forum'] as const) {
              const window = groupWindow(p, stage, now);
              if (window === 'waiting') continue;
              const destinations = await bounded(
                runtime.authority.destinations(p.targetRegionId, stage, tx),
              );
              if (destinations === null) continue;
              const parsed = groupDestinationSchema
                .array()
                .max(16)
                .parse(destinations);
              if (new Set(parsed.map((d) => d.id)).size !== parsed.length)
                throw Error('Ambiguous synthetic destination');
              for (const destination of parsed) {
                if (
                  destination.targetRegionId !== p.targetRegionId ||
                  destination.stage !== stage
                )
                  throw Error('Wrong synthetic destination scope');
                await bounded(
                  runtime.authority.requireCurrent(destination, tx),
                );
                await this.records.enrollDestination(
                  p,
                  stage,
                  destination.id,
                  now,
                  tx,
                  window === 'expired',
                );
                enrolled++;
              }
            }
            await this.records.scanned(p.eventId, tx);
            return enrolled;
          },
          { isolationLevel: 'read committed' },
        );
      } catch {
        // Rollback discards every tentative destination/authority fact above.
        // Only independent scan bookkeeping advances; no failed authority is
        // relabelled known/empty and the next call can retry this publication.
        await this.db.transaction((tx) => this.records.scanned(eventId, tx), {
          isolationLevel: 'read committed',
        });
      }
    }
    return found;
  }
  /** Inspection is read-only, including disabled boot; does not enroll or claim. */
  async inspect() {
    if (this.runtime?.mode !== 'synthetic-only')
      return { enabled: false, deliveries: [] };
    const rows = await this.db.query<{
      stage: string;
      status: string;
      count: number;
    }>(
      'SELECT stage,status,count(*)::integer count FROM whaleu_notifications.errand_group_deliveries GROUP BY stage,status ORDER BY stage,status',
    );
    return { enabled: true, deliveries: rows.rows };
  }
  private async finish(
    claim: GroupClaim,
    status: Exclude<GroupStatus, 'pending' | 'confirmed'>,
    reason: GroupReason,
  ) {
    await this.db.transaction(
      (tx) =>
        this.records.finish(
          claim,
          status,
          reason,
          businessTime(this.runtime!),
          tx,
        ),
      { isolationLevel: 'read committed' },
    );
  }
  private async acknowledge(claim: GroupClaim, ack: SyntheticAck) {
    if (ack.status === 'confirmed') {
      // If either ACK or this COMMIT is lost, the persisted unknown attempt is
      // reconciled using the same key. A rollback cannot undo external acceptance.
      await this.db.transaction(
        (tx) =>
          this.records.confirmed(claim, ack, businessTime(this.runtime!), tx),
        { isolationLevel: 'read committed' },
      );
    } else if (ack.status === 'not_accepted') {
      if (
        ack.key !== claim.idempotency_key ||
        ack.destinationId !== claim.destination_id
      ) {
        await this.finish(claim, 'unknown', 'unknown');
        return;
      }
      const expired =
        groupWindow(
          claim.publication,
          claim.stage,
          businessTime(this.runtime!),
        ) === 'expired';
      await this.finish(
        claim,
        expired ? 'expired' : 'retryable',
        expired ? 'window' : 'not_accepted',
      );
    } else await this.finish(claim, 'unknown', 'unknown');
  }
  async runOne(): Promise<boolean> {
    if (this.runtime?.mode !== 'synthetic-only') return false;
    const runtime = this.runtime;
    const claim = await this.db.transaction(
      (tx) => this.records.claim(businessTime(runtime), tx),
      { isolationLevel: 'read committed' },
    );
    if (!claim) return false;
    if (claim.operation === 'reconcile') {
      // Reconciliation may record an earlier proven ACK after eligibility or
      // authority changed. It never sends content or reuses an old permit.
      try {
        await this.acknowledge(
          claim,
          await bounded(
            runtime.sender.reconcile(
              claim.idempotency_key,
              claim.destination_id,
            ),
          ),
        );
      } catch {
        await this.finish(claim, 'unknown', 'unknown');
      }
      return true;
    }
    if (
      groupWindow(claim.publication, claim.stage, businessTime(runtime)) !==
      'eligible'
    ) {
      await this.finish(claim, 'expired', 'window');
      return true;
    }
    let destination: GroupDestination;
    try {
      destination = await this.db.transaction(
        async (tx) => {
          const destinations = await runtime.authority.destinations(
            claim.publication.targetRegionId,
            claim.stage,
            tx,
          );
          const list = groupDestinationSchema
            .array()
            .max(16)
            .parse(destinations);
          if (new Set(list.map((d) => d.id)).size !== list.length)
            throw Error('Ambiguous synthetic destination');
          const value = list.find((d) => d.id === claim.destination_id);
          if (
            !value ||
            value.stage !== claim.stage ||
            value.targetRegionId !== claim.publication.targetRegionId
          )
            throw Error('Destination unavailable');
          await bounded(runtime.authority.requireCurrent(value, tx));
          return value;
        },
        { isolationLevel: 'read committed' },
      );
    } catch {
      await this.finish(claim, 'suppressed', 'source_or_authority');
      return true;
    }
    let locator = nativeErrandLocator(claim.publication.orderId);
    // Optional shortlink sees only the verified route. Never accept an arbitrary
    // URL, credentials, other source ID or an unbound stale shortlink result.
    if (runtime.shortlinks) {
      try {
        const link = await bounded(runtime.shortlinks.resolve(locator));
        if (
          link?.nativeLocator === locator &&
          /^synthetic:\/\/errand\/[a-zA-Z0-9_-]{1,120}$/.test(link.locator)
        )
          locator = link.locator;
      } catch {
        /* Safe native route fallback. */
      }
    }
    let prepared;
    try {
      prepared = await bounded(
        runtime.sender.prepare(claim.idempotency_key, destination),
      );
    } catch {
      await this.finish(claim, 'retryable', 'unavailable');
      return true;
    }
    let permit: GroupPermit;
    try {
      permit = await this.db.transaction(
        async (tx) => {
          const publication = await this.records.current(claim, tx);
          registerTransactionDeadline(
            tx,
            claim.lease_until.getTime(),
            'ERRAND_UNAVAILABLE',
          );
          if (
            groupWindow(publication, claim.stage, businessTime(runtime)) !==
            'eligible'
          )
            throw new GroupWindowExpired('Window expired');
          await bounded(runtime.authority.requireCurrent(destination, tx));
          const payload = publicGroupPayloadSchema.parse({
            ...(await this.source.current(publication, claim.stage, tx)),
            locator,
          });
          // This process-local deadline includes final proof/COMMIT time. Normal
          // wrapper completes all deferred waits and current owner proofs first.
          return Object.freeze({
            attemptId: claim.attempt_id,
            fence: claim.fence,
            key: claim.idempotency_key,
            destination: Object.freeze({ ...destination }),
            payload: Object.freeze(payload),
            expiresAt: performance.now() + 100,
          });
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      await this.finish(
        claim,
        error instanceof GroupWindowExpired ? 'expired' : 'suppressed',
        error instanceof GroupWindowExpired ? 'window' : 'source_or_authority',
      );
      return true;
    }
    // No awaited operation between committed authorization and dispatch. This
    // is still NOT atomic with external acceptance; production remains closed.
    if (
      prepared.key !== permit.key ||
      prepared.destinationId !== permit.destination.id ||
      !Number.isFinite(prepared.expiresAt) ||
      performance.now() >= Math.min(permit.expiresAt, prepared.expiresAt) ||
      Date.now() >= claim.lease_until.getTime() ||
      groupWindow(claim.publication, claim.stage, businessTime(runtime)) !==
        'eligible'
    ) {
      await this.finish(claim, 'retryable', 'permit_expired');
      return true;
    }
    let ack: SyntheticAck;
    try {
      ack = prepared.dispatch(permit);
    } catch {
      await this.finish(claim, 'unknown', 'unknown');
      return true;
    }
    try {
      await this.acknowledge(claim, ack);
    } catch {
      await this.finish(claim, 'unknown', 'unknown');
    }
    return true;
  }
}
