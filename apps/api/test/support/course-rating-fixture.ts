/** Explicit synthetic source acceptance and independent known-empty baseline.
 * No provider activation, fake production seed or replacement business owner. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import { directoryRuntimeFixture } from './directory-runtime-fixture.js';
export interface SyntheticCourse {
  id: string;
  revision: string;
  name: string;
  department: number;
  category: string | null;
  campusId: string;
  history: 'accepted_empty' | 'unknown';
}
export async function courseHistory(
  pool: Pool,
  id: string,
  coverage: 'accepted_empty' | 'unknown',
  until = new Date(Date.now() + 3600000),
) {
  return inTransaction(pool, async (tx) =>
    writeHistory(tx, id, coverage, until),
  );
}
async function writeHistory(
  tx: PoolClient,
  id: string,
  coverage: 'accepted_empty' | 'unknown',
  until: Date,
) {
  const assertion = randomUUID();
  await tx.query(
    "INSERT INTO whaleu_ratings.course_history_assertions(id,course_id,coverage,source_reference,policy_reference,valid_until) VALUES($1,$2,$3,'synthetic:separate-empty-history-audit','synthetic:no-prior-course-tuples',$4)",
    [assertion, id, coverage, until],
  );
  await tx.query(
    'INSERT INTO whaleu_ratings.course_history_heads(course_id,assertion_id) VALUES($1,$2) ON CONFLICT(course_id) DO UPDATE SET assertion_id=EXCLUDED.assertion_id',
    [id, assertion],
  );
  return assertion;
}
export async function courseRatingFixture() {
  const f = await directoryRuntimeFixture();
  const courses: SyntheticCourse[] = [];
  const add = (patch: Partial<SyntheticCourse> = {}): SyntheticCourse => ({
    id: randomUUID(),
    revision: randomUUID(),
    name: 'Synthetic Course ' + randomUUID().slice(0, 8),
    department: 1,
    category: 'Synthetic Category',
    campusId: f.scope.home.campusId,
    history: 'accepted_empty',
    ...patch,
  });
  const accept = async (
    rows: SyntheticCourse[],
    options: { coverage?: 'complete' | 'unknown'; validUntil?: Date } = {},
  ) =>
    inTransaction(f.pool, async (tx) => {
      const catalog = randomUUID();
      await tx.query(
        "INSERT INTO whaleu_ratings.course_catalogs(id,source_namespace,source_reference,source_revision,coverage,scope_policy,policy_reference,valid_until) VALUES($1,'synthetic:course-fixture','synthetic:accepted-directory',$2,$3,'authenticated_phone','synthetic:all-current-phone-authenticated-actors',$4)",
        [
          catalog,
          randomUUID(),
          options.coverage ?? 'complete',
          options.validUntil ?? new Date(Date.now() + 3600000),
        ],
      );
      for (const [i, c] of rows.entries()) {
        await tx.query(
          "INSERT INTO whaleu_ratings.course_identities(id,source_namespace,source_course_key) VALUES($1,'synthetic:course-fixture',$2) ON CONFLICT DO NOTHING",
          [c.id, 'synthetic:' + c.id],
        );
        await tx.query(
          "INSERT INTO whaleu_ratings.course_entries(catalog_id,course_id,revision,name,department,category,nature,code,campus_id,source_campus_key,campus_label,campus_mapping_reference,source_created_at) VALUES($1,$2,$3,$4,$5,$6,'Synthetic Nature',$7,$8,'synthetic:source-campus','Synthetic Campus','synthetic:explicit-crosswalk',$9)",
          [
            catalog,
            c.id,
            c.revision,
            c.name,
            c.department,
            c.category,
            'SYNTH-' + i,
            c.campusId,
            new Date(Date.UTC(2020, 0, 1, 0, 0, i)),
          ],
        );
        if (
          !(
            await tx.query(
              'SELECT 1 FROM whaleu_ratings.course_history_heads WHERE course_id=$1',
              [c.id],
            )
          ).rowCount
        )
          await writeHistory(
            tx,
            c.id,
            c.history,
            new Date(Date.now() + 3600000),
          );
      }
      await tx.query(
        'INSERT INTO whaleu_ratings.course_catalog_acceptances(catalog_id) VALUES($1)',
        [catalog],
      );
      await tx.query(
        "INSERT INTO whaleu_ratings.course_catalog_head(singleton,catalog_id,state) VALUES(true,$1,'accepted') ON CONFLICT(singleton) DO UPDATE SET catalog_id=EXCLUDED.catalog_id,state='accepted'",
        [catalog],
      );
      courses.splice(0, courses.length, ...rows);
      return catalog;
    });
  const command = (
    catalog: string,
    course: SyntheticCourse,
    patch: Record<string, unknown> = {},
  ) => ({
    clientRequestId: randomUUID(),
    expectedCatalogRevision: catalog,
    expectedCourseRevision: course.revision,
    gradeScore: 0.5,
    abilityScore: 3,
    overallScore: 5,
    ...patch,
  });
  return { ...f, courses, add, accept, command };
}
