import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import {
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalJson,
  type EffectiveContentEnvelope,
} from '../../src/community/content-review/contracts.js';
import { ApprovalRepository } from '../../src/community/content-review/approval.repository.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

/** Direct adversarial storage checks against the real migrations. No trigger,
 * clock, runtime owner or provider is replaced. These rows grant no publication
 * authority, and no real account/provider participates in this fixture. */
test(
  'text review storage preserves original cause, completeness, snapshots and bounded budgets',
  { timeout: 120000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connectionString,
      'Requires disposable TEST_DATABASE_URL; never silently skipped',
    );
    const url = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const spaceId = randomUUID(),
      regionId = randomUUID();
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      COMMUNITY_TEXT_REVIEW: 'local_manual',
      COMMUNITY_TEXT_REVIEW_SPACE_ID: spaceId,
      COMMUNITY_TEXT_REVIEW_REGION_ID: regionId,
      COMMUNITY_TEXT_REVIEW_POLICY_ID: randomUUID(),
      COMMUNITY_TEXT_REVIEW_OPERATOR: 'local:test:storage',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      owns = false,
      locked = false;
    const envelope = (owner: string): EffectiveContentEnvelope =>
      canonicalEnvelope({
        version: 2,
        accountId: owner,
        purpose: 'publish_post',
        spaceId,
        category: 'discussion',
        authorMode: 'named',
        allowAnonymousDm: false,
        commentsPolicy: 'open',
        postId: null,
        rootCommentId: null,
        targetReplyId: null,
        text: 'Synthetic named text storage contract',
        images: [],
        component: { kind: 'none' },
        trading: null,
        scope: {
          originalSpaceId: spaceId,
          originalRegionId: regionId,
          authorOriginRegionId: null,
          identityRegionId: null,
          topologySnapshotId: null,
          sync: 'none',
        },
      });
    const intent = (owner: string) =>
      createHash('sha256')
        .update(`synthetic-storage-intent:${owner}`)
        .digest('hex');
    async function account() {
      const id = randomUUID();
      await pool.query('INSERT INTO whaleu_identity.accounts(id) VALUES($1)', [
        id,
      ]);
      return id;
    }
    async function publication(
      tx: PoolClient,
      owner: string,
      id: string,
      cause: 'current' | 'zero' | 'none' = 'current',
      terminal = false,
    ) {
      await tx.query(
        `INSERT INTO whaleu_community.publication_requests
      (account_id,client_request_id,payload_hash,operation,receipt,review_submission_transaction)
      VALUES($1,$2,$3,'publish_post',$4::jsonb,
        CASE $5 WHEN 'current' THEN pg_current_xact_id() WHEN 'zero' THEN '0'::xid8 ELSE NULL END)`,
        [
          owner,
          id,
          intent(owner),
          terminal
            ? JSON.stringify({
                requestId: id,
                operation: 'publish_post',
                outcome: 'rejected',
                code: 'CONTENT_REVIEW_REJECTED',
              })
            : null,
          cause,
        ],
      );
    }
    async function queue(
      tx: PoolClient,
      owner: string,
      id: string,
      options: {
        operation?: string;
        hash?: string;
        value?: unknown;
        digest?: string;
        cause?: string;
        timestamp?: 'fresh' | 'backdated';
        expiry?: 'normal' | 'short';
      } = {},
    ) {
      const value = options.value ?? envelope(owner);
      await tx.query(
        `INSERT INTO whaleu_community.text_review_requests
      (account_id,client_request_id,operation,intent_hash,envelope,digest,submission_transaction,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,coalesce($7::xid8,pg_current_xact_id()),
        transaction_timestamp()-CASE WHEN $8 THEN interval '8 days' ELSE interval '0' END,
        transaction_timestamp()-CASE WHEN $8 THEN interval '8 days' ELSE interval '0' END+
          CASE WHEN $9 THEN interval '1 second' ELSE interval '7 days' END)`,
        [
          owner,
          id,
          options.operation ?? 'publish_post',
          options.hash ?? intent(owner),
          canonicalJson(value),
          options.digest ?? approvalDigest(envelope(owner)),
          options.cause ?? null,
          options.timestamp === 'backdated',
          options.expiry === 'short',
        ],
      );
    }
    async function pair(tx: PoolClient, owner: string, id = randomUUID()) {
      await publication(tx, owner, id);
      await queue(tx, owner, id);
      return id;
    }
    async function absent(owner: string, id: string) {
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
            [owner, id],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [owner, id],
          )
        ).rowCount,
        0,
      );
    }
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.ok(locked, 'Run disposable PostgreSQL suites serially');
      assert.ok(
        supportedPostgresVersion(
          (
            await pool.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rowCount,
        0,
        'Refuse existing WhaleU schemas',
      );
      owns = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );

      await t.test(
        'a null receipt is incomplete even with a current submission marker alone',
        async () => {
          const owner = await account();
          for (const cause of ['current', 'zero', 'none'] as const) {
            const id = randomUUID();
            await assert.rejects(
              inTransaction(pool, (tx) => publication(tx, owner, id, cause)),
              /Publication request is incomplete/,
            );
            await absent(owner, id);
          }
          const valid = await inTransaction(pool, (tx) => pair(tx, owner));
          const row = (
            await pool.query<{ receipt: unknown; coupled: boolean }>(
              `SELECT p.receipt,q.submission_transaction=p.review_submission_transaction AS coupled
        FROM whaleu_community.publication_requests p JOIN whaleu_community.text_review_requests q USING(account_id,client_request_id)
        WHERE p.account_id=$1 AND p.client_request_id=$2`,
              [owner, valid],
            )
          ).rows[0]!;
          assert.equal(row.receipt, null);
          assert.equal(row.coupled, true);
        },
      );

      await t.test(
        'reverse queue coupling rejects missing, terminal, mismatched owner and foreign transaction causes',
        async () => {
          const owner = await account(),
            other = await account();
          await assert.rejects(
            inTransaction(pool, (tx) => queue(tx, owner, randomUUID())),
            /ownership mismatch|foreign key/i,
          );
          const terminal = randomUUID();
          await inTransaction(pool, (tx) =>
            publication(tx, owner, terminal, 'current', true),
          );
          await assert.rejects(
            inTransaction(pool, (tx) => queue(tx, owner, terminal)),
            /fresh exact submission cause/,
          );
          for (const mode of [
            'missing-marker',
            'foreign-marker',
            'foreign-queue-cause',
            'other-owner',
          ] as const) {
            const id = randomUUID();
            await assert.rejects(
              inTransaction(pool, async (tx) => {
                await publication(
                  tx,
                  owner,
                  id,
                  mode === 'missing-marker'
                    ? 'none'
                    : mode === 'foreign-marker'
                      ? 'zero'
                      : 'current',
                );
                await queue(
                  tx,
                  mode === 'other-owner' ? other : owner,
                  id,
                  mode === 'foreign-queue-cause' ? { cause: '0' } : {},
                );
              }),
              /fresh exact submission cause|ownership mismatch/,
            );
            await absent(owner, id);
          }
        },
      );

      await t.test(
        'operation, intent hash, canonical digest and immutable envelope constraints reject adversarial inserts',
        async () => {
          const owner = await account();
          const original = envelope(owner);
          for (const patch of [
            { operation: 'publish_comment' },
            { hash: 'f'.repeat(64) },
            { digest: '0'.repeat(64) },
            { value: { ...original, text: 'Changed text with old digest' } },
            { value: { ...original, accountId: randomUUID() } },
            { value: { ...original, authorMode: 'anonymous' } },
            {
              value: {
                ...original,
                images: [{ assetId: randomUUID(), digest: 'a'.repeat(64) }],
              },
            },
          ]) {
            const id = randomUUID();
            await assert.rejects(
              inTransaction(pool, async (tx) => {
                await publication(tx, owner, id);
                await queue(tx, owner, id, patch);
              }),
            );
            await absent(owner, id);
          }
        },
      );

      await t.test(
        'queue deletion/truncate and snapshot or reverse-origin rewrites are forbidden',
        async () => {
          const owner = await account(),
            id = await inTransaction(pool, (tx) => pair(tx, owner));
          const before = (
            await pool.query(
              'SELECT to_jsonb(q) AS row FROM whaleu_community.text_review_requests q WHERE account_id=$1 AND client_request_id=$2',
              [owner, id],
            )
          ).rows[0]!.row;
          for (const assignment of [
            "envelope=jsonb_set(envelope,'{text}','\"rewritten\"'::jsonb)",
            "intent_hash=repeat('e',64)",
            "digest=repeat('d',64)",
            "submission_transaction='0'::xid8",
            "created_at=created_at-interval '1 second'",
            "expires_at=expires_at-interval '1 second'",
          ])
            await assert.rejects(
              pool.query(
                `UPDATE whaleu_community.text_review_requests SET ${assignment} WHERE account_id=$1 AND client_request_id=$2`,
                [owner, id],
              ),
              /snapshot is immutable/,
            );
          await assert.rejects(
            pool.query(
              'DELETE FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
              [owner, id],
            ),
            /retained/,
          );
          await assert.rejects(
            pool.query('TRUNCATE whaleu_community.text_review_requests'),
          );
          await assert.rejects(
            pool.query(
              `UPDATE whaleu_community.publication_requests SET receipt='{"outcome":"rejected"}'::jsonb,review_submission_transaction='0'::xid8 WHERE account_id=$1 AND client_request_id=$2`,
              [owner, id],
            ),
            /origin is immutable/,
          );
          await assert.rejects(
            pool.query(
              'DELETE FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
              [owner, id],
            ),
            /immutable/,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT to_jsonb(q) AS row FROM whaleu_community.text_review_requests q WHERE account_id=$1 AND client_request_id=$2',
                [owner, id],
              )
            ).rows[0]!.row,
            before,
          );
        },
      );

      await t.test(
        '32 active rows cap the account, cancellation releases only an active slot',
        async () => {
          const owner = await account();
          const ids = await inTransaction(pool, async (tx) => {
            const result: string[] = [];
            for (let i = 0; i < 32; i++) result.push(await pair(tx, owner));
            return result;
          });
          const denied = randomUUID();
          await assert.rejects(
            inTransaction(pool, (tx) => pair(tx, owner, denied)),
            /budget exhausted/,
          );
          await absent(owner, denied);
          await pool.query(
            "INSERT INTO whaleu_community.publication_cancel_fences(account_id,client_request_id,operation,intent_hash) VALUES($1,$2,'publish_post',$3)",
            [owner, ids[0], intent(owner)],
          );
          await inTransaction(pool, (tx) => pair(tx, owner));
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM whaleu_community.text_review_requests WHERE account_id=$1',
                [owner],
              )
            ).rows[0]!.n,
            33,
          );
        },
      );

      await t.test(
        '128 daily submissions remain counted after terminal rejection',
        async () => {
          const owner = await account();
          await inTransaction(pool, async (tx) => {
            for (let i = 0; i < 128; i++) {
              const id = await pair(tx, owner);
              await tx.query(
                `UPDATE whaleu_community.publication_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2`,
                [
                  owner,
                  id,
                  JSON.stringify({
                    requestId: id,
                    operation: 'publish_post',
                    outcome: 'rejected',
                    code: 'CONTENT_REVIEW_REJECTED',
                  }),
                ],
              );
            }
          });
          const id = randomUUID();
          await assert.rejects(
            inTransaction(pool, (tx) => pair(tx, owner, id)),
            /budget exhausted/,
          );
          await absent(owner, id);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM whaleu_community.text_review_requests WHERE account_id=$1',
                [owner],
              )
            ).rows[0]!.n,
            128,
          );
        },
      );

      await t.test(
        'expiry cannot be forged or shortened and the actual expire command leaves fresh rows unfenced',
        async () => {
          const owner = await account();
          for (const patch of [
            { timestamp: 'backdated' as const },
            { expiry: 'short' as const },
          ]) {
            const id = randomUUID();
            await assert.rejects(
              inTransaction(pool, async (tx) => {
                await publication(tx, owner, id);
                await queue(tx, owner, id, patch);
              }),
            );
            await absent(owner, id);
          }
          const id = await inTransaction(pool, (tx) => pair(tx, owner));
          assert.equal(
            (
              await pool.query<{ fresh: boolean }>(
                `SELECT expires_at=created_at+interval '7 days' AND expires_at>clock_timestamp() AS fresh
        FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2`,
                [owner, id],
              )
            ).rows[0]!.fresh,
            true,
          );
          const runtime = new TextReviewRuntime(
            config,
            new ApprovalRepository(),
          );
          const operator = new TextReviewOperator(
            runtime,
            config.COMMUNITY_TEXT_REVIEW_OPERATOR!,
          );
          assert.deepEqual(
            await inTransaction(pool, (tx) =>
              operator.run({ command: 'expire', limit: 32 }, tx),
            ),
            { expiredRequestsFenced: 0 },
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.publication_cancel_fences WHERE account_id=$1 AND client_request_id=$2',
                [owner, id],
              )
            ).rowCount,
            0,
          );
          // Positive seven-day expiry is intentionally not simulated: neither clocks,
          // immutable timestamps nor triggers are changed to manufacture that case.
        },
      );
    } finally {
      try {
        if (owns)
          for (const schema of migrationSchemaNames)
            await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        if (locked)
          await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
            MIGRATION_LOCK[0],
            2,
          ]);
        suite?.release();
        await pool.end();
      }
    }
  },
);
