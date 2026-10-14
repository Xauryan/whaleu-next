import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import { schoolUidFixture } from '../support/school-uid-fixture.js';
import type { SchoolIdentityCommand } from '../../src/school-identity/contracts.js';

test(
  'UID history forbids orphan writes, counter advancement, no-row mutation and command missing-effect graphs',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      profile = await f.profile(owner);
    await f.approve(f.admin, await f.submit(owner));
    const before = await f.own(owner);
    for (const sql of [
      'UPDATE whaleu_school_uid.admission_heads SET high_water=high_water+1',
      'UPDATE whaleu_school_uid.admission_heads SET high_water=0',
      'UPDATE whaleu_school_uid.account_heads SET revision=revision WHERE false',
      'DELETE FROM whaleu_school_uid.allocations WHERE false',
      'TRUNCATE whaleu_school_uid.assignment_events',
    ])
      await assert.rejects(() => f.pool.query(sql));
    await assert.rejects(() =>
      f.pool.query(
        'INSERT INTO whaleu_school_uid.allocations(id,account_id,institution_id,uid,admission_id,cause_id) VALUES($1,$2,$3,99,$4,$5)',
        [
          randomUUID(),
          owner.accountId,
          f.home.institutionId,
          randomUUID(),
          randomUUID(),
        ],
      ),
    );
    assert.deepEqual(await f.own(owner), before);
    for (const skip of [
      'INSERT INTO whaleu_school_uid.allocations',
      'INSERT INTO whaleu_school_uid.assignment_events',
      'UPDATE whaleu_verification.account_heads',
    ]) {
      const view = await f.management(f.admin, profile, f.destination.campusId);
      assert.ok(view.destination);
      const command: SchoolIdentityCommand = {
        version: 1,
        action: 'correct_school',
        clientRequestId: randomUUID(),
        targetProfileId: profile,
        expectedStateVersion: view.stateVersion,
        destinationCampusId: f.destination.campusId,
        expectedDestinationVersion: view.destination.destinationVersion,
      };
      const database = f.app.get(DatabaseService),
        original = database.transaction,
        run = original.bind(database);
      let hit = false;
      database.transaction = (work, options) =>
        run(async (tx) => {
          const raw = tx.query,
            query = raw.bind(tx);
          tx.query = (async (sql: string, values?: unknown[]) => {
            if (sql.startsWith(skip)) {
              hit = true;
              return {
                command: 'UPDATE',
                rowCount: 1,
                oid: 0,
                rows: [],
                fields: [],
              };
            }
            return query(sql, values);
          }) as PoolClient['query'];
          try {
            return await work(tx);
          } finally {
            tx.query = raw;
          }
        }, options);
      try {
        const response = await f.send(f.admin, command);
        assert.ok(response.status >= 400, JSON.stringify(response.body));
      } finally {
        database.transaction = original;
      }
      assert.ok(hit);
      assert.deepEqual(await f.own(owner), before);
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_school_uid.commands WHERE actor_id=$1 AND request_id=$2',
            [f.admin.accountId, command.clientRequestId],
          )
        ).rows[0].n,
        0,
      );
    }
  },
);

test(
  'raw command closure rejects unrelated receipt events, future times and nullable command discriminators',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      profile = await f.profile(owner);
    await f.approve(f.admin, await f.submit(owner));
    const before = await f.own(owner);
    const database = f.app.get(DatabaseService),
      original = database.transaction,
      run = original.bind(database);
    for (const mode of [
      'receipt-event',
      'receipt-future',
      'missing-version',
      'missing-action',
      'null-state-version',
      'null-destination-version',
    ] as const) {
      const view = await f.management(f.admin, profile, f.home.campusId);
      assert.ok(view.destination);
      const command: SchoolIdentityCommand = {
        version: 1,
        action: 'correct_school',
        clientRequestId: randomUUID(),
        targetProfileId: profile,
        expectedStateVersion: view.stateVersion,
        destinationCampusId: f.home.campusId,
        expectedDestinationVersion: view.destination.destinationVersion,
      };
      let hit = false;
      database.transaction = (work, options) =>
        run(async (tx) => {
          const raw = tx.query,
            query = raw.bind(tx);
          tx.query = (async (sql: string, values?: unknown[]) => {
            if (sql.startsWith('INSERT INTO whaleu_school_uid.commands')) {
              hit = true;
              assert.ok(values);
              values = [...values];
              const intent = { ...(values[9] as Record<string, unknown>) },
                receipt = { ...(values[10] as Record<string, unknown>) };
              if (mode === 'receipt-event') receipt['eventId'] = randomUUID();
              else if (mode === 'receipt-future')
                receipt['recordedAt'] = new Date(
                  Date.now() + 86400000,
                ).toISOString();
              else if (mode === 'missing-version') {
                delete intent['version'];
                delete receipt['version'];
              } else if (mode === 'missing-action') {
                delete intent['action'];
                delete receipt['action'];
              } else if (mode === 'null-state-version') {
                intent['expectedStateVersion'] = null;
                receipt['expectedStateVersion'] = null;
              } else {
                intent['expectedDestinationVersion'] = null;
                receipt['expectedDestinationVersion'] = null;
              }
              values[9] = intent;
              values[10] = receipt;
              values[8] = (
                await query(
                  'SELECT whaleu_school_uid.command_hash($1::jsonb) hash',
                  [intent],
                )
              ).rows[0].hash;
            }
            return query(sql, values);
          }) as PoolClient['query'];
          try {
            return await work(tx);
          } finally {
            tx.query = raw;
          }
        }, options);
      try {
        const result = mode.startsWith('null-')
          ? await request(f.app.getHttpServer())
              .post('/v1/admin/school-identities/commands/cancel')
              .set('Authorization', `Bearer ${f.admin.accessToken}`)
              .send(command)
          : await f.send(f.admin, command);
        assert.ok(
          result.status >= 400,
          mode + ': ' + JSON.stringify(result.body),
        );
      } finally {
        database.transaction = original;
      }
      assert.ok(hit, mode);
      assert.deepEqual(await f.own(owner), before);
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_school_uid.commands WHERE actor_id=$1 AND request_id=$2',
            [f.admin.accountId, command.clientRequestId],
          )
        ).rows[0].n,
        0,
      );
    }
  },
);
