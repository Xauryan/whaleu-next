import { extendLiveFixture } from './live-fixture.js';
/** Independent synthetic Major source/crosswalk acceptance; never production data. */
import { randomUUID } from 'node:crypto';
import { inTransaction } from '../../src/database/database.js';
import { directoryRuntimeFixture } from './directory-runtime-fixture.js';

export interface SyntheticMajor {
  id: string;
  revision: string;
  departmentId: number;
  collegeName: string;
  majorName: string;
  campusId: string;
  active: boolean;
}

export async function majorCatalogFixture(
  existing?: Awaited<ReturnType<typeof directoryRuntimeFixture>>,
) {
  const f = existing ?? (await directoryRuntimeFixture()),
    majors: SyntheticMajor[] = [];
  const add = (patch: Partial<SyntheticMajor> = {}): SyntheticMajor => ({
    id: randomUUID(),
    revision: randomUUID(),
    departmentId: 1,
    collegeName: 'Synthetic College',
    majorName: 'Synthetic Major ' + randomUUID().slice(0, 8),
    campusId: f.scope.home.campusId,
    active: true,
    ...patch,
  });
  const accept = async (
    rows: SyntheticMajor[],
    options: {
      coverage?: 'complete' | 'unknown';
      validUntil?: Date | string;
    } = {},
  ) =>
    inTransaction(f.pool, async (tx) => {
      const catalog = randomUUID();
      await tx.query(
        "INSERT INTO whaleu_majors.major_catalogs(id,source_namespace,source_reference,source_revision,coverage,scope_policy,policy_reference,valid_until) VALUES($1,'synthetic:major-fixture','synthetic:independent-major-directory',$2,$3,'authenticated_phone','synthetic:current-phone-authenticated-actors',$4)",
        [
          catalog,
          randomUUID(),
          options.coverage ?? 'complete',
          options.validUntil ?? new Date(Date.now() + 3600000),
        ],
      );
      for (const m of rows) {
        const sourceSchool = 'synthetic:source-school:' + m.campusId;
        await tx.query(
          "INSERT INTO whaleu_majors.major_identities(id,source_namespace,source_major_key,source_school_key,department_id,campus_id) VALUES($1,'synthetic:major-fixture',$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [m.id, 'synthetic:' + m.id, sourceSchool, m.departmentId, m.campusId],
        );
        await tx.query(
          "INSERT INTO whaleu_majors.major_entries(catalog_id,major_id,revision,department_id,college_name,major_name,is_active,campus_id,source_school_key,school_mapping_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'synthetic:independently-accepted-original-school-crosswalk')",
          [
            catalog,
            m.id,
            m.revision,
            m.departmentId,
            m.collegeName,
            m.majorName,
            m.active,
            m.campusId,
            sourceSchool,
          ],
        );
      }
      await tx.query(
        'INSERT INTO whaleu_majors.major_catalog_acceptances(catalog_id) VALUES($1)',
        [catalog],
      );
      await tx.query(
        "INSERT INTO whaleu_majors.major_catalog_head(singleton,catalog_id,state) VALUES(true,$1,'accepted') ON CONFLICT(singleton) DO UPDATE SET catalog_id=EXCLUDED.catalog_id,state='accepted'",
        [catalog],
      );
      majors.splice(0, majors.length, ...rows);
      return catalog;
    });
  return extendLiveFixture(f, { majors, add, accept });
}
