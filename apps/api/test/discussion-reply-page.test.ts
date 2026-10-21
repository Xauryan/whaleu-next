import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../src/database/database.js';
import type { TransactionOptions } from '../src/database/database.js';
import { DiscussionPages } from '../src/community/discussion/pages.js';
import { FeedService } from '../src/community/feed.service.js';
import { DiscussionReadService } from '../src/community/discussion/read.service.js';
import type {
  CommunityRepository,
  StoredPost,
  StoredComment,
  StoredReply,
} from '../src/community/community.repository.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type { CommunitySerializer } from '../src/community/community-serialization.js';
import type { DiscoveryCursorRepository } from '../src/community/discovery-cursors.js';
import { ApplicationError } from '../src/http/application-error.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
function fixture(size = 4097) {
  const post = { id: id(1) } as StoredPost,
    root = {
      id: id(2),
      post_id: id(1),
      account_id: id(4),
      created_at: new Date(0),
      visibility: 'approved',
      deleted_at: null,
    } as StoredComment,
    actor = id(3);
  const rows: Array<StoredReply> = Array.from({ length: size }, (_, i) => ({
    id: id(100 + i),
    post_id: post.id,
    root_comment_id: root.id,
    sequence: String(i + 1),
    account_id: id(4),
    text: `Reply ${i + 1}`,
    author_mode: 'named',
    visibility: 'approved',
    deleted_at: null,
    created_at: new Date(0),
    target_reply_id: null,
  }));
  const hidden = new Set<string>(),
    queries: { sql: string; args: unknown[] }[] = [],
    positions = new Map<string, { scope: string; value: unknown }>();
  const state = {
    session: 'session-1',
    parentDenied: false,
    preview: false,
    cursorCreated: false,
    finalizing: false,
    creates: 0,
    projections: 0,
  };
  const tx = {
    query: async (sql: string, args: unknown[] = []) => {
      if (sql.startsWith('BEGIN')) {
        state.cursorCreated = false;
        state.finalizing = false;
      }
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') state.finalizing = true;
      if (state.cursorCreated && !state.finalizing)
        assert.ok(
          sql === 'COMMIT' ||
            sql === 'ROLLBACK' ||
            sql === 'SELECT clock_timestamp() AS now',
          `Unexpected domain read after quota: ${sql}`,
        );
      queries.push({ sql, args });
      if (sql.startsWith('SELECT * FROM whaleu_community.root_comments'))
        return { rows: [root] };
      if (
        sql.startsWith(
          'SELECT version::text FROM whaleu_community.post_category_read_epoch',
        )
      )
        return { rows: [{ version: '1' }] };
      if (sql.startsWith('SELECT * FROM whaleu_community.replies')) {
        assert.ok(sql.includes('LIMIT 129 FOR SHARE'));
        assert.deepEqual(args.slice(0, 2), [post.id, root.id]);
        const asc = sql.includes(
          'ORDER BY post_id ASC,root_comment_id ASC,sequence ASC',
        );
        const after = args.length === 2 ? null : BigInt(args[2] as string);
        const selected = rows.filter(
          (row) =>
            row.post_id === post.id &&
            row.root_comment_id === root.id &&
            row.visibility === 'approved' &&
            !row.deleted_at &&
            (after === null ||
              (asc
                ? BigInt(row.sequence) > after
                : BigInt(row.sequence) < after)),
        );
        if (!asc) selected.reverse();
        return { rows: selected.slice(0, 129) };
      }
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '10s',
              lock_timeout: '0',
            },
          ],
        };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => tx } as Pick<Pool, 'connect'>;
  const repository = {
    database: {
      transaction: <T>(
        work: (tx: PoolClient) => Promise<T>,
        options: TransactionOptions,
      ) => inTransaction(pool, work, options),
    },
    reply: async (key: string) => {
      const row = rows.find((row) => row.id === key);
      if (!row || row.deleted_at) throw new ApplicationError('REPLY_NOT_FOUND');
      return row;
    },
  } as unknown as CommunityRepository;
  const access = {
    mediaSession: async () => ({ accountId: actor, sessionId: state.session }),
    advisory: async () => null,
    accessiblePost: async () => {
      if (state.parentDenied) throw new ApplicationError('POST_NOT_FOUND');
      return { post, space: {} };
    },
    accessibleComment: async () => {
      if (state.parentDenied) throw new ApplicationError('POST_NOT_FOUND');
      return { post, comment: root, authority: null };
    },
    accessibleReply: async (key: string) => {
      if (state.parentDenied) throw new ApplicationError('POST_NOT_FOUND');
      const reply = await repository.reply(key, tx, true);
      if (hidden.has(reply.id)) throw new ApplicationError('REPLY_NOT_FOUND');
      return { post, comment: root, reply, authority: null };
    },
    visible: async (_actor: string, row: StoredReply) =>
      !hidden.has(row.id) && row.visibility === 'approved' && !row.deleted_at,
  } as unknown as CommunityAccessService;
  const cursors = {
    create: async (scope: string, _bucket: unknown, value: unknown) => {
      state.cursorCreated = true;
      state.creates++;
      const token = String(positions.size + 1).padStart(43, 'a');
      positions.set(token, { scope, value });
      return token;
    },
    get: async (
      token: string,
      scope: string,
      _tx: PoolClient,
      validate: (v: unknown) => unknown,
    ) => {
      const saved = positions.get(token);
      if (!saved || saved.scope !== scope)
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      return validate(saved.value);
    },
  } as unknown as DiscoveryCursorRepository;
  const pages = new DiscussionPages(repository, access, cursors);
  const serializer = {
    reply: async (row: StoredReply) => {
      assert.equal(
        state.cursorCreated,
        false,
        'Every reply projection precedes the first quota lock',
      );
      state.projections++;
      return { id: row.id };
    },
    comment: async () => {
      assert.equal(state.cursorCreated, false);
      if (!state.preview) return { id: root.id, replyCount: null };
      const page = await pages.replies(
        post,
        root,
        actor,
        state.session,
        tx,
        2,
        undefined,
        20,
      );
      const items = [];
      for (const row of page.rows)
        items.push(await serializer.reply(row, post, root, actor, null, tx));
      const replyPreview = { items, nextCursor: page.nextCursor };
      pages.copyCursor(page, replyPreview);
      return {
        id: root.id,
        createdAt: root.created_at.toISOString(),
        replyCount: null,
        replyPreview,
      };
    },
    flushDiscussionCursors: (client: PoolClient) => pages.flush(client),
  } as unknown as CommunitySerializer;
  const service = new DiscussionReadService(
    repository,
    access,
    serializer,
    pages,
  );
  return {
    post,
    root,
    actor,
    rows,
    hidden,
    queries,
    state,
    tx,
    repository,
    pages,
    service,
    legacy: new FeedService(repository, access, serializer),
  };
}
test('4097 replies traverse by bounded keyset without repeats, omissions or full-thread materialization', async () => {
  const f = fixture();
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const page = await f.service.replies('token', f.root.id, {
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
    assert.ok(ids.length <= 4097);
  } while (cursor);
  assert.deepEqual(
    ids,
    f.rows.map((row) => row.id),
  );
  assert.equal(
    f.queries.filter((q) =>
      q.sql.startsWith('SELECT * FROM whaleu_community.replies'),
    ).length,
    82,
  );
});
test('hidden-heavy empty reply pages remain continuable without encoding hidden IDs', async () => {
  const f = fixture(1100);
  for (const row of f.rows.slice(0, 1025)) f.hidden.add(row.id);
  let cursor: string | undefined;
  const ids: string[] = [];
  let pages = 0;
  do {
    const page = await f.service.replies('token', f.root.id, {
      limit: 20,
      ...(cursor ? { cursor } : {}),
    });
    pages++;
    if (!ids.length && !page.items.length)
      assert.notEqual(page.nextCursor, null);
    if (page.nextCursor) assert.match(page.nextCursor, /^[A-Za-z0-9_-]{43}$/);
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
    assert.ok(pages < 20);
  } while (cursor);
  assert.deepEqual(
    ids,
    f.rows.slice(1025).map((row) => row.id),
  );
});
test('preview continuation uses ordinary twenty-row page scope', async () => {
  const f = fixture(100);
  const preview = await f.repository.database.transaction(
    async (tx) => {
      const page = await f.pages.replies(
        f.post,
        f.root,
        f.actor,
        f.state.session,
        tx,
        2,
        undefined,
        20,
      );
      assert.equal(page.nextCursor, null, 'Cursor creation is deferred');
      await f.pages.flush(tx);
      return page;
    },
    { isolationLevel: 'read committed' },
  );
  const page = await f.service.replies('token', f.root.id, {
    limit: 20,
    cursor: preview.nextCursor!,
  });
  assert.deepEqual(
    page.items.map((item) => item.id),
    f.rows.slice(2, 22).map((row) => row.id),
  );
});
test('deep context resolves exact target and only bounded adjacent windows; denied parent fails first', async () => {
  const f = fixture();
  const target = f.rows[3999]!;
  const context = await f.service.context('token', f.post.id, {
    replyId: target.id,
  });
  assert.equal(context.reply!.id, target.id);
  assert.deepEqual(
    context.replies.items.map((row) => row.id),
    f.rows.slice(3997, 4002).map((row) => row.id),
  );
  assert.equal(context.replies.nextCursor, null);
  assert.equal(
    f.queries.filter((q) =>
      q.sql.startsWith('SELECT * FROM whaleu_community.replies'),
    ).length,
    2,
  );
  f.state.parentDenied = true;
  f.queries.length = 0;
  await assert.rejects(
    f.service.context('token', f.post.id, { replyId: target.id }),
    errorIs('POST_NOT_FOUND'),
  );
  assert.equal(
    f.queries.some((q) =>
      q.sql.startsWith('SELECT * FROM whaleu_community.replies'),
    ),
    false,
  );
});
test('deleted/hidden anchor, different session and old JSON reply cursor explicitly restart', async () => {
  for (const mode of ['deleted', 'hidden', 'session', 'legacy']) {
    const f = fixture(30);
    const first = await f.service.replies('token', f.root.id, { limit: 20 });
    const anchor = f.rows[19]!;
    if (mode === 'deleted') anchor.deleted_at = new Date();
    if (mode === 'hidden') f.hidden.add(anchor.id);
    if (mode === 'session') f.state.session = 'session-2';
    const cursor =
      mode === 'legacy'
        ? Buffer.from(JSON.stringify({ v: 1, sequence: '20' })).toString(
            'base64url',
          )
        : first.nextCursor!;
    await assert.rejects(
      f.service.replies('token', f.root.id, { limit: 20, cursor }),
      errorIs('DISCUSSION_RESTART_REQUIRED'),
    );
  }
});

test('all preview cursors wait for outer standalone/context/legacy projections and populate copied DTOs', async () => {
  for (const endpoint of ['comment', 'context', 'legacy'] as const) {
    const f = fixture(12);
    f.state.preview = true;
    if (endpoint === 'comment') {
      const result = await f.service.comment('token', f.root.id);
      assert.match(result.replyPreview.nextCursor!, /^[A-Za-z0-9_-]{43}$/);
    } else if (endpoint === 'context') {
      const result = await f.service.context('token', f.post.id, {
        replyId: f.rows[8]!.id,
      });
      assert.match(
        result.comment.replyPreview.nextCursor!,
        /^[A-Za-z0-9_-]{43}$/,
      );
      assert.equal(result.reply!.id, f.rows[8]!.id);
      assert.ok(f.state.projections > 2);
    } else {
      const result = await f.legacy.comments('token', f.post.id, { limit: 10 });
      assert.match(
        result.items[0]!.replyPreview.nextCursor!,
        /^[A-Za-z0-9_-]{43}$/,
      );
    }
    assert.equal(f.state.creates, 1);
    assert.equal(f.state.cursorCreated, true);
  }
});

test('multiple nested preview pages share one deferred transaction queue, not a quota lock per projection', async () => {
  const f = fixture(12);
  await f.repository.database.transaction(
    async (tx) => {
      const mirrors: { nextCursor: string | null }[] = [];
      for (let i = 0; i < 3; i++) {
        const page = await f.pages.replies(
          f.post,
          f.root,
          f.actor,
          f.state.session,
          tx,
          2,
          undefined,
          20,
        );
        const mirror = { nextCursor: page.nextCursor };
        f.pages.copyCursor(page, mirror);
        mirrors.push(mirror);
        assert.equal(f.state.creates, 0);
        await tx.query('SELECT synthetic_projection');
      }
      await f.pages.flush(tx);
      assert.equal(f.state.creates, 3);
      for (const mirror of mirrors)
        assert.match(mirror.nextCursor!, /^[A-Za-z0-9_-]{43}$/);
      await f.pages.flush(tx);
      assert.equal(
        f.state.creates,
        3,
        'A second flush does not duplicate navigation writes',
      );
    },
    { isolationLevel: 'read committed' },
  );
});

test('scoped composite reply ranges include bigint maximum and seek strictly in both directions', async () => {
  const f = fixture(3);
  const max = 9223372036854775807n;
  for (const [index, row] of f.rows.entries())
    row.sequence = String(max - 2n + BigInt(index));
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await f.service.replies('token', f.root.id, {
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
    assert.ok(ids.length <= 3);
  } while (cursor);
  assert.deepEqual(
    ids,
    f.rows.map((row) => row.id),
  );
  const context = await f.service.context('token', f.post.id, {
    replyId: f.rows[2]!.id,
  });
  assert.deepEqual(
    context.replies.items.map((row) => row.id),
    ids,
  );
  const samples = f.queries.filter((q) =>
    q.sql.startsWith('SELECT * FROM whaleu_community.replies'),
  );
  assert.ok(samples.some((q) => q.args.length === 2));
  assert.ok(
    samples.some(
      (q) =>
        q.args.length === 3 &&
        q.sql.includes('post_id DESC,root_comment_id DESC,sequence DESC'),
    ),
  );
  for (const { sql, args } of samples) {
    assert.equal(sql.includes('post_id=$1'), false);
    assert.equal(sql.includes('root_comment_id=$2'), false);
    assert.equal(sql.includes('IS NULL OR'), false);
    assert.match(
      sql,
      /\(post_id,root_comment_id,sequence\) > \(\$1::uuid,\$2::uuid,/,
    );
    assert.match(
      sql,
      /\(post_id,root_comment_id,sequence\) <=? \(\$1::uuid,\$2::uuid,/,
    );
    const descendingSeek =
      args.length === 3 && sql.includes('ORDER BY post_id DESC');
    assert.ok(
      sql.includes(
        descendingSeek
          ? 'AND (post_id,root_comment_id,sequence) < ($1::uuid,$2::uuid,$3::bigint)'
          : 'AND (post_id,root_comment_id,sequence) <= ($1::uuid,$2::uuid,9223372036854775807::bigint)',
      ),
    );
    assert.ok(sql.includes('LIMIT 129 FOR SHARE'));
    assert.deepEqual(args.slice(0, 2), [f.post.id, f.root.id]);
  }
});
