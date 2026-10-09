import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { SafetySearchEligibilityFacade } from '../../src/safety/search-eligibility.facade.js';
import { NamedBlockVisibility } from '../../src/safety/visibility.js';
import { SafetyRepository } from '../../src/safety/repository.js';
import { inTransaction } from '../../src/database/database.js';
import { requiredOwnerEpoch } from '../../src/database/required-owner-proof.js';
import { registerTransactionDeadline } from '../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { searchHarness } from './search-fixtures.js';

type Node = {
  node_key: string;
  author_mode: string;
  named_account_id: string | null;
  purpose: 'list_projection' | 'direct_post';
};
type Fact = {
  node_key: string;
  decision: 'allow' | 'deny' | 'unknown';
  valid_until: Date | null;
};
const owner = new SafetySearchEligibilityFacade();
const query = `WITH nodes AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS n(node_key text,author_mode text,named_account_id uuid,purpose text)
) ${owner.relation({ nodes: 'nodes', viewerParameter: 2 }).replace(/^WITH /, ', ')}`;
const unavailable = (e: unknown) =>
  e instanceof ApplicationError && e.code === 'COMMUNITY_UNAVAILABLE';

test(
  'set Safety remains scalar-equivalent with mandatory epoch and deadline closure',
  { timeout: 120000 },
  async (t) => {
    const h = await searchHarness();
    const scalar = new NamedBlockVisibility(
      { check: async () => ({ kind: 'allow', value: undefined }) },
      new SafetyRepository(),
    );
    const w = await h.world();
    let outgoingId: string | undefined;
    const blockOutgoing = async () => {
      outgoingId = await h.writeBlock(w.reader, w.author, true, outgoingId);
      return outgoingId;
    };
    const nodes: Node[] = [];
    for (const purpose of ['list_projection', 'direct_post'] as const) {
      for (const [mode, id, label] of [
        ['anonymous', null, 'anonymous'],
        ['named', w.reader.accountId, 'self'],
        ['named', w.author.accountId, 'named'],
      ] as const)
        nodes.push({
          node_key: `${purpose}:${label}`,
          author_mode: mode,
          named_account_id: id,
          purpose,
        });
    }
    const read = async (tx: PoolClient, viewer: string | null, input = nodes) =>
      (await tx.query<Fact>(query, [JSON.stringify(input), viewer])).rows;
    const compare = async (viewer: string | null) =>
      inTransaction(
        h.pool,
        async (tx) => {
          const facts = await read(tx, viewer);
          assert.equal(facts.length, nodes.length);
          for (const node of nodes) {
            const actual = facts.find((f) => f.node_key === node.node_key)!;
            const result = await scalar.check(
              viewer,
              {
                contentKind: 'post',
                contentId: randomUUID(),
                contentVersion: 1,
                ...(node.author_mode === 'anonymous'
                  ? { authorMode: 'anonymous' as const }
                  : {
                      authorMode: 'named' as const,
                      namedAccountId: node.named_account_id!,
                    }),
              },
              tx,
              node.purpose,
            );
            assert.equal(
              actual.decision,
              result.kind === 'unavailable' ? 'unknown' : result.kind,
              node.node_key,
            );
          }
          return facts;
        },
        { isolationLevel: 'read committed' },
      );
    try {
      await t.test(
        'guest, self, anonymous, named and both block directions',
        async () => {
          await compare(null);
          await compare(w.reader.accountId);
          const incoming = await h.writeBlock(w.author, w.reader);
          let facts = await compare(w.reader.accountId);
          assert.equal(
            facts.find((f) => f.node_key === 'list_projection:named')!.decision,
            'allow',
          );
          assert.equal(
            facts.find((f) => f.node_key === 'direct_post:named')!.decision,
            'deny',
          );
          await h.writeBlock(w.author, w.reader, false, incoming);
          const outgoing = await blockOutgoing();
          facts = await compare(w.reader.accountId);
          assert.equal(
            facts.find((f) => f.node_key === 'list_projection:named')!.decision,
            'deny',
          );
          await compare(null);
          await h.writeBlock(w.reader, w.author, false, outgoing);
        },
      );
      await t.test(
        'missing, malformed coverage/provenance, future and expired heads',
        async () => {
          for (const account of [w.reader.accountId, w.author.accountId]) {
            for (const patch of [
              "block_coverage='missing'",
              "block_coverage='conflict'",
              "provenance='unknown',block_coverage='missing',actions_allowed=NULL,restriction_coverage='missing'",
              "valid_until=clock_timestamp()-interval '1 second'",
              "valid_until=clock_timestamp()+interval '1 hour'",
            ]) {
              await h.pool.query(
                `UPDATE whaleu_safety.account_heads SET ${patch} WHERE account_id=$1`,
                [account],
              );
              await compare(w.reader.accountId);
              await compare(null);
              await h.pool.query(
                "UPDATE whaleu_safety.account_heads SET block_coverage='complete',restriction_coverage='complete',actions_allowed=true,provenance='native_account_creation',valid_until=NULL WHERE account_id=$1",
                [account],
              );
            }
          }
          // Missing author head is irrelevant for list_projection, required for direct.
          const tx = await h.pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              'DELETE FROM whaleu_safety.account_heads WHERE account_id=$1',
              [w.author.accountId],
            );
            const facts = await read(tx, w.reader.accountId);
            assert.equal(
              facts.find((f) => f.node_key === 'list_projection:named')!
                .decision,
              'allow',
            );
            assert.equal(
              facts.find((f) => f.node_key === 'direct_post:named')!.decision,
              'unknown',
            );
            await tx.query(
              'DELETE FROM whaleu_safety.account_heads WHERE account_id=$1',
              [w.reader.accountId],
            );
            const absent = await read(tx, w.reader.accountId);
            assert.equal(
              absent.find((f) => f.node_key === 'list_projection:named')!
                .decision,
              'unknown',
            );
            assert.equal(
              absent.find((f) => f.node_key === 'direct_post:self')!.decision,
              'allow',
            );
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'anonymous parent does not bypass named descendants and malformed metadata is unknown',
        async () => {
          const block = await blockOutgoing();
          const tx = await h.pool.connect();
          try {
            const facts = await read(tx, w.reader.accountId, [
              {
                node_key: 'post',
                author_mode: 'anonymous',
                named_account_id: null,
                purpose: 'direct_post',
              },
              {
                node_key: 'root',
                author_mode: 'named',
                named_account_id: w.author.accountId,
                purpose: 'list_projection',
              },
              {
                node_key: 'reply',
                author_mode: 'anonymous',
                named_account_id: null,
                purpose: 'list_projection',
              },
              {
                node_key: 'bad',
                author_mode: 'named',
                named_account_id: null,
                purpose: 'list_projection',
              },
            ]);
            assert.deepEqual(
              ['post', 'root', 'reply', 'bad'].map(
                (key) => facts.find((f) => f.node_key === key)!.decision,
              ),
              ['allow', 'deny', 'allow', 'unknown'],
            );
          } finally {
            tx.release();
          }
          await h.writeBlock(w.reader, w.author, false, block);
        },
      );
      await t.test(
        'unbounded metadata relation is independent of existing checkBatch ceiling',
        async () => {
          const tx = await h.pool.connect();
          try {
            const facts = await read(
              tx,
              w.reader.accountId,
              Array.from({ length: 1001 }, (_, i) => ({
                node_key: String(i),
                author_mode: 'named',
                named_account_id: w.author.accountId,
                purpose: 'list_projection',
              })),
            );
            assert.equal(facts.length, 1001);
            assert.ok(facts.every((f) => f.decision === 'allow'));
          } finally {
            tx.release();
          }
        },
      );
      await t.test(
        'raw block/head writers invalidate required proof, never yield silent denial/end',
        async () => {
          const capture = requiredOwnerEpoch(
            owner.proofOwner,
            'COMMUNITY_UNAVAILABLE',
          );
          for (const mutation of ['block', 'head'] as const) {
            let block: string | undefined;
            await assert.rejects(
              inTransaction(
                h.pool,
                async (tx) => {
                  await capture(tx);
                  assert.ok(
                    (await read(tx, w.reader.accountId)).every(
                      (f) => f.decision === 'allow',
                    ),
                  );
                  if (mutation === 'block') block = await blockOutgoing();
                  else
                    await h.pool.query(
                      "UPDATE whaleu_safety.account_heads SET block_coverage='missing' WHERE account_id=$1",
                      [w.reader.accountId],
                    );
                  return 'must not escape';
                },
                { isolationLevel: 'read committed' },
              ),
              unavailable,
            );
            if (block) await h.writeBlock(w.reader, w.author, false, block);
            else
              await h.pool.query(
                "UPDATE whaleu_safety.account_heads SET block_coverage='complete' WHERE account_id=$1",
                [w.reader.accountId],
              );
          }
          await inTransaction(
            h.pool,
            async (tx) => {
              await capture(tx);
              await read(tx, w.reader.accountId);
            },
            { isolationLevel: 'read committed' },
          );
        },
      );
      await t.test(
        'required deadlines reject expiry after relation read',
        async () => {
          await h.pool.query(
            "UPDATE whaleu_safety.account_heads SET valid_until=clock_timestamp()+interval '500 milliseconds' WHERE account_id=$1",
            [w.reader.accountId],
          );
          await assert.rejects(
            inTransaction(
              h.pool,
              async (tx) => {
                const facts = await read(tx, w.reader.accountId);
                for (const fact of facts)
                  registerTransactionDeadline(
                    tx,
                    fact.valid_until?.getTime() ?? null,
                    'COMMUNITY_UNAVAILABLE',
                  );
                await tx.query('SELECT pg_sleep(0.6)');
              },
              { isolationLevel: 'read committed' },
            ),
            unavailable,
          );
        },
      );
    } finally {
      await h.close();
    }
  },
);
