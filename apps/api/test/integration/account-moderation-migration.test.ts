import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';

test(
  'latest account moderation migrations preserve source inventories and start the ordinary application',
  { timeout: 180000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    t.after(() => f.close());
    const row = (
      await f.pool.query(`SELECT
    whaleu_community.admin_post_removal_inventory_current() posts,
    whaleu_community.admin_discussion_removal_inventory_current() discussions,
    whaleu_safety.account_punishment_authority_epoch() authority,
    (SELECT count(*)::integer FROM whaleu_safety.account_moderation_epochs) epochs`)
    ).rows[0]!;
    assert.equal(row.posts, true);
    assert.equal(row.discussions, true);
    assert.match(row.authority, /^\d+$/);
    assert.equal(row.epochs, 128);
    const actor = await f.actor();
    const result = await request(f.app.getHttpServer())
      .get('/v1/me/safety/status')
      .set('Authorization', `Bearer ${actor.accessToken}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.effective, 'clear');
    assert.deepEqual(result.body.current, []);
  },
);
