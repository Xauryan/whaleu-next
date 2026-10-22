import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { ratingIso } from '../../src/ratings/repository.js';
import { ratingAdminDeletionIntentHash } from '../../src/ratings/deletion/requests.js';
import { ratingDeletionFixture } from '../support/rating-deletion-fixture.js';
import {
  rollbackOnly,
  sqlError,
  sqlRejected,
  staleEpoch,
} from '../support/epoch-authority-fixture.js';

// First establish a real applied deletion through the native service. The raw
// matrix then exercises its valid exact noop/retained-transition path without
// inventing an unrelated target, author, grant, audit or terminal receipt.
test(
  '0180 administrator deletion audit rejects epoch-only stale actor with exact retained deletion evidence',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingDeletionFixture();
    t.after(() => f.close());
    const author = await f.actor(),
      admin = await f.actor();
    await f.grant(admin, 'super_admin');
    const catalog = await f.catalog(author, { count: 1 });
    const target = catalog.targets[0]!;
    const root = await f.publish(author, catalog, target);
    const originalCommand = f.command(
      await f.context(admin, 'comment', root.id),
    );
    const applied = await f.remove(admin, 'comment', root.id, originalCommand);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.outcome, 'applied');
    const original = (
      await f.pool.query<{ id: string; after_revision: string }>(
        'SELECT id,after_revision FROM whaleu_ratings.admin_delete_audits WHERE actor_account_id=$1 AND request_id=$2',
        [admin.accountId, originalCommand.clientRequestId],
      )
    ).rows[0]!;
    assert.ok(original);
    const before = (
      await f.pool.query(
        'SELECT to_jsonb(c) subject,to_jsonb(a) audit FROM whaleu_ratings.comments c JOIN whaleu_ratings.admin_delete_audits a ON a.id=c.admin_delete_audit_id WHERE c.id=$1',
        [root.id],
      )
    ).rows;
    const command = f.command(await f.context(admin, 'comment', root.id));
    const hash = ratingAdminDeletionIntentHash('admin_delete_comment', {
      subjectId: root.id,
      ...command,
    });
    const audit = randomUUID();
    const write = async (tx: PoolClient) => {
      await tx.query('SET CONSTRAINTS ALL DEFERRED');
      await tx.query(
        "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'admin_delete_comment',$3)",
        [admin.accountId, command.clientRequestId, hash],
      );
      const row = (
        await tx.query<{ occurred_at: string }>(
          `INSERT INTO whaleu_ratings.admin_delete_audits
      (id,actor_account_id,session_id,request_id,intent_hash,subject_kind,target_id,root_id,subject_id,author_account_id,
       target_revision,root_revision,before_revision,after_revision,scope_kind,grant_id,grant_fingerprint,
       origin_source_id,origin_revision,origin_state,origin_fingerprint,origin_campus_id,operating_region_id,
       topology_snapshot_id,topology_revision,context_revision,outcome,occurred_at,effective_comment_transition_id,effective_reply_transition_id)
      SELECT $1,a.actor_account_id,a.session_id,$2,$3,a.subject_kind,a.target_id,a.root_id,a.subject_id,a.author_account_id,
       a.target_revision,a.after_revision,a.after_revision,a.after_revision,a.scope_kind,a.grant_id,a.grant_fingerprint,
       a.origin_source_id,a.origin_revision,a.origin_state,a.origin_fingerprint,a.origin_campus_id,a.operating_region_id,
       a.topology_snapshot_id,a.topology_revision,$4,'noop',a.occurred_at,
       (SELECT id FROM whaleu_ratings.comment_transitions WHERE admin_delete_audit_id=a.id),NULL
      FROM whaleu_ratings.admin_delete_audits a WHERE a.id=$5 RETURNING ${ratingIso('occurred_at')} occurred_at`,
          [
            audit,
            command.clientRequestId,
            hash,
            command.expectedContextRevision,
            original.id,
          ],
        )
      ).rows[0]!;
      assert.ok(row);
      const receipt = {
        requestId: command.clientRequestId,
        operation: 'admin_delete_comment',
        outcome: 'noop',
        targetId: target.id,
        rootId: root.id,
        subjectId: root.id,
        revision: original.after_revision,
        occurredAt: row.occurred_at,
      };
      await tx.query(
        'UPDATE whaleu_ratings.requests SET receipt=$3 WHERE account_id=$1 AND request_id=$2',
        [admin.accountId, command.clientRequestId, receipt],
      );
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      assert.equal(
        (
          await tx.query(
            "SELECT 1 FROM whaleu_ratings.admin_delete_audits WHERE id=$1 AND outcome='noop'",
            [audit],
          )
        ).rowCount,
        1,
      );
    };
    await rollbackOnly(f.pool, async (tx) => {
      await tx.query('SAVEPOINT valid_deletion_noop');
      await write(tx);
      await tx.query('ROLLBACK TO SAVEPOINT valid_deletion_noop');
      await tx.query('RELEASE SAVEPOINT valid_deletion_noop');
      await staleEpoch(tx, admin.accountId);
      await sqlRejected(
        tx,
        () => write(tx),
        sqlError('Invalid administrator deletion actor, request or subject'),
      );
      assert.equal(
        (
          await tx.query(
            'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
            [admin.accountId, command.clientRequestId],
          )
        ).rowCount,
        0,
      );
    });
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT to_jsonb(c) subject,to_jsonb(a) audit FROM whaleu_ratings.comments c JOIN whaleu_ratings.admin_delete_audits a ON a.id=c.admin_delete_audit_id WHERE c.id=$1',
          [root.id],
        )
      ).rows,
      before,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.admin_delete_audits WHERE id=$1',
          [audit],
        )
      ).rowCount,
      0,
    );
  },
);
