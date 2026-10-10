import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  RatingsMediaContentSnapshotFacade,
  ratingsMediaContentKey,
} from '../src/media/ratings-content-snapshot.facade.js';
import type {
  RatingsMediaContentReference,
  MediaSnapshotReadBudget,
} from '../src/media/ratings-content-snapshot.facade.js';
import { validateCurrentMedia } from '../src/media/current-facts.js';
import { sealManifest } from '../src/media/manifest.js';
import { manifestFixture } from './support/media/discovery-manifest.js';

const sealed = sealManifest(manifestFixture());
function fixture() {
  const reference: RatingsMediaContentReference = {
    parent: {
      ownerKind: 'ratings',
      resourceKind: 'target_cover',
      resourceId: randomUUID(),
      contentVersion: 1,
    },
    expected: [{ assetId: randomUUID(), digest: sealed.digest }],
  };
  const row = {
    parent_id: reference.parent.resourceId,
    parent_kind: reference.parent.resourceKind,
    binding_id: randomUUID(),
    asset_id: reference.expected[0]!.assetId,
    binding_digest: sealed.digest,
    ordinal: 0,
    slot: 'cover',
    id: reference.expected[0]!.assetId,
    intent_id: randomUUID(),
    audience: 'content-gated',
    purpose: 'ratings-target-cover-image',
    owner_kind: 'ratings',
    resource_kind: 'target_cover',
    content_version: '1',
    manifest_digest: sealed.digest,
    manifest: sealed.manifest,
    policy_revision: 'media-static-v1',
    intent_state: 'ready',
    protocol_version: 6,
    target_kind: 'edit',
    head_revision: '1',
    event_id: randomUUID(),
    state: 'allow',
    event_digest: sealed.digest,
    event_policy: 'media-static-v1',
    effective_at: new Date(1000),
    valid_until: new Date(10000),
    read_at: new Date(5000),
    exact_time_valid: true,
  };
  return { reference, row };
}
const noRead = {
  query: () => {
    throw new Error(
      'Conditional facade must use the supplied shared budget only',
    );
  },
} as unknown as PoolClient;
function budget(rows: unknown[]): MediaSnapshotReadBudget {
  return { rows: async <T>() => rows as T[] };
}

test('Media conditional batch returns exact frozen positive and negative identity without mandatory registration', async () => {
  for (const state of ['allow', 'held', 'revoked']) {
    const f = fixture();
    f.row.state = state;
    const facts = await new RatingsMediaContentSnapshotFacade().readBatch(
      [f.reference],
      noRead,
      budget([f.row]),
    );
    const fact = facts.get(ratingsMediaContentKey(f.reference.parent))!;
    assert.equal(fact.decision, state === 'allow' ? 'allow' : 'deny');
    assert.equal(fact.validUntil, 10000);
    assert.deepEqual(fact.attachments, [
      {
        slot: 'cover',
        ordinal: 0,
        bindingId: f.row.binding_id,
        assetId: f.row.id,
        manifestDigest: sealed.digest,
        width: sealed.manifest.variants[1].width,
        height: sealed.manifest.variants[1].height,
        policyRevision: 'media-static-v1',
        intentId: f.row.intent_id,
        intentState: 'ready',
        headRevision: '1',
        eventId: f.row.event_id,
      },
    ]);
    assert.equal(Object.isFrozen(fact.attachments[0]), true);
    assert.equal(JSON.stringify(fact).includes('synthetic'), false);
  }
});

test('Media batch missing/malformed/current unknown never becomes a denial', async () => {
  const cases = [
    {},
    { intent_state: 'processing' },
    { head_revision: '0' },
    { event_id: null },
    { manifest_digest: 'f'.repeat(64) },
    { binding_digest: 'f'.repeat(64) },
    { event_policy: 'other' },
    { manifest: {} },
    { exact_time_valid: false },
    { valid_until: new Date(5000) },
    { effective_at: new Date(5001) },
    { ordinal: 1 },
    { slot: 'other' },
    { audience: 'participant-private' },
    { binding_id: null },
    { protocol_version: 5 },
    { target_kind: 'draft' },
    { owner_kind: 'profile' },
    { resource_kind: 'avatar' },
  ];
  for (let index = 0; index < cases.length; index++) {
    const f = fixture();
    const rows =
      index === 0 ? [] : [{ ...f.row, state: 'revoked', ...cases[index] }];
    const facts = await new RatingsMediaContentSnapshotFacade().readBatch(
      [f.reference],
      noRead,
      budget(rows),
    );
    assert.equal(
      facts.get(ratingsMediaContentKey(f.reference.parent))!.decision,
      'unknown',
      JSON.stringify(cases[index]),
    );
  }
});

test('Media duplicate references deduplicate exact expectations but conflicting identity fails closed', async () => {
  const f = fixture();
  let calls = 0;
  const reader: MediaSnapshotReadBudget = {
    rows: async <T>(
      _tx: PoolClient,
      _sql: string,
      values: unknown[],
      cap: number,
    ) => {
      calls++;
      assert.deepEqual(values, [
        [f.reference.parent.resourceId],
        ['target_cover'],
      ]);
      assert.equal(cap, 1);
      return [f.row] as T[];
    },
  };
  assert.equal(
    (
      await new RatingsMediaContentSnapshotFacade().readBatch(
        [f.reference, f.reference],
        noRead,
        reader,
      )
    ).size,
    1,
  );
  assert.equal(calls, 1);
  const conflict = {
    ...f.reference,
    expected: [{ ...f.reference.expected[0]!, digest: 'f'.repeat(64) }],
  };
  const facts = await new RatingsMediaContentSnapshotFacade().readBatch(
    [f.reference, conflict, f.reference],
    noRead,
    reader,
  );
  assert.equal(
    facts.get(ratingsMediaContentKey(f.reference.parent))!.decision,
    'unknown',
  );
  assert.equal(calls, 1);
});

test('Media metadata cardinalities 0/1/255/256 are one bounded query and 257 is rejected', async () => {
  for (const size of [0, 1, 255, 256]) {
    const fixtures = Array.from({ length: size }, fixture);
    let calls = 0;
    const reader: MediaSnapshotReadBudget = {
      rows: async <T>(
        _tx: PoolClient,
        sql: string,
        _values: unknown[],
        cap: number,
      ) => {
        calls++;
        assert.equal(cap, size);
        assert.match(sql, /effective_at<=t.read_at/);
        assert.doesNotMatch(sql, /FOR (SHARE|UPDATE)/);
        return fixtures.map((f) => f.row) as T[];
      },
    };
    const facts = await new RatingsMediaContentSnapshotFacade().readBatch(
      fixtures.map((f) => f.reference),
      noRead,
      reader,
    );
    assert.equal(facts.size, size);
    assert.equal(calls, size ? 1 : 0);
  }
  await assert.rejects(
    new RatingsMediaContentSnapshotFacade().readBatch(
      Array.from({ length: 257 }, () => fixture().reference),
      noRead,
      budget([]),
    ),
  );
  const f = fixture();
  await assert.rejects(
    new RatingsMediaContentSnapshotFacade().readBatch(
      Array.from({ length: 769 }, () => f.reference),
      noRead,
      budget([]),
    ),
  );
});

test('Shared validator requires database-exact not-before and does not revive malformed held evidence', () => {
  const asset = {
    manifest: sealed.manifest,
    manifest_digest: sealed.digest,
    policy_revision: 'media-static-v1',
  };
  const event = {
    state: 'held',
    manifest_digest: sealed.digest,
    policy_revision: 'media-static-v1',
    effective_at: new Date(1000),
    valid_until: new Date(5000),
  };
  assert.equal(
    validateCurrentMedia(asset, 'ready', event, 1000, false).decision,
    'unknown',
  );
  assert.equal(
    validateCurrentMedia(asset, 'ready', event, 1000, true).decision,
    'deny',
  );
  assert.equal(
    validateCurrentMedia({ ...asset, manifest: {} }, 'ready', event, 1000, true)
      .decision,
    'unknown',
  );
});

test('Media budget rejects duplicate/extra active binding evidence instead of truncating it', async () => {
  const f = fixture();
  const facts = await new RatingsMediaContentSnapshotFacade().readBatch(
    [f.reference],
    noRead,
    budget([f.row, { ...f.row, binding_id: randomUUID(), ordinal: 1 }]),
  );
  assert.equal(
    facts.get(ratingsMediaContentKey(f.reference.parent))!.decision,
    'unknown',
  );
});

test('Media shared validator rejects a sealed manifest under a different current policy', () => {
  const asset = {
    manifest: sealed.manifest,
    manifest_digest: sealed.digest,
    policy_revision: 'other-policy',
  };
  const event = {
    state: 'allow',
    manifest_digest: sealed.digest,
    policy_revision: 'other-policy',
    effective_at: new Date(1000),
    valid_until: new Date(10000),
  };
  assert.equal(
    validateCurrentMedia(asset, 'ready', event, 5000, true).decision,
    'unknown',
  );
});

test('Ratings single-cover limit rejects galleries before querying metadata', async () => {
  const f = fixture();
  const two = {
    ...f.reference,
    expected: [
      ...f.reference.expected,
      { assetId: randomUUID(), digest: sealed.digest },
    ],
  };
  const never: MediaSnapshotReadBudget = {
    rows: async () => {
      throw new Error('Over-limit cover must not read');
    },
  };
  assert.equal(
    (
      await new RatingsMediaContentSnapshotFacade().readBatch(
        [two],
        noRead,
        never,
      )
    ).get(ratingsMediaContentKey(two.parent))!.decision,
    'unknown',
  );
});

test('Ratings selected appearance cannot become empty or bypass unavailable runtime', async () => {
  const { UnavailableRatingsMediaContentSnapshotFacade } =
    await import('../src/media/ratings-content-snapshot.facade.js');
  const f = fixture();
  const never: MediaSnapshotReadBudget = {
    rows: async () => {
      throw new Error('Must not query');
    },
  };
  const empty = { ...f.reference, expected: [] };
  assert.equal(
    (
      await new RatingsMediaContentSnapshotFacade().readBatch(
        [empty],
        noRead,
        never,
      )
    ).get(ratingsMediaContentKey(empty.parent))!.decision,
    'unknown',
  );
  assert.equal(
    (
      await new UnavailableRatingsMediaContentSnapshotFacade().readBatch(
        [f.reference],
        noRead,
        never,
      )
    ).get(ratingsMediaContentKey(f.reference.parent))!.decision,
    'unknown',
  );
});
