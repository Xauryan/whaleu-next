import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import { schoolUidFixture } from '../support/school-uid-fixture.js';

test(
  'joint current public UID is optional under UID fence contention and remains exact above2^53',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    await f.admit(f.home, '9007199254740992');
    const owner = await f.actor(),
      profile = await f.profile(owner);
    await f.approve(f.admin, await f.submit(owner));
    const uid = await f.own(owner);
    assert.equal(uid.status, 'assigned');
    if (uid.status !== 'assigned') throw Error('UID absent');
    assert.equal(uid.uid, '9007199254740993');
    assert.equal(uid.formattedUid, uid.uid);
    const http = f.app.getHttpServer();
    const read = () => request(http).get(`/v1/profiles/${profile}`);
    const publicResult = await read();
    assert.equal(publicResult.status, 200, JSON.stringify(publicResult.body));
    assert.equal(publicResult.body.publicUid.value, uid.uid);
    assert.equal(publicResult.body.affiliation.schoolCode, f.home.schoolCode);
    const database = f.app.get(DatabaseService),
      original = database.transaction,
      run = original.bind(database),
      blocker = await f.pool.connect();
    let hit = false;
    database.transaction = (work, options) =>
      run(async (tx) => {
        const raw = tx.query,
          query = raw.bind(tx);
        tx.query = (async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          if (!hit && sql.includes('whaleu_school_uid.projection_facts')) {
            hit = true;
            await blocker.query('BEGIN');
            await blocker.query(
              'LOCK TABLE whaleu_school_uid.account_heads IN ROW EXCLUSIVE MODE',
            );
          }
          return result;
        }) as PoolClient['query'];
        try {
          return await work(tx);
        } finally {
          tx.query = raw;
        }
      }, options);
    try {
      const degraded = await read();
      assert.equal(degraded.status, 200, JSON.stringify(degraded.body));
      assert.equal(degraded.body.schoolUidStatus, 'unavailable');
      assert.equal(degraded.body.affiliation, null);
      assert.equal(degraded.body.publicUid, null);
      assert.equal(degraded.body.profileId, profile);
      assert.equal(degraded.body.displayName, publicResult.body.displayName);
    } finally {
      database.transaction = original;
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    assert.ok(hit);
    let reads = 0;
    database.transaction = (work, options) => {
      let restore = () => {};
      return run(async (tx) => {
        const raw = tx.query,
          query = raw.bind(tx);
        tx.query = (async (sql: string, values?: unknown[]) => {
          if (sql.includes('whaleu_school_uid.projection_facts')) reads++;
          return query(sql, values);
        }) as PoolClient['query'];
        restore = () => {
          tx.query = raw;
        };
        return work(tx);
      }, options).finally(() => restore());
    };
    try {
      const guest = await read();
      assert.equal(guest.body.publicUid.value, uid.uid);
      assert.equal(
        reads,
        2,
        'one initial UID observation and one final optional proof only',
      );
    } finally {
      database.transaction = original;
    }
  },
);

test(
  'optional initial UID timeout restores its checkpoint; failed savepoint and rollback are fatal',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      profile = await f.profile(owner);
    await f.approve(f.admin, await f.submit(owner));
    const http = f.app.getHttpServer(),
      database = f.app.get(DatabaseService),
      original = database.transaction,
      run = original.bind(database);
    const read = () => request(http).get(`/v1/profiles/${profile}`);
    const baseline = await read();
    assert.equal(baseline.status, 200);
    for (const mode of [
      'initial-timeout',
      'savepoint-failure',
      'rollback-failure',
      'arbitrary-sql-failure',
    ] as const) {
      let hit = false;
      database.transaction = (work, options) =>
        run(async (tx) => {
          const raw = tx.query,
            query = raw.bind(tx);
          tx.query = (async (sql: string, values?: unknown[]) => {
            if (
              mode === 'savepoint-failure' &&
              sql === 'SAVEPOINT school_uid_projection'
            ) {
              hit = true;
              throw Error('Synthetic savepoint creation failure');
            }
            if (
              mode === 'rollback-failure' &&
              sql === 'ROLLBACK TO SAVEPOINT school_uid_projection'
            )
              throw Error('Synthetic rollback failure');
            if (
              mode === 'arbitrary-sql-failure' &&
              sql.includes('whaleu_school_uid.projection_facts')
            ) {
              hit = true;
              await query('SELECT 1/0');
            }
            if (
              !hit &&
              mode !== 'savepoint-failure' &&
              sql.includes('whaleu_school_uid.projection_facts')
            ) {
              hit = true;
              await query('SELECT pg_sleep(0.2)');
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
        const response = await read();
        if (mode === 'initial-timeout') {
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.body.schoolUidStatus, 'unavailable');
          assert.equal(response.body.affiliation, null);
          assert.equal(response.body.publicUid, null);
          assert.equal(
            response.body.postCountStatus,
            baseline.body.postCountStatus,
          );
          assert.equal(
            response.body.tradeCountStatus,
            baseline.body.tradeCountStatus,
          );
        } else assert.ok(response.status >= 500, JSON.stringify(response.body));
      } finally {
        database.transaction = original;
      }
      assert.ok(hit, mode);
    }
    assert.equal((await read()).body.schoolUidStatus, 'assigned');
  },
);
