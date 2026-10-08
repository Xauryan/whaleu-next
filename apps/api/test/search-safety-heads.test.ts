import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { SearchReadContext } from '../src/community/content-review/search-read-context.js';
import { inTransaction } from '../src/database/database.js';
import {
  checkpointTransactionDeadlines,
  clearTransactionDeadlines,
  restoreTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import { SafetyRepository } from '../src/safety/repository.js';
import type { SafetyHead } from '../src/safety/repository.js';
import { enableSafetyRelationshipProof } from '../src/safety/relationship-proof.js';
import { NamedBlockVisibility } from '../src/safety/visibility.js';

const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'COMMUNITY_UNAVAILABLE';
const validHead = (validUntil: number | null = null): SafetyHead => ({
  block_coverage: 'complete',
  restriction_coverage: 'complete',
  provenance: 'native_account_creation',
  actions_allowed: true,
  valid_until: validUntil === null ? null : new Date(validUntil),
});
function fixture() {
  const viewer = randomUUID(),
    author = randomUUID();
  const heads = new Map<string, SafetyHead>([
    [viewer, validHead()],
    [author, validHead()],
  ]);
  const commands: { sql: string; values: unknown[] }[] = [];
  const blocks = new Set<string>();
  const state = {
    now: 100,
    clock: async () => {},
    immediate: async () => {},
  };
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      commands.push({ sql, values });
      if (sql.includes('FROM whaleu_safety.account_heads')) {
        const head = heads.get(String(values[0]));
        return { rows: head ? [head] : [] };
      }
      if (sql === 'SELECT clock_timestamp() AS now') {
        const now = new Date(state.now);
        await state.clock();
        return { rows: [{ now }] };
      }
      if (sql.includes('SELECT EXISTS')) {
        const [viewer, author] = values;
        return {
          rows: [
            {
              outgoing: blocks.has(`${viewer}:${author}`),
              incoming: blocks.has(`${author}:${viewer}`),
            },
          ],
        };
      }
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') await state.immediate();
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
      if (sql.includes('FROM unnest')) {
        const [viewers, authors, bilateral] = values as [
          string[],
          string[],
          boolean[],
        ];
        return {
          rows: viewers.map((viewer, i) => ({
            ordinal: i + 1,
            outgoing: blocks.has(`${viewer}:${authors[i]}`),
            incoming: bilateral[i] && blocks.has(`${authors[i]}:${viewer}`),
          })),
        };
      }
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;
  const records = new SafetyRepository();
  const visibility = new NamedBlockVisibility(
    { check: async () => ({ kind: 'allow', value: undefined }) },
    records,
  );
  const count = (part: string) =>
    commands.filter(({ sql }) => sql.includes(part)).length;
  return {
    tx,
    viewer,
    author,
    heads,
    commands,
    blocks,
    state,
    records,
    visibility,
    count,
  };
}
async function contextual(
  f: ReturnType<typeof fixture>,
  work: (read: SearchReadContext) => Promise<void>,
) {
  startTransactionDeadlines(f.tx);
  enableSafetyRelationshipProof(f.tx);
  const read = new SearchReadContext(f.tx);
  try {
    await work(read);
  } finally {
    read.close();
    clearTransactionDeadlines(f.tx);
  }
}

test('search Safety head reuse preserves scalar decisions, fresh clocks and relationship queries for exact purposes', async () => {
  const outputs: unknown[][] = [];
  for (const useContext of [false, true]) {
    const f = fixture(),
      results: unknown[] = [];
    await contextual(f, async (read) => {
      for (const [purpose, outgoing, incoming] of [
        ['list_projection', false, true],
        ['direct_post', false, true],
        ['list_projection', true, true],
        ['direct_post', true, false],
        ['direct_post', false, false],
        ['list_projection', false, false],
      ] as const) {
        f.blocks.clear();
        if (outgoing) f.blocks.add(`${f.viewer}:${f.author}`);
        if (incoming) f.blocks.add(`${f.author}:${f.viewer}`);
        results.push(
          await f.visibility.checkNamedRelationship(
            f.viewer,
            f.author,
            f.tx,
            purpose,
            useContext ? read : undefined,
          ),
        );
      }
      assert.equal(f.count('account_heads'), useContext ? 2 : 9);
      assert.equal(f.count('clock_timestamp'), 9);
      assert.equal(f.count('SELECT EXISTS'), 6);
      const sequence = f.commands
        .filter(({ sql }) => !sql.includes('account_heads'))
        .map(({ sql }) => sql);
      assert.deepEqual(sequence, [
        ...Array.from({ length: 6 }, (_, i) => [
          ...Array(i === 1 || i === 3 || i === 4 ? 2 : 1).fill(
            'SELECT clock_timestamp() AS now',
          ),
          f.commands.find(({ sql }) => sql.includes('SELECT EXISTS'))!.sql,
        ]).flat(),
      ]);
    });
    outputs.push(results);
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(
    outputs[1]!.map((value) => (value as { kind: string }).kind),
    ['allow', 'deny', 'deny', 'deny', 'allow', 'allow'],
  );
});

test('coverage reuse is account-specific and list purpose never demands an author head', async () => {
  const f = fixture(),
    other = randomUUID();
  f.heads.set(other, validHead());
  f.heads.delete(f.author);
  await contextual(f, async (read) => {
    assert.ok(
      await f.records.directions(
        f.viewer,
        f.author,
        'list_projection',
        f.tx,
        read,
      ),
    );
    assert.deepEqual(
      f.commands
        .filter(({ sql }) => sql.includes('account_heads'))
        .map(({ values }) => values[0]),
      [f.viewer],
    );
    assert.equal(
      await f.records.directions(f.viewer, f.author, 'direct_post', f.tx, read),
      null,
    );
    assert.ok(
      await f.records.directions(
        other,
        f.author,
        'list_projection',
        f.tx,
        read,
      ),
    );
    assert.ok(
      f.commands.some(
        ({ sql, values }) =>
          sql.includes('account_heads') && values[0] === other,
      ),
    );
  });
});

test('missing, unknown, malformed and initially expired Safety heads are never retained', async () => {
  for (const head of [
    undefined,
    { ...validHead(), block_coverage: 'missing' },
    { ...validHead(), provenance: 'unknown' },
    { ...validHead(), valid_until: new Date(NaN) },
    { ...validHead(), valid_until: 1000 as unknown as Date },
    validHead(100),
  ]) {
    const f = fixture();
    if (head) f.heads.set(f.viewer, head);
    else f.heads.delete(f.viewer);
    await contextual(f, async (read) => {
      assert.equal(
        await f.records.directions(
          f.viewer,
          f.author,
          'list_projection',
          f.tx,
          read,
        ),
        null,
      );
      f.heads.set(f.viewer, validHead());
      assert.ok(
        await f.records.directions(
          f.viewer,
          f.author,
          'list_projection',
          f.tx,
          read,
        ),
      );
      assert.equal(f.count('account_heads'), 2);
      assert.equal(f.count('clock_timestamp'), 2);
      assert.equal(f.count('SELECT EXISTS'), 1);
    });
  }
});

test('cached positive coverage is revalidated for expiry at every later decision clock', async () => {
  const f = fixture();
  f.heads.set(f.viewer, validHead(101));
  await contextual(f, async (read) => {
    assert.ok(
      await f.records.directions(
        f.viewer,
        f.author,
        'list_projection',
        f.tx,
        read,
      ),
    );
    f.state.now = 101;
    for (let i = 0; i < 2; i++)
      assert.equal(
        await f.records.directions(
          f.viewer,
          f.author,
          'list_projection',
          f.tx,
          read,
        ),
        null,
      );
    assert.equal(f.count('account_heads'), 1);
    assert.equal(f.count('clock_timestamp'), 3);
    assert.equal(f.count('SELECT EXISTS'), 1);
  });
});

test('retained coverage uses immutable primitive expiry rather than a caller-visible Date or head', async () => {
  const f = fixture(),
    head = validHead(101);
  f.heads.set(f.viewer, head);
  await contextual(f, async (read) => {
    assert.ok(
      await f.records.directions(
        f.viewer,
        f.author,
        'list_projection',
        f.tx,
        read,
      ),
    );
    head.valid_until!.setTime(9999);
    head.valid_until = null;
    f.state.now = 101;
    assert.equal(
      await f.records.directions(
        f.viewer,
        f.author,
        'list_projection',
        f.tx,
        read,
      ),
      null,
    );
    assert.equal(f.count('account_heads'), 1);
  });
});

test('restriction and selection consumers keep fresh owner reads outside coverage reuse', async () => {
  const f = fixture();
  await contextual(f, async (read) => {
    assert.ok(
      await f.records.directions(
        f.viewer,
        f.author,
        'list_projection',
        f.tx,
        read,
      ),
    );
    await f.records.restriction(f.viewer, f.tx);
    await f.records.selectionEligibility(f.viewer, f.tx);
    assert.equal(f.count('account_heads'), 4);
    assert.equal(f.count('clock_timestamp'), 3);
  });
});

test('anonymous, guest and self parents do not populate Safety coverage or suppress a named child', async () => {
  const f = fixture();
  await contextual(f, async (read) => {
    const subject = {
      contentId: randomUUID(),
      contentKind: 'post' as const,
      contentVersion: 1 as const,
    };
    await f.visibility.check(
      f.viewer,
      { ...subject, authorMode: 'anonymous' },
      f.tx,
      'direct_post',
      read,
    );
    await f.visibility.check(
      null,
      { ...subject, authorMode: 'named', namedAccountId: f.author },
      f.tx,
      'list_projection',
      read,
    );
    await f.visibility.check(
      f.viewer,
      { ...subject, authorMode: 'named', namedAccountId: f.viewer },
      f.tx,
      'direct_post',
      read,
    );
    assert.equal(f.commands.length, 0);
    f.blocks.add(`${f.viewer}:${f.author}`);
    const result = await f.visibility.check(
      f.viewer,
      {
        ...subject,
        contentId: randomUUID(),
        contentKind: 'comment',
        authorMode: 'named',
        namedAccountId: f.author,
      },
      f.tx,
      'list_projection',
      read,
    );
    assert.deepEqual(result, { kind: 'deny', reason: 'POST_NOT_FOUND' });
    assert.equal(f.count('account_heads'), 1);
    assert.equal(f.count('SELECT EXISTS'), 1);
  });
});

test('nested and concurrent Safety head loads retain one clock per invocation', async () => {
  for (const nested of [true, false]) {
    const f = fixture();
    await contextual(f, async (read) => {
      const check = () =>
        f.records.directions(f.viewer, f.author, 'list_projection', f.tx, read);
      if (nested) {
        let fired = false;
        f.state.clock = async () => {
          if (fired) return;
          fired = true;
          assert.ok(await check());
        };
        assert.ok(await check());
        f.state.clock = async () => {};
      } else assert.ok((await Promise.all([check(), check()])).every(Boolean));
      assert.equal(
        f.count('account_heads'),
        2,
        'In-flight reads are not shared',
      );
      assert.equal(f.count('clock_timestamp'), 2);
      assert.equal(f.count('SELECT EXISTS'), 2);
      assert.ok((await Promise.all([check(), check()])).every(Boolean));
      assert.equal(f.count('account_heads'), 2);
      assert.equal(f.count('clock_timestamp'), 4);
      assert.equal(f.count('SELECT EXISTS'), 4);
    });
  }
});

test('restoration or closure during a cached Safety clock invalidates before a relationship query', async () => {
  for (const close of [false, true]) {
    const f = fixture();
    await contextual(f, async (read) => {
      assert.ok(
        await f.records.directions(
          f.viewer,
          f.author,
          'list_projection',
          f.tx,
          read,
        ),
      );
      const checkpoint = checkpointTransactionDeadlines(f.tx);
      f.state.clock = async () => {
        if (close) read.close();
        else restoreTransactionDeadlines(f.tx, checkpoint);
      };
      await assert.rejects(
        f.records.directions(f.viewer, f.author, 'list_projection', f.tx, read),
        unavailable,
      );
      assert.equal(f.count('account_heads'), 1);
      assert.equal(f.count('clock_timestamp'), 2);
      assert.equal(f.count('SELECT EXISTS'), 1);
    });
  }
});

test('restoration during a first Safety clock never retains or returns the in-flight head', async () => {
  const f = fixture();
  await contextual(f, async (read) => {
    const checkpoint = checkpointTransactionDeadlines(f.tx);
    f.state.clock = async () => restoreTransactionDeadlines(f.tx, checkpoint);
    await assert.rejects(
      f.records.directions(f.viewer, f.author, 'list_projection', f.tx, read),
      unavailable,
    );
    assert.equal(f.count('SELECT EXISTS'), 0);
  });
});

test('pooled client commit and rollback never retain a prior Safety coverage head', async () => {
  for (const rollback of [false, true]) {
    const f = fixture(),
      pool = { connect: async () => f.tx },
      failure = new Error('abort');
    let stale!: SearchReadContext;
    const first = inTransaction(
      pool,
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        stale = new SearchReadContext(tx);
        assert.ok(
          await f.records.directions(
            f.viewer,
            f.author,
            'list_projection',
            tx,
            stale,
          ),
        );
        if (rollback) throw failure;
      },
      { isolationLevel: 'read committed' },
    );
    if (rollback) await assert.rejects(first, (error) => error === failure);
    else await first;
    f.heads.set(f.viewer, { ...validHead(), block_coverage: 'missing' });
    await inTransaction(
      pool,
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        await assert.rejects(
          f.records.directions(
            f.viewer,
            f.author,
            'list_projection',
            tx,
            stale,
          ),
          unavailable,
        );
        const fresh = new SearchReadContext(tx);
        assert.equal(
          await f.records.directions(
            f.viewer,
            f.author,
            'list_projection',
            tx,
            fresh,
          ),
          null,
        );
        fresh.close();
      },
      { isolationLevel: 'read committed' },
    );
    stale.close();
    assert.equal(f.count('account_heads'), 2);
  }
});

test('closing reused Safety coverage preserves deadline and raw-block final proof through rollback', async () => {
  for (const cause of ['expiry', 'block'] as const) {
    const f = fixture(),
      pool = { connect: async () => f.tx };
    f.heads.set(f.viewer, validHead(101));
    f.state.immediate = async () => {
      if (cause === 'expiry') f.state.now = 101;
      else f.blocks.add(`${f.viewer}:${f.author}`);
    };
    await assert.rejects(
      inTransaction(
        pool,
        async (tx) => {
          enableSafetyRelationshipProof(tx);
          const read = new SearchReadContext(tx);
          for (let i = 0; i < 3; i++)
            assert.ok(
              await f.records.directions(
                f.viewer,
                f.author,
                'list_projection',
                tx,
                read,
              ),
            );
          read.assertCurrent(tx);
          read.close();
        },
        { isolationLevel: 'read committed' },
      ),
      unavailable,
    );
    assert.equal(f.count('account_heads'), 1);
    assert.equal(f.count('SELECT EXISTS'), 3);
    assert.equal(
      f.count('LOCK TABLE whaleu_safety.blocks IN SHARE MODE NOWAIT'),
      1,
    );
    assert.equal(f.commands.at(-1)!.sql, 'ROLLBACK');
    assert.equal(
      f.commands.some(({ sql }) => sql === 'COMMIT'),
      false,
    );
  }
});
