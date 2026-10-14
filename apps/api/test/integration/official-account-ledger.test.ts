import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { officialAccountFixture } from '../support/official-account-fixture.js';
import { OfficialDailyEnrollment } from '../../src/official-account-operations/schedule.js';
test(
  'config CAS is config_applied; test replay/cancel uses original intent and cannot publish',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const config = {
        requestId: randomUUID(),
        programId: f.programId,
        expectedRevision: f.revision,
        author: '新的合成作者',
        cover: { action: 'keep' },
        title: { action: 'keep' },
      };
      const saved = await f.service.save(f.world.author.accessToken, config);
      assert.equal(saved.status.state, 'config_applied');
      assert.equal(saved.status.draftRef, null);
      assert.equal(saved.receipt.outcome, 'config_applied');
      assert.deepEqual(
        (await f.service.save(f.world.author.accessToken, config)).receipt,
        saved.receipt,
      );
      await assert.rejects(() =>
        f.service.save(f.world.author.accessToken, {
          ...config,
          author: 'changed',
        }),
      );
      const preview = await f.service.preview(f.world.author.accessToken, {
        programId: f.programId,
        kind: 'test',
        expectedConfigRevision: saved.receipt.configRevision,
      });
      const intent = {
        requestId: randomUUID(),
        programId: f.programId,
        previewId: preview.previewId,
        manifestHash: preview.manifestHash,
        expectedConfigRevision: saved.receipt.configRevision,
        acknowledgement: 'synthetic_draft_only',
      };
      const [a, b] = await Promise.all([
        f.service.createDraft(f.world.author.accessToken, intent),
        f.service.createDraft(f.world.author.accessToken, intent),
      ]);
      assert.deepEqual(a.receipt, b.receipt);
      await f.worker.runCycle();
      const status = await f.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      assert.equal(status.state, 'recorded');
      if (status.state !== 'recorded') throw Error('No receipt');
      assert.equal(status.status.state, 'draft_confirmed');
      await assert.rejects(() =>
        f.service.publishPreview(f.world.author.accessToken, {
          draftRef: status.status.draftRef,
        }),
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT id FROM whaleu_official.effects WHERE stage='publish_submit'",
          )
        ).rows.length,
        0,
      );
      const cancelled = { ...intent, requestId: randomUUID() };
      await f.service.cancel(f.world.author.accessToken, cancelled.requestId, {
        intent: cancelled,
      });
      await assert.rejects(() =>
        f.service.createDraft(f.world.author.accessToken, cancelled),
      );
      const missing = {
        ...intent,
        requestId: randomUUID(),
        previewId: randomUUID(),
      };
      await f.service.cancel(f.world.author.accessToken, missing.requestId, {
        intent: missing,
      });
      const tombstone = await f.service.status(
        f.world.author.accessToken,
        missing.requestId,
      );
      assert.equal(tombstone.state, 'cancelled_before_admission');
      assert.deepEqual(
        await f.service.cancel(f.world.author.accessToken, missing.requestId, {
          intent: missing,
        }),
        tombstone,
      );
      await assert.rejects(() =>
        f.service.cancel(f.world.author.accessToken, missing.requestId, {
          intent: { ...missing, manifestHash: 'b'.repeat(64) },
        }),
      );
      await assert.rejects(() =>
        f.service.createDraft(f.world.author.accessToken, missing, true),
      );
    } finally {
      await f.close();
    }
  },
);
test(
  'known-empty daily slot is stable across concurrent enrollment and config revisions',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      await f.ready();
      const due = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
      const enrollment = new OfficialDailyEnrollment(
        f.service,
        () => new Date(due).getTime() + 1000,
      );
      const [a, b] = await Promise.all([
        enrollment.admitDueSlot(f.programId, due),
        enrollment.admitDueSlot(f.programId, due),
      ]);
      assert.equal(a.slotId, b.slotId);
      assert.equal(a.state, 'no_eligible_content');
      assert.equal(
        (await f.pool.query('SELECT id FROM whaleu_official.slots')).rows
          .length,
        1,
      );
      assert.equal(
        (await f.pool.query('SELECT id FROM whaleu_official.effects')).rows
          .length,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'nonempty daily slot has one draft-only command and cannot switch its frozen service principal',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      await f.publish('One exact daily draft source');
      await f.ready();
      const due = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
      const enroll = new OfficialDailyEnrollment(
        f.service,
        () => Date.parse(due) + 1000,
      );
      const [a, b] = await Promise.all([
        enroll.admitDueSlot(f.programId, due),
        enroll.admitDueSlot(f.programId, due),
      ]);
      assert.equal(a.state, 'admitted');
      assert.ok('commandRef' in a);
      assert.ok('commandRef' in b);
      assert.equal(a.commandRef, b.commandRef);
      assert.ok(a.commandRef);
      const command = (
        await f.pool.query(
          'SELECT service_principal_ref,service_authority_digest,actor_ref FROM whaleu_official.commands WHERE id=$1',
          [a.commandRef],
        )
      ).rows[0];
      assert.equal(command.service_principal_ref, f.servicePrincipal);
      assert.equal(command.actor_ref, null);
      assert.match(command.service_authority_digest, /^[a-f0-9]{64}$/);
      await f.worker.runCycle();
      const first = (
        await f.pool.query(
          'SELECT state,draft_ref FROM whaleu_official.command_states WHERE command_id=$1',
          [a.commandRef],
        )
      ).rows[0];
      assert.equal(first.state, 'draft_confirmed');
      await assert.rejects(() =>
        f.service.publishPreview(f.world.author.accessToken, {
          draftRef: first.draft_ref,
        }),
      );
      const nextDue = new Date(Date.parse(due) + 86400000).toISOString();
      const next = await new OfficialDailyEnrollment(
        f.service,
        () => Date.parse(nextDue) + 1000,
      ).admitDueSlot(f.programId, nextDue);
      assert.equal(next.state, 'admitted');
      assert.ok('commandRef' in next);
      await f.pool.query(
        "UPDATE whaleu_official.capabilities SET revoked_at=clock_timestamp() WHERE principal_ref=$1 AND principal_kind='service'",
        [f.servicePrincipal],
      );
      await f.pool.query(
        "INSERT INTO whaleu_official.capabilities(id,account_ref,program_id,principal_kind,principal_ref,action,revision,region_ids,valid_from,expires_at) SELECT $1,account_ref,program_id,principal_kind,$2,action,revision,region_ids,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour' FROM whaleu_official.capabilities WHERE principal_ref=$3 AND action='daily_draft'",
        [randomUUID(), randomUUID(), f.servicePrincipal],
      );
      await f.worker.runCycle();
      assert.equal(
        (
          await f.pool.query(
            'SELECT a.id FROM whaleu_official.attempts a JOIN whaleu_official.effects e ON e.id=a.effect_id WHERE e.command_id=$1',
            [next.commandRef],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT id FROM whaleu_official.effects WHERE stage='publish_submit'",
          )
        ).rowCount,
        0,
      );
    } finally {
      await f.close();
    }
  },
);
