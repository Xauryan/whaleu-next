import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  institutionalSsoFixture,
  institutionalRows,
  institutionalSyntheticTransition,
} from '../support/institutional-sso-fixture.js';
import {
  syntheticAssertion,
  insertSyntheticAssertion,
} from '../support/verification-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
const ok = (response: { status: number; body: unknown }) =>
  assert.equal(response.status, 200, JSON.stringify(response.body));
function gate() {
  let arrived!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (arrived = r)),
    wait = new Promise<void>((r) => (release = r));
  return {
    entered,
    release,
    run: async () => {
      arrived();
      await wait;
    },
  };
}
test(
  'institutional provider-gap affiliation and number A-B-A history is stale; independent phone/application changes survive',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    for (const kind of ['affiliation', 'student_number'] as const) {
      await t.test(`${kind} provider-gap ABA`, async () => {
        const actor = await f.actor();
        const a = syntheticAssertion(
          actor.accountId,
          f.home.institutionId,
          kind,
          {
            ...(kind === 'affiliation'
              ? { origin_region_id: f.home.regionId }
              : {
                  assertion_state: 'unverified',
                  issuer_institution_id: null,
                  source_issuer_institution_id: null,
                  origin_region_id: null,
                  student_number: null,
                  verified_at: null,
                  expiry_kind: 'policy_exempt',
                  expires_at: null,
                }),
          },
        );
        const b = {
          ...a,
          id: (await import('node:crypto')).randomUUID(),
          source_reference: 'synthetic-alternate-history',
        };
        await inTransaction(f.pool, async (tx) => {
          await insertSyntheticAssertion(tx, a);
          await insertSyntheticAssertion(tx, b);
        });
        const key = kind === 'affiliation' ? 'affiliation' : 'number';
        await institutionalSyntheticTransition(f.pool, actor.accountId, {
          [key]: a.id,
        });
        const p = await f.prepare(actor),
          opaque = await f.mint(actor.accountId, p.command.requestId),
          barrier = gate();
        f.transport.beforeReturn = barrier.run;
        const pending = f
          .authorize(actor, p.command.requestId, p.hash, opaque)
          .then((r) => r);
        await barrier.entered;
        await institutionalSyntheticTransition(f.pool, actor.accountId, {
          [key]: b.id,
        });
        await institutionalSyntheticTransition(f.pool, actor.accountId, {
          [key]: a.id,
        });
        barrier.release();
        const response = await pending;
        ok(response);
        assert.equal(response.body.state, 'stale');
        assert.equal(
          (await institutionalRows(f.pool, actor.accountId)).completions,
          0,
        );
        f.transport.beforeReturn = null;
      });
    }
    await t.test(
      'phone-only and application-only latest values survive',
      async () => {
        const actor = await f.actor(),
          p = await f.prepare(actor),
          opaque = await f.mint(actor.accountId, p.command.requestId),
          barrier = gate();
        f.transport.beforeReturn = barrier.run;
        const pending = f
          .authorize(actor, p.command.requestId, p.hash, opaque)
          .then((r) => r);
        await barrier.entered;
        const phone = syntheticAssertion(
          actor.accountId,
          f.home.institutionId,
          'phone',
        );
        await inTransaction(f.pool, (tx) =>
          insertSyntheticAssertion(tx, phone),
        );
        await institutionalSyntheticTransition(f.pool, actor.accountId, {
          phone: phone.id,
          application: 'pending',
        });
        barrier.release();
        const response = await pending;
        ok(response);
        assert.equal(response.body.state, 'completed');
        const after = (
          await f.pool.query(
            'SELECT s.* FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1',
            [actor.accountId],
          )
        ).rows[0];
        assert.equal(after.phone_assertion_id, phone.id);
        assert.equal(after.application_state, 'pending');
        f.transport.beforeReturn = null;
      },
    );
  },
);
test(
  'institutional cancellation wins provider gap and durable admission is locally recoverable without replay',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      p = await f.prepare(actor),
      opaque = await f.mint(actor.accountId, p.command.requestId),
      barrier = gate();
    f.transport.beforeReturn = barrier.run;
    const pending = f
      .authorize(actor, p.command.requestId, p.hash, opaque)
      .then((r) => r);
    await barrier.entered;
    const closed = await f.closeRequest(actor, p.command.requestId, p.hash);
    ok(closed);
    assert.equal(closed.body.state, 'cancelled');
    barrier.release();
    const response = await pending;
    ok(response);
    assert.deepEqual(response.body, closed.body);
    assert.deepEqual(await institutionalRows(f.pool, actor.accountId), {
      requests: 1,
      results: 0,
      completions: 0,
      causes: 0,
      assertions: 0,
    });
    f.transport.beforeReturn = null;
    const subjectActor = await f.actor(),
      first = await f.prepare(subjectActor);
    const accepted = await f.authorize(
      subjectActor,
      first.command.requestId,
      first.hash,
      await f.mint(subjectActor.accountId, first.command.requestId, {
        subject: 'shared-synthetic-subject',
      }),
    );
    ok(accepted);
    assert.equal(accepted.body.state, 'completed');
    const intruder = await f.actor(),
      second = await f.prepare(intruder);
    const duplicate = await f.authorize(
      intruder,
      second.command.requestId,
      second.hash,
      await f.mint(intruder.accountId, second.command.requestId, {
        subject: 'shared-synthetic-subject',
      }),
    );
    ok(duplicate);
    assert.equal(duplicate.body.state, 'conflict');
    assert.equal(
      (await institutionalRows(f.pool, intruder.accountId)).results,
      0,
    );
    const publicView = await request(f.app.getHttpServer())
      .get('/v1/me/verification')
      .set('Authorization', `Bearer ${subjectActor.accessToken}`);
    ok(publicView);
    assert.ok(
      !JSON.stringify(publicView.body).includes('shared-synthetic-subject'),
    );
  },
);

test(
  'institutional original witness survives neither prepare-to-claim nor admitted-recovery ABA even when pointers match',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    for (const phase of ['before-claim', 'after-admission'] as const) {
      for (const fact of ['affiliation', 'student_number'] as const) {
        await t.test(`${phase} ${fact} ABA`, async () => {
          const actor = await f.actor();
          const a = syntheticAssertion(
              actor.accountId,
              f.home.institutionId,
              fact,
              {
                ...(fact === 'affiliation'
                  ? { origin_region_id: f.home.regionId }
                  : {
                      assertion_state: 'unverified',
                      issuer_institution_id: null,
                      source_issuer_institution_id: null,
                      origin_region_id: null,
                      student_number: null,
                      verified_at: null,
                      expiry_kind: 'policy_exempt',
                      expires_at: null,
                    }),
              },
            ),
            b = {
              ...a,
              id: (await import('node:crypto')).randomUUID(),
              source_reference: 'synthetic-other-pointer',
            };
          await inTransaction(f.pool, async (tx) => {
            await insertSyntheticAssertion(tx, a);
            await insertSyntheticAssertion(tx, b);
          });
          const key = fact === 'affiliation' ? 'affiliation' : 'number';
          await institutionalSyntheticTransition(f.pool, actor.accountId, {
            [key]: a.id,
          });
          const p = await f.prepare(actor),
            opaque = await f.mint(actor.accountId, p.command.requestId),
            calls = f.transport.calls;
          if (phase === 'after-admission') {
            await f.pool.query(
              "CREATE FUNCTION whaleu_verification.synthetic_institutional_gap_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic local gap'; END $$; CREATE TRIGGER a_synthetic_institutional_gap_failure BEFORE INSERT ON whaleu_verification.institutional_completions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_institutional_gap_failure()",
            );
            const response = await f.authorize(
              actor,
              p.command.requestId,
              p.hash,
              opaque,
            );
            assert.equal(response.status, 503);
            assert.equal(
              (await f.read(actor, p.command.requestId)).body.state,
              'ready_to_finalize',
            );
            await f.pool.query(
              'DROP TRIGGER a_synthetic_institutional_gap_failure ON whaleu_verification.institutional_completions; DROP FUNCTION whaleu_verification.synthetic_institutional_gap_failure()',
            );
          }
          await institutionalSyntheticTransition(f.pool, actor.accountId, {
            [key]: b.id,
          });
          await institutionalSyntheticTransition(f.pool, actor.accountId, {
            [key]: a.id,
          });
          const result =
            phase === 'before-claim'
              ? await f.authorize(actor, p.command.requestId, p.hash, opaque)
              : await f.recover(actor, p.command.requestId, p.hash);
          ok(result);
          assert.equal(result.body.state, 'stale');
          assert.equal(
            f.transport.calls,
            calls + (phase === 'after-admission' ? 1 : 0),
          );
          assert.equal(
            (await institutionalRows(f.pool, actor.accountId)).completions,
            0,
          );
        });
      }
    }
  },
);

test(
  'institutional concurrent original commands, admitted cancellation and unknown transport remain single-use',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const { randomUUID } = await import('node:crypto');
    await t.test(
      'different-key prepares and same-key completes race through actual HTTP',
      async () => {
        const a = await f.actor(),
          cap = await f.capability(a),
          make = () => ({
            requestId: randomUUID(),
            campusId: f.home.campusId,
            capabilityVersion: cap.body.capabilityVersion,
            consent: 'institutional-verification-link/v1',
          }),
          commands = [make(), make()];
        const prepared = await Promise.all(
          commands.map((c) =>
            request(f.app.getHttpServer())
              .post('/v1/me/institutional-sso/requests')
              .set('Authorization', `Bearer ${a.accessToken}`)
              .send(c),
          ),
        );
        assert.deepEqual(prepared.map((r) => r.status).sort(), [200, 409]);
        assert.equal(
          (
            await f.pool.query(
              "SELECT count(*)::int n FROM whaleu_verification.institutional_requests WHERE account_id=$1 AND state='prepared'",
              [a.accountId],
            )
          ).rows[0].n,
          1,
        );
        const p = prepared.find((r) => r.status === 200)!.body,
          b = gate(),
          opaque = await f.mint(a.accountId, p.requestId);
        f.transport.beforeReturn = b.run;
        const first = f
          .authorize(a, p.requestId, p.requestHash, opaque)
          .then((r) => r);
        await b.entered;
        const second = await f.authorize(a, p.requestId, p.requestHash, opaque);
        ok(second);
        assert.equal(second.body.state, 'processing');
        assert.equal(f.transport.calls, 1);
        b.release();
        const done = await first;
        ok(done);
        assert.equal(done.body.state, 'completed');
        assert.deepEqual(
          (await f.recover(a, p.requestId, p.requestHash)).body,
          done.body,
        );
        f.transport.beforeReturn = null;
      },
    );
    await t.test(
      'cancel wins after accepted admission but before local issuance',
      async () => {
        const a = await f.actor(),
          p = await f.prepare(a),
          before = f.transport.calls;
        await f.pool.query(
          "CREATE FUNCTION whaleu_verification.synthetic_sso_admitted_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic local interruption'; END $$; CREATE TRIGGER a_synthetic_sso_admitted_cancel BEFORE INSERT ON whaleu_verification.institutional_completions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_sso_admitted_cancel()",
        );
        try {
          assert.equal(
            (
              await f.authorize(
                a,
                p.command.requestId,
                p.hash,
                await f.mint(a.accountId, p.command.requestId),
              )
            ).status,
            503,
          );
        } finally {
          await f.pool.query(
            'DROP TRIGGER a_synthetic_sso_admitted_cancel ON whaleu_verification.institutional_completions; DROP FUNCTION whaleu_verification.synthetic_sso_admitted_cancel()',
          );
        }
        assert.equal((await institutionalRows(f.pool, a.accountId)).results, 1);
        const closed = await f.closeRequest(a, p.command.requestId, p.hash);
        ok(closed);
        assert.equal(closed.body.state, 'cancelled');
        assert.deepEqual(
          (await f.recover(a, p.command.requestId, p.hash)).body,
          closed.body,
        );
        const rows = await institutionalRows(f.pool, a.accountId);
        assert.equal(rows.completions, 0);
        assert.equal(rows.causes, 0);
        assert.equal(f.transport.calls, before + 1);
      },
    );
    await t.test(
      'transport throw after committed claim remains unknown without replay',
      async () => {
        const a = await f.actor(),
          p = await f.prepare(a),
          opaque = await f.mint(a.accountId, p.command.requestId),
          before = f.transport.calls;
        f.transport.beforeReturn = async () => {
          throw new Error('Synthetic transport lost outcome');
        };
        const r = await f.authorize(a, p.command.requestId, p.hash, opaque);
        ok(r);
        assert.equal(r.body.state, 'outcome_unknown');
        f.transport.beforeReturn = null;
        assert.deepEqual(
          (await f.authorize(a, p.command.requestId, p.hash, opaque)).body,
          r.body,
        );
        assert.equal(f.transport.calls, before + 1);
        assert.equal((await institutionalRows(f.pool, a.accountId)).results, 0);
        ok(await f.closeRequest(a, p.command.requestId, p.hash));
      },
    );
  },
);

test(
  'institutional subject, number, issuer and consumed-response compatibility never overwrite accepted history',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const a = await f.actor(),
      p = await f.prepare(a),
      consumed = await f.mint(a.accountId, p.command.requestId);
    ok(await f.authorize(a, p.command.requestId, p.hash, consumed));
    const facts = async (account: string) =>
      (
        await f.pool.query(
          'SELECT to_jsonb(a) row FROM whaleu_verification.assertions a WHERE account_id=$1 ORDER BY id',
          [account],
        )
      ).rows;
    const originals = await facts(a.accountId);
    for (const scenario of [
      'different-subject',
      'different-number',
      'different-issuer',
      'consumed-response',
    ] as const)
      await t.test(scenario, async () => {
        const q = await f.prepare(a),
          opaque =
            scenario === 'consumed-response'
              ? consumed
              : await f.mint(
                  a.accountId,
                  q.command.requestId,
                  scenario === 'different-subject'
                    ? { subject: 'synthetic-other-subject' }
                    : scenario === 'different-number'
                      ? { studentNumber: '99990000' }
                      : scenario === 'different-issuer'
                        ? { issuerNamespace: 'synthetic:foreign-issuer' }
                        : {
                            requestId: (
                              await import('node:crypto')
                            ).randomUUID(),
                          },
                );
        const r = await f.authorize(a, q.command.requestId, q.hash, opaque);
        ok(r);
        assert.ok(
          ['rejected', 'conflict'].includes(r.body.state),
          JSON.stringify(r.body),
        );
        assert.equal((await institutionalRows(f.pool, a.accountId)).results, 1);
        assert.deepEqual(await facts(a.accountId), originals);
      });
    await t.test(
      'operation mismatch cannot mint admission for another original key',
      async () => {
        const owner = await f.actor(),
          q = await f.prepare(owner),
          r = await f.authorize(
            owner,
            q.command.requestId,
            q.hash,
            await f.mint(owner.accountId, q.command.requestId, {
              requestId: randomUUID(),
            }),
          );
        ok(r);
        assert.equal(r.body.state, 'rejected');
        assert.equal(
          (await institutionalRows(f.pool, owner.accountId)).results,
          0,
        );
      },
    );
    await t.test(
      'an existing private number without subject admission is not linked by equality',
      async () => {
        const owner = await f.actor(),
          number = syntheticAssertion(
            owner.accountId,
            f.home.institutionId,
            'student_number',
            { student_number: '00001234' },
          );
        await inTransaction(f.pool, (tx) =>
          insertSyntheticAssertion(tx, number),
        );
        await institutionalSyntheticTransition(f.pool, owner.accountId, {
          number: number.id,
        });
        const old = await facts(owner.accountId),
          q = await f.prepare(owner),
          r = await f.authorize(
            owner,
            q.command.requestId,
            q.hash,
            await f.mint(owner.accountId, q.command.requestId),
          );
        ok(r);
        assert.equal(r.body.state, 'conflict');
        assert.equal(
          (await institutionalRows(f.pool, owner.accountId)).results,
          0,
        );
        assert.deepEqual(await facts(owner.accountId), old);
      },
    );
    await t.test(
      'foreign issuer and revoked historical facts remain unavailable without verifier admission',
      async () => {
        const owner = await f.actor(),
          affiliation = syntheticAssertion(
            owner.accountId,
            f.destination.institutionId,
            'affiliation',
            { origin_region_id: f.destination.regionId },
          );
        await inTransaction(f.pool, (tx) =>
          insertSyntheticAssertion(tx, affiliation),
        );
        await institutionalSyntheticTransition(f.pool, owner.accountId, {
          affiliation: affiliation.id,
        });
        const old = await facts(owner.accountId),
          cap = await f.capability(owner);
        ok(cap);
        assert.notEqual(cap.body.state, 'eligible');
        assert.deepEqual(await facts(owner.accountId), old);
        const { revokeAssertion } =
          await import('../../src/verification/revocation.js');
        const head = (
          await f.pool.query(
            'SELECT revision FROM whaleu_verification.account_heads WHERE account_id=$1',
            [a.accountId],
          )
        ).rows[0];
        await inTransaction(f.pool, (tx) =>
          revokeAssertion(tx, {
            accountId: a.accountId,
            actorAccountId: a.accountId,
            operationId: randomUUID(),
            fact: 'student_number',
            expectedRevision: head.revision,
            reasonCode: 'synthetic_revoked_identity',
          }),
        );
        assert.notEqual((await f.capability(a)).body.state, 'eligible');
      },
    );
  },
);

test(
  'institutional retained document ABA and authorized revocation bridge the same monotone witness; independent before/after gaps preserve latest facts',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    await t.test(
      'genuine document ABA then real revocation during the provider gap',
      async () => {
        const a = await f.actor();
        await f.approve(f.admin, await f.submit(a));
        const read = async () =>
            (
              await f.pool.query(
                'SELECT h.revision,s.affiliation_assertion_id FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1',
                [a.accountId],
              )
            ).rows[0],
          original = await read();
        const alternate = syntheticAssertion(
          a.accountId,
          f.home.institutionId,
          'affiliation',
          { origin_region_id: f.home.regionId },
        );
        await inTransaction(f.pool, (tx) =>
          insertSyntheticAssertion(tx, alternate),
        );
        for (const action of [
          'document-ABA',
          'authorized-revocation',
        ] as const) {
          const p = await f.prepare(a),
            b = gate();
          f.transport.beforeReturn = b.run;
          const pending = f
            .authorize(
              a,
              p.command.requestId,
              p.hash,
              await f.mint(a.accountId, p.command.requestId),
            )
            .then((r) => r);
          await b.entered;
          try {
            if (action === 'document-ABA') {
              await institutionalSyntheticTransition(f.pool, a.accountId, {
                affiliation: alternate.id,
              });
              await institutionalSyntheticTransition(f.pool, a.accountId, {
                affiliation: original.affiliation_assertion_id,
              });
            } else {
              const { revokeAssertion } =
                await import('../../src/verification/revocation.js');
              const revision = (await read()).revision;
              await inTransaction(f.pool, (tx) =>
                revokeAssertion(tx, {
                  accountId: a.accountId,
                  actorAccountId: a.accountId,
                  operationId: randomUUID(),
                  fact: 'affiliation',
                  expectedRevision: revision,
                  reasonCode: 'synthetic_authorized_document_revocation',
                }),
              );
              await institutionalSyntheticTransition(f.pool, a.accountId, {
                affiliation: original.affiliation_assertion_id,
              });
            }
          } finally {
            b.release();
          }
          const r = await pending;
          ok(r);
          assert.equal(r.body.state, 'stale');
          f.transport.beforeReturn = null;
          assert.equal(
            (await institutionalRows(f.pool, a.accountId)).results,
            0,
          );
        }
      },
    );
    await t.test(
      'phone/application before claim and after admission do not masquerade as relevant identity changes',
      async () => {
        const a = await f.actor(),
          p = await f.prepare(a),
          phone = syntheticAssertion(
            a.accountId,
            f.home.institutionId,
            'phone',
          );
        await inTransaction(f.pool, (tx) =>
          insertSyntheticAssertion(tx, phone),
        );
        await institutionalSyntheticTransition(f.pool, a.accountId, {
          phone: phone.id,
          application: 'pending',
        });
        ok(
          await f.authorize(
            a,
            p.command.requestId,
            p.hash,
            await f.mint(a.accountId, p.command.requestId),
          ),
        );
        const read = async () =>
          (
            await f.pool.query(
              'SELECT s.phone_assertion_id,s.application_state FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1',
              [a.accountId],
            )
          ).rows[0];
        assert.deepEqual(await read(), {
          phone_assertion_id: phone.id,
          application_state: 'pending',
        });
        const q = await f.prepare(a);
        await f.pool.query(
          "CREATE FUNCTION whaleu_verification.synthetic_sso_independent_gap() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic local independent gap'; END $$; CREATE TRIGGER a_synthetic_sso_independent_gap BEFORE INSERT ON whaleu_verification.institutional_completions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_sso_independent_gap()",
        );
        try {
          assert.equal(
            (
              await f.authorize(
                a,
                q.command.requestId,
                q.hash,
                await f.mint(a.accountId, q.command.requestId),
              )
            ).status,
            503,
          );
        } finally {
          await f.pool.query(
            'DROP TRIGGER a_synthetic_sso_independent_gap ON whaleu_verification.institutional_completions; DROP FUNCTION whaleu_verification.synthetic_sso_independent_gap()',
          );
        }
        const later = syntheticAssertion(
          a.accountId,
          f.home.institutionId,
          'phone',
        );
        await inTransaction(f.pool, (tx) =>
          insertSyntheticAssertion(tx, later),
        );
        await institutionalSyntheticTransition(f.pool, a.accountId, {
          phone: later.id,
          application: 'none',
        });
        const recovered = await f.recover(a, q.command.requestId, q.hash);
        ok(recovered);
        assert.equal(recovered.body.state, 'completed');
        assert.deepEqual(await read(), {
          phone_assertion_id: later.id,
          application_state: 'none',
        });
        assert.equal(f.transport.calls, 4);
      },
    );
  },
);
