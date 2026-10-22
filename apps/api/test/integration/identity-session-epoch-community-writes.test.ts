import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import { OwnerVisibilityRepository } from '../../src/community/owner-visibility/repository.js';
import { ownerVisibilityIntentHash } from '../../src/community/owner-visibility/service.js';
import { categoryIntentHash } from '../../src/community/category-reclassification/evidence.js';
import { pinIntentHash } from '../../src/community/post-pins/service.js';
import { postPinFixture } from '../support/post-pin-fixture.js';
import {
  rollbackOnly,
  sqlError,
  sqlRejected,
  staleEpoch,
} from '../support/epoch-authority-fixture.js';

// Exercise real command/state tables and deferred triggers, not an extracted
// predicate or an invalid command that could fail for an unrelated reason.
test(
  '0180 raw community commands reject epoch-only stale authority',
  { timeout: 240000 },
  async (t) => {
    const f = await postPinFixture();
    t.after(() => f.close());
    const owner = await f.actor();
    const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
    const grant = await f.grant(owner.accountId, 'super_admin');
    const scope = await f.bind(
      f.scope.home.spaceId,
      'regional',
      f.scope.home.regionId,
    );
    const visibility = new OwnerVisibilityRepository(
      f.app.get(DatabaseService),
    );
    const ownerCommand = {
      clientRequestId: randomUUID(),
      postId: post.id,
      ownerHidden: true,
      expectedVersion: 0,
    };
    const categoryCommand = {
      clientRequestId: randomUUID(),
      postId: post.id,
      targetCategory: 'pets' as const,
      expectedRevision: 0,
    };
    const pinCommand = {
      clientRequestId: randomUUID(),
      postId: post.id,
      operation: 'pin' as const,
      durationHours: 1,
      level: 1 as const,
    };
    const pinId = randomUUID();
    const cases: {
      name: string;
      table: string;
      id: string;
      message: string;
      constraint: string;
      write: (tx: PoolClient) => Promise<void>;
    }[] = [
      {
        name: 'post_owner_visibility_complete applied hide',
        table: 'post_owner_visibility_commands',
        id: ownerCommand.clientRequestId,
        message: 'Current authenticated actor session required',
        constraint: 'post_owner_visibility_causal',
        write: async (tx) => {
          await tx.query('SET CONSTRAINTS ALL DEFERRED');
          const recordedAt = (
            await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
          ).rows[0]!.now.toISOString();
          await visibility.record(
            owner.accountId,
            owner.sessionId,
            ownerVisibilityIntentHash(owner.accountId, ownerCommand),
            ownerCommand,
            {
              requestId: ownerCommand.clientRequestId,
              postId: post.id,
              ownerHidden: true,
              expectedVersion: 0,
              outcome: 'applied',
              version: 1,
              changed: true,
              recordedAt,
            },
            tx,
          );
          await visibility.apply(owner.accountId, ownerCommand, recordedAt, tx);
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          assert.deepEqual(
            (
              await tx.query(
                'SELECT owner_hidden,version FROM whaleu_community.post_owner_visibility WHERE post_id=$1',
                [post.id],
              )
            ).rows[0],
            { owner_hidden: true, version: 1 },
          );
        },
      },
      {
        name: 'post_category_complete authorized unchanged category',
        table: 'post_category_commands',
        id: categoryCommand.clientRequestId,
        message: 'Current authenticated category actor required',
        constraint: 'post_category_causal',
        write: async (tx) => {
          await tx.query('SET CONSTRAINTS ALL DEFERRED');
          assert.equal(
            (
              await tx.query<{ allowed: boolean }>(
                'SELECT whaleu_community.post_category_grant_allowed($1,$2,$3) AND whaleu_community.post_category_supported($3) allowed',
                [owner.accountId, grant, post.id],
              )
            ).rows[0]!.allowed,
            true,
          );
          const recordedAt = (
            await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
          ).rows[0]!.now.toISOString();
          const receipt = {
            requestId: categoryCommand.clientRequestId,
            postId: post.id,
            expectedRevision: 0,
            targetCategory: 'pets',
            outcome: 'unchanged',
            revision: 0,
            eventId: null,
            recordedAt,
          };
          await tx.query(
            'INSERT INTO whaleu_community.post_category_commands(actor_id,request_id,post_id,session_id,grant_id,intent_hash,command,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              owner.accountId,
              categoryCommand.clientRequestId,
              post.id,
              owner.sessionId,
              grant,
              categoryIntentHash(owner.accountId, categoryCommand),
              categoryCommand,
              receipt,
            ],
          );
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        },
      },
      {
        name: 'post_pin_assert_complete applied pin with exact scope and grant',
        table: 'post_pin_commands',
        id: pinCommand.clientRequestId,
        message: 'Current actor session required for pin command',
        constraint: 'post_pin_causal',
        write: async (tx) => {
          await tx.query('SET CONSTRAINTS ALL DEFERRED');
          const row = (
            await tx.query<{ pinned_at: Date }>(
              "INSERT INTO whaleu_community.post_pins(id,scope_id,post_id,actor_id,request_id,level,duration_hours,pinned_at,pinned_until,provenance) SELECT $1,$2,$3,$4,$5,1,1,instant,instant+interval '1 hour','native' FROM (SELECT clock_timestamp() instant) now RETURNING pinned_at",
              [
                pinId,
                scope,
                post.id,
                owner.accountId,
                pinCommand.clientRequestId,
              ],
            )
          ).rows[0]!;
          await tx.query(
            'INSERT INTO whaleu_community.post_pin_heads(scope_id,pin_id) VALUES($1,$2)',
            [scope, pinId],
          );
          const receipt = {
            requestId: pinCommand.clientRequestId,
            operation: 'pin',
            postId: post.id,
            outcome: 'applied',
            pinId,
            recordedAt: row.pinned_at.toISOString(),
          };
          await tx.query(
            'INSERT INTO whaleu_community.post_pin_commands(actor_id,request_id,intent_hash,command,receipt,session_id,scope_id,grant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              owner.accountId,
              pinCommand.clientRequestId,
              pinIntentHash(owner.accountId, pinCommand),
              pinCommand,
              receipt,
              owner.sessionId,
              scope,
              grant,
            ],
          );
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          assert.equal(
            (
              await tx.query(
                'SELECT 1 FROM whaleu_community.post_pin_heads WHERE scope_id=$1 AND pin_id=$2',
                [scope, pinId],
              )
            ).rowCount,
            1,
          );
        },
      },
    ];
    for (const c of cases)
      await t.test(
        c.name +
          ': same full write succeeds before and fails after epoch transition',
        async () => {
          await rollbackOnly(f.pool, async (tx) => {
            await tx.query('SAVEPOINT valid_owner_write');
            await c.write(tx);
            assert.equal(
              (
                await tx.query(
                  `SELECT 1 FROM whaleu_community.${c.table} WHERE actor_id=$1 AND request_id=$2`,
                  [owner.accountId, c.id],
                )
              ).rowCount,
              1,
            );
            await tx.query('ROLLBACK TO SAVEPOINT valid_owner_write');
            await tx.query('RELEASE SAVEPOINT valid_owner_write');
            await staleEpoch(tx, owner.accountId);
            await sqlRejected(
              tx,
              () => c.write(tx),
              sqlError(c.message, c.constraint),
            );
            assert.equal(
              (
                await tx.query(
                  `SELECT 1 FROM whaleu_community.${c.table} WHERE actor_id=$1 AND request_id=$2`,
                  [owner.accountId, c.id],
                )
              ).rowCount,
              0,
            );
          });
          assert.equal(
            (
              await f.pool.query(
                `SELECT 1 FROM whaleu_community.${c.table} WHERE actor_id=$1 AND request_id=$2`,
                [owner.accountId, c.id],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.post_owner_visibility WHERE post_id=$1 UNION ALL SELECT 1 FROM whaleu_community.post_pins WHERE id=$2',
                [post.id, pinId],
              )
            ).rowCount,
            0,
          );
        },
      );
  },
);
