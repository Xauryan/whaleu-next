import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { CampusService } from '../src/campus/campus.service.js';
import type {
  VisibilityPurpose,
  VisibilitySubject,
} from '../src/community/community-policy.js';
import type {
  StoredComment,
  StoredReply,
} from '../src/community/community.repository.js';
import { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import type {
  ApprovalBinding,
  ApprovalRow,
} from '../src/community/content-review/approval-validation.js';
import { ContentDefinitionRepository } from '../src/community/content-review/content-definition.repository.js';
import {
  approvalDigest,
  canonicalEnvelope,
  operationForKind,
} from '../src/community/content-review/contracts.js';
import type { ContentKind } from '../src/community/content-review/contracts.js';
import type { DefinitionPost } from '../src/community/content-review/definition-validation.js';
import { LocalApprovedContentVisibility } from '../src/community/content-review/local-approved-content-visibility.js';
import { SearchReadContext } from '../src/community/content-review/search-read-context.js';
import {
  searchPost,
  searchReply,
  searchRoot,
} from '../src/community/content-review/search-source-reads.js';
import { inTransaction } from '../src/database/database.js';
import {
  checkpointTransactionDeadlines,
  clearTransactionDeadlines,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  restoreTransactionDeadlines,
  startTransactionDeadlines,
  transactionReadEpoch,
} from '../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { SafetyRepository } from '../src/safety/repository.js';
import { NamedBlockVisibility } from '../src/safety/visibility.js';

const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'COMMUNITY_UNAVAILABLE';
const keep = () => true;
const emptyClient = () =>
  ({ query: async () => ({ rows: [] }) }) as unknown as PoolClient;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test('search read contexts require a managed epoch, isolate owners and reject another client or closure', async () => {
  const tx = emptyClient(),
    other = emptyClient();
  assert.throws(() => new SearchReadContext(tx), unavailable);
  startTransactionDeadlines(tx);
  startTransactionDeadlines(other);
  const epoch = transactionReadEpoch(tx)!;
  assert.ok(Object.isFrozen(epoch));
  assert.deepEqual(Reflect.ownKeys(epoch), []);
  assert.equal(
    epoch instanceof Map,
    false,
    'The deadline map must stay private',
  );
  const read = new SearchReadContext(tx),
    owner = {},
    otherOwner = {};
  let loads = 0;
  const load = async () => ++loads;
  try {
    assert.equal(await read.read(owner, 'same', tx, load, keep), 1);
    assert.equal(await read.read(owner, 'same', tx, load, keep), 1);
    assert.equal(await read.read(otherOwner, 'same', tx, load, keep), 2);
    await assert.rejects(
      read.read(owner, 'same', other, load, keep),
      unavailable,
    );
    read.close();
    read.close();
    await assert.rejects(read.read(owner, 'same', tx, load, keep), unavailable);
    assert.equal(loads, 2, 'Invalid contexts must reject before loading');
  } finally {
    clearTransactionDeadlines(tx);
    clearTransactionDeadlines(other);
  }
});

test('same PoolClient cannot reuse a context after commit or rollback into its next transaction', async () => {
  for (const rollback of [false, true]) {
    const commands: string[] = [];
    const tx = {
      query: async (sql: string) => {
        commands.push(sql);
        return { rows: [] };
      },
      release: () => {},
    } as unknown as PoolClient;
    const pool = { connect: async () => tx };
    const owner = {},
      failure = new Error('rollback fixture');
    let stale: SearchReadContext | undefined, oldEpoch: object | undefined;
    const first = inTransaction(pool, async (client) => {
      oldEpoch = transactionReadEpoch(client);
      stale = new SearchReadContext(client);
      assert.equal(
        await stale.read(owner, 'node', client, async () => 1, keep),
        1,
      );
      if (rollback) throw failure;
    });
    if (rollback) await assert.rejects(first, (error) => error === failure);
    else await first;
    assert.equal(transactionReadEpoch(tx), undefined);
    await assert.rejects(
      stale!.read(owner, 'node', tx, async () => 2, keep),
      unavailable,
    );
    await inTransaction(pool, async (client) => {
      assert.equal(client, tx);
      assert.notEqual(transactionReadEpoch(client), oldEpoch);
      await assert.rejects(
        stale!.read(owner, 'node', client, async () => 2, keep),
        unavailable,
      );
      const fresh = new SearchReadContext(client);
      assert.equal(
        await fresh.read(owner, 'node', client, async () => 3, keep),
        3,
      );
      fresh.close();
    });
    assert.deepEqual(commands, [
      'BEGIN',
      rollback ? 'ROLLBACK' : 'COMMIT',
      'BEGIN',
      'COMMIT',
    ]);
  }
});

test('checkpoint restoration invalidates cached reads without reviving them in a fresh context', async () => {
  const tx = emptyClient(),
    owner = {};
  startTransactionDeadlines(tx);
  try {
    const checkpoint = checkpointTransactionDeadlines(tx);
    const read = new SearchReadContext(tx),
      epoch = transactionReadEpoch(tx);
    assert.equal(
      await read.read(owner, 'node', tx, async () => 'before', keep),
      'before',
    );
    restoreTransactionDeadlines(tx, checkpoint);
    assert.notEqual(transactionReadEpoch(tx), epoch);
    await assert.rejects(
      read.read(owner, 'node', tx, async () => 'stale', keep),
      unavailable,
    );
    const fresh = new SearchReadContext(tx);
    assert.equal(
      await fresh.read(owner, 'node', tx, async () => 'after', keep),
      'after',
    );
    fresh.close();
    read.close();
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('closing a search context preserves mandatory deadlines and relationship facts through final validation', async () => {
  for (const expired of [false, true]) {
    const now = Date.parse('2026-10-07T12:00:00Z');
    const commands: string[] = [];
    const tx = {
      query: async (sql: string) => {
        commands.push(sql);
        return {
          rows: sql.includes('clock_timestamp') ? [{ now: new Date(now) }] : [],
        };
      },
      release: () => {},
    } as unknown as PoolClient;
    const fact = Object.freeze({
      viewer: randomUUID(),
      author: randomUUID(),
      purpose: 'direct_post' as const,
    });
    const validated: (typeof fact)[][] = [];
    const required: RequiredTransactionProof<typeof fact> = {
      maximumFacts: 1,
      failureCode: 'COMMUNITY_UNAVAILABLE',
      validate: async (facts, client) => {
        assert.equal(client, tx);
        assert.equal(commands.at(-1), 'SET CONSTRAINTS ALL IMMEDIATE');
        validated.push([...facts]);
      },
    };
    const result = inTransaction(
      { connect: async () => tx },
      async (client) => {
        const read = new SearchReadContext(client);
        const epoch = transactionReadEpoch(client);
        enableRequiredTransactionProof(client, required);
        registerRequiredTransactionFact(client, required, 'relationship', fact);
        registerTransactionDeadline(
          client,
          now + (expired ? 0 : 1000),
          'COMMUNITY_UNAVAILABLE',
        );
        await read.read({}, 'proof', client, async () => true, keep);
        read.close();
        assert.equal(
          transactionReadEpoch(client),
          epoch,
          'Close only ends cache reuse',
        );
        return 'private result';
      },
    );
    if (expired) await assert.rejects(result, unavailable);
    else assert.equal(await result, 'private result');
    assert.deepEqual(
      validated,
      [[fact]],
      'Final mandatory relationship facts survive close',
    );
    assert.deepEqual(commands, [
      'BEGIN',
      'SET CONSTRAINTS ALL IMMEDIATE',
      'SELECT clock_timestamp() AS now',
      expired ? 'ROLLBACK' : 'COMMIT',
    ]);
  }
});

test('in-flight loads cannot return or retain a value after close, restore or transaction replacement', async () => {
  for (const invalidate of ['close', 'restore', 'clear', 'restart'] as const) {
    const tx = emptyClient(),
      owner = {};
    startTransactionDeadlines(tx);
    const checkpoint = checkpointTransactionDeadlines(tx);
    const read = new SearchReadContext(tx);
    const loaded = deferred<string>();
    let retains = 0;
    const pending = read.read(
      owner,
      'node',
      tx,
      () => loaded.promise,
      () => {
        retains++;
        return true;
      },
    );
    if (invalidate === 'close') read.close();
    else if (invalidate === 'restore')
      restoreTransactionDeadlines(tx, checkpoint);
    else if (invalidate === 'clear') clearTransactionDeadlines(tx);
    else startTransactionDeadlines(tx);
    loaded.resolve('must not escape');
    await assert.rejects(pending, unavailable);
    assert.equal(retains, 0, invalidate);
    read.close();
    clearTransactionDeadlines(tx);
  }
});

test('nested and concurrent different-key loads preserve all same-owner entries', async () => {
  const tx = emptyClient(),
    owner = {};
  startTransactionDeadlines(tx);
  const read = new SearchReadContext(tx);
  try {
    assert.equal(
      await read.read(
        owner,
        'outer',
        tx,
        async () => {
          assert.equal(
            await read.read(
              owner,
              'inner',
              tx,
              async () => 'inner value',
              keep,
            ),
            'inner value',
          );
          return 'outer value';
        },
        keep,
      ),
      'outer value',
    );
    const first = deferred<string>();
    const second = deferred<string>();
    const pendingFirst = read.read(
      owner,
      'first',
      tx,
      () => first.promise,
      keep,
    );
    const pendingSecond = read.read(
      owner,
      'second',
      tx,
      () => second.promise,
      keep,
    );
    second.resolve('second value');
    await pendingSecond;
    first.resolve('first value');
    await pendingFirst;
    for (const key of ['inner', 'outer', 'first', 'second'])
      assert.equal(
        await read.read(
          owner,
          key,
          tx,
          async () => assert.fail('Retained entry was overwritten'),
          keep,
        ),
        `${key} value`,
      );
  } finally {
    read.close();
    clearTransactionDeadlines(tx);
  }
});

function fixture(collision = false) {
  const author = randomUUID(),
    viewer = randomUUID(),
    spaceId = randomUUID(),
    regionId = randomUUID();
  const now = Date.parse('2026-10-07T12:00:00Z');
  const post: DefinitionPost = {
    id: randomUUID(),
    space_id: spaceId,
    account_id: author,
    category: 'discussion',
    text: 'Canonical parent post',
    author_mode: 'named',
    comments_policy: 'open',
    visibility: 'approved',
    deleted_at: null,
    published_at: new Date(now - 10000),
    publication_state: 'published',
  };
  const root: StoredComment = {
    id: collision ? post.id : randomUUID(),
    post_id: post.id,
    account_id: author,
    text: 'Canonical root comment',
    author_mode: 'named',
    visibility: 'approved',
    deleted_at: null,
    created_at: new Date(now - 9000),
  };
  const reply: StoredReply = {
    id: collision ? post.id : randomUUID(),
    post_id: post.id,
    root_comment_id: root.id,
    target_reply_id: null,
    account_id: author,
    text: 'Canonical first reply',
    author_mode: 'named',
    visibility: 'approved',
    deleted_at: null,
    created_at: new Date(now - 8000),
    sequence: '1',
  };
  const sibling: StoredReply = {
    ...reply,
    id: randomUUID(),
    text: 'Canonical second reply',
    sequence: '2',
  };
  const nodes = [
    { kind: 'post', node: post },
    { kind: 'comment', node: root },
    { kind: 'reply', node: reply },
    { kind: 'reply', node: sibling },
  ] as const;
  const bindings = new Map<string, ApprovalBinding>(),
    approvals = new Map<string, ApprovalRow>();
  const key = (kind: ContentKind, id: string) => `${kind}:${id}`;
  for (const { kind, node } of nodes) {
    const envelope = canonicalEnvelope({
      version: 1,
      accountId: node.account_id,
      purpose: operationForKind(kind),
      spaceId,
      category: post.category,
      authorMode: node.author_mode,
      commentsPolicy: post.comments_policy,
      postId: kind === 'post' ? null : post.id,
      rootCommentId: kind === 'reply' ? root.id : null,
      targetReplyId: null,
      text: node.text,
      images: [],
      component: { kind: 'none' },
      trading: null,
      scope: {
        originalSpaceId: spaceId,
        originalRegionId: regionId,
        authorOriginRegionId: regionId,
        identityRegionId: regionId,
        topologySnapshotId: randomUUID(),
        sync: 'none',
      },
    });
    const row: ApprovalRow = {
      id: randomUUID(),
      account_id: node.account_id,
      operation: envelope.purpose,
      envelope_version: 1,
      digest: approvalDigest(envelope),
      envelope,
      policy_revision_id: randomUUID(),
      result: 'allow',
      coverage: 'complete',
      provenance: 'accepted',
      issuer: 'fixture',
      provenance_ref: 'fixture',
      evaluated_at: new Date(now - 5000),
      consume_until: new Date(now - 4000),
      visibility_model: 'durable',
      visibility_until: null,
      policy_key: 'local-explicit-v1',
      policy_version: 1,
      policy_coverage: 'complete',
      policy_provenance: 'accepted',
      policy_issuer: 'fixture',
      policy_provenance_ref: 'fixture',
      policy_valid_from: new Date(now - 6000),
      policy_valid_until: null,
      state: 'allow',
      event_at: new Date(now - 5000),
      event_coverage: 'complete',
      event_provenance: 'accepted',
      event_issuer: 'fixture',
      event_provenance_ref: 'fixture',
    };
    bindings.set(key(kind, node.id), {
      content_kind: kind,
      content_id: node.id,
      content_version: 1,
      decision_id: row.id,
      account_id: node.account_id,
      operation: envelope.purpose,
      envelope_version: 1,
      digest: row.digest,
      envelope,
      scope: envelope.scope,
    });
    approvals.set(row.id, row);
  }
  const calls: { sql: string; args: unknown[] }[] = [];
  let accountExists = true,
    regionReads = 0,
    regionActive = true;
  const tx = {
    query: async (sql: string, args: unknown[] = []) => {
      calls.push({ sql, args });
      const one = (value: unknown) => ({ rows: value ? [value] : [] });
      if (sql.includes('clock_timestamp')) return one({ now: new Date(now) });
      if (sql.includes('whaleu_identity.accounts'))
        return one(accountExists ? { id: args[0] } : undefined);
      if (sql.includes('content_approval_bindings'))
        return one(
          bindings.get(key(args[0] as ContentKind, args[1] as string)),
        );
      if (sql.includes('content_approval_decisions'))
        return one(approvals.get(args[0] as string));
      if (sql.includes('whaleu_community.posts'))
        return one(args[0] === post.id ? post : undefined);
      if (sql.includes('whaleu_community.spaces'))
        return one(
          args[0] === spaceId
            ? {
                id: spaceId,
                is_active: true,
                kind: 'regional',
                operating_region_id: regionId,
              }
            : undefined,
        );
      if (sql.includes('whaleu_community.root_comments'))
        return one(
          args[0] === root.id && (args.length < 2 || args[1] === root.post_id)
            ? root
            : undefined,
        );
      if (sql.includes('whaleu_community.replies'))
        return one(
          [reply, sibling].find(
            (node) =>
              node.id === args[0] &&
              (args.length < 2 ||
                (node.post_id === args[1] && node.root_comment_id === args[2])),
          ),
        );
      if (
        /\.(?:post_images|comment_images|reply_images|polls|formations|trading_listings)\b/.test(
          sql,
        )
      )
        return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  const campuses = {
    requireActiveRegion: async () => {
      regionReads++;
      if (!regionActive)
        throw new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
    },
  } as unknown as CampusService;
  const definitions = new ContentDefinitionRepository(campuses);
  const base = new LocalApprovedContentVisibility(
    new ApprovalRepository(),
    definitions,
  );
  const subject = (
    kind: ContentKind,
    node: { id: string; account_id: string },
  ): VisibilitySubject => ({
    contentId: node.id,
    contentKind: kind,
    contentVersion: 1,
    authorMode: 'named',
    namedAccountId: node.account_id,
  });
  const count = (sql: string, id?: string) =>
    calls.filter(
      (call) =>
        call.sql.includes(sql) && (id === undefined || call.args.includes(id)),
    ).length;
  return {
    tx,
    base,
    definitions,
    author,
    viewer,
    post,
    root,
    reply,
    sibling,
    nodes,
    calls,
    bindings,
    approvals,
    subject,
    count,
    key,
    regionReads: () => regionReads,
    setAccountExists: (exists: boolean) => {
      accountExists = exists;
    },
    setRegionActive: (active: boolean) => {
      regionActive = active;
    },
  };
}

test('canonical search and scalar decisions agree while proofs, locked source nodes and shared account anchors load once', async () => {
  const f = fixture();
  const sequence = [f.nodes[2], f.nodes[3], f.nodes[1], f.nodes[0], f.nodes[2]];
  const scalar = [];
  for (const { kind, node } of sequence)
    scalar.push(
      await f.base.check(
        f.viewer,
        f.subject(kind, node),
        f.tx,
        'list_projection',
      ),
    );
  const scalarQueries = f.calls.length;
  assert.ok(f.count('whaleu_identity.accounts') > 4);
  f.calls.length = 0;
  const previousRegions = f.regionReads();
  startTransactionDeadlines(f.tx);
  const read = new SearchReadContext(f.tx);
  try {
    const reused = [];
    for (const { kind, node } of sequence)
      reused.push(
        await f.base.check(
          f.viewer,
          f.subject(kind, node),
          f.tx,
          'list_projection',
          read,
        ),
      );
    assert.deepEqual(reused, scalar);
    assert.ok(reused.every((decision) => decision.kind === 'allow'));
    for (const { kind, node } of f.nodes) {
      assert.equal(
        f.calls.filter(
          (call) =>
            call.sql.includes('content_approval_bindings') &&
            call.args[0] === kind &&
            call.args[1] === node.id,
        ).length,
        1,
      );
      const binding = f.bindings.get(f.key(kind, node.id))!;
      assert.equal(
        f.count('content_approval_decisions', binding.decision_id),
        1,
      );
      assert.equal(f.count(`.${kind}_images`, node.id), 1);
    }
    for (const [table, node] of [
      ['posts', f.post],
      ['root_comments', f.root],
      ['replies', f.reply],
      ['replies', f.sibling],
    ] as const) {
      assert.equal(f.count(`whaleu_community.${table}`, node.id), 1);
      assert.match(
        f.calls.find(
          (call) =>
            call.sql.includes(`whaleu_community.${table}`) &&
            call.args[0] === node.id,
        )!.sql,
        /FOR SHARE$/,
      );
    }
    assert.equal(f.count('whaleu_identity.accounts'), 1);
    assert.equal(f.count('whaleu_community.spaces'), 1);
    assert.equal(f.regionReads() - previousRegions, 1);
    assert.ok(f.calls.length < scalarQueries);
    await searchPost(f.post.id, f.tx, read);
    await searchRoot(f.root.id, f.tx, read);
    await searchReply(f.reply.id, f.tx, read);
    assert.equal(
      f.count('whaleu_community.posts'),
      1,
      'Source helpers and canonical proofs share the same locked source facts',
    );
  } finally {
    read.close();
    clearTransactionDeadlines(f.tx);
  }
});

test('kind-qualified canonical and source keys preserve post, root and reply proofs for the same UUID', async () => {
  const f = fixture(true);
  startTransactionDeadlines(f.tx);
  const read = new SearchReadContext(f.tx);
  try {
    for (const { kind, node } of [f.nodes[2], f.nodes[1], f.nodes[0]]) {
      const subject = f.subject(kind, node);
      assert.deepEqual(
        await f.base.check(f.viewer, subject, f.tx, 'list_projection', read),
        await f.base.check(f.viewer, subject, f.tx, 'list_projection'),
      );
    }
    for (const { kind, node } of f.nodes.slice(0, 3))
      assert.equal(
        (
          await f.base.check(
            f.viewer,
            f.subject(kind, node),
            f.tx,
            'list_projection',
            read,
          )
        ).kind,
        'allow',
      );
    assert.equal((await searchPost(f.post.id, f.tx, read))!.text, f.post.text);
    assert.equal((await searchRoot(f.root.id, f.tx, read))!.text, f.root.text);
    assert.equal(
      (await searchReply(f.reply.id, f.tx, read))!.text,
      f.reply.text,
    );
  } finally {
    read.close();
    clearTransactionDeadlines(f.tx);
  }
});

test('reused locked source rows do not authorize a different supplied definition scope', async () => {
  const f = fixture();
  const scope = f.bindings.get(f.key('reply', f.reply.id))!.scope;
  startTransactionDeadlines(f.tx);
  const read = new SearchReadContext(f.tx);
  try {
    assert.equal(
      (await f.definitions.current('reply', f.reply.id, scope, f.tx, read))
        .kind,
      'allow',
    );
    for (const changed of [
      { ...scope, originalSpaceId: randomUUID() },
      { ...scope, originalRegionId: randomUUID() },
    ]) {
      const before = f.calls.length;
      const reused = await f.definitions.current(
        'reply',
        f.reply.id,
        changed,
        f.tx,
        read,
      );
      assert.deepEqual(reused, { kind: 'unavailable' });
      assert.equal(
        f.calls.length,
        before,
        'Scope is revalidated despite reusing locked source facts',
      );
      assert.deepEqual(
        reused,
        await f.definitions.current('reply', f.reply.id, changed, f.tx),
      );
    }
    assert.equal(
      (await f.definitions.current('reply', f.reply.id, scope, f.tx, read))
        .kind,
      'allow',
    );
  } finally {
    read.close();
    clearTransactionDeadlines(f.tx);
  }
});

test('cached canonical allow still checks subject kind, version, author mode and named author on every call', async () => {
  const f = fixture(),
    subject = f.subject('post', f.post);
  startTransactionDeadlines(f.tx);
  const read = new SearchReadContext(f.tx);
  try {
    assert.equal(
      (await f.base.check(f.viewer, subject, f.tx, 'list_projection', read))
        .kind,
      'allow',
    );
    for (const mismatch of [
      { ...subject, namedAccountId: randomUUID() },
      { ...subject, authorMode: 'anonymous', namedAccountId: undefined },
      { ...subject, contentVersion: 2 },
      { ...subject, contentKind: 'unknown' },
      { ...subject, contentKind: 'comment' },
    ]) {
      const input = mismatch as VisibilitySubject;
      const scalar = await f.base.check(
        f.viewer,
        input,
        f.tx,
        'list_projection',
      );
      assert.deepEqual(scalar, { kind: 'unavailable' });
      assert.deepEqual(
        await f.base.check(f.viewer, input, f.tx, 'list_projection', read),
        scalar,
      );
    }
    assert.equal(
      (await f.base.check(f.viewer, subject, f.tx, 'list_projection', read))
        .kind,
      'allow',
    );
    read.close();
    assert.deepEqual(
      await f.base.check(f.viewer, subject, f.tx, 'list_projection', read),
      { kind: 'unavailable' },
    );
  } finally {
    read.close();
    clearTransactionDeadlines(f.tx);
  }
});

test('canonical unavailable and denied results are retried, never retained as proofs', async () => {
  for (const outcome of ['unavailable', 'deny'] as const) {
    const f = fixture(),
      subject = f.subject('post', f.post);
    const binding = f.bindings.get(f.key('post', f.post.id))!;
    const approval = f.approvals.get(binding.decision_id)!;
    approval.result = outcome === 'unavailable' ? 'pending' : 'reject';
    startTransactionDeadlines(f.tx);
    const read = new SearchReadContext(f.tx);
    try {
      for (let attempt = 0; attempt < 2; attempt++)
        assert.equal(
          (await f.base.check(f.viewer, subject, f.tx, 'list_projection', read))
            .kind,
          outcome,
        );
      assert.equal(f.count('content_approval_bindings'), 2);
      assert.equal(f.count('content_approval_decisions'), 2);
      approval.result = 'allow';
      for (let attempt = 0; attempt < 2; attempt++)
        assert.equal(
          (await f.base.check(f.viewer, subject, f.tx, 'list_projection', read))
            .kind,
          'allow',
        );
      assert.equal(f.count('content_approval_bindings'), 3);
      assert.equal(f.count('content_approval_decisions'), 3);
    } finally {
      read.close();
      clearTransactionDeadlines(f.tx);
    }
  }
});

test('missing anchors and missing source rows are retried rather than cached', async () => {
  const f = fixture(),
    subject = f.subject('post', f.post);
  startTransactionDeadlines(f.tx);
  const read = new SearchReadContext(f.tx);
  try {
    f.setAccountExists(false);
    for (let attempt = 0; attempt < 2; attempt++)
      assert.deepEqual(
        await f.base.check(f.viewer, subject, f.tx, 'list_projection', read),
        { kind: 'unavailable' },
      );
    assert.equal(f.count('whaleu_identity.accounts'), 2);
    f.setAccountExists(true);
    assert.equal(
      (await f.base.check(f.viewer, subject, f.tx, 'list_projection', read))
        .kind,
      'allow',
    );
    assert.equal(f.count('whaleu_identity.accounts'), 3);
    const absent = randomUUID();
    assert.equal(await searchReply(absent, f.tx, read), undefined);
    assert.equal(await searchReply(absent, f.tx, read), undefined);
    assert.equal(f.count('whaleu_community.replies', absent), 2);
  } finally {
    read.close();
    clearTransactionDeadlines(f.tx);
  }
});

test('canonical search and scalar preserve unavailable/deny decisions across parent and definition gates', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.bindings.delete(f.key('post', f.post.id));
    },
    (f) => {
      f.post.text = 'Unreviewed text';
    },
    (f) => {
      f.root.visibility = 'hidden';
    },
    (f) => {
      f.post.publication_state = 'draft';
    },
    (f) => {
      f.reply.root_comment_id = randomUUID();
    },
    (f) => {
      f.setRegionActive(false);
    },
    (f) => {
      f.approvals.get(
        f.bindings.get(f.key('comment', f.root.id))!.decision_id,
      )!.state = 'held';
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    const subject = f.subject('reply', f.reply);
    const scalar = await f.base.check(
      f.viewer,
      subject,
      f.tx,
      'list_projection',
    );
    assert.notEqual(scalar.kind, 'allow');
    startTransactionDeadlines(f.tx);
    const read = new SearchReadContext(f.tx);
    try {
      assert.deepEqual(
        await f.base.check(f.viewer, subject, f.tx, 'list_projection', read),
        scalar,
      );
    } finally {
      read.close();
      clearTransactionDeadlines(f.tx);
    }
  }
});

test('Safety decisions stay viewer- and purpose-specific and are never reused with canonical allow', async () => {
  const f = fixture(),
    subject = f.subject('post', f.post);
  const safetyCalls: {
    viewer: string;
    author: string;
    purpose: VisibilityPurpose;
  }[] = [];
  let directions: { incoming: boolean; outgoing: boolean } | null = {
    incoming: true,
    outgoing: false,
  };
  const visibility = new NamedBlockVisibility(f.base, {
    directions: async (
      viewer: string,
      author: string,
      purpose: VisibilityPurpose,
    ) => {
      safetyCalls.push({ viewer, author, purpose });
      return directions;
    },
  } as unknown as SafetyRepository);
  startTransactionDeadlines(f.tx);
  const read = new SearchReadContext(f.tx);
  try {
    const check = (purpose: VisibilityPurpose, viewer = f.viewer) =>
      visibility.check(viewer, subject, f.tx, purpose, read);
    assert.deepEqual(await check('list_projection'), {
      kind: 'allow',
      value: undefined,
    });
    assert.deepEqual(await check('direct_post'), {
      kind: 'deny',
      reason: 'POST_NOT_FOUND',
    });
    assert.deepEqual(await check('list_projection'), {
      kind: 'allow',
      value: undefined,
    });
    directions = { incoming: false, outgoing: true };
    assert.deepEqual(await check('direct_post'), {
      kind: 'deny',
      reason: 'POST_BLOCKED_BY_YOU',
    });
    assert.deepEqual(await check('list_projection'), {
      kind: 'deny',
      reason: 'POST_NOT_FOUND',
    });
    directions = null;
    assert.deepEqual(await check('list_projection'), { kind: 'unavailable' });
    directions = { incoming: false, outgoing: false };
    const otherViewer = randomUUID();
    assert.deepEqual(await check('list_projection', otherViewer), {
      kind: 'allow',
      value: undefined,
    });
    assert.equal(safetyCalls.length, 7);
    assert.deepEqual(
      safetyCalls.map((call) => call.purpose),
      [
        'list_projection',
        'direct_post',
        'list_projection',
        'direct_post',
        'list_projection',
        'list_projection',
        'list_projection',
      ],
    );
    assert.equal(safetyCalls.at(-1)!.viewer, otherViewer);
    assert.ok(safetyCalls.every((call) => call.author === f.author));
    assert.equal(f.count('content_approval_bindings'), 1);
    assert.equal(f.count('content_approval_decisions'), 1);
  } finally {
    read.close();
    clearTransactionDeadlines(f.tx);
  }
});
