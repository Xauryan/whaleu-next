import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type {
  ErrandRestrictionCount,
  ErrandRestrictionFilter,
  ErrandRestrictionPage,
  ErrandRestrictionSeek,
  StoredErrandRestriction,
  StoredErrandRestrictionEvent,
} from './contracts.js';
export const errandUtc = (field: string) =>
  `to_char((${field}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const from = `FROM whaleu_safety.errand_restriction_definitions d
 JOIN whaleu_safety.errand_restriction_heads h ON h.restriction_id=d.id
 JOIN whaleu_safety.errand_restriction_events e ON e.id=h.event_id`;
const state = `CASE WHEN e.kind='superseded' THEN 'superseded'
 WHEN e.kind='manually_released' OR d.baseline_released_at IS NOT NULL THEN 'released'
 WHEN d.ends_at IS NOT NULL AND d.ends_at<=$3::timestamptz THEN 'expired' ELSE 'active' END`;
const universe = `($1::uuid IS NULL OR d.subject_id=$1) AND ($2::text IS NULL OR d.action=$2)
 AND d.recorded_at<=$3::timestamptz`;
const predicate = `${universe} AND ($4='all' OR (${state})=$4)`;
const projection = `d.id,d.subject_id "subjectId",d.action,d.reason,
 ${errandUtc('d.starts_at')} "startsAt",${errandUtc('d.ends_at')} "endsAt",
 d.origin,${errandUtc('d.recorded_at')} "recordedAt",d.actor_id "actorId",
 d.source_order_id "sourceOrderId",(${state}) state,
 CASE WHEN e.kind IN ('manually_released','superseded') THEN
 jsonb_build_object('kind',e.kind,'eventId',e.id,'effectiveAt',${errandUtc('e.effective_at')},
 'reason',e.reason,'replacementRestrictionId',e.replacement_restriction_id)
 WHEN d.baseline_released_at IS NOT NULL THEN jsonb_build_object('kind','baseline_released','effectiveAt',${errandUtc('d.baseline_released_at')}) ELSE NULL END terminal`;
function values(filter: ErrandRestrictionFilter) {
  return [
    filter.subjectId ?? null,
    filter.action ?? null,
    filter.checkedAt,
    filter.state,
  ];
}
function limit(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 50)
    throw new ApplicationError('SAFETY_UNAVAILABLE');
  return value + 1;
}
/** Immutable definitions/events and exact heads are frozen by the caller's
 * shared common Safety gate. Mutable public display remains Profile-owned. */
export class ErrandRestrictionReader {
  async sourceVersion(tx: PoolClient): Promise<string> {
    return (
      await tx.query<{ version: string }>(
        'SELECT coalesce(max(sequence),0)::text version FROM whaleu_safety.errand_restriction_events',
      )
    ).rows[0]!.version;
  }
  async checkedAt(tx: PoolClient): Promise<string> {
    return (
      await tx.query<{ now: string }>(
        `SELECT ${errandUtc('clock_timestamp()')} now`,
      )
    ).rows[0]!.now;
  }
  async readRestriction(
    id: string,
    checkedAt: string,
    tx: PoolClient,
  ): Promise<StoredErrandRestriction | null> {
    return (
      (
        await tx.query<StoredErrandRestriction>(
          `SELECT ${projection} ${from} WHERE d.id=$1 AND d.recorded_at<=$3::timestamptz AND $2::text IS NULL`,
          [id, null, checkedAt],
        )
      ).rows[0] ?? null
    );
  }
  async listRestrictions(
    filter: ErrandRestrictionPage,
    tx: PoolClient,
  ): Promise<StoredErrandRestriction[]> {
    return (
      await tx.query<StoredErrandRestriction>(
        `SELECT ${projection} ${from} WHERE ${predicate}
 AND ($5::timestamptz IS NULL OR (d.recorded_at,d.id)<($5::timestamptz,$6::uuid))
 ORDER BY d.recorded_at DESC,d.id DESC LIMIT $7`,
        [
          ...values(filter),
          filter.after?.recordedAt ?? null,
          filter.after?.id ?? null,
          limit(filter.limit),
        ],
      )
    ).rows;
  }
  async restrictionHorizon(
    filter: Omit<ErrandRestrictionFilter, 'state'>,
    tx: PoolClient,
  ): Promise<string | null> {
    // Deliberately BEFORE the state filter: active facts can enter an initially
    // empty expired result without a write or epoch change.
    const row = (
      await tx.query<{ horizon: string | null }>(
        `SELECT ${errandUtc('min(d.ends_at)')} horizon ${from}
 WHERE ${universe} AND e.kind IN ('issued','observed_baseline')
 AND d.baseline_released_at IS NULL AND d.ends_at>$3::timestamptz`,
        [filter.subjectId ?? null, filter.action ?? null, filter.checkedAt],
      )
    ).rows[0]!;
    return row.horizon;
  }
  async countRestrictions(
    filter: ErrandRestrictionFilter,
    tx: PoolClient,
  ): Promise<ErrandRestrictionCount> {
    await tx.query('SAVEPOINT safety_errand_recorded_count');
    let result: ErrandRestrictionCount;
    try {
      const prior = (
        await tx.query<{ timeout: string }>(
          "SELECT current_setting('statement_timeout') timeout",
        )
      ).rows[0]!.timeout;
      await tx.query(
        "SELECT set_config('statement_timeout',CASE WHEN current_setting('statement_timeout')::interval=interval '0' OR current_setting('statement_timeout')::interval>interval '500 milliseconds' THEN '500ms' ELSE current_setting('statement_timeout') END,true)",
      );
      const row = (
        await tx.query<{ count: string }>(
          `SELECT count(*)::text count ${from} WHERE ${predicate}`,
          values(filter),
        )
      ).rows[0]!;
      if (!/^(0|[1-9][0-9]*)$/.test(row.count))
        throw new ApplicationError('SAFETY_UNAVAILABLE');
      result = { status: 'known', value: row.count };
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [prior]);
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT safety_errand_recorded_count');
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        !['57014', '55P03'].includes(String(error.code))
      )
        throw error;
      result = { status: 'unavailable' };
    }
    await tx.query('RELEASE SAVEPOINT safety_errand_recorded_count');
    return result;
  }
  async listEvents(
    id: string,
    page: { checkedAt: string; after?: ErrandRestrictionSeek; limit: number },
    tx: PoolClient,
  ): Promise<StoredErrandRestrictionEvent[]> {
    return (
      await tx.query<StoredErrandRestrictionEvent>(
        `SELECT e.id,e.kind,
 ${errandUtc('e.effective_at')} "effectiveAt",${errandUtc('e.recorded_at')} "recordedAt",e.reason,
 CASE WHEN e.kind='observed_baseline' THEN NULL ELSE c.actor_id END "actorId",
 e.replacement_restriction_id "replacementRestrictionId"
 FROM whaleu_safety.errand_restriction_events e JOIN whaleu_safety.errand_restriction_commands c ON c.id=e.command_id
 WHERE e.restriction_id=$1 AND e.recorded_at<=$2::timestamptz
 AND ($3::timestamptz IS NULL OR (e.recorded_at,e.sequence)<($3::timestamptz,(SELECT sequence FROM whaleu_safety.errand_restriction_events WHERE id=$4::uuid AND restriction_id=$1)))
 ORDER BY e.recorded_at DESC,e.sequence DESC LIMIT $5`,
        [
          id,
          page.checkedAt,
          page.after?.recordedAt ?? null,
          page.after?.id ?? null,
          limit(page.limit),
        ],
      )
    ).rows;
  }
}
