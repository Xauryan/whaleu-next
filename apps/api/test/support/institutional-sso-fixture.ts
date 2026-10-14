import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { schoolUidFixture } from './school-uid-fixture.js';
import type { UidSchool } from './school-uid-fixture.js';
import { extendLiveFixture } from './live-fixture.js';
import {
  INSTITUTIONAL_PROVIDER,
  TrustedInstitutionalVerifier,
} from '../../src/verification/institutional/provider.js';
import type {
  InstitutionalTransport,
  InstitutionalProviderContext,
} from '../../src/verification/institutional/provider.js';
import {
  INSTITUTIONAL_CONSENT,
  INSTITUTIONAL_PURPOSE,
  institutionalRequestHash,
  institutionalReceiptSchema,
} from '../../src/verification/institutional/contracts.js';
import type { InstitutionalPrepare } from '../../src/verification/institutional/contracts.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
interface FixtureResponse {
  accountId: string;
  requestId: string;
  requestHash: string;
  subject: string;
  studentNumber: string | null;
  issuerNamespace: string;
  institutionId: string;
  originRegionId: string;
  bindingVersion: string;
  policyReference: string;
  audience: string;
  authenticatedAt: string;
  responseUseExpiresAt: string;
  factExpiresAt: string;
  evidenceDigest: string;
  eligibleStudent: boolean;
}
/** Test composition only. No HTTP enrollment, environment activation or real transport. */
export class SyntheticInstitutionalTransport implements InstitutionalTransport {
  readonly adapterId = 'synthetic-institutional-v1';
  readonly #responses = new Map<string, FixtureResponse>();
  calls = 0;
  returnedPayloads = 0;
  /** Fault injection: a non-cooperating transport can finish after cancellation. */
  ignoreAbort = false;
  beforeReturn:
    ((context: InstitutionalProviderContext) => Promise<void>) | null = null;
  enroll(opaque: string, fixture: FixtureResponse) {
    assert.ok(!this.#responses.has(opaque));
    this.#responses.set(opaque, Object.freeze({ ...fixture }));
  }
  async exchange(
    opaque: string,
    context: InstitutionalProviderContext,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.calls++;
    const fixture = this.#responses.get(opaque);
    this.#responses.delete(opaque);
    if (
      !fixture ||
      signal.aborted ||
      fixture.accountId !== context.accountId ||
      fixture.requestId !== context.requestId ||
      fixture.requestHash !== context.requestHash
    )
      return { state: 'rejected' };
    await this.beforeReturn?.(context);
    if (signal.aborted && !this.ignoreAbort)
      throw new Error('Synthetic response interrupted');
    this.returnedPayloads++;
    return {
      ...fixture,
      adapterId: this.adapterId,
      claimId: context.claimId,
      sessionId: context.sessionId,
      purpose: INSTITUTIONAL_PURPOSE,
    };
  }
}
export async function institutionalSsoFixture(
  options: { defaultProvider?: boolean; maximumMigration?: number } = {},
) {
  const transport = new SyntheticInstitutionalTransport(),
    verifier = new TrustedInstitutionalVerifier(transport);
  const f = await schoolUidFixture({
    ...(options.maximumMigration
      ? { maximumMigration: options.maximumMigration }
      : {}),
    configureTestModule(builder) {
      if (!options.defaultProvider)
        builder.overrideProvider(INSTITUTIONAL_PROVIDER).useValue(verifier);
    },
  });
  try {
    const install = async (location: UidSchool = f.home, enabled = true) => {
      const id = randomUUID(),
        version = 'synthetic-' + randomUUID();
      await f.pool.query(
        `INSERT INTO whaleu_verification.institutional_bindings(id,version,issuer_namespace,adapter_id,campus_id,institution_id,origin_region_id,policy_reference,purpose,audience,consent_version,supports_student_number,enabled,source_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,'institutional-sso/synthetic-v1',$8,'whaleu-institutional-verification',$9,true,$10,$11)`,
        [
          id,
          version,
          'synthetic:institution:' + location.institutionId,
          transport.adapterId,
          location.campusId,
          location.institutionId,
          location.regionId,
          INSTITUTIONAL_PURPOSE,
          INSTITUTIONAL_CONSENT,
          enabled,
          '1'.repeat(64),
        ],
      );
      const old = await f.pool.query(
        'SELECT revision FROM whaleu_verification.institutional_binding_heads WHERE campus_id=$1',
        [location.campusId],
      );
      if (old.rowCount)
        await f.pool.query(
          'UPDATE whaleu_verification.institutional_binding_heads SET binding_id=$2,revision=revision+1 WHERE campus_id=$1',
          [location.campusId, id],
        );
      else
        await f.pool.query(
          'INSERT INTO whaleu_verification.institutional_binding_heads(campus_id,binding_id,revision) VALUES($1,$2,1)',
          [location.campusId, id],
        );
      return id;
    };
    await install();
    await install(f.deferred);
    const http = f.app.getHttpServer(),
      auth = (actor: SessionCredentials) => `Bearer ${actor.accessToken}`;
    const capability = async (
      actor: SessionCredentials,
      campusId = f.home.campusId,
    ) =>
      request(http)
        .get('/v1/me/institutional-sso/capability')
        .query({ campusId })
        .set('Authorization', auth(actor));
    const prepare = async (
      actor: SessionCredentials,
      campusId = f.home.campusId,
    ) => {
      const cap = await capability(actor, campusId);
      assert.equal(cap.status, 200, JSON.stringify(cap.body));
      assert.equal(cap.body.state, 'eligible');
      const command: InstitutionalPrepare = {
        requestId: randomUUID(),
        campusId,
        capabilityVersion: String(cap.body.capabilityVersion),
        consent: INSTITUTIONAL_CONSENT,
      };
      const response = await request(http)
        .post('/v1/me/institutional-sso/requests')
        .set('Authorization', auth(actor))
        .send(command);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const receipt = institutionalReceiptSchema.parse(response.body);
      assert.equal(receipt.state, 'prepared');
      assert.equal(
        receipt.requestHash,
        institutionalRequestHash(actor.accountId, command),
      );
      return { command, receipt, hash: receipt.requestHash! };
    };
    const mint = async (
      actorId: string,
      id: string,
      overrides: Partial<FixtureResponse> = {},
    ) => {
      const q = (
        await f.pool.query(
          `SELECT q.request_expires_at::text request_expires_at,q.request_hash,b.issuer_namespace,b.institution_id,b.origin_region_id,b.version,b.policy_reference,b.audience,clock_timestamp()::text authenticated_at,least(clock_timestamp()+interval '60 seconds',q.request_expires_at)::text response_use_expires_at,(clock_timestamp()+interval '600 seconds')::text fact_expires_at FROM whaleu_verification.institutional_requests q JOIN whaleu_verification.institutional_bindings b ON b.id=q.binding_id WHERE q.account_id=$1 AND q.request_id=$2`,
          [actorId, id],
        )
      ).rows[0];
      assert.ok(q);
      // One authoritative DB instant supplies the exact synthetic lifetime relationships.
      const times = (
        await f.pool.query(
          "SELECT $1::timestamptz::text authenticated,least($1::timestamptz+interval '60 seconds',$2::timestamptz)::text response,($1::timestamptz+interval '600 seconds')::text fact",
          [q.authenticated_at, q.request_expires_at],
        )
      ).rows[0];
      const opaque =
        'synthetic-response-' + randomBytes(24).toString('base64url');
      transport.enroll(opaque, {
        accountId: actorId,
        requestId: id,
        requestHash: q.request_hash,
        subject: 'synthetic-subject:' + actorId,
        studentNumber: '00001234',
        issuerNamespace: q.issuer_namespace,
        institutionId: q.institution_id,
        originRegionId: q.origin_region_id,
        bindingVersion: q.version,
        policyReference: q.policy_reference,
        audience: q.audience,
        authenticatedAt: times.authenticated,
        responseUseExpiresAt: times.response,
        factExpiresAt: times.fact,
        evidenceDigest: createHash('sha256').update(opaque).digest('hex'),
        eligibleStudent: true,
        ...overrides,
      });
      return opaque;
    };
    const authorize = (
      actor: SessionCredentials,
      id: string,
      hash: string,
      response: string,
    ) =>
      request(http)
        .post(`/v1/me/institutional-sso/requests/${id}/complete`)
        .set('Authorization', auth(actor))
        .send({
          mode: 'authorize',
          requestHash: hash,
          authorizationResponse: response,
        });
    const recover = (actor: SessionCredentials, id: string, hash: string) =>
      request(http)
        .post(`/v1/me/institutional-sso/requests/${id}/complete`)
        .set('Authorization', auth(actor))
        .send({ mode: 'recover', requestHash: hash });
    const closeRequest = (
      actor: SessionCredentials,
      id: string,
      hash: string,
    ) =>
      request(http)
        .post(`/v1/me/institutional-sso/requests/${id}/close`)
        .set('Authorization', auth(actor))
        .send({ requestHash: hash });
    const read = (actor: SessionCredentials, id: string) =>
      request(http)
        .get(`/v1/me/institutional-sso/requests/${id}`)
        .set('Authorization', auth(actor));
    return extendLiveFixture(f, {
      transport,
      verifier,
      install,
      capability,
      prepare,
      mint,
      authorize,
      recover,
      closeRequest,
      read,
    });
  } catch (error) {
    await f.close();
    throw error;
  }
}
export async function institutionalRows(pool: Pool, account: string) {
  return (
    await pool.query(
      `SELECT (SELECT count(*)::int FROM whaleu_verification.institutional_requests WHERE account_id=$1) requests,(SELECT count(*)::int FROM whaleu_verification.institutional_results WHERE account_id=$1) results,(SELECT count(*)::int FROM whaleu_verification.institutional_completions WHERE account_id=$1) completions,(SELECT count(*)::int FROM whaleu_school_uid.producing_causes WHERE account_id=$1 AND kind='institutional_sso') causes,(SELECT count(*)::int FROM whaleu_verification.assertions WHERE account_id=$1 AND method='institutional_sso' AND assertion_state='verified') assertions`,
      [account],
    )
  ).rows[0];
}

/** Explicit synthetic prior-owner history; changes the real Verification head through its ordinary immutable ledger. */
export async function institutionalSyntheticTransition(
  pool: Pool,
  account: string,
  changes: {
    affiliation?: string;
    number?: string;
    phone?: string;
    application?: 'none' | 'pending' | 'rejected';
  },
) {
  const { inTransaction } = await import('../../src/database/database.js');
  return inTransaction(pool, async (tx) => {
    const prior = (
      await tx.query(
        'SELECT s.* FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1 FOR UPDATE OF h',
        [account],
      )
    ).rows[0];
    assert.ok(prior);
    const snapshot = randomUUID(),
      event = randomUUID();
    await tx.query(
      'INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        snapshot,
        account,
        prior.revision + 1,
        changes.affiliation ?? prior.affiliation_assertion_id,
        changes.number ?? prior.student_number_assertion_id,
        changes.phone ?? prior.phone_assertion_id,
        changes.application ?? prior.application_state,
        prior.application_coverage,
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,fact_kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code) VALUES($1,$2,$3,'reconciled_snapshot',NULL,$2,$4,$5,$6,'synthetic_institutional_race')",
      [
        event,
        account,
        randomUUID(),
        prior.revision,
        snapshot,
        prior.revision + 1,
      ],
    );
    await tx.query(
      'UPDATE whaleu_verification.account_heads SET revision=$2,snapshot_id=$3 WHERE account_id=$1',
      [account, prior.revision + 1, snapshot],
    );
    return { prior, snapshot };
  });
}
