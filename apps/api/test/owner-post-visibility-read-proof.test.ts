import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  ownerPostVisibilityAllowed,
  readOwnerPostVisibility,
} from '../src/community/owner-visibility/read-proof.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

function fixture() {
  const postId = randomUUID(),
    owner = randomUUID();
  let row: Record<string, unknown> | null = {
    postId,
    ownerHidden: false,
    version: 0,
    requestId: null,
    xmin: null,
  };
  let blocked = false;
  const tx = {
    query: async (sql: string) => {
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '15s',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.startsWith('LOCK TABLE')) {
        if (blocked)
          throw Object.assign(new Error('writer active'), { code: '55P03' });
        return { rows: [] };
      }
      if (sql.includes('LEFT JOIN whaleu_community.post_owner_visibility'))
        return { rows: row ? [{ ...row }] : [] };
      if (sql.includes('set_config') || sql === 'SET CONSTRAINTS ALL IMMEDIATE')
        return { rows: [] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      throw new Error(`Unexpected owner-proof SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  return {
    tx,
    postId,
    owner,
    set(value: typeof row) {
      row = value;
    },
    block() {
      blocked = true;
    },
    hidden(version = 1) {
      return {
        postId,
        ownerHidden: true,
        version,
        requestId: randomUUID(),
        xmin: String(100 + version),
      };
    },
  };
}
const unavailable = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === 'COMMUNITY_UNAVAILABLE';

test('known absent overlay is public baseline; missing parent, unknown or inconsistent overlay is never an allow', async () => {
  for (const kind of [
    'baseline',
    'missing-parent',
    'unknown-hidden',
    'unknown-version',
    'wrong-parent',
    'missing-lineage',
    'impossible-hidden-baseline',
  ] as const) {
    const f = fixture();
    startTransactionDeadlines(f.tx);
    try {
      if (kind === 'baseline') {
        assert.equal(
          await ownerPostVisibilityAllowed(
            f.postId,
            f.owner,
            null,
            'list_projection',
            f.tx,
          ),
          true,
        );
        await checkTransactionDeadlines(f.tx);
      } else {
        const bad =
          kind === 'missing-parent'
            ? null
            : kind === 'unknown-hidden'
              ? { postId: f.postId, version: 0 }
              : kind === 'unknown-version'
                ? { ...f.hidden(), version: '1' }
                : kind === 'wrong-parent'
                  ? { ...f.hidden(), postId: randomUUID() }
                  : kind === 'missing-lineage'
                    ? { ...f.hidden(), requestId: null }
                    : {
                        postId: f.postId,
                        ownerHidden: true,
                        version: 0,
                        requestId: null,
                        xmin: null,
                      };
        f.set(bad);
        await assert.rejects(
          readOwnerPostVisibility(f.postId, f.tx),
          unavailable,
          kind,
        );
      }
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});

test('owner-private proof does not allow public or another actor and exact final state survives every result', async () => {
  const f = fixture();
  f.set(f.hidden());
  startTransactionDeadlines(f.tx);
  try {
    assert.equal(
      await ownerPostVisibilityAllowed(
        f.postId,
        f.owner,
        f.owner,
        'direct_post',
        f.tx,
      ),
      true,
    );
    assert.equal(
      await ownerPostVisibilityAllowed(
        f.postId,
        f.owner,
        f.owner,
        'detail_projection',
        f.tx,
      ),
      true,
    );
    assert.equal(
      await ownerPostVisibilityAllowed(
        f.postId,
        f.owner,
        f.owner,
        'list_projection',
        f.tx,
      ),
      false,
    );
    assert.equal(
      await ownerPostVisibilityAllowed(
        f.postId,
        f.owner,
        f.owner,
        'named_interaction',
        f.tx,
      ),
      false,
    );
    assert.equal(
      await ownerPostVisibilityAllowed(
        f.postId,
        f.owner,
        randomUUID(),
        'direct_post',
        f.tx,
      ),
      false,
    );
    await checkTransactionDeadlines(f.tx);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('final owner proof rejects first insertion, ABA lineage change and a concurrent unfenced writer', async () => {
  for (const kind of ['insert', 'aba', 'busy'] as const) {
    const f = fixture();
    const original = f.hidden();
    if (kind === 'aba') f.set(original);
    startTransactionDeadlines(f.tx);
    try {
      await readOwnerPostVisibility(f.postId, f.tx);
      if (kind === 'insert') f.set(f.hidden());
      else if (kind === 'aba')
        f.set({
          ...original,
          version: 3,
          requestId: randomUUID(),
          xmin: '103',
        });
      else f.block();
      await assert.rejects(checkTransactionDeadlines(f.tx), unavailable, kind);
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});
