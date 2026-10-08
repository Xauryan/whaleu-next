import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import {
  commentWorkerSchema,
  parseCommentCommand,
} from '../src/community/comment-component/contracts.js';
import type {
  CommentContribution,
  CommentCounts,
  CommentMembership,
  CommentSource,
  CommentState,
} from '../src/community/comment-component/contracts.js';
import { CommentComponentRepository } from '../src/community/comment-component/repository.js';
import {
  commentAfterCounts,
  CommentComponentSettlement,
} from '../src/community/comment-component/settlement.js';
import {
  CommentComponentWorker,
  assertLocalCommentConnection,
  assertLocalCommentWorker,
} from '../src/community/comment-component/worker.js';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const owner = '33333333-3333-4333-8333-333333333333';
const secondActor = '44444444-4444-4444-8444-444444444444';
const fixtureId = (value: number) =>
  `55555555-5555-4555-8555-${value.toString(16).padStart(12, '0')}`;
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost/whaleu_test',
});
const source: CommentSource = {
  source_id: id,
  post_id: id,
  actor_id: other,
  kind: 'root',
  content_id: id,
  root_id: null,
  transition: 'created',
  source_sequence: '3',
  delta: 1,
  positive_source_id: null,
};
const zero: CommentState = {
  root_count: '0',
  reply_count: '0',
  eligible_count: '0',
  unique_actor_count: '0',
  last_sequence: '0',
  last_receipt_id: null,
};
const one: CommentState = {
  ...zero,
  root_count: '1',
  eligible_count: '1',
  unique_actor_count: '1',
  last_sequence: '1',
  last_receipt_id: id,
};
const active: CommentContribution = {
  actor_id: other,
  root_id: null,
  eligible: true,
  active: true,
  positive_source_id: id,
  last_sequence: '1',
  last_receipt_id: id,
};
const member: CommentMembership = {
  active_count: '1',
  last_sequence: '1',
  last_receipt_id: id,
};
const deletion: CommentSource = {
  ...source,
  source_id: fixtureId(5),
  transition: 'deleted',
  delta: -1,
  positive_source_id: id,
};

function counts(state: CommentCounts): string[] {
  return [
    state.root_count,
    state.reply_count,
    state.eligible_count,
    state.unique_actor_count,
  ];
}

/** Advances captured facts only, with no current content or visibility lookup. */
function capturedHistory() {
  const states = new Map<string, CommentState>();
  const contributions = new Map<string, CommentContribution>();
  const memberships = new Map<string, CommentMembership>();
  const sourceIds = new Set<string>();
  return (event: CommentSource) => {
    assert.equal(
      sourceIds.has(event.source_id),
      false,
      'fixture source is unique',
    );
    sourceIds.add(event.source_id);
    const contributionKey = `${event.post_id}:${event.kind}:${event.content_id}`;
    const memberKey = `${event.post_id}:${event.actor_id}`;
    const contribution = contributions.get(contributionKey) ?? null;
    const after = commentAfterCounts(
      event,
      states.get(event.post_id) ?? zero,
      contribution,
      memberships.get(memberKey) ?? null,
      owner,
    );
    const causal = {
      last_sequence: event.source_sequence,
      last_receipt_id: event.source_id,
    };
    states.set(event.post_id, { ...after, ...causal });
    contributions.set(contributionKey, {
      actor_id: event.actor_id,
      root_id: event.root_id,
      eligible: after.eligible,
      active: event.transition === 'created',
      positive_source_id: contribution?.positive_source_id ?? event.source_id,
      ...causal,
    });
    memberships.set(memberKey, {
      active_count: after.active_count,
      ...causal,
    });
    return after;
  };
}

test('comment cardinality unions a real actor across kinds and roots, with kind-scoped content IDs', () => {
  const apply = capturedHistory();
  const root = { ...source, source_sequence: '1' };
  const reply: CommentSource = {
    ...source,
    source_id: other,
    kind: 'reply',
    root_id: id,
    source_sequence: '3',
  };
  assert.deepEqual(counts(apply(root)), ['1', '0', '1', '1']);
  assert.deepEqual(counts(apply(reply)), ['1', '1', '2', '1']);
  const anotherRoot = {
    ...source,
    source_id: owner,
    content_id: other,
    source_sequence: '7',
  };
  assert.deepEqual(counts(apply(anotherRoot)), ['2', '1', '3', '1']);
  assert.deepEqual(
    counts(
      apply({
        ...source,
        source_id: secondActor,
        actor_id: secondActor,
        content_id: secondActor,
        source_sequence: '9',
      }),
    ),
    ['3', '1', '4', '2'],
  );
  // Removing a root retains the actor's live reply and other root contribution.
  assert.deepEqual(counts(apply({ ...deletion, source_sequence: '11' })), [
    '2',
    '1',
    '3',
    '2',
  ]);
  assert.deepEqual(
    counts(
      apply({
        ...deletion,
        source_id: fixtureId(6),
        content_id: anotherRoot.content_id,
        positive_source_id: anotherRoot.source_id,
        source_sequence: '15',
      }),
    ),
    ['1', '1', '2', '2'],
  );
  const last = apply({
    ...deletion,
    source_id: fixtureId(7),
    kind: 'reply',
    root_id: id,
    positive_source_id: reply.source_id,
    source_sequence: '19',
  });
  assert.deepEqual(counts(last), ['1', '0', '1', '1']);
  assert.equal(last.active_count, '0');
  // A subsequent new contribution reactivates the actor, not the old content.
  assert.deepEqual(
    counts(
      apply({
        ...source,
        source_id: fixtureId(8),
        content_id: owner,
        source_sequence: '23',
      }),
    ),
    ['2', '0', '2', '2'],
  );
});

test('post-author contributions change raw counts and retained cardinality only', () => {
  const apply = capturedHistory();
  const authorRoot: CommentSource = {
    ...source,
    actor_id: owner,
    source_sequence: '1',
  };
  assert.deepEqual(apply(authorRoot), {
    root_count: '1',
    reply_count: '0',
    eligible_count: '0',
    unique_actor_count: '0',
    active_count: '1',
    eligible: false,
  });
  assert.deepEqual(
    counts(
      apply({
        ...authorRoot,
        kind: 'reply',
        source_id: other,
        root_id: id,
        source_sequence: '3',
      }),
    ),
    ['1', '1', '0', '0'],
  );
  assert.deepEqual(
    counts(
      apply({
        ...source,
        source_id: secondActor,
        kind: 'reply',
        content_id: other,
        root_id: id,
        source_sequence: '5',
      }),
    ),
    ['1', '2', '1', '1'],
  );
  const afterRoot = apply({
    ...deletion,
    actor_id: owner,
    source_sequence: '7',
  });
  assert.deepEqual(counts(afterRoot), ['0', '2', '1', '1']);
  assert.equal(afterRoot.active_count, '1');
  const afterReply = apply({
    ...deletion,
    source_id: fixtureId(6),
    actor_id: owner,
    kind: 'reply',
    root_id: id,
    positive_source_id: other,
    source_sequence: '9',
  });
  assert.deepEqual(counts(afterReply), ['0', '1', '1', '1']);
  assert.equal(afterReply.active_count, '0');
});

test('deleting a reply leaves other replies to that reply and its root intact', () => {
  const apply = capturedHistory();
  apply({ ...source, actor_id: owner, source_sequence: '1' });
  const reply: CommentSource = {
    ...source,
    source_id: other,
    kind: 'reply',
    root_id: id,
    source_sequence: '3',
  };
  apply(reply);
  // Reply-target identity does not enter this aggregate's source contract.
  apply({
    ...reply,
    source_id: secondActor,
    content_id: other,
    source_sequence: '5',
  });
  const after = apply({
    ...reply,
    source_id: fixtureId(5),
    transition: 'deleted',
    delta: -1,
    positive_source_id: reply.source_id,
    source_sequence: '7',
  });
  assert.deepEqual(counts(after), ['1', '1', '1', '1']);
  assert.equal(after.active_count, '1');
});

test('comment actor membership is independent for each post', () => {
  const apply = capturedHistory();
  const first = apply(source);
  const second = apply({ ...source, source_id: other, post_id: other });
  assert.deepEqual(counts(first), ['1', '0', '1', '1']);
  assert.deepEqual(counts(second), ['1', '0', '1', '1']);
  assert.equal(second.active_count, '1');
});

test('comment counts and actor cardinality retain bigint precision and do not apply a comments-per-user cap', () => {
  const large = '9007199254740993';
  const after = commentAfterCounts(
    { ...source, source_sequence: '9007199254740995' },
    {
      ...one,
      root_count: large,
      eligible_count: large,
      last_sequence: '9007199254740994',
    },
    null,
    { ...member, active_count: large, last_sequence: '9007199254740993' },
    owner,
  );
  assert.deepEqual(counts(after), [
    '9007199254740994',
    '0',
    '9007199254740994',
    '1',
  ]);
  assert.equal(after.active_count, '9007199254740994');
  const firstActor = commentAfterCounts(
    { ...source, source_sequence: '9007199254740995' },
    {
      ...one,
      root_count: large,
      eligible_count: large,
      unique_actor_count: large,
      last_sequence: '9007199254740994',
    },
    null,
    null,
    owner,
  );
  assert.equal(firstActor.unique_actor_count, '9007199254740994');
});

test('comment deletions require the exact active content, actor, parent, eligibility and positive source', () => {
  assert.deepEqual(
    counts(commentAfterCounts(deletion, one, active, member, owner)),
    ['0', '0', '0', '0'],
  );
  for (const contribution of [
    null,
    { ...active, active: false },
    { ...active, actor_id: secondActor },
    { ...active, root_id: other },
    { ...active, eligible: false },
    { ...active, positive_source_id: other },
  ])
    assert.throws(() =>
      commentAfterCounts(deletion, one, contribution, member, owner),
    );
  assert.throws(() =>
    commentAfterCounts(
      { ...deletion, positive_source_id: null },
      one,
      active,
      member,
      owner,
    ),
  );
  // Another surviving contribution cannot excuse deleting this content twice.
  assert.throws(() =>
    commentAfterCounts(
      deletion,
      one,
      { ...active, active: false },
      { ...member, active_count: '2' },
      owner,
    ),
  );
});

test('comment arithmetic rejects duplicate creation, invalid deltas, malformed identities and underflow without clamping', () => {
  for (const changed of [
    { delta: -1 },
    { delta: 0 },
    { delta: 2 },
    { positive_source_id: other },
    { root_id: other },
    { kind: 'reply' as const },
  ])
    assert.throws(() =>
      commentAfterCounts({ ...source, ...changed }, zero, null, null, owner),
    );
  for (const contribution of [active, { ...active, active: false }])
    assert.throws(() =>
      commentAfterCounts(source, one, contribution, member, owner),
    );
  for (const changed of [{ delta: 1 }, { delta: 0 }, { delta: -2 }])
    assert.throws(() =>
      commentAfterCounts(
        { ...deletion, ...changed },
        one,
        active,
        member,
        owner,
      ),
    );
  assert.throws(() =>
    commentAfterCounts(deletion, zero, active, member, owner),
  );
  assert.throws(() => commentAfterCounts(deletion, one, active, null, owner));
  assert.throws(() =>
    commentAfterCounts(
      deletion,
      one,
      active,
      { ...member, active_count: '0' },
      owner,
    ),
  );
  assert.throws(() =>
    commentAfterCounts(
      source,
      zero,
      null,
      { ...member, active_count: '-1' },
      owner,
    ),
  );
  for (const state of [
    { ...zero, eligible_count: '2' },
    { ...zero, unique_actor_count: '2' },
    { ...zero, reply_count: '-1' },
  ])
    assert.throws(() => commentAfterCounts(source, state, null, null, owner));
});

test('comment causal positions compare bigint sequences for post, contribution and actor independently', () => {
  const sequence = '9007199254740993';
  const event = { ...deletion, source_sequence: sequence };
  for (const last_sequence of [sequence, '9007199254740994']) {
    assert.throws(() =>
      commentAfterCounts(
        event,
        { ...one, last_sequence },
        active,
        member,
        owner,
      ),
    );
    assert.throws(() =>
      commentAfterCounts(
        event,
        one,
        { ...active, last_sequence },
        member,
        owner,
      ),
    );
    assert.throws(() =>
      commentAfterCounts(
        event,
        one,
        active,
        { ...member, last_sequence },
        owner,
      ),
    );
  }
  assert.deepEqual(
    counts(
      commentAfterCounts(
        event,
        { ...one, last_sequence: '9007199254740992' },
        active,
        member,
        owner,
      ),
    ),
    ['0', '0', '0', '0'],
  );
});

test('comment selection defaults to advisory dry-run and requires bounded explicit apply IDs', () => {
  assert.deepEqual(parseCommentCommand([]), {
    mode: 'dry-run',
    sourceIds: [],
  });
  assert.deepEqual(parseCommentCommand([`--source-id=${id}`]), {
    mode: 'dry-run',
    sourceIds: [id],
  });
  assert.deepEqual(parseCommentCommand(['apply', `--source-id=${id}`]), {
    mode: 'apply',
    sourceIds: [id],
  });
  const ids = Array.from(
    { length: 51 },
    (_, index) =>
      `11111111-1111-4111-8111-${index.toString(16).padStart(12, '0')}`,
  );
  assert.equal(
    commentWorkerSchema.parse({ mode: 'apply', sourceIds: ids.slice(0, 50) })
      .sourceIds.length,
    50,
  );
  assert.throws(() => commentWorkerSchema.parse({ sourceIds: ids }));
  for (const args of [
    ['apply'],
    ['--all'],
    ['apply', '--production'],
    ['--backfill'],
    ['--repair'],
    ['--import=x'],
    [`--source-id=${id}`, `--source-id=${id}`],
    ['--source-id=invalid'],
    ['--source-id='],
    ['dry-run', 'apply', `--source-id=${id}`],
  ]) {
    assert.throws(() => parseCommentCommand(args), args.join(' '));
  }
  for (const input of [{ all: true }, { mode: 'automatic' }, { repair: true }])
    assert.throws(() => commentWorkerSchema.parse(input));
});

test('comment source IDs normalize case before duplicate validation', () => {
  const mixed = 'ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF';
  assert.deepEqual(parseCommentCommand([`--source-id=${mixed}`]).sourceIds, [
    mixed.toLowerCase(),
  ]);
  assert.throws(() =>
    parseCommentCommand([
      `--source-id=${mixed}`,
      `--source-id=${mixed.toLowerCase()}`,
    ]),
  );
});

test('comment worker refuses production, remote hosts and non-disposable database URLs', () => {
  for (const changed of [
    { NODE_ENV: 'production' as const },
    { DATABASE_URL: 'postgres://remote/whaleu_test' },
    { DATABASE_URL: 'postgres://localhost/production' },
    { DATABASE_URL: 'postgres://127.0.0.1/whaleu_test_copy' },
  ])
    assert.throws(() => assertLocalCommentWorker({ ...config, ...changed }));
  for (const DATABASE_URL of [
    'postgres://localhost/whaleu_test',
    'postgres://127.0.0.1/whaleu_dev',
    'postgres://[::1]/whaleu_test',
  ])
    assert.doesNotThrow(() =>
      assertLocalCommentWorker({ ...config, DATABASE_URL }),
    );
});

test('comment worker validates actual peer and database rather than trusting a local URL', async () => {
  const connection = (host: string, peer: string | undefined, name: string) =>
    ({
      host,
      connection: { stream: { remoteAddress: peer } },
      query: async () => ({ rows: [{ name }] }),
    }) as unknown as PoolClient;
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
    await assertLocalCommentConnection(
      connection('localhost', peer, 'whaleu_test'),
    );
  for (const tx of [
    connection('localhost', '10.0.0.1', 'whaleu_test'),
    connection('localhost', undefined, 'whaleu_test'),
    connection('remote', '127.0.0.1', 'whaleu_test'),
    connection('localhost', '127.0.0.1', 'production'),
  ])
    await assert.rejects(assertLocalCommentConnection(tx));
});

test('comment dry-run declares read-only before inspection and isolates failed selected IDs', async () => {
  const calls: string[] = [];
  const tx = {
    host: 'localhost',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [{ name: 'whaleu_test' }] };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async (
      fn: (tx: PoolClient) => Promise<unknown>,
      options: { isolationLevel: string },
    ) => {
      assert.equal(options.isolationLevel, 'read committed');
      return fn(tx);
    },
  } as unknown as DatabaseService;
  const settlement = {
    process: async (selected: string, client: PoolClient, apply: boolean) => {
      assert.equal(client, tx);
      assert.equal(apply, false);
      calls.push(`inspect:${selected}`);
      if (selected === id) throw new Error(`private source details ${id}`);
      return 'pending';
    },
  } as unknown as CommentComponentSettlement;
  const result = await new CommentComponentWorker(
    config,
    database,
    settlement,
  ).run({ sourceIds: [id, other] });
  assert.equal(result.requested, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.advisory, true);
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(calls, [
    'SET TRANSACTION READ ONLY',
    'SELECT current_database() AS name',
    `inspect:${id}`,
    'SET TRANSACTION READ ONLY',
    'SELECT current_database() AS name',
    `inspect:${other}`,
  ]);
  assert.equal(JSON.stringify(result).includes(id), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('disabled comment apply and invalid selection are rejected before obtaining a transaction', async () => {
  const database = {
    transaction: async () => {
      assert.fail('must not connect');
    },
  } as unknown as DatabaseService;
  const worker = new CommentComponentWorker(
    { ...config, COMMENT_COMPONENT_PROCESSING: 'disabled' },
    database,
    {} as CommentComponentSettlement,
  );
  await assert.rejects(
    worker.run({ mode: 'apply', sourceIds: [id] }),
    /Comment processing is disabled/,
  );
  await assert.rejects(worker.run({ mode: 'apply', sourceIds: [] }));
  await assert.rejects(worker.run({ sourceIds: [id, id] }));
});

function settlementFixture(
  options: {
    source?: CommentSource | null;
    sourceAfterLock?: CommentSource | null;
    ownerId?: string | null;
    state?: CommentState | null;
    receipt?: boolean;
    first?: string | null;
    contribution?: CommentContribution | null;
    membership?: CommentMembership | null;
    failWrite?: number;
  } = {},
) {
  const calls: string[] = [];
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const selected = options.source === undefined ? source : options.source;
  const tx = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      if (queries.length === options.failWrite)
        throw new Error('injected write failure');
      return { rows: [] };
    },
  } as unknown as PoolClient;
  let reads = 0;
  const records = {
    reference: async (selectedId: string, client: PoolClient) => {
      calls.push('reference');
      assert.equal(selectedId, selected?.source_id ?? id);
      assert.equal(client, tx);
      reads++;
      return reads > 1 && options.sourceAfterLock !== undefined
        ? options.sourceAfterLock
        : selected;
    },
    lockPost: async (postId: string, client: PoolClient) => {
      calls.push('post-lock');
      assert.equal(postId, selected?.post_id);
      assert.equal(client, tx);
    },
    owner: async () => {
      calls.push('owner');
      return options.ownerId === undefined ? owner : options.ownerId;
    },
    state: async (_post: string, _tx: PoolClient, lock: boolean) => {
      calls.push(lock ? 'state-lock' : 'state-read');
      return options.state === undefined ? zero : options.state;
    },
    receipt: async () => {
      calls.push('receipt');
      return options.receipt ?? false;
    },
    first: async () => {
      calls.push('first');
      return options.first === undefined
        ? selected?.source_sequence
        : options.first;
    },
    contribution: async (
      captured: CommentSource,
      client: PoolClient,
      lock: boolean,
    ) => {
      calls.push(lock ? 'contribution-lock' : 'contribution-read');
      assert.equal(captured, options.sourceAfterLock ?? selected);
      assert.equal(client, tx);
      return options.contribution ?? null;
    },
    membership: async (
      postId: string,
      actorId: string,
      client: PoolClient,
      lock: boolean,
    ) => {
      calls.push(lock ? 'member-lock' : 'member-read');
      assert.equal(postId, (options.sourceAfterLock ?? selected)?.post_id);
      assert.equal(actorId, (options.sourceAfterLock ?? selected)?.actor_id);
      assert.equal(client, tx);
      return options.membership ?? null;
    },
  } as unknown as CommentComponentRepository;
  return {
    calls,
    queries,
    tx,
    settlement: new CommentComponentSettlement(records),
  };
}

test('comment apply locks parent, state, contribution then actor and only writes this component', async () => {
  const f = settlementFixture();
  assert.equal(await f.settlement.process(id, f.tx, true), 'applied');
  assert.deepEqual(f.calls, [
    'reference',
    'post-lock',
    'reference',
    'owner',
    'state-lock',
    'receipt',
    'first',
    'contribution-lock',
    'member-lock',
  ]);
  assert.equal(f.queries.length, 4);
  assert.match(
    f.queries[0]!.sql,
    /INSERT INTO whaleu_post_hotness.comment_receipts/,
  );
  assert.match(f.queries[1]!.sql, /UPDATE whaleu_post_hotness.comment_states/);
  assert.match(
    f.queries[2]!.sql,
    /INSERT INTO whaleu_post_hotness.comment_contributions/,
  );
  assert.match(
    f.queries[3]!.sql,
    /INSERT INTO whaleu_post_hotness.comment_memberships/,
  );
  assert.deepEqual(f.queries[0]!.values, [
    id,
    id,
    other,
    'root',
    id,
    null,
    'created',
    1,
    '3',
    null,
    true,
    '0',
    '0',
    '0',
    '0',
    '1',
    '0',
    '1',
    '1',
    '0',
    '0',
    null,
    '0',
    '0',
    '1',
  ]);
  assert.deepEqual(f.queries[1]!.values, [id, '1', '0', '1', '1', '3', id]);
  assert.deepEqual(f.queries[2]!.values, [
    id,
    'root',
    id,
    null,
    other,
    true,
    id,
    '3',
  ]);
  assert.deepEqual(f.queries[3]!.values, [id, other, '1', '3', id]);
  assert.equal(
    f.queries.some(({ sql }) =>
      /experience|author_interactions|reward|outbox|saved|root_comments|replies|accounts|policy/.test(
        sql,
      ),
    ),
    false,
  );
});

test('comment deletion updates exactly the selected kind/content and retains actor evidence', async () => {
  const f = settlementFixture({
    source: deletion,
    state: { ...one, root_count: '2', eligible_count: '2' },
    contribution: active,
    membership: { ...member, active_count: '2' },
  });
  assert.equal(
    await f.settlement.process(deletion.source_id, f.tx, true),
    'applied',
  );
  assert.match(
    f.queries[2]!.sql,
    /UPDATE whaleu_post_hotness.comment_contributions/,
  );
  assert.match(
    f.queries[2]!.sql,
    /WHERE post_id=\$1 AND kind=\$2 AND content_id=\$3/,
  );
  assert.deepEqual(f.queries[1]!.values, [
    id,
    '1',
    '0',
    '1',
    '1',
    '3',
    deletion.source_id,
  ]);
  assert.deepEqual(f.queries[2]!.values, [
    id,
    'root',
    id,
    '3',
    deletion.source_id,
  ]);
  assert.deepEqual(f.queries[3]!.values, [
    id,
    other,
    '1',
    '3',
    deletion.source_id,
  ]);
  assert.equal(
    f.queries.some(({ sql }) => /DELETE FROM/.test(sql)),
    false,
  );
});

test('comment immutable replay bypasses newer head, contribution and membership validation', async () => {
  for (const apply of [false, true]) {
    const f = settlementFixture({
      receipt: true,
      state: { ...zero, last_sequence: '9007199254740993' },
      contribution: {
        ...active,
        active: false,
        last_sequence: '9007199254740993',
      },
      membership: {
        ...member,
        active_count: '0',
        last_sequence: '9007199254740993',
      },
    });
    assert.equal(
      await f.settlement.process(id, f.tx, apply),
      'alreadyCompleted',
    );
    assert.deepEqual(f.calls, [
      'reference',
      ...(apply ? ['post-lock', 'reference'] : []),
      'owner',
      apply ? 'state-lock' : 'state-read',
      'receipt',
    ]);
    assert.deepEqual(f.queries, []);
  }
});

test('comment dry-run uses no row locks or writes and preserves explicit unavailable outcomes', async () => {
  const f = settlementFixture();
  assert.equal(await f.settlement.process(id, f.tx, false), 'pending');
  assert.deepEqual(f.calls, [
    'reference',
    'owner',
    'state-read',
    'receipt',
    'first',
    'contribution-read',
    'member-read',
  ]);
  assert.deepEqual(f.queries, []);
  for (const [options, expected] of [
    [{ source: null }, 'missing'],
    [{ ownerId: null }, 'blockedBaseline'],
    [{ first: '1' }, 'blockedPredecessor'],
    [{ first: null }, 'blockedPredecessor'],
  ] as const) {
    const blocked = settlementFixture(options);
    assert.equal(
      await blocked.settlement.process(id, blocked.tx, false),
      expected,
    );
    assert.equal(
      blocked.calls.some((call) => /lock/.test(call)),
      false,
    );
    assert.deepEqual(blocked.queries, []);
  }
});

test('comment apply rereads source after parent lock and leaves missing or blocked work untouched', async () => {
  const unavailable = settlementFixture({ sourceAfterLock: null });
  assert.equal(
    await unavailable.settlement.process(id, unavailable.tx, true),
    'sourceUnavailable',
  );
  assert.deepEqual(unavailable.calls, ['reference', 'post-lock', 'reference']);
  assert.deepEqual(unavailable.queries, []);
  const predecessor = settlementFixture({ first: '1' });
  assert.equal(
    await predecessor.settlement.process(id, predecessor.tx, true),
    'blockedPredecessor',
  );
  assert.equal(predecessor.calls.includes('contribution-lock'), false);
  assert.equal(predecessor.calls.includes('member-lock'), false);
  assert.deepEqual(predecessor.queries, []);
  const missingState = settlementFixture({ state: null });
  await assert.rejects(
    missingState.settlement.process(id, missingState.tx, true),
    /Known comment baseline without state/,
  );
  assert.deepEqual(missingState.queries, []);
});

test('comment settlement propagates failure at each write for the transaction owner to roll back', async () => {
  for (let failWrite = 1; failWrite <= 4; failWrite++) {
    const f = settlementFixture({ failWrite });
    await assert.rejects(
      f.settlement.process(id, f.tx, true),
      /injected write failure/,
    );
    assert.equal(f.queries.length, failWrite);
  }
});

test('comment repository keys applied contribution by post, kind and content with optional lock', async () => {
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: readonly unknown[]) => {
      queries.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const records = new CommentComponentRepository();
  assert.equal(await records.contribution(source, tx, false), null);
  assert.equal(
    await records.contribution(
      { ...source, kind: 'reply', root_id: other },
      tx,
      true,
    ),
    null,
  );
  assert.deepEqual(queries[0]!.values, [id, 'root', id]);
  assert.deepEqual(queries[1]!.values, [id, 'reply', id]);
  for (const { sql } of queries) {
    assert.match(sql, /WHERE post_id=\$1 AND kind=\$2 AND content_id=\$3/);
    assert.doesNotMatch(sql, /root_comments|replies|accounts/);
  }
  assert.doesNotMatch(queries[0]!.sql, /FOR UPDATE/);
  assert.match(queries[1]!.sql, /FOR UPDATE$/);
});

test('comment immutable receipt validation binds every source identity field and rejects mismatch', async () => {
  const records = new CommentComponentRepository();
  for (const valid of [true, false, undefined]) {
    const tx = {
      query: async (sql: string, values: readonly unknown[]) => {
        assert.match(sql, /component_version=1/);
        assert.match(sql, /positive_source_id IS NOT DISTINCT FROM/);
        assert.match(sql, /root_id IS NOT DISTINCT FROM/);
        assert.deepEqual(values, [
          source.source_id,
          source.post_id,
          source.actor_id,
          source.kind,
          source.content_id,
          source.root_id,
          source.transition,
          source.delta,
          source.source_sequence,
          source.positive_source_id,
        ]);
        return { rows: valid === undefined ? [] : [{ valid }] };
      },
    } as unknown as PoolClient;
    if (valid === false)
      await assert.rejects(
        records.receipt(source, tx),
        /Comment receipt identity mismatch/,
      );
    else assert.equal(await records.receipt(source, tx), valid ?? false);
  }
});

test('comment apply counts only committed outcomes and a blocked selection does not starve later IDs', async () => {
  const selectedIds = [id, other, owner];
  const queried: string[] = [];
  const tx = {
    host: 'localhost',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async (sql: string) => {
      queried.push(sql);
      return { rows: [{ name: 'whaleu_test' }] };
    },
  } as unknown as PoolClient;
  let transaction = 0;
  const database = {
    transaction: async (fn: (tx: PoolClient) => Promise<unknown>) => {
      transaction++;
      const result = await fn(tx);
      if (transaction === 1) throw new Error('deferred consistency failed');
      return result;
    },
  } as unknown as DatabaseService;
  const inspected: string[] = [];
  const settlement = {
    process: async (selected: string, _tx: PoolClient, apply: boolean) => {
      assert.equal(apply, true);
      inspected.push(selected);
      return selected === other ? 'blockedPredecessor' : 'applied';
    },
  } as unknown as CommentComponentSettlement;
  const result = await new CommentComponentWorker(
    { ...config, COMMENT_COMPONENT_PROCESSING: 'manual_only' },
    database,
    settlement,
  ).run({ mode: 'apply', sourceIds: selectedIds });
  assert.deepEqual(inspected, selectedIds);
  assert.equal(result.advisory, false);
  assert.equal(result.failed, 1);
  assert.equal(result.blockedPredecessor, 1);
  assert.equal(result.applied, 1);
  assert.equal(result.requested, 3);
  assert.deepEqual(queried, Array(3).fill('SELECT current_database() AS name'));
});
