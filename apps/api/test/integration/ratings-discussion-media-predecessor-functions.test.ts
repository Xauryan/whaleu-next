/** Real accepted-schema upgrade: predecessor code keeps function-local names,
 * recursive/cross-function dispatch and every execution/security attribute. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
const names = [
  ['whaleu_ratings', 'scoped_context_record_digest'],
  ['whaleu_ratings', 'scoped_context_current'],
  ['whaleu_ratings', 'scoped_intent_valid'],
  ['whaleu_ratings', 'scoped_intent_hash'],
  ['whaleu_ratings', 'scoped_preparation_envelope'],
  ['whaleu_ratings', 'rating_scoped_operation_rule'],
  ['whaleu_community', 'rating_envelope_shape'],
  ['whaleu_community', 'rating_scoped_parent_review_current'],
  ['whaleu_ratings', 'verify_scoped_content'],
  ['whaleu_ratings', 'scoped_command_parents_current'],
] as const;
interface FunctionRow {
  source: string;
  attributes: unknown;
}
test('0082 to discussion upgrade preserves all ten predecessor function bodies and execution attributes', async (t) => {
  const f = await directoryRuntimeFixture(82);
  t.after(() => f.close());
  const read = async (schema: string, name: string) => {
    const rows = (
      await f.pool.query<FunctionRow>(
        `SELECT p.prosrc source,
      jsonb_build_object('language',l.lanname,'kind',p.prokind,'owner',p.proowner::text,'acl',p.proacl,'securityDefiner',p.prosecdef,
      'leakproof',p.proleakproof,'strict',p.proisstrict,'returnsSet',p.proretset,
      'volatility',p.provolatile,'parallel',p.proparallel,'config',p.proconfig,
      'arguments',p.proargtypes::text,'argumentNames',p.proargnames,'returnType',p.prorettype::text,
      'cost',p.procost,'rows',p.prorows) attributes
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
      WHERE n.nspname=$1 AND p.proname=$2`,
        [schema, name],
      )
    ).rows;
    assert.equal(rows.length, 1, `${schema}.${name}`);
    return rows[0]!;
  };
  const before = await Promise.all(
    names.map(([schema, name]) => read(schema, name)),
  );
  for (const [index, [, name]] of names.entries()) {
    assert.doesNotMatch(
      before[index]!.source,
      new RegExp(`\\b${name}\\s*\\(`),
      `${name}: no hidden recursive call to a replaced public dispatcher`,
    );
    const qualifiers = [
      ...before[index]!.source.matchAll(
        new RegExp(`\\b${name}\\.([a-z_]+)`, 'g'),
      ),
    ].map((match) => match[1]);
    assert.deepEqual(
      qualifiers,
      name === 'verify_scoped_content' ? ['kind'] : [],
      `${name}: exact predecessor-local qualifiers`,
    );
  }
  await runMigrations(
    f.pool,
    await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    ),
    { mode: 'up' },
  );
  for (const [index, [schema, name]] of names.entries()) {
    const previous = before[index]!,
      clone = await read(schema, `${name}_pre_discussion_media`);
    assert.deepEqual(
      clone.attributes,
      previous.attributes,
      `${name}: LANGUAGE/SECURITY/SEARCH_PATH/strictness/volatility/signature preserved`,
    );
    assert.equal(
      clone.source,
      name === 'verify_scoped_content'
        ? previous.source.replaceAll(
            'verify_scoped_content.kind',
            'verify_scoped_content_pre_discussion_media.kind',
          )
        : previous.source,
      `${name}: all cross-function calls and code preserved except the exact local block qualifier`,
    );
  }
});
