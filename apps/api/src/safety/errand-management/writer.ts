import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { errandUtc } from './reader.js';
import type {
  ErrandRestrictionAction,
  ErrandRestrictionContext,
  ErrandRestrictionDuration,
  ErrandRestrictionMutation,
} from './contracts.js';
interface Baseline {
  id: string;
  occurredAt: string;
  policyReference: string;
  validUntil: string | null;
}
interface Definition {
  id: string;
  subjectId: string;
  action: ErrandRestrictionAction;
  reason: string;
  startsAt: string;
  endsAt: string | null;
  eventId: string;
  active: boolean;
}
const unavailable = () => new ApplicationError('SAFETY_UNAVAILABLE');
/** Short ordinary row waits avoid account-lock -> Safety inversion with external
 * writers. This is not the target-absence proof and performs no external I/O. */
async function bounded<T>(tx: PoolClient, apply: () => Promise<T>): Promise<T> {
  const prior = (
    await tx.query<{ timeout: string }>(
      "SELECT current_setting('lock_timeout') timeout",
    )
  ).rows[0]!.timeout;
  await tx.query(
    "SELECT set_config('lock_timeout',CASE WHEN current_setting('lock_timeout')::interval=interval '0' OR current_setting('lock_timeout')::interval>interval '100 milliseconds' THEN '100ms' ELSE current_setting('lock_timeout') END,true)",
  );
  try {
    const result = await apply();
    await tx.query("SELECT set_config('lock_timeout',$1,true)", [prior]);
    return result;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (
        ['22003', '22008', '22015'].includes(String(error.code)) ||
        ('constraint' in error &&
          error.constraint === 'errand_restriction_duration_invalid')
      )
        throw new BadRequestException('Invalid errand restriction duration');
      if (
        ['55P03', '57014'].includes(String(error.code)) ||
        ('constraint' in error &&
          error.constraint === 'errand_restriction_unavailable')
      )
        throw unavailable();
    }
    throw error;
  }
}
function contextValid(context: ErrandRestrictionContext, release: boolean) {
  if (
    release
      ? context.kind !== 'global' || context.operation !== 'release'
      : context.operation === 'release'
  )
    throw unavailable();
  if (
    (context.kind === 'global' &&
      (context.orderId !== undefined ||
        context.targetRegionId !== undefined ||
        !['issue', 'release'].includes(context.operation))) ||
    (context.kind === 'order' &&
      (!context.orderId ||
        !context.targetRegionId ||
        !['admin_delete', 'restrict_accepter'].includes(context.operation)))
  )
    throw unavailable();
}
function durationValid(duration: ErrandRestrictionDuration) {
  if (duration.kind === 'permanent') return;
  if (
    duration.kind !== 'finite' ||
    !['hours', 'days'].includes(duration.unit) ||
    !Number.isSafeInteger(duration.value) ||
    duration.value <= 0
  )
    throw new BadRequestException('Invalid errand restriction duration');
}
export class ErrandRestrictionWriter {
  private async baseline(subjectId: string, tx: PoolClient): Promise<Baseline> {
    // Lock pointer first; then re-read immutable revision after any wait.
    const head = (
      await tx.query<{ snapshot_id: string }>(
        'SELECT snapshot_id FROM whaleu_safety.errand_feature_heads WHERE account_id=$1 FOR UPDATE',
        [subjectId],
      )
    ).rows[0];
    if (!head) throw unavailable();
    const row = (
      await tx.query<Baseline>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
 SELECT s.id,${errandUtc('instant.now')} "occurredAt",s.policy_reference "policyReference",
 ${errandUtc('s.valid_until')} "validUntil",
 whaleu_safety.require_errand_restriction_snapshot(s.id,s.account_id,instant.now) valid
 FROM whaleu_safety.errand_feature_snapshots s CROSS JOIN instant
 WHERE s.id=$1 AND s.account_id=$2 AND s.effective_at<instant.now`,
        [head.snapshot_id, subjectId],
      )
    ).rows[0];
    if (!row) throw unavailable();
    registerTransactionDeadline(
      tx,
      row.validUntil === null ? null : Date.parse(row.validUntil),
      'SAFETY_UNAVAILABLE',
    );
    return row;
  }
  private async command(
    context: ErrandRestrictionContext,
    subjectId: string,
    baseline: Baseline,
    tx: PoolClient,
  ): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_safety.errand_restriction_commands
 (id,actor_id,session_id,grant_id,request_id,kind,operation,order_id,target_region_id,subject_id,occurred_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        context.actorId,
        context.sessionId,
        context.grantId,
        context.requestId,
        context.kind,
        context.operation,
        context.orderId ?? null,
        context.targetRegionId ?? null,
        subjectId,
        baseline.occurredAt,
      ],
    );
    return id;
  }
  private async enroll(
    subjectId: string,
    baseline: Baseline,
    commandId: string,
    tx: PoolClient,
  ) {
    const conflict = (
      await tx.query<{ conflict: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM whaleu_safety.errand_feature_snapshots s
 CROSS JOIN LATERAL jsonb_array_elements(s.restrictions) f JOIN whaleu_safety.errand_restriction_definitions d ON d.id=(f->>'id')::uuid
 WHERE s.id=$1 AND (d.subject_id<>$2 OR (d.terms<>f AND NOT ((d.terms-'releasedAt')=(f-'releasedAt')
 AND EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_heads h JOIN whaleu_safety.errand_restriction_events e ON e.id=h.event_id
 WHERE h.restriction_id=d.id AND e.kind IN ('manually_released','superseded') AND (f->>'releasedAt')::timestamptz=e.effective_at))))) conflict`,
        [baseline.id, subjectId],
      )
    ).rows[0]!.conflict;
    if (conflict) throw unavailable();
    await tx.query(
      `INSERT INTO whaleu_safety.errand_restriction_definitions
 (id,subject_id,action,reason,starts_at,ends_at,baseline_released_at,origin,baseline_snapshot_id,command_id,terms,recorded_at)
 SELECT (f->>'id')::uuid,$2,f->>'action',f->>'reason',(f->>'startsAt')::timestamptz,(f->>'endsAt')::timestamptz,
 (f->>'releasedAt')::timestamptz,'baseline',$1,$3,f,$4
 FROM whaleu_safety.errand_feature_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.restrictions) f
 WHERE s.id=$1 AND NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_definitions known WHERE known.id=(f->>'id')::uuid) ON CONFLICT(id) DO NOTHING`,
      [baseline.id, subjectId, commandId, baseline.occurredAt],
    );
    await tx.query(
      `WITH inserted AS (
 INSERT INTO whaleu_safety.errand_restriction_events(id,restriction_id,kind,command_id,effective_at,recorded_at)
 SELECT gen_random_uuid(),id,'observed_baseline',$1,$2,$2 FROM whaleu_safety.errand_restriction_definitions
 WHERE command_id=$1 AND origin='baseline' RETURNING id,restriction_id)
 INSERT INTO whaleu_safety.errand_restriction_heads(restriction_id,event_id) SELECT restriction_id,id FROM inserted`,
      [commandId, baseline.occurredAt],
    );
    // Even an externally adopted complete envelope must retain every effective
    // known fact and cannot reactivate a terminal definition.
    const coherent = (
      await tx.query<{ coherent: boolean }>(
        `SELECT NOT EXISTS(
 SELECT 1 FROM whaleu_safety.errand_restriction_definitions d
 JOIN whaleu_safety.errand_restriction_heads h ON h.restriction_id=d.id
 JOIN whaleu_safety.errand_restriction_events e ON e.id=h.event_id
 WHERE d.subject_id=$2 AND e.kind IN ('issued','observed_baseline') AND d.baseline_released_at IS NULL
 AND (d.ends_at IS NULL OR d.ends_at>$3::timestamptz)
 AND NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_feature_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.restrictions) f WHERE s.id=$1 AND f=d.terms)) coherent`,
        [baseline.id, subjectId, baseline.occurredAt],
      )
    ).rows[0]!.coherent;
    if (!coherent) throw unavailable();
  }
  private async materialize(
    subjectId: string,
    baseline: Baseline,
    commandId: string,
    eventId: string,
    tx: PoolClient,
  ) {
    const snapshotId = randomUUID();
    const inserted = await tx.query(
      `INSERT INTO whaleu_safety.errand_feature_snapshots
 (id,account_id,coverage,provenance,source_reference,policy_reference,effective_at,valid_until,restrictions)
 SELECT $1,$2,'complete','accepted',s.source_reference,s.policy_reference,instant.now,s.valid_until,
 coalesce((SELECT jsonb_agg(d.terms ORDER BY d.id)
 FROM whaleu_safety.errand_restriction_definitions d JOIN whaleu_safety.errand_restriction_heads h ON h.restriction_id=d.id
 JOIN whaleu_safety.errand_restriction_events e ON e.id=h.event_id
 WHERE d.subject_id=$2 AND e.kind IN ('issued','observed_baseline') AND d.baseline_released_at IS NULL
 AND d.starts_at<=instant.now AND (d.ends_at IS NULL OR d.ends_at>instant.now)),'[]'::jsonb)
 FROM whaleu_safety.errand_feature_snapshots s CROSS JOIN LATERAL (SELECT clock_timestamp() now) instant
 WHERE s.id=$3 AND instant.now>s.effective_at AND (s.valid_until IS NULL OR s.valid_until>instant.now)`,
      [snapshotId, subjectId, baseline.id],
    );
    if (inserted.rowCount !== 1) throw unavailable();
    await tx.query(
      'INSERT INTO whaleu_safety.errand_restriction_materializations(snapshot_id,predecessor_snapshot_id,command_id,source_event_id) VALUES($1,$2,$3,$4)',
      [snapshotId, baseline.id, commandId, eventId],
    );
    await tx.query(
      'UPDATE whaleu_safety.errand_feature_heads SET snapshot_id=$2 WHERE account_id=$1 AND snapshot_id=$3',
      [subjectId, snapshotId, baseline.id],
    );
  }
  issue(
    context: ErrandRestrictionContext,
    input: {
      subjectId: string;
      action: ErrandRestrictionAction;
      reason: string;
      duration: ErrandRestrictionDuration;
    },
    tx: PoolClient,
  ): Promise<ErrandRestrictionMutation> {
    contextValid(context, false);
    durationValid(input.duration);
    if (context.kind === 'order' && input.action !== 'all') throw unavailable();
    return bounded(tx, async () => {
      const baseline = await this.baseline(input.subjectId, tx),
        commandId = await this.command(context, input.subjectId, baseline, tx);
      await this.enroll(input.subjectId, baseline, commandId, tx);
      const times = (
        await tx.query<{ endsAt: string | null }>(
          `SELECT ${errandUtc('whaleu_safety.errand_restriction_end($1::timestamptz,$2::jsonb)')} "endsAt"`,
          [baseline.occurredAt, JSON.stringify(input.duration)],
        )
      ).rows[0]!;
      const restrictionId = randomUUID(),
        eventId = randomUUID();
      const terms = {
        id: restrictionId,
        action: input.action,
        reason: input.reason,
        startsAt: baseline.occurredAt,
        endsAt: times.endsAt,
        releasedAt: null,
        provenance: 'accepted',
        issuer: 'whaleu:errand-management:v1',
        sourceReference: commandId,
        policyReference: baseline.policyReference,
      };
      await tx.query(
        `INSERT INTO whaleu_safety.errand_restriction_definitions(id,subject_id,action,reason,starts_at,ends_at,origin,actor_id,source_order_id,command_id,terms,recorded_at)
 VALUES($1,$2,$3,$4,$5,$6,'local',$7,$8,$9,$10,$5)`,
        [
          restrictionId,
          input.subjectId,
          input.action,
          input.reason,
          baseline.occurredAt,
          times.endsAt,
          context.actorId,
          context.orderId ?? null,
          commandId,
          JSON.stringify(terms),
        ],
      );
      await tx.query(
        `INSERT INTO whaleu_safety.errand_restriction_events(id,restriction_id,kind,command_id,effective_at,recorded_at,reason) VALUES($1,$2,'issued',$3,$4,$4,$5)`,
        [eventId, restrictionId, commandId, baseline.occurredAt, input.reason],
      );
      await tx.query(
        'INSERT INTO whaleu_safety.errand_restriction_heads(restriction_id,event_id) VALUES($1,$2)',
        [restrictionId, eventId],
      );
      await tx.query(
        `WITH terminal AS (
 INSERT INTO whaleu_safety.errand_restriction_events(id,restriction_id,kind,previous_event_id,command_id,replacement_restriction_id,effective_at,recorded_at)
 SELECT gen_random_uuid(),d.id,'superseded',h.event_id,$1,$2,$3,$3
 FROM whaleu_safety.errand_restriction_definitions d JOIN whaleu_safety.errand_restriction_heads h ON h.restriction_id=d.id
 JOIN whaleu_safety.errand_restriction_events e ON e.id=h.event_id
 WHERE d.subject_id=$4 AND d.action=$5 AND d.id<>$2 AND e.kind IN ('issued','observed_baseline')
 AND d.baseline_released_at IS NULL AND (d.ends_at IS NULL OR d.ends_at>$3::timestamptz)
 RETURNING id,restriction_id)
 UPDATE whaleu_safety.errand_restriction_heads h SET event_id=terminal.id FROM terminal WHERE h.restriction_id=terminal.restriction_id`,
        [
          commandId,
          restrictionId,
          baseline.occurredAt,
          input.subjectId,
          input.action,
        ],
      );
      const capacity = (
        await tx.query<{ count: string }>(
          `SELECT count(*)::text count FROM whaleu_safety.errand_restriction_definitions d
 JOIN whaleu_safety.errand_restriction_heads h ON h.restriction_id=d.id JOIN whaleu_safety.errand_restriction_events e ON e.id=h.event_id
 WHERE d.subject_id=$1 AND e.kind IN ('issued','observed_baseline') AND d.baseline_released_at IS NULL AND (d.ends_at IS NULL OR d.ends_at>$2::timestamptz)`,
          [input.subjectId, baseline.occurredAt],
        )
      ).rows[0]!.count;
      if (BigInt(capacity) > 256n) throw unavailable();
      await this.materialize(input.subjectId, baseline, commandId, eventId, tx);
      return {
        restrictionId,
        eventId,
        occurredAt: baseline.occurredAt,
        notice: {
          recipientAccountId: input.subjectId,
          kind: 'feature_restricted',
          restrictionId,
          eventId,
          action: input.action,
          reason: input.reason,
          startsAt: baseline.occurredAt,
          endsAt: times.endsAt,
          recordedAt: baseline.occurredAt,
        },
      };
    });
  }
  release(
    context: ErrandRestrictionContext,
    input: { restrictionId: string; reason: string },
    tx: PoolClient,
  ): Promise<ErrandRestrictionMutation> {
    contextValid(context, true);
    return bounded(tx, async () => {
      const candidates = (
        await tx.query<{ subjectId: string; knownActive: boolean }>(
          `SELECT d.subject_id "subjectId", e.kind IN ('issued','observed_baseline') AND d.baseline_released_at IS NULL AND (d.ends_at IS NULL OR d.ends_at>clock_timestamp()) "knownActive"
 FROM whaleu_safety.errand_restriction_definitions d JOIN whaleu_safety.errand_restriction_heads h ON h.restriction_id=d.id JOIN whaleu_safety.errand_restriction_events e ON e.id=h.event_id WHERE d.id=$1
 UNION SELECT h.account_id "subjectId",true "knownActive" FROM whaleu_safety.errand_feature_heads h
 JOIN whaleu_safety.errand_feature_snapshots s ON s.id=h.snapshot_id
 WHERE NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_definitions known WHERE known.id=$1)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.restrictions) f WHERE lower(f->>'id')=$1::text) LIMIT 2`,
          [input.restrictionId],
        )
      ).rows;
      if (candidates.length === 0)
        throw new ApplicationError('ERRAND_RESTRICTION_NOT_FOUND');
      if (candidates.length !== 1) throw unavailable();
      if (!candidates[0]!.knownActive)
        throw new ApplicationError('ERRAND_RESTRICTION_NOT_ACTIVE');
      const subjectId = candidates[0]!.subjectId;
      const baseline = await this.baseline(subjectId, tx);
      const commandId = await this.command(context, subjectId, baseline, tx);
      await this.enroll(subjectId, baseline, commandId, tx);
      const definition = (
        await tx.query<Definition>(
          `SELECT d.id,d.subject_id "subjectId",d.action,d.reason,
 ${errandUtc('d.starts_at')} "startsAt",${errandUtc('d.ends_at')} "endsAt",h.event_id "eventId",
 e.kind IN ('issued','observed_baseline') AND d.baseline_released_at IS NULL AND (d.ends_at IS NULL OR d.ends_at>$2::timestamptz) active
 FROM whaleu_safety.errand_restriction_definitions d JOIN whaleu_safety.errand_restriction_heads h ON h.restriction_id=d.id
 JOIN whaleu_safety.errand_restriction_events e ON e.id=h.event_id WHERE d.id=$1`,
          [input.restrictionId, baseline.occurredAt],
        )
      ).rows[0];
      if (!definition) throw unavailable();
      if (!definition.active)
        throw new ApplicationError('ERRAND_RESTRICTION_NOT_ACTIVE');
      const eventId = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_safety.errand_restriction_events(id,restriction_id,kind,previous_event_id,command_id,effective_at,recorded_at,reason)
 VALUES($1,$2,'manually_released',$3,$4,$5,$5,$6)`,
        [
          eventId,
          definition.id,
          definition.eventId,
          commandId,
          baseline.occurredAt,
          input.reason,
        ],
      );
      await tx.query(
        'UPDATE whaleu_safety.errand_restriction_heads SET event_id=$2 WHERE restriction_id=$1',
        [definition.id, eventId],
      );
      await this.materialize(
        definition.subjectId,
        baseline,
        commandId,
        eventId,
        tx,
      );
      return {
        restrictionId: definition.id,
        eventId,
        occurredAt: baseline.occurredAt,
        notice: {
          recipientAccountId: definition.subjectId,
          kind: 'feature_released',
          restrictionId: definition.id,
          eventId,
          action: definition.action,
          reason: input.reason,
          startsAt: definition.startsAt,
          endsAt: definition.endsAt,
          releasedAt: baseline.occurredAt,
          recordedAt: baseline.occurredAt,
        },
      };
    });
  }
}
