import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { hashToken } from '../../identity/tokens.js';
import { CampusStudentVerificationFacade } from '../../campus/student-verification.facade.js';
import { SafetyRepository } from '../../safety/repository.js';
import { enforceAccountPunishment } from '../../safety/account-moderation/policy.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import {
  SchoolUidLedger,
  requireUidCauseCurrent,
} from '../../school-uid/ledger.js';
import { SchoolIdentityVerificationFacade } from '../school-identity.facade.js';
import { lockStudentLedger } from '../student/ledger.js';
import {
  lockStudentAccount,
  requireStudentCurrent,
} from '../student/current-proof.js';
import { assertionStatus } from '../policy.js';
import type { AssertionRecord, SnapshotRecord } from '../contracts.js';
import {
  INSTITUTIONAL_CONSENT,
  INSTITUTIONAL_PURPOSE,
  institutionalPrepareSchema,
  institutionalCompleteSchema,
  institutionalHashSchema,
  institutionalReceiptSchema,
  institutionalRequestHash,
  institutionalTerminalStates,
} from './contracts.js';
import type {
  InstitutionalPrepare,
  InstitutionalComplete,
  InstitutionalReceipt,
  InstitutionalCapability,
} from './contracts.js';
import { INSTITUTIONAL_PROVIDER } from './provider.js';
import type {
  InstitutionalProvider,
  InstitutionalProviderContext,
  InstitutionalVerifiedPayload,
} from './provider.js';
import {
  readInstitutionalBinding,
  requireInstitutionalCurrent,
} from './owner.js';
import type { InstitutionalBinding } from './owner.js';
interface FrozenContext {
  campusId: string;
  capabilityVersion: string;
  consent: typeof INSTITUTIONAL_CONSENT;
  purpose: typeof INSTITUTIONAL_PURPOSE;
  institutionId: string;
  originRegionId: string;
  campusVersion: string;
  bindingFingerprint: string;
}
interface RequestRow {
  account_id: string;
  request_id: string;
  request_hash: string;
  frozen_context: FrozenContext;
  binding_id: string;
  relevant_witness: unknown;
  state: string;
  claim_id: string | null;
  session_id: string | null;
  result_id: string | null;
  completion_id: string | null;
  receipt: InstitutionalReceipt | null;
  revision: number;
  request_expires_at: string;
  claim_deadline: string | null;
  request_current: boolean;
  claim_current: boolean;
  finalize_current: boolean;
}
interface ResultRow {
  id: string;
  provider_subject: string;
  issuer_namespace: string;
  student_number: string | null;
  authenticated_at: string;
  fact_expires_at: string;
  finalize_deadline: string;
}
const unavailable = () => new ApplicationError('INSTITUTIONAL_SSO_UNAVAILABLE');
const conflict = () => new ApplicationError('INSTITUTIONAL_SSO_CONFLICT');
class Stop extends Error {
  constructor(
    readonly state: 'stale' | 'conflict' | 'expired' | 'provider_unavailable',
  ) {
    super(state);
  }
}
@Injectable()
export class InstitutionalSsoService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(CampusStudentVerificationFacade)
    private readonly campuses: CampusStudentVerificationFacade,
    @Inject(SafetyRepository) private readonly safety: SafetyRepository,
    @Inject(SchoolUidLedger) private readonly uids: SchoolUidLedger,
    @Inject(SchoolIdentityVerificationFacade)
    private readonly verification: SchoolIdentityVerificationFacade,
    @Inject(INSTITUTIONAL_PROVIDER)
    private readonly provider: InstitutionalProvider,
  ) {}
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (e instanceof ApplicationError) throw e;
      if (e instanceof Stop) throw conflict();
      throw unavailable();
    }
  }
  private transaction<T>(work: (tx: PoolClient) => Promise<T>) {
    return this.db.transaction(work, { isolationLevel: 'read committed' });
  }
  private async authenticate(token: string, tx: PoolClient) {
    const actor = await this.identity.session(token, tx);
    const row = (
      await tx.query<{ until: string }>(
        `SELECT least(t.expires_at,s.absolute_expires_at)::text until FROM whaleu_identity.access_tokens t
       JOIN whaleu_identity.sessions s ON s.id=t.session_id WHERE t.token_hash=$1 AND s.id=$2 AND s.account_id=$3`,
        [hashToken(token), actor.sessionId, actor.accountId],
      )
    ).rows[0];
    if (!row) throw unavailable();
    registerTransactionExactDeadline(tx, row.until, 'ACCESS_TOKEN_EXPIRED');
    return actor;
  }
  private async lock(account: string, id: string, tx: PoolClient) {
    await tx.query('SELECT whaleu_verification.institutional_lock($1,$2)', [
      account,
      id,
    ]);
  }
  private async row(account: string, id: string, tx: PoolClient) {
    return (
      await tx.query<RequestRow>(
        `SELECT q.*,q.request_expires_at::text,q.claim_deadline::text,q.request_expires_at>clock_timestamp() request_current,COALESCE(q.claim_deadline>clock_timestamp(),false) claim_current,COALESCE(r.finalize_deadline>clock_timestamp(),false) finalize_current FROM whaleu_verification.institutional_requests q LEFT JOIN whaleu_verification.institutional_results r ON r.id=q.result_id WHERE q.account_id=$1 AND q.request_id=$2`,
        [account, id],
      )
    ).rows[0];
  }
  private async fence(account: string, id: string, tx: PoolClient) {
    return (
      await tx.query<{ request_hash: string; receipt: InstitutionalReceipt }>(
        'SELECT request_hash,receipt FROM whaleu_verification.institutional_cancel_fences WHERE account_id=$1 AND request_id=$2',
        [account, id],
      )
    ).rows[0];
  }
  private receipt(
    row: RequestRow | undefined,
    id: string,
  ): InstitutionalReceipt {
    if (!row)
      return { requestId: id, requestHash: null, state: 'not_recorded' };
    if (row.receipt) return institutionalReceiptSchema.parse(row.receipt);
    const base = { requestId: id, requestHash: row.request_hash };
    if (row.state === 'prepared' && row.request_current)
      return {
        ...base,
        state: 'prepared',
        context: {
          campusId: row.frozen_context.campusId,
          capabilityVersion: row.frozen_context.capabilityVersion,
          consent: row.frozen_context.consent,
        },
        expiresAt: row.request_expires_at,
      };
    const state =
      row.state === 'prepared'
        ? 'expired'
        : row.state === 'processing' && !row.claim_current
          ? 'outcome_unknown'
          : row.state === 'ready_to_finalize' && !row.finalize_current
            ? 'expired'
            : row.state;
    return institutionalReceiptSchema.parse({ ...base, state });
  }
  private async finish(
    row: RequestRow,
    state: string,
    tx: PoolClient,
  ): Promise<InstitutionalReceipt> {
    const receipt = institutionalReceiptSchema.parse({
      requestId: row.request_id,
      requestHash: row.request_hash,
      state,
    });
    await tx.query(
      'UPDATE whaleu_verification.institutional_requests SET state=$3,receipt=$4::jsonb,revision=revision+1 WHERE account_id=$1 AND request_id=$2 AND revision=$5',
      [
        row.account_id,
        row.request_id,
        state,
        JSON.stringify(receipt),
        row.revision,
      ],
    );
    return receipt;
  }
  private async allowed(account: string, tx: PoolClient) {
    await enforceAccountPunishment(account, 'private_self_service', tx);
    await this.safety.baseRestriction(account, tx);
    await requireStudentCurrent(null, account, tx);
  }
  private async currentBinding(
    row: RequestRow,
    tx: PoolClient,
  ): Promise<InstitutionalBinding> {
    const current = await readInstitutionalBinding(
      row.frozen_context.campusId,
      tx,
    );
    if (
      !current ||
      !current.binding.enabled ||
      !this.provider.available(current.binding.adapter_id)
    )
      throw new Stop('provider_unavailable');
    const campus = await this.campuses.resolve(row.frozen_context.campusId, tx);
    if (
      current.binding.id !== row.binding_id ||
      current.fingerprint !== row.frozen_context.bindingFingerprint ||
      campus.version !== row.frozen_context.campusVersion ||
      campus.institutionId !== row.frozen_context.institutionId ||
      campus.regionId !== row.frozen_context.originRegionId
    )
      throw new Stop('stale');
    return current.binding;
  }
  private async witness(row: RequestRow, tx: PoolClient) {
    const match = (
      await tx.query<{ valid: boolean }>(
        'SELECT whaleu_verification.relevant_fact_witness($1) IS NOT DISTINCT FROM $2::jsonb valid',
        [row.account_id, JSON.stringify(row.relevant_witness)],
      )
    ).rows[0];
    if (!match?.valid) throw new Stop('stale');
  }
  private context(
    row: RequestRow,
    b: InstitutionalBinding,
  ): InstitutionalProviderContext {
    if (!row.claim_id || !row.session_id || !row.claim_deadline)
      throw unavailable();
    return {
      accountId: row.account_id,
      requestId: row.request_id,
      requestHash: row.request_hash,
      claimId: row.claim_id,
      sessionId: row.session_id,
      issuerNamespace: b.issuer_namespace,
      adapterId: b.adapter_id,
      audience: b.audience,
      bindingVersion: b.version,
      policyReference: b.policy_reference,
      institutionId: b.institution_id,
      originRegionId: b.origin_region_id,
      supportedNumber: b.supports_student_number,
      requestExpiresAt: row.request_expires_at,
      claimDeadline: row.claim_deadline,
    };
  }
  private async facts(account: string, institution: string, tx: PoolClient) {
    const locked = await lockStudentLedger(account, tx);
    const rows = (
      await tx.query<AssertionRecord & { exact_expiry: string | null }>(
        'SELECT a.*,a.expires_at::text exact_expiry FROM whaleu_verification.assertions a WHERE a.account_id=$1 AND a.id=ANY($2::uuid[])',
        [
          account,
          [
            locked.prior.affiliation_assertion_id,
            locked.prior.student_number_assertion_id,
          ].filter(Boolean),
        ],
      )
    ).rows;
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() now'))
      .rows[0]!.now;
    const affiliation = rows.find(
        (a) => a.id === locked.prior.affiliation_assertion_id,
      ),
      number = rows.find(
        (a) => a.id === locked.prior.student_number_assertion_id,
      );
    const a = assertionStatus(affiliation, account, 'affiliation', now),
      n = assertionStatus(number, account, 'student_number', now);
    const coveredAbsence = (fact: AssertionRecord) =>
      ['native_enrollment', 'reconciled_import'].includes(fact.method) &&
      fact.issuer_institution_id === null &&
      fact.source_issuer_institution_id === null &&
      fact.origin_region_id === null &&
      fact.student_number === null &&
      fact.phone_binding_reference === null &&
      fact.verified_at === null &&
      fact.expiry_kind === 'policy_exempt' &&
      fact.expires_at === null;
    if (
      !['verified', 'unverified'].includes(a) ||
      !['verified', 'unverified'].includes(n) ||
      !affiliation ||
      !number ||
      (a === 'unverified' && !coveredAbsence(affiliation)) ||
      (n === 'unverified' && !coveredAbsence(number)) ||
      (a === 'verified' && affiliation.issuer_institution_id !== institution) ||
      (n === 'verified' && number.issuer_institution_id !== institution)
    )
      throw new Stop('conflict');
    for (const [kind, status] of [
      ['affiliation', a],
      ['student_number', n],
    ] as const) {
      if (status !== 'unverified') continue;
      const history = await tx.query(
        "SELECT id FROM whaleu_verification.assertions WHERE account_id=$1 AND fact_kind=$2 AND assertion_state IN('verified','revoked','expired') LIMIT 1",
        [account, kind],
      );
      if (history.rowCount) throw new Stop('conflict');
    }
    return {
      locked,
      affiliation,
      number,
      affiliationCurrent: a === 'verified',
      numberCurrent: n === 'verified',
    };
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  async capability(
    token: string,
    campusId: string,
  ): Promise<InstitutionalCapability> {
    return this.guard(() =>
      this.transaction(async (tx) => {
        const actor = await this.authenticate(token, tx),
          campus = await this.campuses.resolve(campusId, tx);
        const base = {
          campusId,
          schoolName: campus.institutionName,
          capabilityVersion: null,
          consent: null,
          purpose: INSTITUTIONAL_PURPOSE,
          supportedFacts: [],
        };
        const current = await readInstitutionalBinding(campusId, tx);
        if (!current) return { ...base, state: 'provider_unconfigured' };
        if (
          !current.binding.enabled ||
          !this.provider.available(current.binding.adapter_id)
        )
          return { ...base, state: 'provider_unavailable' };
        try {
          await this.allowed(actor.accountId, tx);
        } catch (e) {
          if (
            e instanceof ApplicationError &&
            ['SAFETY_ACCESS_SUSPENDED', 'SAFETY_ACTION_RESTRICTED'].includes(
              e.code,
            )
          )
            return { ...base, state: 'account_restricted' };
          throw e;
        }
        try {
          await this.facts(actor.accountId, campus.institutionId, tx);
        } catch (e) {
          if (e instanceof Stop)
            return { ...base, state: 'verification_conflict' };
          throw e;
        }
        return {
          ...base,
          state: 'eligible',
          capabilityVersion: current.fingerprint,
          consent: INSTITUTIONAL_CONSENT,
          supportedFacts: current.binding.supports_student_number
            ? ['affiliation', 'student_number']
            : ['affiliation'],
        };
      }),
    );
  }
  @AccountPolicy('private_self_service', 'owner_after_recovery')
  async prepare(
    token: string,
    input: InstitutionalPrepare,
  ): Promise<InstitutionalReceipt> {
    institutionalPrepareSchema.parse(input);
    return this.guard(() =>
      this.transaction(async (tx) => {
        const actor = await this.authenticate(token, tx),
          hash = institutionalRequestHash(actor.accountId, input);
        await this.lock(actor.accountId, input.requestId, tx);
        const old = await this.row(actor.accountId, input.requestId, tx),
          fence = await this.fence(actor.accountId, input.requestId, tx);
        if (old) {
          if (old.request_hash !== hash) throw conflict();
          return this.receipt(old, input.requestId);
        }
        if (fence) {
          if (fence.request_hash !== hash) throw conflict();
          return fence.receipt;
        }
        await this.allowed(actor.accountId, tx);
        const active = await tx.query(
          'SELECT request_id FROM whaleu_verification.institutional_requests WHERE account_id=$1 AND state=ANY($2::text[])',
          [
            actor.accountId,
            ['prepared', 'processing', 'outcome_unknown', 'ready_to_finalize'],
          ],
        );
        if (active.rowCount) throw conflict();
        const recent = await tx.query(
          "SELECT request_id FROM whaleu_verification.institutional_requests WHERE account_id=$1 AND prepared_at>clock_timestamp()-interval '1 hour' LIMIT 5",
          [actor.accountId],
        );
        if (recent.rows.length >= 5) throw new ApplicationError('RATE_LIMITED');
        const campus = await this.campuses.resolve(input.campusId, tx),
          current = await readInstitutionalBinding(input.campusId, tx);
        if (
          !current ||
          !current.binding.enabled ||
          !this.provider.available(current.binding.adapter_id)
        )
          throw unavailable();
        const b = current.binding;
        if (
          current.fingerprint !== input.capabilityVersion ||
          b.institution_id !== campus.institutionId ||
          b.origin_region_id !== campus.regionId ||
          b.purpose !== INSTITUTIONAL_PURPOSE ||
          b.consent_version !== input.consent
        )
          throw conflict();
        await lockStudentAccount(actor.accountId, tx);
        await this.facts(actor.accountId, campus.institutionId, tx);
        const frozen: FrozenContext = {
          ...input,
          purpose: INSTITUTIONAL_PURPOSE,
          institutionId: campus.institutionId,
          originRegionId: campus.regionId,
          campusVersion: campus.version,
          bindingFingerprint: current.fingerprint,
        };
        await tx.query(
          `INSERT INTO whaleu_verification.institutional_requests(account_id,request_id,request_hash,frozen_context,binding_id,relevant_witness,request_expires_at,state) VALUES($1,$2,$3,$4::jsonb,$5,whaleu_verification.relevant_fact_witness($1),clock_timestamp(),'prepared')`,
          [
            actor.accountId,
            input.requestId,
            hash,
            JSON.stringify(frozen),
            b.id,
          ],
        );
        await requireInstitutionalCurrent(
          actor.accountId,
          input.requestId,
          null,
          tx,
        );
        return this.receipt(
          await this.row(actor.accountId, input.requestId, tx),
          input.requestId,
        );
      }),
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  async read(token: string, id: string): Promise<InstitutionalReceipt> {
    return this.guard(() =>
      this.transaction(async (tx) => {
        const actor = await this.authenticate(token, tx);
        const fence = await this.fence(actor.accountId, id, tx);
        return (
          fence?.receipt ??
          this.receipt(await this.row(actor.accountId, id, tx), id)
        );
      }),
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  async close(
    token: string,
    id: string,
    hash: string,
  ): Promise<InstitutionalReceipt> {
    institutionalHashSchema.parse(hash);
    return this.guard(() =>
      this.transaction(async (tx) => {
        const actor = await this.authenticate(token, tx);
        await this.lock(actor.accountId, id, tx);
        const row = await this.row(actor.accountId, id, tx),
          fence = await this.fence(actor.accountId, id, tx);
        if (fence) {
          if (fence.request_hash !== hash) throw conflict();
          return fence.receipt;
        }
        if (row) {
          if (row.request_hash !== hash) throw conflict();
          if (institutionalTerminalStates.has(row.state))
            return this.receipt(row, id);
          return this.finish(row, 'cancelled', tx);
        }
        const receipt: InstitutionalReceipt = {
          requestId: id,
          requestHash: hash,
          state: 'cancelled',
        };
        await tx.query(
          'INSERT INTO whaleu_verification.institutional_cancel_fences(account_id,request_id,request_hash,receipt) VALUES($1,$2,$3,$4::jsonb)',
          [actor.accountId, id, hash, JSON.stringify(receipt)],
        );
        return receipt;
      }),
    );
  }
  @AccountPolicy('private_self_service', 'owner_after_recovery')
  async complete(
    token: string,
    id: string,
    input: InstitutionalComplete,
  ): Promise<InstitutionalReceipt> {
    institutionalCompleteSchema.parse(input);
    return this.guard(async () => {
      if (input.mode === 'recover')
        return this.finalize(token, id, input.requestHash);
      const claimed = await this.transaction(async (tx) => {
        const actor = await this.authenticate(token, tx);
        await this.lock(actor.accountId, id, tx);
        const row = await this.row(actor.accountId, id, tx),
          fence = await this.fence(actor.accountId, id, tx);
        if (fence) {
          if (fence.request_hash !== input.requestHash) throw conflict();
          return { receipt: fence.receipt };
        }
        if (!row) return { receipt: this.receipt(row, id) };
        if (row.request_hash !== input.requestHash) throw conflict();
        if (row.state !== 'prepared') return { receipt: this.receipt(row, id) };
        if (!row.request_current)
          return { receipt: await this.finish(row, 'expired', tx) };
        await this.allowed(actor.accountId, tx);
        try {
          const binding = await this.currentBinding(row, tx);
          await lockStudentAccount(actor.accountId, tx);
          await this.facts(actor.accountId, binding.institution_id, tx);
          await this.witness(row, tx);
          await tx.query(
            "UPDATE whaleu_verification.institutional_requests SET state='processing',claim_id=$3,session_id=$4,revision=revision+1 WHERE account_id=$1 AND request_id=$2",
            [actor.accountId, id, randomUUID(), actor.sessionId],
          );
          const claimed = (await this.row(actor.accountId, id, tx))!;
          registerTransactionExactDeadline(
            tx,
            claimed.request_expires_at,
            'INSTITUTIONAL_SSO_UNAVAILABLE',
          );
          await requireInstitutionalCurrent(actor.accountId, id, null, tx);
          return { context: this.context(claimed, binding) };
        } catch (e) {
          if (e instanceof Stop)
            return { receipt: await this.finish(row, e.state, tx) };
          throw e;
        }
      });
      if ('receipt' in claimed) return claimed.receipt!;
      // Claim is committed before the only trusted external call. No database lock spans it.
      const transientResponse = { value: input.authorizationResponse };
      input.authorizationResponse = '';
      let accepted;
      try {
        accepted = await this.provider.verifyResponse(
          transientResponse.value,
          claimed.context,
        );
      } finally {
        transientResponse.value = '';
      }
      if (accepted.state !== 'accepted')
        return this.transaction(async (tx) => {
          const actor = await this.authenticate(token, tx);
          await this.lock(actor.accountId, id, tx);
          const row = await this.row(actor.accountId, id, tx);
          if (
            !row ||
            row.state !== 'processing' ||
            row.claim_id !== claimed.context.claimId
          )
            return this.receipt(row, id);
          if (
            accepted.state === 'outcome_unknown' ||
            !row.claim_current ||
            !row.request_current
          ) {
            await tx.query(
              "UPDATE whaleu_verification.institutional_requests SET state='outcome_unknown',revision=revision+1 WHERE account_id=$1 AND request_id=$2",
              [actor.accountId, id],
            );
            return this.receipt(await this.row(actor.accountId, id, tx), id);
          }
          return this.finish(row, accepted.state, tx);
        });
      const transientProof: { value: InstitutionalVerifiedPayload | null } = {
        value: this.provider.consume(accepted.capability, claimed.context),
      };
      if (!transientProof.value) throw unavailable();
      try {
        const admitted = await this.admit(
          token,
          id,
          input.requestHash,
          claimed.context,
          transientProof.value,
        );
        if (admitted.state !== 'ready_to_finalize') return admitted;
      } finally {
        transientProof.value = null;
      }
      return this.finalize(token, id, input.requestHash);
    });
  }
  private async admit(
    token: string,
    id: string,
    hash: string,
    context: InstitutionalProviderContext,
    payload: InstitutionalVerifiedPayload,
  ): Promise<InstitutionalReceipt> {
    return this.transaction(async (tx) => {
      const actor = await this.authenticate(token, tx);
      await this.lock(actor.accountId, id, tx);
      const row = await this.row(actor.accountId, id, tx);
      if (!row || row.state !== 'processing') return this.receipt(row, id);
      if (
        row.request_hash !== hash ||
        row.claim_id !== context.claimId ||
        row.session_id !== actor.sessionId
      )
        throw conflict();
      if (!row.claim_current || !row.request_current) {
        await tx.query(
          "UPDATE whaleu_verification.institutional_requests SET state='outcome_unknown',revision=revision+1 WHERE account_id=$1 AND request_id=$2",
          [actor.accountId, id],
        );
        return this.receipt(await this.row(actor.accountId, id, tx), id);
      }
      await this.allowed(actor.accountId, tx);
      try {
        const binding = await this.currentBinding(row, tx);
        await lockStudentAccount(actor.accountId, tx);
        const facts = await this.facts(
          actor.accountId,
          binding.institution_id,
          tx,
        );
        await this.witness(row, tx);
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:institutional-subject:v1:'||$1||':'||$2,0))",
          [payload.issuerNamespace, payload.subject],
        );
        const subjects = (
          await tx.query<{ provider_subject: string; account_id: string }>(
            'SELECT provider_subject,account_id FROM whaleu_verification.institutional_subjects WHERE issuer_namespace=$1 AND (provider_subject=$2 OR account_id=$3)',
            [payload.issuerNamespace, payload.subject, actor.accountId],
          )
        ).rows;
        if (
          subjects.some(
            (s) =>
              s.provider_subject !== payload.subject ||
              s.account_id !== actor.accountId,
          )
        )
          throw new Stop('conflict');
        if (!subjects.length) {
          const history = await tx.query(
            "SELECT id FROM whaleu_verification.assertions WHERE account_id=$1 AND fact_kind='student_number' AND (student_number IS NOT NULL OR assertion_state IN('verified','revoked','expired')) LIMIT 1",
            [actor.accountId],
          );
          if (history.rowCount) throw new Stop('conflict');
        }
        if (
          facts.numberCurrent &&
          payload.studentNumber !== null &&
          facts.number.student_number !== payload.studentNumber
        )
          throw new Stop('conflict');
        const resultId = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_verification.institutional_results(id,account_id,request_id,claim_id,binding_id,issuer_namespace,provider_subject,institution_id,origin_region_id,policy_reference,student_number,authenticated_at,response_use_expires_at,fact_expires_at,evidence_digest,finalize_deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz,$14::timestamptz,$15,clock_timestamp())`,
          [
            resultId,
            actor.accountId,
            id,
            row.claim_id,
            row.binding_id,
            payload.issuerNamespace,
            payload.subject,
            payload.institutionId,
            payload.originRegionId,
            payload.policyReference,
            payload.studentNumber,
            payload.authenticatedAt,
            payload.responseUseExpiresAt,
            payload.factExpiresAt,
            payload.evidenceDigest,
          ],
        );
        if (!subjects.length)
          await tx.query(
            'INSERT INTO whaleu_verification.institutional_subjects(issuer_namespace,provider_subject,account_id,first_result_id) VALUES($1,$2,$3,$4)',
            [
              payload.issuerNamespace,
              payload.subject,
              actor.accountId,
              resultId,
            ],
          );
        await tx.query(
          "UPDATE whaleu_verification.institutional_requests SET state='ready_to_finalize',result_id=$3,revision=revision+1 WHERE account_id=$1 AND request_id=$2",
          [actor.accountId, id, resultId],
        );
        for (const deadline of [
          row.request_expires_at,
          row.claim_deadline,
          payload.responseUseExpiresAt,
          payload.factExpiresAt,
        ])
          registerTransactionExactDeadline(
            tx,
            deadline,
            'INSTITUTIONAL_SSO_UNAVAILABLE',
          );
        await requireInstitutionalCurrent(actor.accountId, id, null, tx);
        return this.receipt(await this.row(actor.accountId, id, tx), id);
      } catch (e) {
        if (e instanceof Stop) return this.finish(row, e.state, tx);
        throw e;
      }
    });
  }
  private async finalize(
    token: string,
    id: string,
    hash: string,
  ): Promise<InstitutionalReceipt> {
    try {
      return await this.transaction(async (tx) => {
        const actor = await this.authenticate(token, tx);
        await this.lock(actor.accountId, id, tx);
        const row = await this.row(actor.accountId, id, tx),
          fence = await this.fence(actor.accountId, id, tx);
        if (fence) {
          if (fence.request_hash !== hash) throw conflict();
          return fence.receipt;
        }
        if (!row) return this.receipt(row, id);
        if (row.request_hash !== hash) throw conflict();
        if (row.state === 'prepared' && !row.request_current)
          return this.finish(row, 'expired', tx);
        if (row.state !== 'ready_to_finalize') return this.receipt(row, id);
        if (!row.finalize_current) return this.finish(row, 'expired', tx);
        if (row.session_id !== actor.sessionId) throw conflict();
        await this.allowed(actor.accountId, tx);
        const binding = await this.currentBinding(row, tx);
        // First DB-owned V0 and native absence are captured before Verification/UID waits.
        const generation = await this.verification.observeGeneration(
            tx,
            actor.accountId,
          ),
          absence = await this.uids.coverage.observeNativeAbsence(
            actor.accountId,
            tx,
          );
        await lockStudentAccount(actor.accountId, tx);
        const facts = await this.facts(
          actor.accountId,
          binding.institution_id,
          tx,
        );
        await this.witness(row, tx);
        const result = (
          await tx.query<ResultRow>(
            'SELECT id,provider_subject,issuer_namespace,student_number,authenticated_at::text,fact_expires_at::text,finalize_deadline::text FROM whaleu_verification.institutional_results WHERE id=$1',
            [row.result_id],
          )
        ).rows[0];
        if (!result) throw unavailable();
        if (
          facts.numberCurrent &&
          result.student_number !== null &&
          facts.number.student_number !== result.student_number
        )
          throw new Stop('conflict');
        const uidLocked = await this.uids.lockAccount(actor.accountId, tx);
        await this.uids.lockInstitutions(
          [
            binding.institution_id,
            ...(uidLocked.head ? [uidLocked.head.institution_id] : []),
          ],
          tx,
        );
        const completion = randomUUID(),
          cause = randomUUID(),
          snapshot = randomUUID(),
          event = randomUUID(),
          uidEvent = randomUUID();
        const newAffiliation = facts.affiliationCurrent ? null : randomUUID(),
          newNumber =
            !facts.numberCurrent && result.student_number !== null
              ? randomUUID()
              : null;
        const affiliation = newAffiliation ?? facts.affiliation.id,
          number = newNumber ?? facts.number.id;
        await tx.query(
          `INSERT INTO whaleu_verification.institutional_completions(id,account_id,request_id,result_id,cause_id,old_head,old_snapshot,relevant_witness,new_affiliation_assertion_id,new_student_number_assertion_id,affiliation_assertion_id,student_number_assertion_id,snapshot_id,event_id) SELECT $1,$2,$3,$4,$5,to_jsonb(h),to_jsonb(s),$6::jsonb,$7,$8,$9,$10,$11,$12 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision) WHERE h.account_id=$2`,
          [
            completion,
            actor.accountId,
            id,
            result.id,
            cause,
            JSON.stringify(row.relevant_witness),
            newAffiliation,
            newNumber,
            affiliation,
            number,
            snapshot,
            event,
          ],
        );
        await this.uids.registerCause(
          {
            id: cause,
            kind: 'institutional_sso',
            account: actor.accountId,
            actor: actor.accountId,
            sourceId: completion,
            institutionId: binding.institution_id,
            assertionId: affiliation,
            snapshotId: snapshot,
            verificationEventId: event,
            oldSnapshotId: facts.locked.head.snapshot_id!,
            oldRevision: facts.locked.head.revision,
            coverageObservationId: absence.id,
          },
          tx,
        );
        await this.verification.registerGeneration(cause, generation, tx);
        for (const [kind, newId, previous] of [
          ['affiliation', newAffiliation, facts.affiliation.id],
          ['student_number', newNumber, facts.number.id],
        ] as const) {
          if (newId)
            await tx.query(
              `INSERT INTO whaleu_verification.assertions(id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,issuer_institution_id,source_issuer_institution_id,origin_region_id,student_number,verified_at,expiry_kind,expires_at,previous_assertion_id) SELECT $1,r.account_id,$2,'verified','complete','accepted','institutional_sso','institutional_sso:'||$3::text,r.policy_reference,r.account_id,r.institution_id,r.institution_id,r.origin_region_id,CASE WHEN $2='student_number' THEN r.student_number ELSE NULL END,r.authenticated_at,'at',r.fact_expires_at,$4 FROM whaleu_verification.institutional_results r WHERE r.id=$5`,
              [newId, kind, completion, previous, result.id],
            );
        }
        await this.appendSnapshot(
          actor.accountId,
          id,
          facts.locked.prior,
          snapshot,
          event,
          affiliation,
          number,
          tx,
        );
        const uid = await this.uids.produce(
          { causeId: cause, eventId: uidEvent, coverageObservation: absence },
          tx,
        );
        await this.uids.recordInstitutionalResult(cause, uidEvent, tx);
        const receipt: InstitutionalReceipt = {
          requestId: id,
          requestHash: hash,
          state: 'completed',
          changedFacts: [
            ...(newAffiliation ? ['affiliation' as const] : []),
            ...(newNumber ? ['student_number' as const] : []),
          ],
          uidOutcome: uid.outcome,
          uidReason: uid.unavailableReason,
        };
        await tx.query(
          "UPDATE whaleu_verification.institutional_requests SET state='completed',completion_id=$3,receipt=$4::jsonb,revision=revision+1 WHERE account_id=$1 AND request_id=$2",
          [actor.accountId, id, completion, JSON.stringify(receipt)],
        );
        await requireUidCauseCurrent(cause, tx);
        await requireInstitutionalCurrent(actor.accountId, id, completion, tx);
        for (const deadline of [
          row.request_expires_at,
          result.finalize_deadline,
          result.fact_expires_at,
          ...(facts.affiliationCurrent ? [facts.affiliation.exact_expiry] : []),
          ...(facts.numberCurrent ? [facts.number.exact_expiry] : []),
        ])
          registerTransactionExactDeadline(
            tx,
            deadline,
            'INSTITUTIONAL_SSO_UNAVAILABLE',
          );
        return receipt;
      });
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      // Roll back the first-observation transaction before recording a no-write terminal result.
      return this.transaction(async (tx) => {
        const actor = await this.authenticate(token, tx);
        await this.lock(actor.accountId, id, tx);
        const row = await this.row(actor.accountId, id, tx);
        if (!row || row.state !== 'ready_to_finalize')
          return this.receipt(row, id);
        if (row.request_hash !== hash) throw conflict();
        return this.finish(row, e.state, tx);
      });
    }
  }
  private async appendSnapshot(
    account: string,
    operation: string,
    prior: SnapshotRecord,
    snapshot: string,
    event: string,
    affiliation: string,
    number: string,
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        snapshot,
        account,
        prior.revision + 1,
        affiliation,
        number,
        prior.phone_assertion_id,
        prior.application_state,
        prior.application_coverage,
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,fact_kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code) VALUES($1,$2,$3,'institutional_sso',NULL,$2,$4,$5,$6,'institutional_verified')",
      [event, account, operation, prior.revision, snapshot, prior.revision + 1],
    );
    const changed = await tx.query(
      'UPDATE whaleu_verification.account_heads SET revision=$2,snapshot_id=$3 WHERE account_id=$1 AND revision=$4 AND snapshot_id=$5',
      [account, prior.revision + 1, snapshot, prior.revision, prior.id],
    );
    if (changed.rowCount !== 1) throw unavailable();
  }
}
