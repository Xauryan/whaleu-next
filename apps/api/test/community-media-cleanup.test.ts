import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.js';
import {
  clearTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { UnavailableMedia } from '../src/community/community-policy.js';
import {
  CommunityMediaCleanupFacade,
  COMMUNITY_MEDIA_CLEANUP_PAGE_SIZE,
} from '../src/community/media/cleanup-facade.js';
import { CommunityMediaCleanupWorker } from '../src/community/media/cleanup-worker.js';

// Query-shape specifications only. The separate disposable-PG suite establishes
// real trigger capture, atomic detachment, restart and concurrent ownership.
function fixture(kind: 'post' | 'comment' | 'reply', phase = 'self') {
  const post = randomUUID(),
    root = kind === 'post' ? null : randomUUID();
  const job = {
    id: randomUUID(),
    resource_kind: kind,
    resource_id:
      kind === 'post' ? post : kind === 'comment' ? root! : randomUUID(),
    post_id: post,
    root_comment_id: root,
    source_deleted_at: '2026-10-10 11:00:00+00',
    phase,
    cursor_id: null,
  };
  const calls: { sql: string; values: unknown[] }[] = [];
  let children: { id: string; post_id: string; root_comment_id?: string }[] =
    [];
  let busy = false;
  let rolledBack = false;
  const tx = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      let rows: unknown[] = [];
      if (sql.includes('FROM whaleu_community.media_cleanup_jobs'))
        rows = [job];
      else if (sql.startsWith('UPDATE whaleu_community.media_cleanup_jobs'))
        rows = [{}];
      else if (sql.includes('deleted_at=$2'))
        rows = [{ id: job.resource_id, post_id: post, root_comment_id: root }];
      else if (sql.includes('FROM whaleu_community.posts'))
        rows = busy ? [] : [{ id: post }];
      else if (sql.includes('root_comments') && sql.includes('id=ANY'))
        rows = [...new Set(children.map((row) => row.root_comment_id))].map(
          (id) => ({ id }),
        );
      else if (sql.includes('root_comments') && sql.includes('LIMIT'))
        rows = children;
      else if (sql.includes('root_comments')) rows = [{ id: root }];
      else if (sql.includes('FROM whaleu_community.replies')) rows = children;
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  const database = {
    async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
      startTransactionDeadlines(tx);
      try {
        return await operation(tx);
      } catch (error) {
        rolledBack = true;
        throw error;
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as DatabaseService;
  return {
    job,
    tx,
    database,
    calls,
    setChildren(value: typeof children) {
      children = value;
    },
    setBusy() {
      busy = true;
    },
    get rolledBack() {
      return rolledBack;
    },
  };
}

test('cleanup requires a managed transaction before reading any owner data', async () => {
  const f = fixture('post');
  await assert.rejects(new CommunityMediaCleanupFacade().claimPage(f.tx));
  assert.equal(f.calls.length, 0);
});

test('reply cleanup locks ancestors before the job and detaches its typed identity only', async () => {
  const f = fixture('reply');
  const detached: unknown[] = [];
  let batches = 0;
  class Media extends UnavailableMedia {
    override async detachMany(
      targets: readonly { kind: 'post' | 'comment' | 'reply'; id: string }[],
    ) {
      batches++;
      for (const target of targets) await this.detach(target.kind, target.id);
    }
    override async detach(kind: 'post' | 'comment' | 'reply', id: string) {
      detached.push({ kind, id });
    }
  }
  const worker = new CommunityMediaCleanupWorker(
    f.database,
    new CommunityMediaCleanupFacade(),
    new Media(),
  );
  assert.deepEqual(await worker.runOnePage(), {
    status: 'enumeration-complete',
    jobId: f.job.id,
    detachedTargets: 1,
  });
  assert.deepEqual(detached, [{ kind: 'reply', id: f.job.resource_id }]);
  assert.equal(batches, 1);
  const sql = f.calls.map((call) => call.sql);
  const index = (pattern: string) =>
    sql.findIndex((value) => value.includes(pattern));
  assert.ok(index('ORDER BY updated_at') < index('pg_advisory_xact_lock('));
  assert.ok(
    index('pg_advisory_xact_lock(') < index('FROM whaleu_community.posts'),
  );
  assert.ok(
    index('FROM whaleu_community.posts') <
      index('FROM whaleu_community.root_comments'),
  );
  assert.ok(
    index('FROM whaleu_community.root_comments') <
      index('AND enumeration_completed_at IS NULL FOR UPDATE SKIP LOCKED'),
  );
  assert.equal(
    sql.some((value) =>
      /target_reply_id|whaleu_media\.|LOCK TABLE/.test(value),
    ),
    false,
  );
});

test('a 16-target page persists the UUID keyset without claiming enumeration or physical deletion is complete', async () => {
  const f = fixture('post', 'comments');
  const ids = Array.from({ length: COMMUNITY_MEDIA_CLEANUP_PAGE_SIZE }, () =>
    randomUUID(),
  ).sort();
  f.setChildren(ids.map((id) => ({ id, post_id: f.job.post_id })));
  const owner = new CommunityMediaCleanupFacade();
  await f.database.transaction(async (tx) => {
    const page = await owner.claimPage(tx);
    assert.ok(page);
    assert.equal(page.parents.length, 16);
    assert.deepEqual(
      page.parents.map((parent) => parent.resourceKind),
      Array(16).fill('comment'),
    );
    assert.equal(await owner.completePage(page, tx), 'progress');
    await assert.rejects(
      owner.completePage(page, tx),
      'Page capabilities are single-use',
    );
  });
  const update = f.calls.find((call) =>
    call.sql.startsWith('UPDATE whaleu_community.media_cleanup_jobs'),
  )!;
  assert.deepEqual(update.values.slice(0, 4), [
    f.job.id,
    'comments',
    ids.at(-1),
    16,
  ]);
  const enumeration = f.calls.find(
    (call) => call.sql.includes('root_comments') && call.sql.includes('LIMIT'),
  )!;
  assert.match(enumeration.sql, /ORDER BY id LIMIT \$3 FOR UPDATE NOWAIT/);
  assert.equal(enumeration.values[2], 16);
  assert.doesNotMatch(enumeration.sql, /visibility|deleted_at IS NULL|OFFSET/);
});

test('a full page uses one bounded Media mutation boundary and never falls back to repeated detach', async () => {
  const f = fixture('post', 'comments');
  const ids = Array.from({ length: 16 }, () => randomUUID()).sort();
  f.setChildren(ids.map((id) => ({ id, post_id: f.job.post_id })));
  const batches: unknown[] = [];
  class Media extends UnavailableMedia {
    override async detachMany(
      targets: readonly { kind: 'post' | 'comment' | 'reply'; id: string }[],
    ) {
      batches.push(targets);
    }
    override async detach() {
      assert.fail('A cleanup page must not invoke individual detach');
    }
  }
  assert.deepEqual(
    await new CommunityMediaCleanupWorker(
      f.database,
      new CommunityMediaCleanupFacade(),
      new Media(),
    ).runOnePage(),
    { status: 'progress', jobId: f.job.id, detachedTargets: 16 },
  );
  assert.deepEqual(batches, [ids.map((id) => ({ kind: 'comment', id }))]);
});

test('reply pages lock bounded roots before replies, and an exact-full page requires a later empty-page observation', async () => {
  const f = fixture('post', 'replies');
  const roots = [randomUUID(), randomUUID()].sort();
  const ids = Array.from({ length: 16 }, () => randomUUID()).sort();
  f.setChildren(
    ids.map((id, index) => ({
      id,
      post_id: f.job.post_id,
      root_comment_id: roots[index % 2]!,
    })),
  );
  const owner = new CommunityMediaCleanupFacade();
  await f.database.transaction(async (tx) => {
    const page = await owner.claimPage(tx);
    assert.ok(page);
    assert.equal(await owner.completePage(page, tx), 'progress');
  });
  const rootLock = f.calls.findIndex(
    (call) => call.sql.includes('root_comments') && call.sql.includes('id=ANY'),
  );
  const replyLock = f.calls.findIndex(
    (call) => call.sql.includes('replies') && call.sql.includes('id=ANY'),
  );
  assert.ok(rootLock >= 0 && rootLock < replyLock);
  assert.deepEqual(f.calls[rootLock]!.values, [f.job.post_id, roots]);
  f.calls.length = 0;
  f.setChildren([]);
  await f.database.transaction(async (tx) => {
    const page = await owner.claimPage(tx);
    assert.ok(page);
    assert.equal(page.parents.length, 0);
    assert.equal(await owner.completePage(page, tx), 'enumeration-complete');
  });
});

test('detach failure cannot advance a page and busy ancestor hints release their candidate locks', async () => {
  const f = fixture('comment', 'replies');
  const children = [0, 1]
    .map(() => ({
      id: randomUUID(),
      post_id: f.job.post_id,
      root_comment_id: f.job.root_comment_id!,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  f.setChildren(children);
  const detached: { kind: string; id: string }[] = [];
  let batches = 0;
  class Media extends UnavailableMedia {
    private calls = 0;
    override async detachMany(
      targets: readonly { kind: 'post' | 'comment' | 'reply'; id: string }[],
    ) {
      batches++;
      for (const target of targets) await this.detach(target.kind, target.id);
    }
    override async detach(kind: 'post' | 'comment' | 'reply', id: string) {
      detached.push({ kind, id });
      if (++this.calls === 2) throw new Error('SYNTHETIC_DETACH_FAILURE');
    }
  }
  await assert.rejects(
    new CommunityMediaCleanupWorker(
      f.database,
      new CommunityMediaCleanupFacade(),
      new Media(),
    ).runOnePage(),
    /SYNTHETIC_DETACH_FAILURE/,
  );
  assert.equal(f.rolledBack, true);
  assert.equal(batches, 1);
  assert.deepEqual(
    detached,
    children.map((row) => ({ kind: 'reply', id: row.id })),
  );
  assert.equal(
    f.calls.some((call) =>
      call.sql.startsWith('UPDATE whaleu_community.media_cleanup_jobs'),
    ),
    false,
  );
  const busy = fixture('post');
  busy.setBusy();
  assert.deepEqual(
    await new CommunityMediaCleanupWorker(
      busy.database,
      new CommunityMediaCleanupFacade(),
      new Media(),
    ).runOnePage(),
    { status: 'idle' },
  );
  assert.ok(
    busy.calls.some(
      (call) =>
        call.sql === 'ROLLBACK TO SAVEPOINT community_media_cleanup_candidate',
    ),
  );
});

test('migration captures tombstones transactionally, retains cursors, and never claims storage deletion', async () => {
  const sql = await readFile(
    new URL('../migrations/0078_community_media_cleanup.sql', import.meta.url),
    'utf8',
  );
  for (const table of ['posts', 'root_comments', 'replies'])
    assert.match(
      sql,
      new RegExp(`AFTER UPDATE OF deleted_at ON whaleu_community\\.${table}`),
    );
  assert.match(sql, /OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL/);
  assert.match(sql, /enumeration_completed_at/);
  assert.match(sql, /OLD.detached_targets\+16/);
  assert.doesNotMatch(
    sql,
    /whaleu_media\.|confirmed_deleted_at|DELETE FROM|TRUNCATE TABLE/,
  );
});
