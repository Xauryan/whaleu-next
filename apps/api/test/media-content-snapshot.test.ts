import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  MediaContentSnapshotFacade,
  mediaContentKey,
} from '../src/media/content-snapshot.facade.js';
import type {
  MediaContentReference,
  MediaSnapshotReadBudget,
} from '../src/media/content-snapshot.facade.js';
import { validateCurrentMedia } from '../src/media/current-facts.js';
import { sealManifest } from '../src/media/manifest.js';
import { SnapshotReadBudget } from '../src/community/content-review/count-snapshot.repository.js';
import { manifestFixture } from './support/media/discovery-manifest.js';

const sealed = sealManifest(manifestFixture());
function fixture() {
  const reference: MediaContentReference = {
    parent: {
      ownerKind: 'community',
      resourceKind: 'post',
      resourceId: randomUUID(),
      contentVersion: 1,
    },
    expected: [{ assetId: randomUUID(), digest: sealed.digest }],
  };
  const row = {
    parent_id: reference.parent.resourceId,
    binding_id: randomUUID(),
    asset_id: reference.expected[0]!.assetId,
    binding_digest: sealed.digest,
    ordinal: 0,
    slot: 'images',
    id: reference.expected[0]!.assetId,
    intent_id: randomUUID(),
    audience: 'content-gated',
    purpose: 'community-post-image',
    owner_kind: 'community',
    resource_kind: 'post',
    content_version: '1',
    manifest_digest: sealed.digest,
    manifest: sealed.manifest,
    policy_revision: 'media-static-v1',
    intent_state: 'ready',
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
    const facts = await new MediaContentSnapshotFacade().readBatch(
      [f.reference],
      noRead,
      budget([f.row]),
    );
    const fact = facts.get(mediaContentKey(f.reference.parent))!;
    assert.equal(fact.decision, state === 'allow' ? 'allow' : 'deny');
    assert.equal(fact.validUntil, 10000);
    assert.deepEqual(fact.attachments, [
      {
        slot: 'images',
        ordinal: 0,
        bindingId: f.row.binding_id,
        assetId: f.row.id,
        manifestDigest: sealed.digest,
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
  ];
  for (let index = 0; index < cases.length; index++) {
    const f = fixture();
    const rows =
      index === 0 ? [] : [{ ...f.row, state: 'revoked', ...cases[index] }];
    const facts = await new MediaContentSnapshotFacade().readBatch(
      [f.reference],
      noRead,
      budget(rows),
    );
    assert.equal(
      facts.get(mediaContentKey(f.reference.parent))!.decision,
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
      assert.deepEqual(values, [[f.reference.parent.resourceId]]);
      assert.equal(cap, 1);
      return [f.row] as T[];
    },
  };
  assert.equal(
    (
      await new MediaContentSnapshotFacade().readBatch(
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
  const facts = await new MediaContentSnapshotFacade().readBatch(
    [f.reference, conflict, f.reference],
    noRead,
    reader,
  );
  assert.equal(
    facts.get(mediaContentKey(f.reference.parent))!.decision,
    'unknown',
  );
  assert.equal(calls, 1);
});

test('Media explicit empty definition does not require installed Media and unsupported child/multi-image stays unknown', async () => {
  const f = fixture();
  const empty = { ...f.reference, expected: [] };
  const facade = new MediaContentSnapshotFacade();
  const forbidden: MediaSnapshotReadBudget = {
    rows: async () => {
      throw new Error('No Media lookup for explicit empty definition');
    },
  };
  assert.equal(
    (await facade.readBatch([empty], noRead, forbidden)).get(
      mediaContentKey(empty.parent),
    )!.decision,
    'allow',
  );
  const child: MediaContentReference = {
    ...f.reference,
    parent: {
      ...f.reference.parent,
      ownerKind: 'community',
      resourceKind: 'comment',
      contentVersion: 1,
    },
  };
  assert.equal(
    (await facade.readBatch([child], noRead, forbidden)).get(
      mediaContentKey(child.parent),
    )!.decision,
    'unknown',
  );
  assert.equal(
    (
      await facade.readBatch(
        [
          {
            ...f.reference,
            expected: [...f.reference.expected, ...f.reference.expected],
          },
        ],
        noRead,
        forbidden,
      )
    ).get(mediaContentKey(f.reference.parent))!.decision,
    'unknown',
  );
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
    const facts = await new MediaContentSnapshotFacade().readBatch(
      fixtures.map((f) => f.reference),
      noRead,
      reader,
    );
    assert.equal(facts.size, size);
    assert.equal(calls, size ? 1 : 0);
  }
  await assert.rejects(
    new MediaContentSnapshotFacade().readBatch(
      Array.from({ length: 257 }, () => fixture().reference),
      noRead,
      budget([]),
    ),
  );
  const f = fixture();
  await assert.rejects(
    new MediaContentSnapshotFacade().readBatch(
      Array.from({ length: 769 }, () => f.reference),
      noRead,
      budget([]),
    ),
  );
});

test('Media uses remaining shared four MiB wire budget and never silently truncates excess bindings', async () => {
  const f = fixture();
  const sqls: string[] = [];
  const tx = {
    query: async (sql: string) => {
      sqls.push(sql);
      return { rows: [{ data: null, bytes: String(4 * 1024 * 1024 + 1) }] };
    },
  } as unknown as PoolClient;
  await assert.rejects(
    new MediaContentSnapshotFacade().readBatch(
      [f.reference],
      tx,
      new SnapshotReadBudget(),
    ),
  );
  assert.match(sqls[0]!, /LIMIT 2/);
  assert.match(sqls[0]!, /bytes<=4194304/);
  const shared = new SnapshotReadBudget();
  let call = 0;
  const consumed = {
    query: async (sql: string) => {
      sqls.push(sql);
      return {
        rows:
          call++ === 0
            ? [{ data: { id: 'prior-owner' }, bytes: '4194303' }]
            : [{ data: null, bytes: '2' }],
      };
    },
  } as unknown as PoolClient;
  await shared.rows(consumed, 'SELECT 1 id', [], 1);
  await assert.rejects(
    new MediaContentSnapshotFacade().readBatch([f.reference], consumed, shared),
  );
  assert.match(sqls.at(-1)!, /bytes<=1/);
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
  const facts = await new MediaContentSnapshotFacade().readBatch(
    [f.reference],
    noRead,
    budget([f.row, { ...f.row, binding_id: randomUUID(), ordinal: 1 }]),
  );
  assert.equal(
    facts.get(mediaContentKey(f.reference.parent))!.decision,
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
