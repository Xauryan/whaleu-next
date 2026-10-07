import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { inTransaction } from '../../database/database.js';
import {
  identifierAliasSchema,
  identifierSourceSchema,
  legacyCrosswalkSchema,
  schoolIdentifierSchema,
} from './contracts.js';
import type { IdentifierSnapshot } from './contracts.js';
import { planSchoolIdentifiers } from './planner.js';
import type { SchoolIdentifierPlan } from './planner.js';

const reviewColumns = {
  reviewedBy: 'reviewed_by',
  reviewedAt: 'reviewed_at',
  reviewNote: 'review_note',
};
const definitions = {
  sources: {
    table: 'school_identifier_sources',
    schema: identifierSourceSchema,
    columns: {
      id: 'id',
      title: 'title',
      publisher: 'publisher',
      url: 'url',
      publishedOn: 'published_on',
      retrievedAt: 'retrieved_at',
      contentSha256: 'content_sha256',
    },
  },
  mappings: {
    table: 'school_identifiers',
    schema: schoolIdentifierSchema,
    columns: {
      institutionId: 'institution_id',
      schoolCode: 'school_code',
      moeCode: 'moe_code',
      fiveDigitSourceId: 'five_digit_source_id',
      moeSourceId: 'moe_source_id',
      ...reviewColumns,
    },
  },
  aliases: {
    table: 'school_identifier_aliases',
    schema: identifierAliasSchema,
    columns: {
      scheme: 'scheme',
      scope: 'scope',
      value: 'value',
      institutionId: 'institution_id',
      validFrom: 'valid_from',
      validTo: 'valid_to',
      sourceId: 'source_id',
      ...reviewColumns,
    },
  },
  legacyCrosswalks: {
    table: 'school_legacy_crosswalks',
    schema: legacyCrosswalkSchema,
    columns: {
      sourceSystem: 'source_system',
      legacyRecordId: 'legacy_record_id',
      institutionId: 'institution_id',
      sourceId: 'source_id',
      ...reviewColumns,
    },
  },
} as const;
async function rows<T>(
  transaction: PoolClient,
  definition: {
    table: string;
    columns: Record<string, string>;
    schema: z.ZodType<T>;
  },
): Promise<T[]> {
  // Table/column definitions above are fixed trusted code, never manifest values.
  const fields = Object.entries(definition.columns)
    .map(([key, column]) => `'${key}', ${column}`)
    .join(', ');
  const result = await transaction.query<{ value: unknown }>(
    `SELECT jsonb_build_object(${fields}) AS value FROM whaleu_campus.${definition.table}`,
  );
  return result.rows.map(({ value }) => definition.schema.parse(value));
}
export async function readIdentifierSnapshot(
  transaction: PoolClient,
): Promise<IdentifierSnapshot> {
  return {
    institutionIds: (
      await transaction.query<{ id: string }>(
        'SELECT id FROM whaleu_campus.institutions ORDER BY id',
      )
    ).rows.map(({ id }) => id),
    sources: await rows(transaction, definitions.sources),
    mappings: await rows(transaction, definitions.mappings),
    aliases: await rows(transaction, definitions.aliases),
    legacyCrosswalks: await rows(transaction, definitions.legacyCrosswalks),
  };
}
export type MigrationMode = 'dry-run' | 'apply';
export interface SchoolMigrationResult extends SchoolIdentifierPlan {
  readonly mode: MigrationMode;
  readonly applied: boolean;
}
export async function migrateSchoolIdentifiers(
  pool: Pick<Pool, 'connect'>,
  manifest: unknown,
  mode: MigrationMode = 'dry-run',
): Promise<SchoolMigrationResult> {
  // Do not permit unexpected runtime strings to select the writable branch.
  if (mode !== 'dry-run' && mode !== 'apply')
    throw new Error('Invalid school migration mode');
  return inTransaction(pool, async (transaction) => {
    if (mode === 'dry-run')
      await transaction.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
    else {
      await transaction.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      // Serializes all registry writers including direct SQL INSERT/UPDATE/DELETE.
      // No source institution, campus, profile or legacy table is modified.
      await transaction.query(
        `LOCK TABLE whaleu_campus.school_identifier_sources, whaleu_campus.school_identifiers, whaleu_campus.school_identifier_aliases, whaleu_campus.school_legacy_crosswalks IN SHARE ROW EXCLUSIVE MODE`,
      );
    }
    const plan = planSchoolIdentifiers(
      manifest,
      await readIdentifierSnapshot(transaction),
    );
    if (!plan.ready || mode === 'dry-run')
      return { ...plan, mode, applied: false };
    for (const key of [
      'sources',
      'mappings',
      'aliases',
      'legacyCrosswalks',
    ] as const) {
      const definition = definitions[key];
      const keys = Object.keys(definition.columns);
      const columns = Object.values(definition.columns);
      for (const record of plan.additions[key]) {
        const values = keys.map(
          (key) => (record as unknown as Record<string, unknown>)[key],
        );
        await transaction.query(
          `INSERT INTO whaleu_campus.${definition.table} (${columns.join(', ')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(', ')})`,
          values,
        );
      }
    }
    return { ...plan, mode, applied: true };
  });
}
