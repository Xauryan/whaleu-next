import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { publishPostSchema } from '../src/community/contracts.js';
import { postIntent } from '../src/community/publication-intent.js';
import { publicationHash } from '../src/community/publication.repository.js';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalJson,
} from '../src/community/content-review/contracts.js';
import {
  ratingTargetBindingSchema,
  ratingTargetLinkViewSchema,
  reviewedRatingTargetLinkSchema,
} from '../src/community/rating-target-link/contracts.js';
import { RatingTargetLinkFacade } from '../src/ratings/target-link/facade.js';
import type { RatingScopedContextService } from '../src/ratings/scoped/context.service.js';
import type { RatingScopedRepository } from '../src/ratings/scoped/repository.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { TextReviewRuntime } from '../src/community/text-review/runtime.js';
import { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import { loadConfig } from '../src/config/config.js';
const id = () => randomUUID();
const actor = id(),
  space = id(),
  region = id(),
  campus = id(),
  category = id(),
  target = id();
function fixture() {
  const revision = id();
  const b = ratingTargetBindingSchema.parse({
    version: 1,
    targetId: target,
    categoryId: category,
    targetRevision: id(),
    definitionRevision: id(),
    contentVersion: 1,
    originSourceId: id(),
    sourceId: id(),
    sourceRevision: id(),
    placementRevision: id(),
    categoryRevision: revision,
    catalogId: id(),
    headRevision: id(),
    protocolGeneration: id(),
    sourceDigest: 'a'.repeat(64),
    selector: { kind: 'campus', campusId: campus },
    originRegionId: region,
    systemKey: 'course',
    ancestry: [{ categoryId: category, revision }],
  });
  const component = {
    kind: 'rating_target_link' as const,
    targetId: target,
    label: '这门课程怎么样？',
    selector: b.selector,
    expectedTargetRevision: b.targetRevision,
    expectedCategoryRevision: b.categoryRevision,
    expectedSourceRevision: b.sourceRevision,
  };
  const body = publishPostSchema.parse({
    clientRequestId: id(),
    spaceId: space,
    category: 'discussion',
    text: 'Original reviewed discussion',
    imageAssetIds: [],
    authorMode: 'named',
    component,
  });
  const envelope = canonicalEnvelope({
    version: 5,
    accountId: actor,
    purpose: 'publish_post',
    spaceId: space,
    category: 'discussion',
    authorMode: 'named',
    commentsPolicy: 'open',
    postId: null,
    rootCommentId: null,
    targetReplyId: null,
    text: body.text,
    images: [],
    component: {
      kind: 'rating_target_link',
      targetId: target,
      label: component.label,
      binding: b,
    },
    trading: null,
    scope: {
      originalSpaceId: space,
      originalRegionId: region,
      authorOriginRegionId: region,
      identityRegionId: region,
      topologySnapshotId: id(),
      sync: 'none',
    },
  });
  return { b, component, body, envelope };
}
test('v5 is explicit, strict, one text-only regional discussion; labels count Unicode scalar values', () => {
  const f = fixture();
  assert.equal(f.envelope.version, 5);
  for (const patch of [
    { category: 'confession' },
    { imageAssetIds: [id()] },
    { syncToRelatedCampuses: true },
    { allowAnonymousDm: false },
    { component: { ...f.component, name: 'forged' } },
    { component: { ...f.component, label: '界'.repeat(13) } },
    { component: { ...f.component, label: 'two\nlines' } },
    { component: { ...f.component, label: '\u202Ehidden' } },
  ])
    assert.equal(
      publishPostSchema.safeParse({ ...f.body, ...patch }).success,
      false,
    );
  assert.equal(
    publishPostSchema.safeParse({
      ...f.body,
      component: { ...f.component, label: '𠮷'.repeat(12) },
    }).success,
    true,
  );
  for (const label of ['a\u2028b', 'a\u2029b']) {
    assert.equal(
      publishPostSchema.safeParse({
        ...f.body,
        component: { ...f.component, label },
      }).success,
      false,
    );
    assert.throws(() =>
      canonicalEnvelope({
        ...f.envelope,
        component: { ...f.envelope.component, label },
      }),
    );
  }
  assert.throws(() => canonicalEnvelope({ ...f.envelope, version: 1 }));
  assert.throws(() =>
    canonicalEnvelope({
      ...f.envelope,
      scope: { ...f.envelope.scope, originalRegionId: null },
    }),
  );
  assert.equal(
    reviewedRatingTargetLinkSchema.safeParse({
      ...f.envelope.component,
      targetId: id(),
    }).success,
    false,
  );
});
test('old pending none/absent post command identity stays byte-identical; v5 domain is isolated', () => {
  const f = fixture();
  const plain = { ...f.body };
  delete plain.component;
  const absent = publishPostSchema.parse(plain),
    none = publishPostSchema.parse({ ...plain, component: { kind: 'none' } });
  const original = createHash('sha256')
    .update(
      JSON.stringify({ operation: 'publish_post', intent: postIntent(absent) }),
    )
    .digest('hex');
  assert.equal(publicationHash('publish_post', postIntent(absent)), original);
  assert.equal(publicationHash('publish_post', postIntent(none)), original);
  assert.equal(
    publicationHash('publish_post', postIntent(f.body)),
    createHash('sha256')
      .update(
        'whaleu-community-rating-target-link:v1\n' +
          JSON.stringify({
            operation: 'publish_post',
            intent: postIntent(f.body),
          }),
      )
      .digest('hex'),
  );
  assert.notEqual(
    publicationHash('publish_post', postIntent(f.body)),
    original,
  );
  assert.deepEqual(Object.keys(postIntent(f.body).component!), [
    'kind',
    'targetId',
    'label',
    'selector',
    'expectedTargetRevision',
    'expectedCategoryRevision',
    'expectedSourceRevision',
  ]);
});
test('approved card binds final body, label and immutable original target snapshot', () => {
  const f = fixture(),
    before = canonicalJson(f.envelope),
    digest = approvalDigest(f.envelope);
  for (const change of [
    { text: 'Changed body' },
    { component: { ...f.envelope.component, label: 'Changed' } },
    {
      component: {
        ...f.envelope.component,
        binding: { ...f.b, targetRevision: id() },
      },
    },
  ])
    assert.notEqual(
      approvalDigest(canonicalEnvelope({ ...f.envelope, ...change })),
      digest,
    );
  assert.equal(canonicalJson(f.envelope), before);
});
test('same-identity accepted successor updates only current name/generation; denial and unknown stay distinct', async () => {
  const f = fixture();
  let name = 'Original target',
    revision = f.b.targetRevision,
    originSource = f.b.originSourceId;
  let targetDecision: 'allow' | 'deny' | 'unavailable' = 'allow';
  const row = () => ({
    id: target,
    category_id: category,
    region_id: region,
    name,
    revision,
    definition: { definitionRevision: revision },
  });
  const path = [
    {
      id: category,
      parent_id: null,
      level: 1,
      system_key: 'course',
      revision: f.b.categoryRevision,
    },
  ];
  const scope = {
    selector: f.b.selector,
    deadline: Date.now() + 60000,
    catalog: {
      id: f.b.catalogId,
      scopeKey: `campus:${campus}`,
      regionId: region,
      headRevision: f.b.headRevision,
      sourceDigest: f.b.sourceDigest,
    },
    protocolGeneration: f.b.protocolGeneration,
  };
  const contexts = {
    resolveRecipient: async () => scope,
  } as unknown as RatingScopedContextService;
  const records = {
    targetLinkBatch: async () =>
      new Map([
        [
          target,
          targetDecision === 'allow'
            ? { kind: 'allow', value: { row: row(), path } }
            : targetDecision === 'deny'
              ? { kind: 'deny', reason: 'POST_NOT_FOUND' }
              : { kind: 'unavailable' },
        ],
      ]),
    retainAfter: async () => {},
  } as unknown as RatingScopedRepository;
  const tx = {
    query: async (sql: string) => ({
      rows: sql.includes('jsonb_to_recordset')
        ? [
            {
              leaf_id: category,
              valid: true,
              valid_until: new Date(scope.deadline),
            },
          ]
        : [
            {
              target_id: target,
              origin_source_id: originSource,
              source_id: f.b.sourceId,
              source_revision: f.b.sourceRevision,
              placement_revision: f.b.placementRevision,
            },
          ],
    }),
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  try {
    const owner = new RatingTargetLinkFacade(contexts, records),
      key = canonicalJson(f.b),
      before = canonicalJson(f.envelope);
    const original = (await owner.currentBatch(actor, [f.b], tx)).get(key)!;
    assert.equal(original.kind, 'allow');
    name = 'Accepted new name';
    revision = id();
    const successor = (await owner.currentBatch(actor, [f.b], tx)).get(key)!;
    assert.equal(successor.kind, 'allow');
    if (original.kind === 'allow' && successor.kind === 'allow') {
      assert.equal(successor.value.name, name);
      assert.notEqual(successor.value.generation, original.value.generation);
    }
    assert.equal(canonicalJson(f.envelope), before);
    originSource = id();
    assert.equal(
      (await owner.currentBatch(actor, [f.b], tx)).get(key)?.kind,
      'unavailable',
    );
    originSource = f.b.originSourceId;
    targetDecision = 'deny';
    assert.equal(
      (await owner.currentBatch(actor, [f.b], tx)).get(key)?.kind,
      'deny',
    );
    targetDecision = 'unavailable';
    assert.equal(
      (await owner.currentBatch(actor, [f.b], tx)).get(key)?.kind,
      'unavailable',
    );
    assert.equal(
      (await owner.currentBatch(null, [f.b], tx)).get(key)?.kind,
      'deny',
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('actual local-manual runtime admits bounded named/anonymous v5 through exact-current owner, never generic components', async () => {
  const f = fixture();
  let source = true;
  const tx = {
    query: async (sql: string) => ({
      rows: sql.includes('rating_target_link_admitted')
        ? [{ current: source }]
        : [{ id: id() }],
    }),
  } as unknown as PoolClient;
  const runtime = new TextReviewRuntime(
    loadConfig({
      DATABASE_URL: 'postgresql://dev:test@127.0.0.1:55432/whaleu_test',
      NODE_ENV: 'test',
      COMMUNITY_TEXT_REVIEW: 'local_manual',
      COMMUNITY_TEXT_REVIEW_SPACE_ID: space,
      COMMUNITY_TEXT_REVIEW_REGION_ID: region,
      COMMUNITY_TEXT_REVIEW_POLICY_ID: id(),
      COMMUNITY_TEXT_REVIEW_OPERATOR: 'local:synthetic',
    }),
    new ApprovalRepository(),
  );
  await runtime.requireEnvelope(f.envelope, tx);
  await runtime.requireEnvelope(
    canonicalEnvelope({ ...f.envelope, authorMode: 'anonymous' }),
    tx,
  );
  source = false;
  await assert.rejects(runtime.requireEnvelope(f.envelope, tx));
});

test('256 distinct targets and three-level paths qualify in bounded owner vectors; foreign selectors share one recipient capture', async () => {
  const f = fixture();
  const bindings = Array.from({ length: 256 }, () => {
    const categoryId = id(),
      categoryRevision = id();
    return ratingTargetBindingSchema.parse({
      ...f.b,
      targetId: id(),
      categoryId,
      categoryRevision,
      ancestry: [
        { categoryId: id(), revision: id() },
        { categoryId: id(), revision: id() },
        { categoryId, revision: categoryRevision },
      ],
    });
  });
  let contexts = 0,
    batches = 0,
    queries = 0;
  const scope = {
    selector: f.b.selector,
    deadline: Date.now() + 60000,
    catalog: {
      id: f.b.catalogId,
      scopeKey: `campus:${campus}`,
      regionId: region,
      headRevision: f.b.headRevision,
      sourceDigest: f.b.sourceDigest,
    },
    protocolGeneration: f.b.protocolGeneration,
  };
  const contextOwner = {
    resolveRecipient: async () => {
      contexts++;
      return scope;
    },
  } as unknown as RatingScopedContextService;
  const records = {
    targetLinkBatch: async (_scope: unknown, ids: string[]) => {
      batches++;
      assert.equal(ids.length, 256);
      return new Map(
        bindings.map((binding) => [
          binding.targetId,
          {
            kind: 'allow',
            value: {
              row: {
                id: binding.targetId,
                category_id: binding.categoryId,
                region_id: region,
                name: 'Current name',
                revision: binding.targetRevision,
                definition: { definitionRevision: binding.definitionRevision },
              },
              path: binding.ancestry.map((node, index) => ({
                id: node.categoryId,
                parent_id: index
                  ? binding.ancestry[index - 1]!.categoryId
                  : null,
                level: index + 1,
                system_key: index === 0 ? 'course' : null,
                revision: node.revision,
              })),
            },
          },
        ]),
      );
    },
    retainAfter: async () => {},
  } as unknown as RatingScopedRepository;
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      queries++;
      return {
        rows: sql.includes('jsonb_to_recordset')
          ? JSON.parse(String(values[1])).map((wanted: { leafId: string }) => ({
              leaf_id: wanted.leafId,
              valid: true,
              valid_until: new Date(scope.deadline),
            }))
          : bindings.map((binding) => ({
              target_id: binding.targetId,
              origin_source_id: binding.originSourceId,
              source_id: binding.sourceId,
              source_revision: binding.sourceRevision,
              placement_revision: binding.placementRevision,
            })),
      };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  try {
    const owner = new RatingTargetLinkFacade(contextOwner, records),
      result = await owner.currentBatch(actor, bindings, tx);
    assert.equal(result.size, 256);
    assert.ok([...result.values()].every((value) => value.kind === 'allow'));
    assert.equal(contexts, 1);
    assert.equal(batches, 1);
    assert.equal(queries, 2);
    const foreign = bindings.map((binding) => ({
      ...binding,
      selector: { kind: 'campus' as const, campusId: id() },
    }));
    const denied = await owner.currentBatch(actor, foreign, tx);
    assert.ok([...denied.values()].every((value) => value.kind === 'deny'));
    assert.equal(contexts, 2);
    assert.equal(batches, 1);
    assert.equal(queries, 2);
    await assert.rejects(
      owner.currentBatch(actor, [...bindings, bindings[0]!], tx),
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('card output is canonical and representable without a schema transform', () => {
  assert.doesNotThrow(() =>
    z.toJSONSchema(ratingTargetLinkViewSchema, {
      target: 'openapi-3.0',
      io: 'output',
    }),
  );
  const view = {
    kind: 'rating_target_link',
    label: '去评分',
    target: {
      id: target,
      name: '课程\t名称',
      locator: { targetId: target, selector: { kind: 'global' } },
    },
  };
  assert.deepEqual(ratingTargetLinkViewSchema.parse(view), view);
  assert.equal(
    ratingTargetLinkViewSchema.safeParse({
      ...view,
      target: { ...view.target, name: '课程\r\n名称' },
    }).success,
    false,
  );
});
