import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { courseOwnSchema, courseSummarySchema } from './contracts.js';
import type {
  CourseQuery,
  CourseFirstScore,
  CourseReceipt,
} from './contracts.js';
import type { CoursePosition } from './cursor.js';
import { currentHistory } from './proof.js';
export interface CourseRow {
  course_id: string;
  revision: string;
  name: string;
  department: number;
  category: string | null;
  nature: string | null;
  code: string | null;
  campus_id: string;
  source_campus_key: string;
  campus_label: string;
  source_created_at: Date;
  sort_value: string | null;
}
@Injectable()
export class CourseRepository {
  async course(catalog: string, id: string, tx: PoolClient) {
    const row = (
      await tx.query<CourseRow>(
        'SELECT * FROM whaleu_ratings.course_entries WHERE catalog_id=$1 AND course_id=$2',
        [catalog, id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('COURSE_NOT_FOUND');
    return row;
  }
  async orderingDeadline(
    catalog: string,
    q: CourseQuery,
    tx: PoolClient,
  ): Promise<Date | null> {
    // A time-only history transition can reorder a candidate outside this page.
    // Bind the continuation to the earliest transition across the WHOLE filtered
    // accepted catalog, not just visible rows or a guessed larger page budget.
    return (
      await tx.query<{ until: Date | null }>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT min(boundary.value) until FROM whaleu_ratings.course_entries e JOIN whaleu_ratings.course_history_heads h ON h.course_id=e.course_id JOIN whaleu_ratings.course_history_assertions a ON a.id=h.assertion_id CROSS JOIN instant CROSS JOIN LATERAL (VALUES(a.accepted_at),(a.valid_until)) boundary(value) WHERE e.catalog_id=$1 AND a.coverage='accepted_empty' AND boundary.value>instant.now AND ($2::text IS NULL OR position(lower($2) in lower(e.name))>0) AND ($3::integer IS NULL OR ($3=99 AND e.department BETWEEN 90 AND 99) OR ($3<>99 AND e.department=$3)) AND ($4::text IS NULL OR e.category=$4)`,
        [catalog, q.search || null, q.department ?? null, q.category ?? null],
      )
    ).rows[0]!.until;
  }
  async page(
    catalog: string,
    q: CourseQuery,
    after: CoursePosition | null,
    tx: PoolClient,
  ) {
    // Legacy department99 is EXACTLY executable range90–99, not a campus guess.
    // Search intentionally matches only name, never code/department.
    const sort =
      q.sort === 'rating'
        ? `CASE WHEN a.coverage='accepted_empty' AND a.accepted_at<=clock_timestamp() AND a.valid_until>clock_timestamp() THEN totals.mean END`
        : `(extract(epoch FROM e.source_created_at)*1000000)::bigint::numeric`;
    return (
      await tx.query<CourseRow>(
        `WITH directory AS (SELECT e.*,${sort} sort_number FROM whaleu_ratings.course_entries e LEFT JOIN whaleu_ratings.course_history_heads h ON h.course_id=e.course_id LEFT JOIN whaleu_ratings.course_history_assertions a ON a.id=h.assertion_id LEFT JOIN LATERAL (SELECT round(avg(s.overall_half_units)::numeric/2,1) mean FROM whaleu_ratings.course_scores s WHERE s.course_id=e.course_id) totals ON true WHERE e.catalog_id=$1 AND ($2::text IS NULL OR position(lower($2) in lower(e.name))>0) AND ($3::integer IS NULL OR ($3=99 AND e.department BETWEEN 90 AND 99) OR ($3<>99 AND e.department=$3)) AND ($4::text IS NULL OR e.category=$4)) SELECT *,sort_number::text sort_value FROM directory WHERE $5::uuid IS NULL OR ($6::numeric IS NULL AND sort_number IS NULL AND course_id<$5) OR ($6::numeric IS NOT NULL AND (sort_number<$6 OR sort_number IS NULL OR (sort_number=$6 AND course_id<$5))) ORDER BY sort_number DESC NULLS LAST,course_id DESC LIMIT $7`,
        [
          catalog,
          q.search || null,
          q.department ?? null,
          q.category ?? null,
          after?.id ?? null,
          after?.value ?? null,
          q.limit + 1,
        ],
      )
    ).rows;
  }
  async summary(id: string, tx: PoolClient) {
    if (!(await currentHistory(id, tx)))
      return courseSummarySchema.parse({ kind: 'unavailable' });
    const row = (
      await tx.query<{
        count: string;
        grade: string | null;
        ability: string | null;
        overall: string | null;
      }>(
        'SELECT count(*)::text count,round(avg(grade_half_units)::numeric/2,1)::text grade,round(avg(ability_half_units)::numeric/2,1)::text ability,round(avg(overall_half_units)::numeric/2,1)::text overall FROM whaleu_ratings.course_scores WHERE course_id=$1',
        [id],
      )
    ).rows[0]!;
    return courseSummarySchema.parse({
      kind: 'known',
      count: Number(row.count),
      gradeScore: row.grade === null ? null : Number(row.grade),
      abilityScore: row.ability === null ? null : Number(row.ability),
      overallScore: row.overall === null ? null : Number(row.overall),
    });
  }
  async score(id: string, actor: string, tx: PoolClient) {
    return (
      await tx.query<{
        grade_half_units: number;
        ability_half_units: number;
        overall_half_units: number;
        recorded_at: Date;
      }>(
        'SELECT grade_half_units,ability_half_units,overall_half_units,recorded_at FROM whaleu_ratings.course_scores WHERE course_id=$1 AND actor_id=$2',
        [id, actor],
      )
    ).rows[0];
  }
  async own(id: string, actor: string, tx: PoolClient) {
    const row = await this.score(id, actor, tx);
    if (row)
      return courseOwnSchema.parse({
        kind: 'recorded',
        gradeScore: row.grade_half_units / 2,
        abilityScore: row.ability_half_units / 2,
        overallScore: row.overall_half_units / 2,
        recordedAt: row.recorded_at.toISOString(),
      });
    return courseOwnSchema.parse({
      kind: (await currentHistory(id, tx)) ? 'not_submitted' : 'unavailable',
    });
  }
  async prior(actor: string, key: string, tx: PoolClient) {
    return (
      await tx.query<{ intent_hash: string; receipt: unknown }>(
        'SELECT intent_hash,receipt FROM whaleu_ratings.course_commands WHERE actor_id=$1 AND request_id=$2',
        [actor, key],
      )
    ).rows[0];
  }
  async record(
    actor: string,
    id: string,
    command: CourseFirstScore,
    hash: string,
    receipt: CourseReceipt,
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_ratings.course_commands(actor_id,request_id,course_id,command,intent_hash,receipt) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb)',
      [
        actor,
        command.clientRequestId,
        id,
        JSON.stringify(command),
        hash,
        JSON.stringify(receipt),
      ],
    );
  }
}
