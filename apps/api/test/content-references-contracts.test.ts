import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  referenceCodeSchema,
  referenceResolveSchema,
  referenceLookupSchema,
  referenceDestinationSchema,
  referenceLookupResultSchema,
} from '../src/community/content-references/contracts.js';

test('reference wire contracts accept only whole ASCII seven-to-nine-digit codes and typed UUIDs', () => {
  for (const code of [
    '1000000',
    '9999999',
    '10000000',
    '99999999',
    '100000000',
    '999999999',
  ])
    assert.equal(referenceCodeSchema.safeParse(code).success, true);
  for (const code of [
    '123456',
    '1234567890',
    '01234567',
    '１２３４５６７',
    '١٢٣٤٥٦٧',
    '#1234567',
    ' 1234567',
    '1234567\n',
    1234567,
    null,
  ])
    assert.equal(
      referenceCodeSchema.safeParse(code).success,
      false,
      String(code),
    );
  const target = { kind: 'comment', targetId: randomUUID() };
  const viewSpaceId = randomUUID();
  assert.equal(
    referenceResolveSchema.parse({
      code: '1234567',
      viewSpaceId: viewSpaceId.toUpperCase(),
    }).viewSpaceId,
    viewSpaceId,
  );
  assert.equal(
    referenceLookupSchema.safeParse({ targets: [target] }).success,
    true,
  );
  assert.equal(referenceLookupSchema.safeParse({ targets: [] }).success, false);
  assert.equal(
    referenceLookupSchema.safeParse({ targets: Array(31).fill(target) })
      .success,
    false,
  );
  assert.equal(
    referenceLookupSchema.safeParse({ targets: [{ ...target, kind: 'root' }] })
      .success,
    false,
  );
  for (const extra of [
    { authorId: randomUUID() },
    { rootCommentId: randomUUID() },
    { isManager: true },
    { allocate: true },
  ]) {
    assert.equal(
      referenceResolveSchema.safeParse({ code: '12345678', ...extra }).success,
      false,
    );
    assert.equal(
      referenceLookupSchema.safeParse({ targets: [target], ...extra }).success,
      false,
    );
  }
  assert.deepEqual(
    referenceLookupSchema.parse({
      targets: [{ ...target, targetId: target.targetId.toUpperCase() }],
    }).targets,
    [target],
  );
});

test('reference navigation emits no canonical-alias identity, account or content fields', () => {
  const postId = randomUUID(),
    rootCommentId = randomUUID(),
    replyId = randomUUID();
  for (const output of [
    { kind: 'post', postId },
    { kind: 'comment', postId, rootCommentId },
    { kind: 'reply', postId, rootCommentId, replyId },
  ]) {
    assert.equal(referenceDestinationSchema.safeParse(output).success, true);
    for (const extra of [
      { canonicalCode: '12345678' },
      { resolvedFromAlias: true },
      { accountId: randomUUID() },
      { text: 'private' },
      { author: {} },
    ])
      assert.equal(
        referenceDestinationSchema.safeParse({ ...output, ...extra }).success,
        false,
      );
  }
  assert.equal(
    referenceDestinationSchema.safeParse({ kind: 'reply', postId, replyId })
      .success,
    false,
  );
  assert.equal(
    referenceLookupResultSchema.safeParse({
      items: [
        { kind: 'post', targetId: postId, code: '12345678', aliases: [] },
      ],
    }).success,
    false,
  );
});

test('additive schema preserves a single immutable reservation namespace and cannot activate production', async () => {
  const sql = await readFile(
    new URL(
      '../migrations/0171_community_content_references.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /code text COLLATE "C" PRIMARY KEY/);
  assert.match(sql, /FOREIGN KEY\(code,target_kind,target_id\)/);
  assert.match(
    sql,
    /content_reference_reservations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE/,
  );
  assert.match(
    sql,
    /content_reference_canonicals_immutable BEFORE UPDATE OR DELETE OR TRUNCATE/,
  );
  assert.match(sql, /VALUES\(true,'inactive'\)/);
  assert.match(sql, /source_kind text CHECK\(source_kind='synthetic'\)/);
  assert.doesNotMatch(sql, /nextval|CREATE SEQUENCE|DROP TABLE/);
  const immutableTables = sql.slice(
    sql.indexOf('CREATE TABLE whaleu_community.content_reference_reservations'),
    sql.indexOf('CREATE TABLE whaleu_community.content_reference_budgets'),
  );
  assert.doesNotMatch(
    immutableTables,
    /REFERENCES whaleu_identity|REFERENCES whaleu_community\.(posts|root_comments|replies)|ON DELETE CASCADE/,
  );
});
