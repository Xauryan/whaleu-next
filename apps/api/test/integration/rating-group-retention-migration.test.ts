import { RatingGroupRepository } from '../../src/notifications/rating-group/repository.js';
import request from 'supertest';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createPromotionFixture,
  admitPromotion,
} from './support/rating-group-promotion.js';
import { commandHash } from '../../src/ratings/group-promotion/contracts.js';
import { RatingPromotionRetention } from '../../src/ratings/group-promotion/retention.js';
import { DurableSyntheticRatingGroupPort } from '../../src/notifications/rating-group/synthetic.js';
import { RatingGroupPromotionService } from '../../src/ratings/group-promotion/service.js';
test(
  'additive owner migrations seed no live enrollment and bounded retention drops expired bytes without new effects',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture();
    t.after(() => f.close());
    const current = await admitPromotion(f);
    await f.worker.maintain();
    // Deliberately historical immutable fixture issuance; only retention is exercised
    // on this record. This is not evidence of a past or real external dispatch.
    const id = randomUUID(),
      request = randomUUID(),
      preview = randomUUID();
    await f.db.transaction(
      async (tx) => {
        const prior = (
          await tx.query(
            'SELECT * FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
            [current.status.campaignId],
          )
        ).rows[0];
        const command = {
            ...prior.command,
            requestId: request,
            previewId: preview,
          },
          hash = commandHash(command);
        await tx.query(
          `INSERT INTO whaleu_ratings.promotion_previews(id,program_id,actor,command,source_hash,audience_epoch,grant_revision,grant_epoch,expires_at,originating_session_id) SELECT $1,program_id,actor,command,source_hash,audience_epoch,grant_revision,grant_epoch,clock_timestamp()-interval '2 days',originating_session_id FROM whaleu_ratings.promotion_previews WHERE id=$2`,
          [preview, prior.command.previewId],
        );
        await tx.query(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp()-interval '2 days' issued_clock) INSERT INTO whaleu_ratings.promotion_intents(request_id,program_id,actor,preview_id,command,request_hash,ticket,issued_at,expires_at) SELECT $1,$2,$3,$4,$5,$6,'synthetic:expired-intent',issued_clock,issued_clock+interval '15 minutes' FROM instant`,
          [request, f.programId, f.actorId, preview, command, hash],
        );
        await tx.query(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp()-interval '2 days' issued_clock) INSERT INTO whaleu_ratings.promotion_campaigns(id,request_id,program_id,actor,request_hash,command,program_revision,source_hash,audience_epoch,grant_revision,grant_epoch,created_at,expires_at,compose_by,mode,recipient_count,payload,payload_hash,qualification_hash,copy_provenance,originating_session_id,snapshot_sealed)
    SELECT $1,$2,program_id,actor,$3,$4,program_revision,source_hash,audience_epoch,grant_revision,grant_epoch,issued_clock,issued_clock+interval '30 minutes',issued_clock+interval '2 minutes','normal',0,payload,payload_hash,qualification_hash,copy_provenance,originating_session_id,true FROM whaleu_ratings.promotion_campaigns CROSS JOIN instant WHERE id=$5`,
          [id, request, hash, command, current.status.campaignId],
        );
      },
      { isolationLevel: 'read committed' },
    );
    const result = await f.app.get(RatingPromotionRetention).maintain();
    assert.equal(result.purged, 1);
    const row = (
      await f.pool.query(
        'SELECT payload,payload_hash,payload_purged_at FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
        [id],
      )
    ).rows[0];
    assert.equal(row.payload, null);
    assert.ok(row.payload_hash);
    assert.ok(row.payload_purged_at);
    assert.equal(await f.sender.receiptCount(), 0);
    const sql = readFileSync(
      new URL(
        '../../migrations/0156_rating_group_promotion.sql',
        import.meta.url,
      ),
      'utf8',
    );
    assert.doesNotMatch(sql, /INSERT INTO whaleu_ratings.promotion_programs/i);
  },
);
test(
  'one-sided synthetic store reset is refused while exact domain reload is accepted',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture();
    t.after(() => f.close());
    const app = f.app.get(RatingGroupPromotionService);
    await app.run((tx) => app.verifyRuntime(tx));
    const restored = new DurableSyntheticRatingGroupPort(
      f.sender.path,
      f.runtime.domainId,
      f.runtime.ticketSecret,
    );
    assert.deepEqual(
      await restored.storageIdentity(),
      await f.sender.storageIdentity(),
    );
    const fresh = new DurableSyntheticRatingGroupPort(
      f.directory + '/replacement.json',
      f.runtime.domainId,
      f.runtime.ticketSecret,
      true,
    );
    const original = f.runtime.sender;
    Object.defineProperty(f.runtime, 'sender', {
      value: fresh,
      configurable: true,
    });
    await assert.rejects(
      () => app.run((tx) => app.verifyRuntime(tx)),
      /unavailable/i,
    );
    Object.defineProperty(f.runtime, 'sender', {
      value: original,
      configurable: true,
    });
    await app.run((tx) => app.verifyRuntime(tx));
    // An isolated fixture ledger reset generates a new incarnation even when
    // someone reuses the same domain label and provider store identifiers.
    const binding = (
      await f.pool.query(
        'SELECT * FROM whaleu_notifications.rating_group_restore_binding',
      )
    ).rows[0];
    await f.pool.query(
      'TRUNCATE whaleu_notifications.rating_group_restore_binding',
    );
    await f.pool.query(
      'INSERT INTO whaleu_notifications.rating_group_restore_binding(domain_id,sender_store_id,generation_store_id,shortlink_store_id) VALUES($1,$2,$3,$4)',
      [
        binding.domain_id,
        binding.sender_store_id,
        binding.generation_store_id,
        binding.shortlink_store_id,
      ],
    );
    await assert.rejects(
      () => app.run((tx) => app.verifyRuntime(tx)),
      /unavailable/i,
    );
    await assert.rejects(
      () => f.sender.bindLedger(randomUUID(), randomUUID()),
      /already bound/i,
    );
  },
);

test(
  'expired unrecorded signed intent cannot admit before or after bounded metadata purge',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture();
    t.after(() => f.close());
    const live = await admitPromotion(f);
    const prior = (
      await f.pool.query(
        'SELECT command FROM whaleu_ratings.promotion_intents WHERE request_id=$1',
        [live.body.requestId],
      )
    ).rows[0].command;
    const requestId = randomUUID(),
      previewId = randomUUID(),
      issued = new Date(Date.now() - 181 * 86400000),
      expires = new Date(issued.getTime() + 900000),
      command = { ...prior, requestId, previewId },
      hash = commandHash(command);
    const ticket = createHmac('sha256', f.runtime.ticketSecret)
      .update(
        JSON.stringify([
          'rating-intent-v1',
          f.programId,
          f.actorId,
          requestId,
          hash,
          expires.toISOString(),
        ]),
      )
      .digest('base64url');
    await f.db.transaction(
      async (tx) => {
        await tx.query(
          'INSERT INTO whaleu_ratings.promotion_previews(id,program_id,actor,command,source_hash,audience_epoch,grant_revision,grant_epoch,expires_at,originating_session_id) SELECT $1,program_id,actor,command,source_hash,audience_epoch,grant_revision,grant_epoch,$3,originating_session_id FROM whaleu_ratings.promotion_previews WHERE id=$2',
          [previewId, prior.previewId, expires],
        );
        await tx.query(
          'INSERT INTO whaleu_ratings.promotion_intents(request_id,program_id,actor,preview_id,command,request_hash,ticket,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            requestId,
            f.programId,
            f.actorId,
            previewId,
            command,
            hash,
            ticket,
            issued,
            expires,
          ],
        );
      },
      { isolationLevel: 'read committed' },
    );
    const send = () =>
      request(f.app.getHttpServer())
        .post(`/v1/rating-group-promotion/programs/${f.programId}/campaigns`)
        .set('Authorization', `Bearer ${f.token}`)
        .send({ requestId, intentTicket: ticket, requestHash: hash });
    assert.equal((await send()).status, 410);
    await f.app.get(RatingPromotionRetention).maintain();
    assert.equal((await send()).status, 404);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.promotion_campaigns WHERE request_id=$1',
          [requestId],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(await f.sender.receiptCount(), 0);
  },
);

test(
  'bounded 180-day unknown retirement preserves a physical receiver exclusion tombstone',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture({
      receivers: 1,
      auxiliaryReceivers: false,
    });
    t.after(() => f.close());
    const live = await admitPromotion(f);
    await f.worker.maintain();
    const app = f.app.get(RatingGroupPromotionService),
      repo = f.app.get(RatingGroupRepository),
      id = randomUUID(),
      requestId = randomUUID(),
      preview = randomUUID();
    // Explicit immutable historical storage fixture. It asserts retention causality,
    // not that a message was actually emitted 181 days ago.
    await app.run(async (tx) => {
      const prior = (
        await tx.query(
          'SELECT * FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
          [live.status.campaignId],
        )
      ).rows[0];
      const command = { ...prior.command, requestId, previewId: preview },
        hash = commandHash(command);
      await tx.query(
        "INSERT INTO whaleu_ratings.promotion_previews(id,program_id,actor,command,source_hash,audience_epoch,grant_revision,grant_epoch,expires_at,originating_session_id) SELECT $1,program_id,actor,command,source_hash,audience_epoch,grant_revision,grant_epoch,clock_timestamp()-interval '181 days',originating_session_id FROM whaleu_ratings.promotion_previews WHERE id=$2",
        [preview, prior.command.previewId],
      );
      await tx.query(
        "WITH instant AS MATERIALIZED(SELECT clock_timestamp()-interval '181 days' issued_clock) INSERT INTO whaleu_ratings.promotion_intents(request_id,program_id,actor,preview_id,command,request_hash,ticket,issued_at,expires_at) SELECT $1,$2,$3,$4,$5,$6,'synthetic:historic',issued_clock,issued_clock+interval '15 minutes' FROM instant",
        [requestId, f.programId, f.actorId, preview, command, hash],
      );
      await tx.query(
        "WITH instant AS MATERIALIZED(SELECT clock_timestamp()-interval '181 days' issued_clock) INSERT INTO whaleu_ratings.promotion_campaigns(id,request_id,program_id,actor,request_hash,command,program_revision,source_hash,audience_epoch,grant_revision,grant_epoch,created_at,expires_at,compose_by,mode,recipient_count,payload,payload_hash,qualification_hash,copy_provenance,originating_session_id) SELECT $1,$2,program_id,actor,$3,$4,program_revision,source_hash,audience_epoch,grant_revision,grant_epoch,issued_clock,issued_clock+interval '30 minutes',issued_clock+interval '2 minutes','normal',1,payload,payload_hash,qualification_hash,copy_provenance,originating_session_id FROM whaleu_ratings.promotion_campaigns CROSS JOIN instant WHERE id=$5",
        [id, requestId, hash, command, prior.id],
      );
      await tx.query(
        'INSERT INTO whaleu_ratings.promotion_campaign_recipients SELECT $1,stable_destination_id,enrollment_revision,registry_revision,audience_kind,school_scope_id FROM whaleu_ratings.promotion_campaign_recipients WHERE campaign_id=$2',
        [id, prior.id],
      );
      await tx.query(
        'UPDATE whaleu_ratings.promotion_campaigns SET snapshot_sealed=true WHERE id=$1',
        [id],
      );
      const c = (
        await tx.query(
          'SELECT * FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
          [id],
        )
      ).rows[0];
      await repo.add(
        c,
        await app.program(f.programId, tx),
        'delivery',
        c.payload_hash,
        f.destinationIds[0]!,
        tx,
      );
      await tx.query(
        "UPDATE whaleu_notifications.rating_group_effects SET next_action_at=CASE WHEN campaign_id=$1 THEN clock_timestamp()-interval '1 hour' ELSE clock_timestamp()+interval '1 hour' END",
        [id],
      );
    });
    const claim = await app.run((tx) => repo.claim('delivery', tx));
    assert.ok(claim);
    assert.equal(claim.effect.campaign_id, id);
    await app.run(async (tx) => {
      const c = (
        await tx.query(
          'SELECT * FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
          [id],
        )
      ).rows[0];
      await repo.markPossible(claim, c, 'a'.repeat(64), tx);
    });
    await f.app.get(RatingPromotionRetention).maintain();
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
          [id],
        )
      ).rows[0].n,
      0,
    );
    const tombstone = (
      await f.pool.query(
        'SELECT * FROM whaleu_notifications.rating_group_retired_gates WHERE stable_destination_id=$1',
        [f.destinationIds[0]],
      )
    ).rows[0];
    assert.equal(tombstone.original_key, claim.identity.key);
    assert.equal(tombstone.original_attempt_id, claim.identity.attemptId);
    assert.equal(
      (
        await f.pool.query(
          'SELECT retired FROM whaleu_ratings.promotion_receiver_lineages WHERE id=$1',
          [f.destinationIds[0]],
        )
      ).rows[0].retired,
      true,
    );
    await assert.rejects(() => f.enroll(0, 1), /unavailable/i);
    assert.equal(await f.sender.receiptCount(), 0);
  },
);
