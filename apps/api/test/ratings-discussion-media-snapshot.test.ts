import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  RatingsDiscussionMediaContentSnapshotFacade,
  ratingsDiscussionMediaContentKey,
} from '../src/media/ratings-discussion-content-snapshot.facade.js';
import type {
  RatingsDiscussionMediaContentReference,
  MediaSnapshotReadBudget,
} from '../src/media/ratings-discussion-content-snapshot.facade.js';
import { sealManifest } from '../src/media/manifest.js';
import { manifestFixture } from './support/media/discovery-manifest.js';
const sealed = sealManifest(manifestFixture());
function fixture(count = 9, reply = false) {
  const reference: RatingsDiscussionMediaContentReference = {
    parent: reply
      ? {
          ownerKind: 'ratings',
          resourceKind: 'rating_reply',
          targetId: randomUUID(),
          rootId: randomUUID(),
          resourceId: randomUUID(),
          contentVersion: 1,
        }
      : {
          ownerKind: 'ratings',
          resourceKind: 'rating_comment',
          targetId: randomUUID(),
          resourceId: randomUUID(),
          contentVersion: 1,
        },
    expected: Array.from({ length: count }, () => ({
      assetId: randomUUID(),
      digest: sealed.digest,
    })),
  };
  const rows = reference.expected.map((image, ordinal) => ({
    parent_id: reference.parent.resourceId,
    parent_kind: reference.parent.resourceKind,
    parent_target_id: reference.parent.targetId,
    parent_root_id:
      reference.parent.resourceKind === 'rating_reply'
        ? reference.parent.rootId
        : null,
    parent_matches: true,
    binding_id: randomUUID(),
    asset_id: image.assetId,
    binding_digest: image.digest,
    ordinal,
    slot: 'images',
    id: image.assetId,
    intent_id: randomUUID(),
    audience: 'content-gated',
    purpose: reply ? 'ratings-reply-image' : 'ratings-comment-image',
    owner_kind: 'ratings',
    resource_kind: reference.parent.resourceKind,
    content_version: '1',
    manifest_digest: sealed.digest,
    manifest: sealed.manifest,
    policy_revision: 'media-static-v1',
    intent_state: 'ready',
    protocol_version: 7,
    target_kind: 'draft',
    head_revision: '1',
    event_id: randomUUID(),
    state: 'allow',
    event_digest: sealed.digest,
    event_policy: 'media-static-v1',
    effective_at: new Date(1000),
    valid_until: new Date(10000),
    read_at: new Date(5000),
    exact_time_valid: true,
  }));
  return { reference, rows };
}
const noRead = {
  query: () => {
    throw new Error('Must use the caller shared metadata budget');
  },
} as unknown as PoolClient;
const budget = (rows: unknown[]): MediaSnapshotReadBudget => ({
  rows: async <T>() => rows as T[],
});
test('Media7 root9 and reply3 use one exact ordered metadata set, no object locator', async () => {
  for (const [count, reply] of [
    [9, false],
    [3, true],
    [1, false],
  ] as const) {
    const f = fixture(count, reply);
    let reads = 0;
    const facts =
      await new RatingsDiscussionMediaContentSnapshotFacade().readBatch(
        [f.reference],
        noRead,
        {
          rows: async <T>(
            _tx: PoolClient,
            sql: string,
            _values: unknown[],
            cap: number,
          ) => {
            reads++;
            assert.equal(cap, count);
            assert.doesNotMatch(sql, /FOR (SHARE|UPDATE)/);
            return f.rows as T[];
          },
        },
      );
    const fact = facts.get(
      ratingsDiscussionMediaContentKey(f.reference.parent),
    )!;
    assert.equal(reads, 1);
    assert.equal(fact.version, 7);
    assert.equal(fact.decision, 'allow');
    assert.equal(fact.attachments.length, count);
    assert.deepEqual(
      fact.attachments.map((x) => x.ordinal),
      Array.from({ length: count }, (_, i) => i),
    );
    assert.equal(JSON.stringify(fact).includes('synthetic'), false);
    assert.ok(Object.isFrozen(fact.attachments[0]));
  }
});
test('a held ninth image denies the whole root, unknown or missing ninth never truncates to eight', async () => {
  for (const change of [
    'held',
    'unknown',
    'missing',
    'protocol',
    'purpose',
    'duplicate',
  ] as const) {
    const f = fixture();
    if (change === 'missing') f.rows.pop();
    else if (change === 'protocol') f.rows[8]!.protocol_version = 6;
    else if (change === 'purpose') f.rows[8]!.purpose = 'community-post-image';
    else if (change === 'duplicate')
      f.rows[8]!.binding_id = f.rows[0]!.binding_id;
    else f.rows[8]!.state = change;
    const facts =
        await new RatingsDiscussionMediaContentSnapshotFacade().readBatch(
          [f.reference],
          noRead,
          budget(f.rows),
        ),
      fact = facts.get(ratingsDiscussionMediaContentKey(f.reference.parent))!;
    assert.equal(fact.decision, change === 'held' ? 'deny' : 'unknown');
    assert.equal(fact.attachments.length, change === 'held' ? 9 : 0);
  }
});
test('reply4 rejected before read and text-only absence is explicit', async () => {
  const invalid = fixture(4, true);
  const result =
    await new RatingsDiscussionMediaContentSnapshotFacade().readBatch(
      [invalid.reference],
      noRead,
      {
        rows: async () => {
          throw new Error('Invalid reply set must not query');
        },
      },
    );
  assert.equal(
    result.get(ratingsDiscussionMediaContentKey(invalid.reference.parent))!
      .decision,
    'unknown',
  );
  const zero = fixture(0),
    absence = {
      parent_id: zero.reference.parent.resourceId,
      parent_kind: zero.reference.parent.resourceKind,
      parent_target_id: zero.reference.parent.targetId,
      parent_root_id: null,
      binding_id: null,
    };
  const clean =
    await new RatingsDiscussionMediaContentSnapshotFacade().readBatch(
      [zero.reference],
      noRead,
      budget([absence]),
    );
  assert.equal(
    clean.get(ratingsDiscussionMediaContentKey(zero.reference.parent))!
      .decision,
    'allow',
  );
  const dirty =
    await new RatingsDiscussionMediaContentSnapshotFacade().readBatch(
      [zero.reference],
      noRead,
      budget([{ ...absence, binding_id: randomUUID() }]),
    );
  assert.equal(
    dirty.get(ratingsDiscussionMediaContentKey(zero.reference.parent))!
      .decision,
    'unknown',
  );
});
