import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import type { RatingContentReviewFacade } from '../src/community/content-review/rating-content-review.facade.js';
import { RatingsRepository } from '../src/ratings/repository.js';
import {
  currentRatingTargetRow,
  ratingCurrentTargetColumns,
  ratingCurrentTargetDefinitionJoins,
  sameRatingTargetDefinition,
  type CurrentTargetRead,
} from '../src/ratings/target-definition.repository.js';
import { qualifyCurrentRatingTarget } from '../src/ratings/target-projection.facade.js';
import {
  checkTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fails = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;

function definitionRead(version = 1): CurrentTargetRead {
  const envelope = {
    accountId: id(2),
    clientRequestId: id(3),
    targetId: id(1),
    targetRevision: id(4),
    categoryId: id(5),
    categoryRevision: id(6),
    catalogRevision: id(7),
    scope: { regionId: null },
    assetIds: [],
    name: version === 1 ? 'Creation definition' : 'Edited definition',
    description: version === 1 ? 'Creation description' : 'Edited description',
  };
  return {
    id: id(1),
    revision: id(8),
    category_id: id(5),
    creator_id: id(2),
    region_id: null,
    active: true,
    name: envelope.name,
    description: envelope.description,
    envelope:
      version === 1
        ? { ...envelope, version: 1, purpose: 'publish_rating_target' }
        : {
            ...envelope,
            version: 3,
            purpose: 'edit_rating_target',
            previousTargetRevision: id(9),
            previousDefinitionRevision: id(10),
            definitionRevision: id(11),
            contentVersion: version,
          },
    content_version: version,
    definition_revision: version === 1 ? id(4) : id(11),
    applied_target_revision: id(4),
    definition_target_id: id(1),
    lifecycle_target_revision: id(8),
    owner_deleted: false,
  };
}

test('current v1 and edited definitions use their publication anchor across ordinary lifecycle changes', () => {
  for (const version of [1, 2, 3]) {
    const source = definitionRead(version);
    const row = currentRatingTargetRow(source);
    assert.equal(row.definition.contentVersion, version);
    assert.equal(row.revision, id(8));
    assert.equal(row.definition.appliedTargetRevision, id(4));
    assert.equal(row.name, source.name);
    assert.equal(row.description, source.description);
    assert.equal(row.envelope, row.definition.envelope);
    assert.ok(Object.isFrozen(row.definition));
    assert.equal(
      sameRatingTargetDefinition(row.definition, row.definition),
      true,
    );
    assert.equal(
      sameRatingTargetDefinition(row.definition, {
        ...row.definition,
        definitionRevision: id(100),
      }),
      false,
    );
  }
});

test('head, exact version and lifecycle mapping absence never fall back to creation text', () => {
  for (const column of [
    'content_version',
    'definition_revision',
    'applied_target_revision',
    'definition_target_id',
    'lifecycle_target_revision',
    'name',
    'description',
    'envelope',
  ] as const) {
    const source = definitionRead(2);
    source[column] = null;
    assert.throws(
      () => currentRatingTargetRow(source),
      fails('RATING_UNAVAILABLE'),
    );
  }
  assert.match(
    ratingCurrentTargetColumns,
    /d\.name,d\.description,d\.envelope/,
  );
  assert.doesNotMatch(
    ratingCurrentTargetColumns,
    /t\.(name|description|envelope)|coalesce/i,
  );
  for (const table of ['heads', 'versions', 'lifecycles'])
    assert.ok(
      ratingCurrentTargetDefinitionJoins.includes(
        `LEFT JOIN whaleu_ratings.target_definition_${table}`,
      ),
    );
});

test('immutable identity, canonical text, publication and definition tuple substitutions fail closed', () => {
  const changes: Partial<CurrentTargetRead>[] = [
    { id: id(100) },
    { creator_id: id(100) },
    { category_id: id(100) },
    { region_id: id(100) },
    { revision: id(100) },
    { definition_target_id: id(100) },
    { definition_revision: id(100) },
    { applied_target_revision: id(100) },
    { content_version: 3 },
    { name: 'Old text' },
    { description: 'Old description' },
    { active: false },
    { owner_deleted: true },
  ];
  for (const change of changes)
    assert.throws(
      () => currentRatingTargetRow({ ...definitionRead(2), ...change }),
      fails('RATING_UNAVAILABLE'),
    );
});

test('one public qualification gate uses the exact current descriptor and never the old target shortcut', async () => {
  const row = currentRatingTargetRow(definitionRead(2));
  const tx = {} as PoolClient;
  const catalog = { id: id(7), regionId: null };
  let decision = 'allow';
  const calls: unknown[][] = [];
  const records = {
    target: async (...args: unknown[]) => {
      calls.push(args);
      return { row };
    },
  } as unknown as RatingsRepository;
  const review = {
    current: async () =>
      assert.fail('v1-only target Review must not be called'),
    currentTargetDefinition: async (...args: unknown[]) => {
      calls.push(args);
      return { kind: decision };
    },
  } as unknown as RatingContentReviewFacade;
  assert.equal(
    (
      await qualifyCurrentRatingTarget(
        records,
        review,
        catalog,
        row.id,
        tx,
        true,
      )
    ).row,
    row,
  );
  assert.deepEqual(calls, [
    [catalog, row.id, tx, true],
    [row.definition, tx],
  ]);
  decision = 'deny';
  await assert.rejects(
    qualifyCurrentRatingTarget(records, review, catalog, row.id, tx),
    fails('RATING_NOT_FOUND'),
  );
  decision = 'unavailable';
  await assert.rejects(
    qualifyCurrentRatingTarget(records, review, catalog, row.id, tx),
    fails('CONTENT_REVIEW_UNAVAILABLE'),
  );
});

function repositoryFixture() {
  const state = {
    current: definitionRead(2),
    epoch: '0',
    pendingWriter: false,
    proofCount: 1,
    membership: true,
  };
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '5s',
              lock_timeout: '1s',
            },
          ],
        };
      if (sql.includes('set_config') || sql.startsWith('SET CONSTRAINTS'))
        return { rows: [] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      if (sql.startsWith('LOCK TABLE')) {
        if (state.pendingWriter)
          throw Object.assign(new Error('pending definition writer'), {
            code: '55P03',
          });
        return { rows: [] };
      }
      if (sql.includes('FROM whaleu_ratings.navigation_epoch'))
        return { rows: [{ epoch: state.epoch }] };
      if (sql.includes('FROM whaleu_ratings.target_memberships'))
        return { rows: state.membership ? [{ category_id: id(5) }] : [] };
      if (sql.includes('catalog_category_lineage')) {
        assert.equal(values[0], id(7));
        assert.deepEqual(values[1], [id(5)]);
        return {
          rows: [
            {
              ordinal: 1,
              lineage: {
                source_kind: 'opaque',
                effective_revision: id(6),
                base_revision: null,
                scope_version_id: null,
                topology_snapshot_id: null,
              },
              base: null,
              head_revision: null,
              source_scope: null,
            },
          ],
        };
      }
      if (sql.includes('WITH RECURSIVE path AS'))
        return {
          rows: [
            {
              id: id(5),
              revision: id(6),
              parent_id: null,
              level: 1,
              active: true,
              hidden: false,
            },
          ],
        };
      if (sql.startsWith('SELECT t.id,t.revision'))
        return { rows: [structuredClone(state.current)] };
      if (
        sql.includes(
          'f(id,revision,content_version,definition_revision,applied_target_revision)',
        )
      )
        return { rows: [{ n: state.proofCount }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const repository = new RatingsRepository();
  repository.enable(tx);
  return {
    state,
    calls,
    tx,
    repository,
    catalog: { id: id(7), regionId: null },
  };
}

test('single-item final proof retains exact head, publication anchor, map and tombstone with bounded typed arrays', async () => {
  const f = repositoryFixture();
  const { row } = await f.repository.target(f.catalog, id(1), f.tx);
  assert.equal(row.name, 'Edited definition');
  await checkTransactionDeadlines(f.tx);
  const proof = f.calls.find(({ sql }) =>
    sql.includes(
      'f(id,revision,content_version,definition_revision,applied_target_revision)',
    ),
  )!;
  assert.deepEqual(proof.values, [[id(1)], [id(8)], [2], [id(11)], [id(4)]]);
  assert.match(proof.sql, /target_definition_heads/);
  assert.match(proof.sql, /target_definition_versions/);
  assert.match(proof.sql, /target_definition_lifecycles/);
  assert.match(
    proof.sql,
    /NOT EXISTS\(SELECT 1 FROM whaleu_ratings.target_owner_tombstones/,
  );
  assert.doesNotMatch(proof.sql, /FOR SHARE|FOR UPDATE/);
  assert.ok(
    f.calls.some(
      ({ sql }) =>
        sql ===
        'LOCK TABLE whaleu_ratings.navigation_epoch IN SHARE MODE NOWAIT',
    ),
  );
});

test('changed or pending definition writer invalidates the read and absence remains epoch-observed', async () => {
  for (const mode of ['epoch', 'tuple', 'pending'] as const) {
    const f = repositoryFixture();
    await f.repository.target(f.catalog, id(1), f.tx);
    if (mode === 'epoch') f.state.epoch = '1';
    if (mode === 'tuple') f.state.proofCount = 0;
    if (mode === 'pending') f.state.pendingWriter = true;
    await assert.rejects(
      checkTransactionDeadlines(f.tx),
      fails('RATING_UNAVAILABLE'),
    );
  }
  const absent = repositoryFixture();
  absent.state.membership = false;
  await assert.rejects(
    absent.repository.target(absent.catalog, id(1), absent.tx),
    fails('RATING_NOT_FOUND'),
  );
  absent.state.epoch = '1';
  await assert.rejects(
    checkTransactionDeadlines(absent.tx),
    fails('RATING_UNAVAILABLE'),
  );
  const deleted = repositoryFixture();
  deleted.state.current.owner_deleted = true;
  deleted.state.current.name = null;
  await assert.rejects(
    deleted.repository.target(deleted.catalog, id(1), deleted.tx),
    fails('RATING_NOT_FOUND'),
  );
});
