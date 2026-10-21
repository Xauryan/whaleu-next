import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { DatabaseService } from '../../src/database/database.js';
import { hashToken } from '../../src/identity/tokens.js';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';

test(
  'historical Identity uses the exact predecessor under a live account ALTER fence and rejects partial upgrade',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture(65);
    t.after(() => f.close());
    const actor = await f.actor(),
      identity = f.app.get(IdentityRepository),
      database = f.app.get(DatabaseService);
    const ddl = await f.pool.connect();
    try {
      await database.transaction(async (tx) => {
        assert.equal(await identity.activeAccount(actor.accountId, tx), true);
        await ddl.query('BEGIN');
        try {
          await assert.rejects(
            ddl.query(
              'LOCK TABLE whaleu_identity.accounts IN ACCESS EXCLUSIVE MODE NOWAIT',
            ),
            { code: '55P03' },
          );
        } finally {
          await ddl.query('ROLLBACK');
        }
        assert.equal(
          (await identity.authenticate(hashToken(actor.accessToken), tx))
            .accountId,
          actor.accountId,
        );
      });
    } finally {
      ddl.release();
    }
    // The prior transaction released its fence; an additive partial upgrade must
    // now deny all legacy access even without any corresponding migration row.
    await f.pool.query(
      "ALTER TABLE whaleu_identity.accounts ADD COLUMN lifecycle text NOT NULL DEFAULT 'active'",
    );
    await assert.rejects(
      identity.authenticate(hashToken(actor.accessToken)),
      /Partial deletion schema/,
    );
    await assert.rejects(
      database.transaction((tx) => identity.activeAccount(actor.accountId, tx)),
      /Partial deletion schema/,
    );
    await f.pool.query(
      'ALTER TABLE whaleu_identity.accounts DROP COLUMN lifecycle',
    );
    await f.pool.query('CREATE SCHEMA whaleu_account_deletion');
    try {
      await assert.rejects(
        identity.authenticate(hashToken(actor.accessToken)),
        /Partial deletion schema/,
      );
    } finally {
      await f.pool.query('DROP SCHEMA whaleu_account_deletion');
    }
    assert.equal(
      (await identity.authenticate(hashToken(actor.accessToken))).accountId,
      actor.accountId,
    );
    // Migration checksums are inspected every time, not accepted once by DI.
    await f.pool.query(
      "UPDATE whaleu_meta.schema_migrations SET checksum=repeat('0',64) WHERE name=(SELECT name FROM whaleu_meta.schema_migrations ORDER BY name LIMIT 1)",
    );
    await assert.rejects(
      identity.revoke(hashToken(actor.accessToken)),
      /cannot cross an upgrade/,
    );
  },
);
