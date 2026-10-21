import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import request from 'supertest';
import { accountAppealsFixture } from '../support/account-appeals-fixture.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import {
  timetableReceiptSchema,
  timetableIntentHash,
} from '../../src/personal-timetable/contracts.js';
import type { TimetableCommand } from '../../src/personal-timetable/contracts.js';
const termPayload = {
  name: '我的秋季学期',
  weekOneMonday: '2026-09-07',
  weekCount: 20,
  timeZone: 'Asia/Shanghai' as const,
};
const entryPayload = {
  name: '离散数学',
  teacher: '张老师',
  location: 'A101',
  note: '私密复习计划\n材料第5页',
  dayOfWeek: 1,
  startMinute: 480,
  endMinute: 530,
  weeks: [1, 3, 20],
  color: 'blue' as const,
};
const create = (): Extract<TimetableCommand, { operation: 'term.create' }> => ({
  version: 1,
  requestId: randomUUID(),
  operation: 'term.create',
  termId: randomUUID(),
  expectedRevision: 0,
  payload: termPayload,
});

test(
  'private timetable real HTTP owner isolation, CRUD, exact recovery, CAS, quotas, erasure, rollback, policy and lock deadlines',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const owner = await createRuntimeActor(f.app),
      other = await createRuntimeActor(f.app);
    const auth = (actor = owner) => ({
      Authorization: `Bearer ${actor.accessToken}`,
    });
    const send = (c: TimetableCommand, actor = owner) =>
      request(f.http)
        .post('/v1/me/timetable/commands')
        .set(auth(actor))
        .send(c);
    const recover = (id: string, actor = owner) =>
      request(f.http).get(`/v1/me/timetable/requests/${id}`).set(auth(actor));
    const cancel = (c: TimetableCommand, actor = owner) =>
      request(f.http)
        .post(`/v1/me/timetable/requests/${c.requestId}/cancel`)
        .set(auth(actor))
        .send(c);
    const detail = (id: string, actor = owner) =>
      request(f.http).get(`/v1/me/timetable/terms/${id}`).set(auth(actor));
    const apply = async (c: TimetableCommand, actor = owner) => {
      const response = await send(c, actor);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const receipt = timetableReceiptSchema.parse(response.body);
      assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
      assert.equal(receipt.intentHash, timetableIntentHash(c));
      return receipt;
    };
    await request(f.http).get('/v1/me/timetable/terms').expect(401);
    await request(f.http)
      .get('/v1/me/timetable/terms')
      .set(auth())
      .query({ accountId: other.accountId })
      .expect(400);
    const initial = await request(f.http)
      .get('/v1/me/timetable/terms')
      .set(auth())
      .expect(200);
    assert.deepEqual(initial.body, { terms: [] });
    assert.equal(typeof initial.headers['cache-control'], 'string');
    assert.match(initial.headers['cache-control']!, /no-store/);
    const createTerm = create(),
      created = await apply(createTerm);
    const createdView = await detail(createTerm.termId).expect(200);
    assert.equal(createdView.body.term.revision, 1);
    assert.deepEqual(createdView.body.entries, []);
    await detail(createTerm.termId, other).expect(404);
    assert.deepEqual((await recover(createTerm.requestId, other)).body, {
      status: 'unknown',
      requestId: createTerm.requestId,
    });
    const crossWrite: TimetableCommand = {
      version: 1,
      requestId: randomUUID(),
      operation: 'term.update',
      termId: createTerm.termId,
      expectedRevision: 1,
      payload: { ...termPayload, name: 'not mine' },
    };
    assert.equal(
      (await send(crossWrite, other)).body.code,
      'TIMETABLE_NOT_FOUND',
    );
    assert.equal(
      (await detail(createTerm.termId)).body.term.name,
      termPayload.name,
    );
    await send({
      ...createTerm,
      requestId: randomUUID(),
      payload: { ...termPayload, weekOneMonday: '2026-09-08' },
    }).expect(400);
    // A distinct genuine Identity session for the same account can read/recover.
    const identity = (
      await f.pool.query<{
        provider: 'wechat';
        app_id: string;
        subject: string;
      }>(
        'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
        [owner.accountId],
      )
    ).rows[0]!;
    const accessToken = mintToken('access'),
      refreshToken = mintToken('refresh');
    const session = await f.app.get(IdentityRepository).createSession(
      {
        provider: identity.provider,
        appId: identity.app_id,
        subject: identity.subject,
      },
      { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
    );
    const second = { ...session, accessToken, refreshToken };
    assert.equal(second.accountId, owner.accountId);
    assert.notEqual(second.sessionId, owner.sessionId);
    assert.deepEqual((await recover(createTerm.requestId, second)).body, {
      status: 'settled',
      receipt: created,
    });
    assert.equal(
      (await detail(createTerm.termId, second)).body.term.revision,
      1,
    );
    const entryId = randomUUID();
    const createEntry: TimetableCommand = {
      version: 1,
      requestId: randomUUID(),
      operation: 'entry.create',
      termId: createTerm.termId,
      entryId,
      expectedRevision: 1,
      payload: entryPayload,
    };
    const entryCreated = await apply(createEntry);
    assert.equal(entryCreated.resultingRevision, 2);
    assert.deepEqual((await send(createEntry, second)).body, entryCreated);
    assert.equal((await detail(createTerm.termId)).body.entries.length, 1);
    await send({
      ...createEntry,
      payload: { ...entryPayload, note: 'changed same key' },
    }).expect(409);
    assert.deepEqual((await cancel(createEntry)).body, entryCreated);
    const edits: TimetableCommand[] = ['甲', '乙'].map((name) => ({
      version: 1,
      requestId: randomUUID(),
      operation: 'entry.update',
      termId: createTerm.termId,
      entryId,
      expectedRevision: 2,
      payload: { ...entryPayload, name },
    }));
    const raced = await Promise.all(edits.map((c) => send(c)));
    assert.deepEqual(raced.map((r) => r.body.outcome).sort(), [
      'applied',
      'rejected',
    ]);
    assert.equal(
      raced.find((r) => r.body.outcome === 'rejected')!.body.code,
      'TIMETABLE_REVISION_CONFLICT',
    );
    const loser = edits[raced.findIndex((r) => r.body.outcome === 'rejected')]!;
    assert.deepEqual(
      (await send(loser)).body,
      raced.find((r) => r.body.outcome === 'rejected')!.body,
    );
    const shorten: TimetableCommand = {
      version: 1,
      requestId: randomUUID(),
      operation: 'term.update',
      termId: createTerm.termId,
      expectedRevision: 3,
      payload: { ...termPayload, weekCount: 19 },
    };
    assert.equal(
      (await send(shorten)).body.code,
      'TIMETABLE_WEEKS_OUT_OF_RANGE',
    );
    assert.equal((await detail(createTerm.termId)).body.term.weekCount, 20);
    const shift: TimetableCommand = {
      ...shorten,
      requestId: randomUUID(),
      payload: { ...termPayload, weekOneMonday: '2026-09-14' },
    };
    await apply(shift);
    assert.deepEqual(
      (await detail(createTerm.termId)).body.entries[0].weeks,
      [1, 3, 20],
    );
    const invalidWeek: TimetableCommand = {
      ...createEntry,
      requestId: randomUUID(),
      entryId: randomUUID(),
      expectedRevision: 4,
      payload: { ...entryPayload, weeks: [21] },
    };
    assert.equal(
      (await send(invalidWeek)).body.code,
      'TIMETABLE_WEEKS_OUT_OF_RANGE',
    );
    const pending: TimetableCommand = {
      ...createEntry,
      requestId: randomUUID(),
      entryId: randomUUID(),
      expectedRevision: 4,
    };
    assert.equal((await recover(pending.requestId)).body.status, 'unknown');
    const cancelled = (await cancel(pending)).body;
    assert.equal(cancelled.outcome, 'cancelled');
    assert.equal(cancelled.intentHash, timetableIntentHash(pending));
    assert.deepEqual((await send(pending)).body, cancelled);
    assert.equal((await detail(createTerm.termId)).body.term.revision, 4);
    await request(f.http)
      .post(`/v1/me/timetable/requests/${randomUUID()}/cancel`)
      .set(auth())
      .send(pending)
      .expect(409);
    const deleteEntry: TimetableCommand = {
      version: 1,
      requestId: randomUUID(),
      operation: 'entry.delete',
      termId: createTerm.termId,
      entryId,
      expectedRevision: 4,
      payload: {},
    };
    await apply(deleteEntry);
    const erased = (
      await f.pool.query(
        'SELECT * FROM whaleu_timetable.entries WHERE account_id=$1 AND entry_id=$2',
        [owner.accountId, entryId],
      )
    ).rows[0]!;
    for (const field of [
      'name',
      'teacher',
      'location',
      'note',
      'day_of_week',
      'start_minute',
      'end_minute',
      'weeks',
      'color',
    ])
      assert.equal(erased[field], null, field);
    assert.ok(erased['deleted_at']);
    assert.equal(
      (
        await send({
          ...createEntry,
          requestId: randomUUID(),
          expectedRevision: 5,
        })
      ).body.code,
      'TIMETABLE_ID_REUSED',
    );
    const anotherEntry: TimetableCommand = {
      ...createEntry,
      requestId: randomUUID(),
      entryId: randomUUID(),
      expectedRevision: 5,
    };
    await apply(anotherEntry);
    const deleteTerm: TimetableCommand = {
      version: 1,
      requestId: randomUUID(),
      operation: 'term.delete',
      termId: createTerm.termId,
      expectedRevision: 6,
      payload: {},
    };
    const removed = await apply(deleteTerm);
    await detail(createTerm.termId).expect(404);
    assert.deepEqual((await recover(createEntry.requestId)).body, {
      status: 'settled',
      receipt: entryCreated,
    });
    assert.deepEqual((await cancel(deleteTerm)).body, removed);
    const stored = (
      await f.pool.query(
        'SELECT to_jsonb(t) row FROM whaleu_timetable.terms t WHERE account_id=$1 AND term_id=$2',
        [owner.accountId, createTerm.termId],
      )
    ).rows[0]!.row;
    for (const key of ['name', 'week_one_monday', 'week_count', 'time_zone'])
      assert.equal(stored[key], null, key);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_timetable.entries WHERE account_id=$1 AND term_id=$2 AND deleted_at IS NULL',
          [owner.accountId, createTerm.termId],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (await send({ ...createTerm, requestId: randomUUID() })).body.code,
      'TIMETABLE_ID_REUSED',
    );
    const history = JSON.stringify(
      (
        await f.pool.query(
          'SELECT * FROM whaleu_timetable.commands WHERE account_id=$1',
          [owner.accountId],
        )
      ).rows,
    );
    assert.ok(!history.includes(entryPayload.note));
    assert.ok(!history.includes(termPayload.name));
    assert.ok(!history.includes(entryPayload.teacher));
    await assert.rejects(
      f.pool.query(
        'UPDATE whaleu_timetable.commands SET receipt=receipt WHERE account_id=$1 AND request_id=$2',
        [owner.accountId, createTerm.requestId],
      ),
    );
    await assert.rejects(
      f.pool.query(
        'DELETE FROM whaleu_timetable.terms WHERE account_id=$1 AND term_id=$2',
        [owner.accountId, createTerm.termId],
      ),
    );
    await assert.rejects(
      f.pool.query(
        `UPDATE whaleu_timetable.terms SET revision=revision+1,deleted_at=NULL,name='resurrect',week_one_monday='2026-09-07',week_count=20,time_zone='Asia/Shanghai' WHERE account_id=$1 AND term_id=$2`,
        [owner.accountId, createTerm.termId],
      ),
    );
    // Valid synthetic quota rows exercise database owner guards as well as HTTP edge.
    const quotaOwner = await createRuntimeActor(f.app);
    await f.pool.query(
      `INSERT INTO whaleu_timetable.terms(account_id,term_id,revision,name,week_one_monday,week_count,time_zone) SELECT $1,gen_random_uuid(),1,'Quota term','2026-09-07',20,'Asia/Shanghai' FROM generate_series(1,31)`,
      [quotaOwner.accountId],
    );
    const quotaTerm = create();
    await apply(quotaTerm, quotaOwner);
    assert.equal(
      (await send(create(), quotaOwner)).body.code,
      'TIMETABLE_TERM_LIMIT',
    );
    await f.pool.query(
      `INSERT INTO whaleu_timetable.entries(account_id,term_id,entry_id,name,teacher,location,note,day_of_week,start_minute,end_minute,weeks,color) SELECT $1,$2,gen_random_uuid(),'Quota course','','','',1,0,1,ARRAY[1]::smallint[],'blue' FROM generate_series(1,199)`,
      [quotaOwner.accountId, quotaTerm.termId],
    );
    const quotaEntry: TimetableCommand = {
      ...createEntry,
      requestId: randomUUID(),
      termId: quotaTerm.termId,
      entryId: randomUUID(),
      expectedRevision: 1,
    };
    await apply(quotaEntry, quotaOwner);
    assert.equal(
      (
        await send(
          {
            ...quotaEntry,
            requestId: randomUUID(),
            entryId: randomUUID(),
            expectedRevision: 2,
          },
          quotaOwner,
        )
      ).body.code,
      'TIMETABLE_ENTRY_LIMIT',
    );
    await assert.rejects(
      f.pool.query(
        `INSERT INTO whaleu_timetable.entries(account_id,term_id,entry_id,name,teacher,location,note,day_of_week,start_minute,end_minute,weeks,color) VALUES($1,$2,$3,'Cross owner','','','',1,0,1,ARRAY[1]::smallint[],'blue')`,
        [other.accountId, quotaTerm.termId, randomUUID()],
      ),
    );
    // Cancellation versus execution has one durable winner, never false rollback.
    const racing = create();
    const [execution, cancellation] = await Promise.all([
      send(racing),
      cancel(racing),
    ]);
    assert.equal(execution.status, 200, JSON.stringify(execution.body));
    assert.equal(cancellation.status, 200, JSON.stringify(cancellation.body));
    assert.deepEqual(execution.body, cancellation.body);
    assert.ok(['applied', 'cancelled'].includes(execution.body.outcome));
    await detail(racing.termId).expect(
      execution.body.outcome === 'applied' ? 200 : 404,
    );
    assert.deepEqual((await recover(racing.requestId)).body, {
      status: 'settled',
      receipt: execution.body,
    });
    // Failed durable receipt rolls back the actual tentative term mutation.
    const rollback = create();
    await f.pool.query(
      `CREATE FUNCTION whaleu_timetable.test_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${rollback.requestId}'::uuid THEN RAISE EXCEPTION 'Synthetic receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_reject_receipt BEFORE INSERT ON whaleu_timetable.commands FOR EACH ROW EXECUTE FUNCTION whaleu_timetable.test_reject_receipt()`,
    );
    await send(rollback).expect(503);
    await detail(rollback.termId).expect(404);
    assert.equal((await recover(rollback.requestId)).body.status, 'unknown');
    await f.pool.query(
      'DROP TRIGGER test_reject_receipt ON whaleu_timetable.commands; DROP FUNCTION whaleu_timetable.test_reject_receipt()',
    );
    await apply(rollback);
    // PostgreSQL CHECK(NULL) must never admit a malformed minimal receipt.
    for (const patch of [
      { version: null },
      { version: '1' },
      { operation: null },
      { termId: null },
      { entryId: {} },
      { expectedRevision: null },
      { expectedRevision: '0' },
      { expectedRevision: 0.5 },
      { resultingRevision: null },
      { resultingRevision: '1' },
      { outcome: null },
      { outcome: 'rejected', code: null },
      { outcome: 'cancelled', resultingRevision: 1 },
      { code: 'private text must not survive' },
      { payload: termPayload },
    ]) {
      const requestId = randomUUID(),
        intentHash = 'a'.repeat(64);
      const malformed = { ...created, requestId, intentHash, ...patch };
      await assert.rejects(
        f.pool.query(
          'INSERT INTO whaleu_timetable.commands(account_id,request_id,intent_hash,receipt) VALUES($1,$2,$3,$4::jsonb)',
          [owner.accountId, requestId, intentHash, JSON.stringify(malformed)],
        ),
        (error: unknown) =>
          error instanceof Error && 'code' in error && error.code === '23514',
        JSON.stringify(patch),
      );
    }
    // Production punishment comes from an actual causal moderation operation.
    const admin = await f.actor(),
      subject = await f.actor();
    await f.grant(admin, 'super_admin', null);
    const muteSource = await f.publish(subject),
      suspendSource = await f.publish(subject);
    const subjectTerm = create();
    const original = await apply(subjectTerm, subject);
    await f.issue(admin, subject, muteSource, 'interaction_mute');
    const mutedWrite: TimetableCommand = {
      version: 1,
      requestId: randomUUID(),
      operation: 'term.update',
      termId: subjectTerm.termId,
      expectedRevision: 1,
      payload: { ...termPayload, name: 'Mute permits private edits' },
    };
    await apply(mutedWrite, subject);
    await detail(subjectTerm.termId, subject).expect(200);
    // The read has already authenticated and observed the unpunished policy,
    // then waits on its private owner lock while a real suspension commits.
    const readLocker = await f.pool.connect();
    let delayedRead: Promise<request.Response> | undefined;
    try {
      await readLocker.query('BEGIN');
      await readLocker.query('SELECT whaleu_timetable.owner_lock($1)', [
        subject.accountId,
      ]);
      delayedRead = detail(subjectTerm.termId, subject).then((r) => r);
      const until = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < until) {
        const row = (
          await f.pool.query<{ waiting: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%SELECT whaleu_timetable.owner_lock%') waiting`,
          )
        ).rows[0]!;
        if (row.waiting) {
          waiting = true;
          break;
        }
        await sleep(10);
      }
      assert.equal(
        waiting,
        true,
        'Private read reached actual owner lock wait',
      );
      await f.issue(admin, subject, suspendSource, 'access_suspension');
      await readLocker.query('ROLLBACK');
      const deniedRead = await delayedRead;
      assert.equal(deniedRead.status, 403, JSON.stringify(deniedRead.body));
      assert.equal(deniedRead.body.error.code, 'SAFETY_ACCESS_SUSPENDED');
      assert.ok(
        !JSON.stringify(deniedRead.body).includes('Mute permits private edits'),
      );
    } finally {
      await readLocker.query('ROLLBACK');
      readLocker.release();
      await delayedRead;
    }
    await detail(subjectTerm.termId, subject).expect(403);
    assert.deepEqual((await send(subjectTerm, subject)).body, original);
    assert.deepEqual((await recover(subjectTerm.requestId, subject)).body, {
      status: 'settled',
      receipt: original,
    });
    const blocked: TimetableCommand = {
      ...mutedWrite,
      requestId: randomUUID(),
      expectedRevision: 2,
    };
    const denied = (await send(blocked, subject)).body;
    assert.equal(denied.code, 'SAFETY_ACCESS_SUSPENDED');
    assert.equal(denied.resultingRevision, null);
    const restrictedCancel: TimetableCommand = {
      ...blocked,
      requestId: randomUUID(),
    };
    assert.equal(
      (await cancel(restrictedCancel, subject)).body.outcome,
      'cancelled',
    );
    // Expiry while awaiting the owner lock must roll back, not deliver an old read.
    const short = await createRuntimeActor(f.app),
      late = create(),
      locker = await f.pool.connect();
    let pendingResponse: Promise<request.Response> | undefined;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT whaleu_timetable.owner_lock($1)', [
        short.accountId,
      ]);
      await f.pool.query(
        `UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1`,
        [hashToken(short.accessToken)],
      );
      pendingResponse = send(late, short).then((r) => r);
      const until = Date.now() + 1500;
      let waiting = false;
      while (Date.now() < until) {
        const row = (
          await f.pool.query<{ waiting: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%SELECT whaleu_timetable.owner_lock%') waiting`,
          )
        ).rows[0]!;
        if (row.waiting) {
          waiting = true;
          break;
        }
        await sleep(10);
      }
      assert.equal(waiting, true, 'Observed real owner lock wait');
      await f.pool.query(
        `SELECT pg_sleep(greatest(0,extract(epoch FROM expires_at-clock_timestamp()))+0.05) FROM whaleu_identity.access_tokens WHERE token_hash=$1`,
        [hashToken(short.accessToken)],
      );
      await locker.query('ROLLBACK');
      const response = await pendingResponse;
      assert.equal(response.status, 401, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'ACCESS_TOKEN_EXPIRED');
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::integer n FROM whaleu_timetable.commands WHERE account_id=$1',
            [short.accountId],
          )
        ).rows[0]!.n,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::integer n FROM whaleu_timetable.terms WHERE account_id=$1',
            [short.accountId],
          )
        ).rows[0]!.n,
        0,
      );
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await pendingResponse;
    }
    await f.pool.query(
      `UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1`,
      [owner.sessionId],
    );
    await recover(createTerm.requestId).expect(401);
  },
);
