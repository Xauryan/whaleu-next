import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CampusModule } from '../src/campus/campus.module.js';
import {
  CampusContentScopeFacade,
  CONTENT_SCOPE_BATCH_LIMIT,
} from '../src/campus/content-scope.facade.js';
import {
  checkpointTransactionDeadlines,
  clearTransactionDeadlines,
  registerTransactionDeadline,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  CONTENT_VISIBILITY_BATCH_LIMIT,
  SafetyContentVisibilityFacade,
} from '../src/safety/content-visibility.facade.js';
import type { ContentVisibilityFact } from '../src/safety/content-visibility.facade.js';
import { SafetyPolicyModule } from '../src/safety/policy.module.js';
import { SafetyRepository } from '../src/safety/repository.js';
import type { SafetyHead } from '../src/safety/repository.js';
import { NamedBlockVisibility } from '../src/safety/visibility.js';

const viewer = randomUUID();
const author = randomUUID();
const now = new Date(1_000);
const expiry = new Date(2_000);
const allow = { decision: 'allow', optionalUntil: null } as const;
const unknown = { decision: 'unknown', optionalUntil: null } as const;

function head(patch: Partial<SafetyHead> = {}): SafetyHead {
  return {
    block_coverage: 'complete',
    restriction_coverage: 'complete',
    provenance: 'native_account_creation',
    actions_allowed: true,
    valid_until: null,
    ...patch,
  };
}

function fixture(authors: string[] = [author]) {
  const state = {
    heads: new Map([viewer, ...authors].map((id) => [id, head()])),
    blocks: [] as { blocker_id: string; blocked_id: string; active: boolean }[],
    now,
    regions: new Map<string, boolean>(),
  };
  const statements: { sql: string; values: unknown[] | undefined }[] = [];
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.includes('FROM whaleu_campus.operating_regions')) {
        const ids = values![0] as string[];
        return {
          rows: ids.flatMap((id) =>
            state.regions.has(id)
              ? [{ id, is_active: state.regions.get(id) }]
              : [],
          ),
        };
      }
      if (sql.includes('FROM whaleu_safety.account_heads')) {
        const ids = Array.isArray(values![0])
          ? (values![0] as string[])
          : [values![0] as string];
        return {
          rows: ids.flatMap((id) =>
            state.heads.has(id)
              ? [{ account_id: id, ...state.heads.get(id) }]
              : [],
          ),
        };
      }
      if (sql.includes('FROM whaleu_safety.blocks')) {
        const requester = values![0] as string;
        const active = state.blocks.filter((block) => block.active);
        if (Array.isArray(values![1])) {
          const ids = values![1] as string[];
          return {
            rows: active.flatMap((block) => {
              if (
                block.blocker_id === requester &&
                ids.includes(block.blocked_id)
              )
                return [{ author_id: block.blocked_id }];
              if (
                block.blocked_id === requester &&
                ids.includes(block.blocker_id)
              )
                return [{ author_id: block.blocker_id }];
              return [];
            }),
          };
        }
        const target = values![1] as string;
        return {
          rows: [
            {
              outgoing: active.some(
                (block) =>
                  block.blocker_id === requester && block.blocked_id === target,
              ),
              incoming: active.some(
                (block) =>
                  block.blocker_id === target && block.blocked_id === requester,
              ),
            },
          ],
        };
      }
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: state.now }] };
      throw new Error(`Unexpected count-owner SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  return { state, statements, tx };
}

function unavailable(error: unknown) {
  return (
    error instanceof ApplicationError && error.code === 'COMMUNITY_UNAVAILABLE'
  );
}

test('campus count snapshots use one narrow unlocked query and make missing regions false', async () => {
  const f = fixture();
  const active = randomUUID(),
    inactive = randomUUID(),
    missing = randomUUID();
  f.state.regions.set(active, true);
  f.state.regions.set(inactive, false);
  const ids = [missing, active, inactive, active];
  const result = await new CampusContentScopeFacade().readRegionsBatch(
    ids,
    f.tx,
  );
  assert.deepEqual(
    result,
    new Map([
      [active, true],
      [inactive, false],
      [missing, false],
    ]),
  );
  assert.deepEqual(f.statements, [
    {
      sql: 'SELECT id,is_active FROM whaleu_campus.operating_regions WHERE id=ANY($1::uuid[])',
      values: [[active, inactive, missing].sort()],
    },
  ]);
  assert.deepEqual(ids, [missing, active, inactive, active]);
});

test('campus count snapshots bound distinct inputs and skip empty batches', async () => {
  const f = fixture();
  const facade = new CampusContentScopeFacade();
  assert.deepEqual(await facade.readRegionsBatch([], f.tx), new Map());
  assert.equal(f.statements.length, 0);
  const ids = Array.from({ length: CONTENT_SCOPE_BATCH_LIMIT }, () =>
    randomUUID(),
  );
  assert.equal(
    (await facade.readRegionsBatch([...ids, ...ids], f.tx)).size,
    256,
  );
  assert.equal(f.statements.length, 1);
  await assert.rejects(
    facade.readRegionsBatch([...ids, randomUUID()], f.tx),
    unavailable,
  );
  assert.equal(f.statements.length, 1);
});

test('safety count snapshots bypass SQL for guest, self and empty named batches', async () => {
  const f = fixture();
  const facade = new SafetyContentVisibilityFacade();
  assert.deepEqual(await facade.checkBatch(null, [author, author], f.tx), {
    facts: new Map([[author, allow]]),
    namedAccountIds: [],
  });
  assert.deepEqual(await facade.checkBatch(viewer, [viewer, viewer], f.tx), {
    facts: new Map([[viewer, allow]]),
    namedAccountIds: [],
  });
  assert.deepEqual(await facade.checkBatch(viewer, [], f.tx), {
    facts: new Map(),
    namedAccountIds: [],
  });
  assert.equal(f.statements.length, 0);
});

test('safety count snapshots have a fixed three-query shape at one and 768 authors', async () => {
  for (const size of [1, CONTENT_VISIBILITY_BATCH_LIMIT]) {
    const ids = Array.from({ length: size }, () => randomUUID());
    const f = fixture(ids);
    const result = await new SafetyContentVisibilityFacade().checkBatch(
      viewer,
      [...ids, ...ids],
      f.tx,
    );
    assert.equal(result.facts.size, size);
    assert.deepEqual(result.namedAccountIds, [...ids].sort());
    for (const id of ids) assert.deepEqual(result.facts.get(id), allow);
    assert.equal(f.statements.length, 3);
    assert.equal(
      f.statements[0]!.sql,
      'SELECT account_id,block_coverage,provenance,valid_until FROM whaleu_safety.account_heads WHERE account_id=ANY($1::uuid[])',
    );
    assert.deepEqual(f.statements[0]!.values, [[viewer, ...ids].sort()]);
    assert.deepEqual(f.statements[1]!.values, [viewer, [...ids].sort()]);
    assert.match(
      f.statements[1]!.sql,
      /blocker_id=\$1 AND blocked_id=ANY\(\$2::uuid\[\]\) AND active/,
    );
    assert.match(
      f.statements[1]!.sql,
      /blocked_id=\$1 AND blocker_id=ANY\(\$2::uuid\[\]\) AND active/,
    );
    assert.equal(f.statements[2]!.sql, 'SELECT clock_timestamp() AS now');
    assert.doesNotMatch(
      f.statements.map(({ sql }) => sql).join('\n'),
      /FOR SHARE|FOR UPDATE|pg_advisory|whaleu_(?:identity|profile|community|campus)|restriction_coverage|actions_allowed|display_snapshot|source_id|SELECT \*/,
    );
  }
});

test('safety count bounds apply to distinct named inputs before SQL or bypass', async () => {
  const f = fixture();
  const ids = Array.from({ length: CONTENT_VISIBILITY_BATCH_LIMIT + 1 }, () =>
    randomUUID(),
  );
  const facade = new SafetyContentVisibilityFacade();
  for (const requester of [null, viewer])
    await assert.rejects(facade.checkBatch(requester, ids, f.tx), unavailable);
  assert.equal(f.statements.length, 0);
});

test('bilateral direct visibility honors outgoing, incoming, both and inactive blocks', async () => {
  for (const direction of [
    'outgoing',
    'incoming',
    'both',
    'inactive',
    'unrelated',
  ] as const) {
    const f = fixture();
    if (
      direction === 'outgoing' ||
      direction === 'both' ||
      direction === 'inactive'
    )
      f.state.blocks.push({
        blocker_id: viewer,
        blocked_id: author,
        active: direction !== 'inactive',
      });
    if (direction === 'incoming' || direction === 'both')
      f.state.blocks.push({
        blocker_id: author,
        blocked_id: viewer,
        active: true,
      });
    if (direction === 'unrelated')
      f.state.blocks.push({
        blocker_id: viewer,
        blocked_id: randomUUID(),
        active: true,
      });
    const result = await new SafetyContentVisibilityFacade().checkBatch(
      viewer,
      [author],
      f.tx,
    );
    assert.deepEqual(result.facts.get(author), {
      decision:
        direction === 'inactive' || direction === 'unrelated'
          ? 'allow'
          : 'deny',
      optionalUntil: null,
    });
  }
});

test('missing, expired, malformed and uncovered heads remain unknown even with active blocks', async () => {
  const invalid: (Partial<SafetyHead> | null)[] = [
    null,
    { block_coverage: 'missing' },
    { block_coverage: 'conflict' },
    { provenance: 'unknown' },
    { provenance: 'unsupported' },
    { valid_until: new Date(now.getTime() - 1) },
    { valid_until: now },
    { valid_until: new Date(Number.NaN) },
  ];
  for (const invalidAccount of [viewer, author])
    for (const patch of invalid) {
      const f = fixture();
      if (patch) f.state.heads.set(invalidAccount, head(patch));
      else f.state.heads.delete(invalidAccount);
      f.state.blocks.push({
        blocker_id: author,
        blocked_id: viewer,
        active: true,
      });
      const result = await new SafetyContentVisibilityFacade().checkBatch(
        viewer,
        [viewer, author],
        f.tx,
      );
      assert.deepEqual(result.facts.get(author), unknown);
      assert.deepEqual(result.facts.get(viewer), allow);
      assert.equal(f.statements.length, 3);
    }
  const f = fixture();
  f.state.now = new Date(Number.NaN);
  assert.deepEqual(
    (
      await new SafetyContentVisibilityFacade().checkBatch(
        viewer,
        [author],
        f.tx,
      )
    ).facts.get(author),
    unknown,
  );
});

test('batch authors retain independent coverage, decisions and horizons', async () => {
  const denied = randomUUID(),
    missing = randomUUID();
  const f = fixture([author, denied]);
  f.state.heads.set(viewer, head({ valid_until: new Date(4_000) }));
  f.state.heads.set(author, head({ valid_until: new Date(3_000) }));
  f.state.heads.set(denied, head({ valid_until: expiry }));
  f.state.blocks.push({ blocker_id: denied, blocked_id: viewer, active: true });
  const result = await new SafetyContentVisibilityFacade().checkBatch(
    viewer,
    [missing, viewer, denied, author, denied],
    f.tx,
  );
  assert.deepEqual(
    result.facts,
    new Map<string, ContentVisibilityFact>([
      [viewer, allow],
      [missing, unknown],
      [author, { decision: 'allow', optionalUntil: 3_000 }],
      [denied, { decision: 'deny', optionalUntil: 2_000 }],
    ]),
  );
  assert.deepEqual(result.namedAccountIds, [author, denied, missing].sort());
  assert.equal(f.statements.length, 3);
});

test('each allowed or denied fact carries the earliest bilateral head horizon', async () => {
  for (const blocked of [false, true])
    for (const [viewerUntil, authorUntil, expected] of [
      [null, null, null],
      [null, expiry, expiry.getTime()],
      [expiry, null, expiry.getTime()],
      [expiry, new Date(3_000), expiry.getTime()],
      [new Date(3_000), expiry, expiry.getTime()],
    ] as const) {
      const f = fixture();
      f.state.heads.set(viewer, head({ valid_until: viewerUntil }));
      f.state.heads.set(author, head({ valid_until: authorUntil }));
      if (blocked)
        f.state.blocks.push({
          blocker_id: author,
          blocked_id: viewer,
          active: true,
        });
      assert.deepEqual(
        (
          await new SafetyContentVisibilityFacade().checkBatch(
            viewer,
            [author],
            f.tx,
          )
        ).facts.get(author),
        {
          decision: blocked ? 'deny' : 'allow',
          optionalUntil: expected,
        },
      );
    }
});

test('batch snapshots do not register or disturb mandatory transaction deadlines', async () => {
  const f = fixture();
  f.state.heads.set(viewer, head({ valid_until: expiry }));
  startTransactionDeadlines(f.tx);
  try {
    registerTransactionDeadline(f.tx, 3_000, 'ACCESS_TOKEN_EXPIRED');
    const before = checkpointTransactionDeadlines(f.tx);
    await new SafetyContentVisibilityFacade().checkBatch(
      viewer,
      [author],
      f.tx,
    );
    await new CampusContentScopeFacade().readRegionsBatch([randomUUID()], f.tx);
    assert.deepEqual(checkpointTransactionDeadlines(f.tx), before);
    await new SafetyRepository().directions(
      viewer,
      author,
      'direct_post',
      f.tx,
    );
    assert.equal(
      checkpointTransactionDeadlines(f.tx).get('COMMUNITY_UNAVAILABLE'),
      expiry.getTime(),
    );
    assert.equal(
      checkpointTransactionDeadlines(f.tx).get('ACCESS_TOKEN_EXPIRED'),
      3_000,
    );
    assert.equal(
      f.statements.filter(({ sql }) => sql.endsWith('FOR SHARE')).length,
      2,
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('scalar and count batch visibility share coverage policy without adding restriction authority', async () => {
  for (const direction of ['none', 'outgoing', 'incoming'] as const)
    for (const patch of [
      {},
      { block_coverage: 'missing' },
      { provenance: 'unknown' },
      { valid_until: expiry },
      { valid_until: now },
      { restriction_coverage: 'missing', actions_allowed: false },
    ] satisfies Partial<SafetyHead>[]) {
      const f = fixture();
      f.state.heads.set(author, head(patch));
      if (direction !== 'none')
        f.state.blocks.push({
          blocker_id: direction === 'outgoing' ? viewer : author,
          blocked_id: direction === 'outgoing' ? author : viewer,
          active: true,
        });
      const scalar = new NamedBlockVisibility(
        { check: async () => ({ kind: 'allow', value: undefined }) },
        new SafetyRepository(),
      );
      const scalarResult = await scalar.checkNamedRelationship(
        viewer,
        author,
        f.tx,
        'direct_post',
      );
      const batchResult = await new SafetyContentVisibilityFacade().checkBatch(
        viewer,
        [author],
        f.tx,
      );
      assert.equal(
        batchResult.facts.get(author)!.decision,
        scalarResult.kind === 'unavailable' ? 'unknown' : scalarResult.kind,
      );
    }
});

test('ordinary scalar list projection remains outgoing-only with no author head requirement', async () => {
  const f = fixture();
  f.state.heads.delete(author);
  f.state.blocks.push({ blocker_id: author, blocked_id: viewer, active: true });
  const scalar = new NamedBlockVisibility(
    { check: async () => ({ kind: 'allow', value: undefined }) },
    new SafetyRepository(),
  );
  assert.equal(
    (
      await scalar.checkNamedRelationship(
        viewer,
        author,
        f.tx,
        'list_projection',
      )
    ).kind,
    'allow',
  );
  assert.deepEqual(f.statements[0]!.values, [viewer]);
  assert.equal(
    f.statements.filter(({ sql }) => sql.includes('account_heads')).length,
    1,
  );
  assert.deepEqual(
    (
      await new SafetyContentVisibilityFacade().checkBatch(
        viewer,
        [author],
        f.tx,
      )
    ).facts.get(author),
    unknown,
  );
});

test('each owner exports its narrow snapshot facade through its own module', () => {
  for (const [module, facade] of [
    [CampusModule, CampusContentScopeFacade],
    [SafetyPolicyModule, SafetyContentVisibilityFacade],
  ] as const) {
    assert.ok(
      (Reflect.getMetadata('providers', module) as unknown[]).includes(facade),
    );
    assert.ok(
      (Reflect.getMetadata('exports', module) as unknown[]).includes(facade),
    );
  }
});
