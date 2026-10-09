import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  publishCommentSchema,
  publishPostSchema,
} from '../src/community/contracts.js';
import type { PublishPost } from '../src/community/contracts.js';
import { publishReplySchema } from '../src/community/discussion/contracts.js';
import { postIntent } from '../src/community/publication-intent.js';
import {
  publicationHash,
  PublicationRepository,
} from '../src/community/publication.repository.js';
import { PublicationService } from '../src/community/publication.service.js';
import { CommunityRepository } from '../src/community/community.repository.js';
import { CommunityAccessService } from '../src/community/community-access.service.js';
import type {
  ContentPublicationGate,
  MediaAttachmentPort,
} from '../src/community/community-policy.js';
import type { PollRepository } from '../src/community/polls/poll.repository.js';
import type { FormationRepository } from '../src/community/formation/repository.js';
import type { TradingRepository } from '../src/community/trading/repository.js';
import type { AuthorDisplayService } from '../src/profile/author-display.service.js';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalJson,
} from '../src/community/content-review/contracts.js';
import type { EffectiveContentEnvelope } from '../src/community/content-review/contracts.js';
import {
  validateApprovalBinding,
  validateApprovalRow,
} from '../src/community/content-review/approval-validation.js';
import type {
  ApprovalBinding,
  ApprovalRow,
} from '../src/community/content-review/approval-validation.js';
import {
  reconstructDefinition,
  definitionMatchesApproval,
} from '../src/community/content-review/definition-validation.js';
import type { DefinitionPost } from '../src/community/content-review/definition-validation.js';
import { verified } from './support/community-fixtures.js';

const accountId = '00000000-0000-4000-8000-000000000001';
const spaceId = '00000000-0000-4000-8000-000000000002';
const regionId = '00000000-0000-4000-8000-000000000003';
const input = (): PublishPost => ({
  clientRequestId: randomUUID(),
  spaceId,
  category: 'discussion',
  text: 'Reviewed canonical example text',
  imageAssetIds: [],
  authorMode: 'named',
  commentsPolicy: 'open',
});
const original = (): Extract<EffectiveContentEnvelope, { version: 1 }> => ({
  version: 1,
  accountId,
  purpose: 'publish_post',
  spaceId,
  category: 'discussion',
  authorMode: 'named',
  commentsPolicy: 'open',
  postId: null,
  rootCommentId: null,
  targetReplyId: null,
  text: input().text,
  images: [],
  component: { kind: 'none' },
  trading: null,
  scope: {
    originalSpaceId: spaceId,
    originalRegionId: regionId,
    authorOriginRegionId: regionId,
    identityRegionId: regionId,
    topologySnapshotId: null,
    sync: 'none',
  },
});
const exact = (allowAnonymousDm: boolean) =>
  canonicalEnvelope({
    ...original(),
    version: 2,
    allowAnonymousDm,
  });

test('anonymous DM option is an explicit named-post-only boolean, never an implicit v1 default', () => {
  assert.equal(
    Object.hasOwn(publishPostSchema.parse(input()), 'allowAnonymousDm'),
    false,
  );
  for (const option of [false, true]) {
    assert.equal(
      publishPostSchema.parse({ ...input(), allowAnonymousDm: option })
        .allowAnonymousDm,
      option,
    );
    assert.equal(
      publishPostSchema.safeParse({
        ...input(),
        authorMode: 'anonymous',
        allowAnonymousDm: option,
      }).success,
      false,
    );
    for (const schema of [publishCommentSchema, publishReplySchema])
      assert.equal(
        schema.safeParse({
          clientRequestId: randomUUID(),
          text: 'Comment',
          authorMode: 'named',
          allowAnonymousDm: option,
        }).success,
        false,
      );
  }
  for (const option of [null, 0, 1, 'true', 'false'])
    assert.equal(
      publishPostSchema.safeParse({ ...input(), allowAnonymousDm: option })
        .success,
      false,
    );
});

test('absent choice preserves exact prior intent bytes and request hashes; false and true are distinct new intents', () => {
  const body = input();
  const oldIntent = {
    spaceId: body.spaceId,
    category: body.category,
    text: body.text,
    imageAssetIds: body.imageAssetIds,
    authorMode: body.authorMode,
    commentsPolicy: body.commentsPolicy,
  };
  const oldHash = createHash('sha256')
    .update(JSON.stringify({ operation: 'publish_post', intent: oldIntent }))
    .digest('hex');
  assert.equal(JSON.stringify(postIntent(body)), JSON.stringify(oldIntent));
  assert.equal(publicationHash('publish_post', postIntent(body)), oldHash);
  assert.equal(
    publicationHash(
      'publish_post',
      postIntent({ ...body, component: { kind: 'none' } }),
    ),
    oldHash,
  );
  const hashes = [undefined, false, true].map((option) =>
    publicationHash(
      'publish_post',
      postIntent({
        ...body,
        ...(option === undefined ? {} : { allowAnonymousDm: option }),
      }),
    ),
  );
  assert.equal(new Set(hashes).size, 3);
});

test('v1 golden bytes survive; v2 exact consent is domain-separated and cannot be moved to another identity or source kind', () => {
  const old = canonicalEnvelope(original());
  assert.equal(
    approvalDigest(old),
    'ec0d15f6900d34d327cb5c9b4d534f7d0ba00d9fa5eb4184dbb24de1189dce7f',
  );
  assert.equal(Object.hasOwn(old, 'allowAnonymousDm'), false);
  const yes = exact(true),
    no = exact(false);
  assert.notEqual(approvalDigest(yes), approvalDigest(no));
  assert.notEqual(approvalDigest(no), approvalDigest(old));
  assert.equal(
    approvalDigest(yes),
    createHash('sha256')
      .update(`whaleu-content-approval:v2\n${canonicalJson(yes)}`)
      .digest('hex'),
  );
  for (const candidate of [
    { ...old, allowAnonymousDm: false },
    { ...old, version: 2 },
    { ...yes, authorMode: 'anonymous' },
    { ...yes, purpose: 'publish_comment', postId: randomUUID() },
    {
      ...yes,
      purpose: 'publish_reply',
      postId: randomUUID(),
      rootCommentId: randomUUID(),
    },
    { ...yes, allowAnonymousDm: 'true' },
    { ...yes, version: 3 },
  ])
    assert.throws(() => canonicalEnvelope(candidate));
});

function approvalRow(envelope: EffectiveContentEnvelope): ApprovalRow {
  const before = new Date('2026-10-09T00:00:00Z');
  return {
    id: randomUUID(),
    account_id: accountId,
    operation: envelope.purpose,
    envelope_version: envelope.version,
    digest: approvalDigest(envelope),
    envelope,
    policy_revision_id: randomUUID(),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'test-owner',
    provenance_ref: 'test-ref',
    evaluated_at: before,
    consume_until: new Date('2026-10-10T00:00:00Z'),
    visibility_model: 'durable',
    visibility_until: null,
    policy_key: 'local-explicit-v1',
    policy_version: 1,
    policy_coverage: 'complete',
    policy_provenance: 'accepted',
    policy_issuer: 'test-owner',
    policy_provenance_ref: 'test-policy',
    policy_valid_from: before,
    policy_valid_until: null,
    state: 'allow',
    event_at: before,
    event_coverage: 'complete',
    event_provenance: 'accepted',
    event_issuer: 'test-owner',
    event_provenance_ref: 'test-event',
  };
}

test('approval row, immutable binding and rebuilt stored definition agree on the exact v2 boolean', () => {
  const now = Date.parse('2026-10-09T12:00:00Z'),
    envelope = exact(true);
  const row = approvalRow(envelope);
  const accepted = validateApprovalRow(row, true, now).decision;
  assert.equal(accepted.kind, 'allow');
  if (accepted.kind !== 'allow')
    throw new Error('Expected exact fixture approval');
  assert.equal(accepted.value.version, 2);
  assert.equal(
    validateApprovalRow({ ...row, envelope_version: 1 }, true, now).decision
      .kind,
    'unavailable',
  );
  const binding: ApprovalBinding = {
    content_kind: 'post',
    content_id: randomUUID(),
    content_version: 1,
    decision_id: row.id,
    account_id: accountId,
    operation: 'publish_post',
    envelope_version: 2,
    digest: row.digest,
    envelope,
    scope: envelope.scope,
  };
  assert.equal(validateApprovalBinding(binding, accepted).kind, 'allow');
  assert.equal(
    validateApprovalBinding({ ...binding, envelope_version: 1 }, accepted).kind,
    'unavailable',
  );
  assert.equal(
    validateApprovalBinding({ ...binding, envelope: exact(false) }, accepted)
      .kind,
    'unavailable',
  );
  const post: DefinitionPost = {
    id: binding.content_id,
    space_id: spaceId,
    account_id: accountId,
    category: 'discussion',
    text: envelope.text,
    author_mode: 'named',
    comments_policy: 'open',
    visibility: 'approved',
    deleted_at: null,
    published_at: new Date(now),
    publication_state: 'published',
    publication_envelope_version: 2,
    allow_anonymous_dm: true,
  };
  const rebuild = (value: DefinitionPost) =>
    reconstructDefinition('post', value, value, null, envelope.scope, [], {
      images: [],
      options: [],
      creators: [],
    });
  const rebuilt = rebuild(post);
  assert.equal(rebuilt.kind, 'allow');
  if (rebuilt.kind !== 'allow') throw new Error('Expected exact definition');
  assert.equal(definitionMatchesApproval(rebuilt.value, accepted.value), true);
  const changed = rebuild({ ...post, allow_anonymous_dm: false });
  assert.equal(changed.kind, 'allow');
  if (changed.kind === 'allow')
    assert.equal(
      definitionMatchesApproval(changed.value, accepted.value),
      false,
    );
  assert.equal(
    rebuild({ ...post, publication_envelope_version: 1 }).kind,
    'unavailable',
  );
  assert.equal(
    rebuild({ ...post, allow_anonymous_dm: null }).kind,
    'unavailable',
  );
  const historical = rebuild({
    ...post,
    publication_envelope_version: 1,
    allow_anonymous_dm: null,
  });
  assert.equal(historical.kind, 'allow');
  if (historical.kind === 'allow') {
    assert.equal(historical.value.envelope.version, 1);
    assert.equal(
      Object.hasOwn(historical.value.envelope, 'allowAnonymousDm'),
      false,
    );
    assert.equal(
      definitionMatchesApproval(historical.value, accepted.value),
      false,
    );
  }
});

function publicationHarness(unreviewed = false) {
  const writes: unknown[][] = [],
    envelopes: EffectiveContentEnvelope[] = [],
    bindings: string[] = [];
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      assert.ok(sql.startsWith('INSERT INTO whaleu_community.posts'));
      writes.push(values);
      return { rows: [{ published_at: new Date('2026-10-09T12:00:00Z') }] };
    },
  } as unknown as PoolClient;
  const service = new PublicationService(
    {
      space: async () => ({
        id: spaceId,
        kind: 'regional',
        isActive: true,
        name: 'Test',
        operatingRegionId: regionId,
      }),
      attach: async () => {},
      event: async () => {},
    } as unknown as CommunityRepository,
    {
      authority: async () => verified(regionId),
    } as unknown as CommunityAccessService,
    {
      execute: async (_token, requestId, operation, _intent, create) => ({
        requestId,
        operation,
        outcome: 'created',
        ...(await create(accountId, tx)),
      }),
    } as PublicationRepository,
    {} as PollRepository,
    {} as FormationRepository,
    {} as TradingRepository,
    { prepare: async () => {} } as unknown as AuthorDisplayService,
    {
      check: async (request) => {
        const envelope = canonicalEnvelope(request.envelope);
        envelopes.push(envelope);
        return {
          kind: 'allow',
          value: unreviewed
            ? undefined
            : {
                decisionId: randomUUID(),
                version: envelope.version,
                digest: approvalDigest(envelope),
                envelope,
              },
        };
      },
      bind: async (_accepted, _kind, id) => {
        bindings.push(id);
      },
    } as ContentPublicationGate,
    {} as MediaAttachmentPort,
  );
  return { service, writes, envelopes, bindings };
}

test('publication carries consent through exact Review, stored post and binding; absence stores unknown', async () => {
  for (const option of [undefined, false, true]) {
    const harness = publicationHarness();
    const result = await harness.service.post('test-token', {
      ...input(),
      ...(option === undefined ? {} : { allowAnonymousDm: option }),
    });
    assert.equal(result.outcome, 'created');
    assert.equal(harness.writes.length, 1);
    assert.deepEqual(harness.writes[0]!.slice(7), [
      option === undefined ? 1 : 2,
      option ?? null,
    ]);
    assert.equal(harness.envelopes[0]!.version, option === undefined ? 1 : 2);
    assert.equal(harness.bindings.length, 1);
  }
  const unreviewed = publicationHarness(true);
  await assert.rejects(
    () =>
      unreviewed.service.post('test-token', {
        ...input(),
        allowAnonymousDm: true,
      }),
    (error: unknown) =>
      (error as { code?: string }).code === 'CONTENT_REVIEW_UNAVAILABLE',
  );
  assert.equal(unreviewed.writes.length, 0);
});
