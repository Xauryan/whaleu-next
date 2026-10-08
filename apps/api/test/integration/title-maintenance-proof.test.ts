import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import { maintenanceIntentHash } from '../../src/experience/maintenance.contracts.js';
import { maintenanceFixture } from '../support/title-maintenance-fixture.js';

const constraintError = (error: unknown) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['23514', '23503', '23505', '22023'].includes(String(error.code)),
  );

test(
  'real PostgreSQL maintenance proof rejects fabricated authority, eligibility, state, cursor and same-transaction evidence',
  { timeout: 120000 },
  async (t) => {
    const f = await maintenanceFixture();
    try {
      const target = await f.account({ balance: 0n }),
        actor = await f.actor(),
        stranger = await f.actor();
      const grant = await f.grant(actor.accountId, 'developer');
      const strangerGrant = await f.grant(stranger.accountId, 'super_admin');
      const member = await f.actor();
      interface Changes {
        actorId?: string;
        grantId?: string;
        sessionId?: string;
        operation?: 'repair_level_titles' | 'repair_default_title';
        balance?: string | null;
        revision?: string | null;
        level?: number | null;
        eligible?: boolean;
        keys?: string[];
        owner?: string;
        count?: number;
        itemTimeOffset?: number;
        earnedOffset?: number;
        skipItem?: boolean;
        skipEvidence?: boolean;
        skipEntitlement?: boolean;
        cursorAfter?: string;
        cursorBefore?: string;
        upper?: string;
        done?: boolean;
        extraReceipt?: Record<string, unknown>;
      }
      async function write(tx: PoolClient, id: string, change: Changes = {}) {
        const actorId = change.actorId ?? actor.accountId,
          owner = change.owner ?? target.id;
        const operation = change.operation ?? 'repair_level_titles';
        const keys = change.keys ?? ['level_1'];
        const boundary = (
          await tx.query<{ at: Date; upper: string }>(
            "SELECT date_trunc('milliseconds',clock_timestamp()) at,(SELECT max(id::text)::uuid FROM whaleu_identity.accounts) upper",
          )
        ).rows[0]!;
        // These are ordinary real facts, not a runtime authorizer. SQL must still validate them.
        const receipt = {
          requestId: id,
          operation,
          runId: id,
          previousRequestId: null,
          visited: 1,
          updatedOwners: 1,
          grantedTitles: change.count ?? keys.length,
          skippedUnknownLevel: 0,
          skippedIneligible: 0,
          done: change.done ?? false,
          ...change.extraReceipt,
        };
        const at = (
          await tx.query<{ decided_at: Date }>(
            `INSERT INTO whaleu_experience.maintenance_requests(actor_id,request_id,intent_hash,operation,run_id,previous_request_id,run_started_at,upper_account_id,cursor_before,cursor_after,grant_id,session_id,receipt)
        VALUES($1,$2,$3,$4,$2,NULL,$5,$6,$7,$8,$9,$10,$11) RETURNING decided_at`,
            [
              actorId,
              id,
              maintenanceIntentHash({ requestId: id, operation }),
              operation,
              boundary.at,
              change.upper ?? boundary.upper,
              change.cursorBefore ?? null,
              change.cursorAfter ?? owner,
              change.grantId ?? grant,
              change.sessionId ?? actor.sessionId,
              receipt,
            ],
          )
        ).rows[0]!.decided_at;
        if (!change.skipItem)
          await tx.query(
            `INSERT INTO whaleu_experience.maintenance_items(actor_id,request_id,owner_id,eligible,known_balance,state_revision,observed_level,outcome,granted_title_keys,decided_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'repaired',$8,$9)`,
            [
              actorId,
              id,
              owner,
              change.eligible ?? true,
              'balance' in change ? change.balance : '0',
              'revision' in change ? change.revision : '0',
              'level' in change ? change.level : 1,
              keys,
              new Date(at.getTime() + (change.itemTimeOffset ?? 0)),
            ],
          );
        for (const key of keys) {
          if (!change.skipEvidence)
            await tx.query(
              'INSERT INTO whaleu_experience.maintenance_grants(actor_id,request_id,owner_id,title_key) VALUES($1,$2,$3,$4)',
              [actorId, id, owner, key],
            );
          if (!change.skipEntitlement)
            await tx.query(
              "INSERT INTO whaleu_experience.entitlements(owner_id,title_key,origin,maintenance_actor_id,maintenance_request_id,earned_at) VALUES($1,$2,'maintenance',$3,$4,$5)",
              [
                owner,
                key,
                actorId,
                id,
                new Date(at.getTime() + (change.earnedOffset ?? 0)),
              ],
            );
        }
        return at;
      }
      const cases: [string, Changes][] = [
        [
          'another account cannot borrow a global grant',
          { actorId: member.accountId, sessionId: member.sessionId },
        ],
        ['a different operator grant is not proof', { grantId: strangerGrant }],
        [
          'a different operator session is not proof',
          { sessionId: stranger.sessionId },
        ],
        ['fabricated known balance', { balance: '17150', level: 30 }],
        ['fabricated state revision', { revision: '999' }],
        ['fabricated level', { level: 29 }],
        ['higher threshold not justified by zero', { keys: ['level_29'] }],
        [
          'limited title is not maintenance',
          { keys: ['redeem_liangchenmeijing'] },
        ],
        ['default title is not level repair', { keys: ['default_jingxiaoyu'] }],
        ['false aggregate count', { count: 9 }],
        ['extra receipt field', { extraReceipt: { ownerId: target.id } }],
        ['item decision time must match', { itemTimeOffset: 1 }],
        ['grant time must match', { earnedOffset: 1 }],
        ['missing item proof', { skipItem: true }],
        ['missing normalized evidence', { skipEvidence: true }],
        ['orphan normalized evidence', { skipEntitlement: true }],
        ['false done omits live candidate', { done: true }],
        ['cursor jumps past selected owner', { cursorAfter: actor.accountId }],
        ['start cursor cannot be supplied', { cursorBefore: target.id }],
        ['upper bound cannot omit population', { upper: target.id }],
      ];
      for (const [name, change] of cases)
        await t.test(name, async () => {
          const id = randomUUID();
          await assert.rejects(
            inTransaction(f.pool, (tx) => write(tx, id, change)),
            constraintError,
          );
          await f.rollbackRows(id);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_experience.entitlements WHERE maintenance_request_id=$1',
                [id],
              )
            ).rowCount,
            0,
          );
        });
      await t.test(
        'valid current global authority and actual zero state can commit one complete SQL proof',
        async () => {
          const id = randomUUID();
          await inTransaction(f.pool, (tx) => write(tx, id));
          assert.equal(
            (
              await f.pool.query(
                "SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='level_1' AND origin='maintenance'",
                [target.id],
              )
            ).rowCount,
            1,
          );
          for (const table of [
            'maintenance_requests',
            'maintenance_items',
            'maintenance_grants',
          ]) {
            await assert.rejects(
              f.pool.query(
                `UPDATE whaleu_experience.${table} SET request_id=request_id WHERE actor_id=$1 AND request_id=$2`,
                [actor.accountId, id],
              ),
              constraintError,
            );
            await assert.rejects(
              f.pool.query(
                `DELETE FROM whaleu_experience.${table} WHERE actor_id=$1 AND request_id=$2`,
                [actor.accountId, id],
              ),
              constraintError,
            );
          }
          await assert.rejects(
            f.pool.query(
              "INSERT INTO whaleu_experience.entitlements(owner_id,title_key,origin,maintenance_actor_id,maintenance_request_id,earned_at) SELECT owner_id,'level_3','maintenance',actor_id,request_id,decided_at FROM whaleu_experience.maintenance_items WHERE actor_id=$1 AND request_id=$2",
              [actor.accountId, id],
            ),
            constraintError,
          );
          await assert.rejects(
            f.pool.query(
              "INSERT INTO whaleu_experience.maintenance_grants(actor_id,request_id,owner_id,title_key) VALUES($1,$2,$3,'level_3')",
              [actor.accountId, id, target.id],
            ),
            constraintError,
          );
        },
      );
      await t.test(
        'a default repair cannot fabricate provider eligibility or attach level-state evidence',
        async () => {
          const noProvider = await f.account({
            provider: false,
            id: '00000000-0000-4000-8000-000000000000',
          });
          await f.pool.query(
            'INSERT INTO whaleu_experience.owners(owner_id) VALUES($1)',
            [noProvider.id],
          );
          for (const change of [
            {
              operation: 'repair_default_title' as const,
              owner: noProvider.id,
              keys: ['default_jingxiaoyu'],
              balance: null,
              revision: null,
              level: null,
            },
            {
              operation: 'repair_default_title' as const,
              owner: noProvider.id,
              keys: ['default_jingxiaoyu'],
              eligible: false,
              balance: null,
              revision: null,
              level: null,
            },
          ])
            await assert.rejects(
              inTransaction(f.pool, (tx) => write(tx, randomUUID(), change)),
              constraintError,
            );
        },
      );
    } finally {
      await f.close();
    }
  },
);
