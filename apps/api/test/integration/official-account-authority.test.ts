import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ApplicationError } from '../../src/http/application-error.js';
import { seedCommunityScope } from '../support/community-scope-fixtures.js';
import {
  officialAccountFixture,
  attachOfficialFixture,
} from '../support/official-account-fixture.js';
import { ratingTargetLinkFixture } from '../support/rating-target-link-fixture.js';
import { boundHotTransaction } from '../../src/community/hot-score/transaction.js';
test(
  'all-of purpose capability and real super role are separate from metadata recovery',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const p = await f.service.preview(f.world.author.accessToken, {
        programId: f.programId,
        kind: 'test',
        expectedConfigRevision: f.revision,
      });
      const intent = {
        requestId: randomUUID(),
        programId: f.programId,
        previewId: p.previewId,
        manifestHash: p.manifestHash,
        expectedConfigRevision: f.revision,
        acknowledgement: 'synthetic_draft_only',
      };
      const accepted = await f.service.createDraft(
        f.world.author.accessToken,
        intent,
      );
      await f.pool.query(
        'UPDATE whaleu_official.capabilities SET revoked_at=clock_timestamp() WHERE principal_ref=$1',
        [f.world.author.accountId],
      );
      const recovered = await f.service.status(
        f.world.author.accessToken,
        intent.requestId,
      );
      assert.equal(recovered.state, 'recorded');
      if (recovered.state === 'recorded')
        assert.deepEqual(recovered.receipt, accepted.receipt);
      const foreign = await f.service.status(
        f.world.reader.accessToken,
        intent.requestId,
      );
      assert.deepEqual(foreign, { state: 'not_recorded' });
      await assert.rejects(() =>
        f.service.preview(f.world.author.accessToken, {
          programId: f.programId,
          kind: 'test',
          expectedConfigRevision: f.revision,
        }),
      );
      await f.worker.runCycle();
      assert.equal(
        (await f.pool.query('SELECT id FROM whaleu_official.attempts')).rows
          .length,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'accepted program binds actual source-space topology, not just matching grant regions',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      await f.service.preview(f.world.author.accessToken, {
        programId: f.programId,
        kind: 'test',
        expectedConfigRevision: f.revision,
      });
      const other = await seedCommunityScope(f.pool),
        programId = randomUUID();
      await f.pool.query(
        'INSERT INTO whaleu_official.programs(id,account_ref,institution_id,school_space_id,region_ids,lineage_ref,revision) SELECT $1,account_ref,institution_id,$2,region_ids,$3,revision FROM whaleu_official.programs WHERE id=$4',
        [programId, other.home.spaceId, randomUUID(), f.programId],
      );
      await f.pool.query(
        "INSERT INTO whaleu_official.configs(program_id,revision,author) VALUES($1,$2,'Invalid source mapping')",
        [programId, f.revision],
      );
      await f.pool.query(
        "INSERT INTO whaleu_official.capabilities(id,account_ref,program_id,principal_kind,principal_ref,action,revision,region_ids,valid_from,expires_at) SELECT $1,account_ref,$2,principal_kind,principal_ref,action,revision,region_ids,valid_from,expires_at FROM whaleu_official.capabilities WHERE program_id=$3 AND principal_ref=$4 AND action='test'",
        [randomUUID(), programId, f.programId, f.world.author.accountId],
      );
      await assert.rejects(
        () =>
          f.service.preview(f.world.author.accessToken, {
            programId,
            kind: 'test',
            expectedConfigRevision: f.revision,
          }),
        (error) =>
          error instanceof ApplicationError &&
          error.code === 'OFFICIAL_ACCOUNT_UNAVAILABLE',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT id FROM whaleu_official.commands WHERE program_id=$1',
            [programId],
          )
        ).rowCount,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'one fixed school-admin region cannot configure a multi-region institution and developer is not super',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const actor = f.world.author.accountId;
      await f.pool.query(
        "UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$1 WHERE account_id=$1 AND role='super_admin' AND revoked_at IS NULL",
        [actor],
      );
      await f.pool.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'Bounded synthetic school role')",
        [randomUUID(), actor, f.world.scope.home.regionId],
      );
      await assert.rejects(
        () => f.service.config(f.world.author.accessToken, f.programId),
        (error) =>
          error instanceof ApplicationError &&
          error.code === 'OFFICIAL_AUTHORITY_REQUIRED',
      );
      await f.pool.query(
        "UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$1 WHERE account_id=$1 AND role='school_admin' AND revoked_at IS NULL",
        [actor],
      );
      await f.pool.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'developer',NULL,$2,'Synthetic developer is not content super')",
        [randomUUID(), actor],
      );
      await assert.rejects(
        () =>
          f.service.preview(f.world.author.accessToken, {
            programId: f.programId,
            kind: 'test',
            expectedConfigRevision: f.revision,
          }),
        (error) =>
          error instanceof ApplicationError &&
          error.code === 'OFFICIAL_AUTHORITY_REQUIRED',
      );
      assert.equal(
        (await f.pool.query('SELECT id FROM whaleu_official.commands'))
          .rowCount,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'real approved v5 rating card remains outside anonymous official export even with explicit eligibility',
  { timeout: 180000 },
  async () => {
    const native = await ratingTargetLinkFixture();
    let f: Awaited<ReturnType<typeof attachOfficialFixture>> | undefined;
    try {
      const category = await native.createLinkCategory('course');
      const target = await native.createLinkTarget(category);
      const body = await native.card(target.id);
      const published = await native.publishCard(body);
      f = await attachOfficialFixture(native, {
        scope: native.scope,
        author: native.creator,
      });
      await f.eligibility(published.resourceId);
      const installed = f;
      const fact = await f.database.transaction(
        async (tx) => {
          await boundHotTransaction(tx);
          return installed.source.inspect(published.resourceId, false, tx);
        },
        { isolationLevel: 'read committed' },
      );
      assert.equal(fact?.decision, 'deny');
      const preview = await f.service.preview(
        native.creator.accessToken,
        { programId: f.programId, expectedConfigRevision: f.revision },
        true,
      );
      assert.equal(preview.eligibleCount, 0);
      assert.equal(preview.sourceState, 'known_empty');
      assert.equal(
        (await f.pool.query('SELECT id FROM whaleu_official.effects')).rowCount,
        0,
      );
    } finally {
      if (f) await f.close();
      else await native.close();
    }
  },
);
