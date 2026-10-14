import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { schoolUidFixture } from '../support/school-uid-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { DatabaseService, inTransaction } from '../../src/database/database.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { requirePublication } from '../../src/community/community-policy.js';
import { contentScopeSchema } from '../../src/community/content-review/contracts.js';
import { PHONE_CONSENT } from '../../src/verification/phone-binding.service.js';
import { revokeAssertion } from '../../src/verification/revocation.js';

/** administrator_correction is obtained through actual student evidence,
 * reviewed correction + school UID allocation + explicit identity selection. */
test(
  'card and title destination SQL accepts the current administrator-corrected identity and closes exact revocation',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      profile = await f.profile(owner),
      http = f.app.getHttpServer(),
      auth = `Bearer ${owner.accessToken}`;
    await f.approve(f.admin, await f.submit(owner));
    const phoneId = randomUUID();
    assert.equal(
      (
        await request(http)
          .post('/v1/me/phone-binding/requests')
          .set('Authorization', auth)
          .send({
            requestId: phoneId,
            consent: PHONE_CONSENT,
            replacesRequestId: null,
          })
      ).status,
      200,
    );
    const phone = await request(http)
      .post(`/v1/me/phone-binding/requests/${phoneId}/authorize`)
      .set('Authorization', auth)
      .send({
        code: 'synthetic-card-phone-' + randomUUID(),
        consent: PHONE_CONSENT,
      });
    assert.equal(phone.status, 200, JSON.stringify(phone.body));
    assert.equal(phone.body.state, 'verified');
    const corrected = await f.correct(f.admin, profile, f.destination.campusId);
    assert.equal(corrected.receipt.outcome, 'applied');
    assert.equal(
      (
        await f.pool.query(
          'SELECT a.method FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.affiliation_assertion_id WHERE h.account_id=$1',
          [owner.accountId],
        )
      ).rows[0].method,
      'administrator_correction',
    );
    const identity = await request(http)
      .get('/v1/me/identity-campus')
      .set('Authorization', auth);
    assert.equal(identity.status, 200);
    const selected = await request(http)
      .put('/v1/me/identity-campus')
      .set('Authorization', auth)
      .send({
        requestId: randomUUID(),
        campusId: f.destination.campusId,
        expectedStateRevision: identity.body.expectedStateRevision,
      });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    const spaceId = randomUUID();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "INSERT INTO whaleu_community.spaces(id,kind,operating_region_id,name,is_active) VALUES($1,'regional',$2,'Synthetic corrected destination',true)",
        [spaceId, f.destination.regionId],
      ),
    );
    const scope = await f.app.get(DatabaseService).transaction(async (tx) => {
      const space = await f.app.get(CommunityRepository).space(spaceId, tx),
        authority = await f.app
          .get(CommunityAccessService)
          .authority(owner.accountId, space, tx, { publication: true });
      for (const mode of ['named', 'anonymous'] as const)
        requirePublication(
          authority,
          space,
          'discussion',
          mode,
          'publish_post',
        );
      assert.ok(authority.publicationScope);
      return contentScopeSchema.parse(authority.publicationScope);
    });
    for (const mode of ['named', 'anonymous'])
      assert.equal(
        (
          await f.pool.query(
            'SELECT whaleu_community.rating_target_link_destination_current($1,$2::jsonb,$3) current',
            [owner.accountId, JSON.stringify(scope), mode],
          )
        ).rows[0].current,
        true,
        mode,
      );
    assert.equal(
      (
        await f.pool.query(
          'SELECT whaleu_community.rating_target_link_destination_current($1,$2::jsonb,NULL) current',
          [owner.accountId, JSON.stringify(scope)],
        )
      ).rows[0].current,
      false,
    );
    const revision = (
      await f.pool.query(
        'SELECT revision FROM whaleu_verification.account_heads WHERE account_id=$1',
        [owner.accountId],
      )
    ).rows[0].revision;
    await inTransaction(f.pool, (tx) =>
      revokeAssertion(tx, {
        accountId: owner.accountId,
        actorAccountId: f.admin.accountId,
        operationId: randomUUID(),
        fact: 'affiliation',
        expectedRevision: revision,
        reasonCode: 'synthetic_card_correction_revoked',
      }),
    );
    for (const mode of ['named', 'anonymous'])
      assert.equal(
        (
          await f.pool.query(
            'SELECT whaleu_community.rating_target_link_destination_current($1,$2::jsonb,$3) current',
            [owner.accountId, JSON.stringify(scope), mode],
          )
        ).rows[0].current,
        false,
      );
  },
);
