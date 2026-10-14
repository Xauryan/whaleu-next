import { Inject, Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import {
  registerTransactionDeadline,
  transactionResultExpiry,
} from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { RatingsAccessService } from '../access.js';
import { RatingAssistanceQualification } from './qualification.js';
import {
  RatingAssistanceRepository,
  type AssistanceClaim,
  type AssistanceAccountingClaim,
} from './repository.js';
import {
  boundedAssistance,
  decodeAssistanceAck,
  dispatchAssistance,
  type AssistanceAck,
  type AssistanceRuntime,
} from './provider.js';
import * as C from './contracts.js';

@Injectable()
export class RatingAssistanceService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingAssistanceQualification)
    private readonly qualification: RatingAssistanceQualification,
    @Inject(RatingAssistanceRepository)
    private readonly records: RatingAssistanceRepository,
    @Inject(C.ASSISTANCE_RUNTIME)
    private readonly runtime: AssistanceRuntime | null,
  ) {}
  private run<T>(fn: (tx: PoolClient) => Promise<T>) {
    return this.db.transaction(fn, { isolationLevel: 'read committed' });
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  async create(token: string, raw: C.AssistanceRequest) {
    const request = C.assistanceRequestSchema.parse(raw),
      hash = C.assistanceIntentHash(request);
    const admitted = await this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx);
      const old = await this.records.bind(
        session.accountId,
        request.requestId,
        request.purpose,
        hash,
        tx,
      );
      if (old) {
        await this.access.recheck(token, tx);
        return old;
      }
      const qualified = await this.qualification.qualify(token, request, tx);
      if (
        qualified.accountId !== session.accountId ||
        qualified.sessionId !== session.sessionId
      )
        throw new ApplicationError('RATING_ASSISTANCE_UNAVAILABLE');
      if (
        this.runtime?.mode !== 'synthetic-only' ||
        this.runtime.profile !== C.ASSISTANCE_PROFILE
      ) {
        const result = await this.records.finish(
          session.accountId,
          request.requestId,
          'unavailable',
          tx,
        );
        await this.access.recheck(token, tx);
        return result;
      }
      const measured = this.runtime.measure(qualified.input);
      if (
        !Number.isSafeInteger(measured) ||
        measured < 0 ||
        measured > C.ASSISTANCE_LIMITS.inputTokens
      )
        throw new ApplicationError('RATING_ASSISTANCE_UNAVAILABLE');
      await this.records.admit(
        session.accountId,
        session.sessionId,
        request,
        qualified.input,
        qualified.sourceRevision,
        qualified.sourceBinding,
        tx,
      );
      await this.access.recheck(token, tx);
      return (await this.records.metadata(
        session.accountId,
        request.requestId,
        tx,
      ))!;
    });
    // Admission is committed before any synthetic provider boundary. The token
    // remains in this invocation only; it is never stored in a job or provider.
    if (
      ['queued', 'claimed', 'dispatch_admitted', 'outcome_unknown'].includes(
        admitted.outcome,
      )
    )
      await this.process(token, request.requestId);
    return this.status(token, request.requestId);
  }
  @AccountPolicy('private_self_service', 'entry')
  status(token: string, id: string) {
    C.assistanceRequestIdSchema.parse(id);
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx);
      await this.records.expireUndispatched(session.accountId, id, tx);
      const result = await this.records.metadata(session.accountId, id, tx);
      if (!result) throw new ApplicationError('RATING_ASSISTANCE_NOT_FOUND');
      await this.access.recheck(token, tx);
      return result;
    });
  }
  @AccountPolicy('protective_cleanup', 'entry')
  cancel(
    token: string,
    id: string,
    raw: { purpose: C.AssistancePurpose; intentHash: string },
  ) {
    C.assistanceRequestIdSchema.parse(id);
    const input = C.assistanceCancelSchema.parse(raw);
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx);
      await this.records.bind(
        session.accountId,
        id,
        input.purpose,
        input.intentHash,
        tx,
      );
      await this.records.cancelVisibility(session.accountId, id, tx);
      const result = await this.records.finish(
        session.accountId,
        id,
        'cancelled',
        tx,
      );
      await this.access.recheck(token, tx);
      return result;
    });
  }
  @AccountPolicy('interaction', 'entry')
  result(token: string, id: string) {
    C.assistanceRequestIdSchema.parse(id);
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx);
      await this.records.lock(session.accountId, id, tx);
      const record = await this.records.record(session.accountId, id, tx);
      if (!record)
        return C.assistanceResultSchema.parse({ status: 'unavailable' });
      const plain = await this.records.result(session.accountId, id, tx);
      if (!plain)
        return C.assistanceResultSchema.parse({ status: 'unavailable' });
      const qualified = await this.qualification.qualify(
        token,
        C.assistanceRequestSchema.parse(record.intent),
        tx,
      );
      if (
        qualified.accountId !== record.account_id ||
        C.assistanceInputDigest(qualified.input, qualified.sourceRevision) !==
          record.input_digest
      )
        return C.assistanceResultSchema.parse({ status: 'unavailable' });
      registerTransactionDeadline(
        tx,
        record.payload_until.getTime(),
        'RATING_ASSISTANCE_UNAVAILABLE',
      );
      await this.access.recheck(token, tx);
      return C.assistanceResultSchema.parse({
        status: 'available',
        version: 1,
        actorId: session.accountId,
        requestId: id,
        purpose: record.purpose,
        draftId: record.draft_id,
        inputRevision: record.input_revision,
        intentHash: record.intent_hash,
        inputDigest: record.input_digest,
        resultId: plain.result_id,
        resultDigest: plain.result_digest,
        profileRevision: record.profile,
        outputContract: 1,
        text: plain.literal_text,
        expiresAt: new Date(
          transactionResultExpiry(tx, record.payload_until.getTime()),
        ).toISOString(),
      });
    });
  }
  private key(
    claim: Pick<AssistanceAccountingClaim, 'account_id' | 'request_id'>,
  ) {
    return createHash('sha256')
      .update(
        `whaleu:rating-assistance-provider-key:v1\n${claim.account_id}\n${claim.request_id}`,
      )
      .digest('hex');
  }
  private async current(token: string, claim: AssistanceClaim, tx: PoolClient) {
    await this.records.current(claim, tx);
    const qualified = await this.qualification.qualify(
      token,
      C.assistanceRequestSchema.parse(claim.intent),
      tx,
    );
    if (
      qualified.accountId !== claim.account_id ||
      qualified.sessionId !== claim.session_id ||
      C.assistanceInputDigest(qualified.input, qualified.sourceRevision) !==
        claim.input_digest
    )
      throw new ApplicationError('RATING_ASSISTANCE_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      claim.lease_until.getTime(),
      'RATING_ASSISTANCE_UNAVAILABLE',
    );
    await this.access.recheck(token, tx);
    return qualified;
  }
  /** Manual bounded synthetic worker. No scheduled task, timer or real adapter
   * is installed. Expired original sessions cannot be replaced for dispatch. */
  @AccountPolicy('interaction', 'entry')
  async process(token: string, id: string): Promise<void> {
    if (
      this.runtime?.mode !== 'synthetic-only' ||
      this.runtime.profile !== C.ASSISTANCE_PROFILE
    )
      return;
    const runtime = this.runtime;
    const claim = await this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx);
      const r = await this.records.record(session.accountId, id, tx);
      if (!r || r.session_id !== session.sessionId) return null;
      return this.records.claim(session.accountId, id, tx);
    });
    if (!claim) return;
    const key = this.key(claim);
    if (claim.attempt > 0) {
      // A previous effect exists. Recovery is status-only and cannot resend.
      const admitted = await this.run((tx) =>
        this.records.reconcileAdmission(claim, tx),
      );
      if (!admitted) {
        await this.run((tx) =>
          this.records.settle(
            claim,
            claim.attempt,
            'conservatively_charged',
            { inputTokens: 512, outputTokens: 64, monetaryMinorUnits: 0 },
            tx,
          ),
        );
        await this.run((tx) =>
          this.records.finishClaim(claim, 'unavailable', tx),
        );
        return;
      }
      let ack: AssistanceAck = { status: 'unknown' };
      try {
        ack = decodeAssistanceAck(
          await boundedAssistance(runtime.reconcile(key, claim.input_digest)),
          key,
          claim.input_digest,
        );
      } catch {
        /* Keep worst-case reservation. */
      }
      await this.account(claim, claim.attempt, ack);
      if (ack.status === 'unknown')
        await this.run((tx) => this.records.unknown(claim, tx));
      else
        await this.run((tx) =>
          this.records.finishClaim(claim, 'unavailable', tx),
        );
      return;
    }
    let prepared;
    try {
      prepared = await boundedAssistance(
        runtime.prepare(key, claim.input_digest),
      );
    } catch {
      await this.run((tx) =>
        this.records.finishClaim(claim, 'unavailable', tx),
      );
      return;
    }
    const expiresAt = performance.now() + C.ASSISTANCE_LIMITS.dispatchMs;
    let dispatch: { attempt: number; deadline: number };
    try {
      dispatch = await this.run(async (tx) => {
        await this.current(token, claim, tx);
        if (
          prepared.key !== key ||
          prepared.inputDigest !== claim.input_digest ||
          prepared.profile !== C.ASSISTANCE_PROFILE
        )
          throw new ApplicationError('RATING_ASSISTANCE_UNAVAILABLE');
        return this.records.dispatch(claim, tx);
      });
    } catch {
      await this.run((tx) =>
        this.records.finishClaim(claim, 'unavailable', tx),
      );
      return;
    }
    let ack: AssistanceAck = { status: 'unknown' };
    try {
      ack = decodeAssistanceAck(
        dispatchAssistance(
          prepared,
          Object.freeze({
            key,
            inputDigest: claim.input_digest,
            profile: C.ASSISTANCE_PROFILE,
            input: Object.freeze({ ...claim.provider_input }),
            expiresAt,
          }),
        ),
        key,
        claim.input_digest,
      );
    } catch {
      /* Dispatch intent already durably unknown. Never blind retry. */
    }
    await this.account(claim, dispatch.attempt, ack);
    if (ack.status === 'unknown') {
      await this.run((tx) => this.records.unknown(claim, tx));
      return;
    }
    if (ack.status === 'not_accepted') {
      await this.run((tx) =>
        this.records.finishClaim(claim, 'unavailable', tx),
      );
      return;
    }
    const accepted = ack;
    if (
      !C.validAssistanceOutput(claim.purpose, accepted.text) ||
      performance.now() >= expiresAt
    ) {
      await this.run((tx) => this.records.finishClaim(claim, 'rejected', tx));
      return;
    }
    try {
      await this.run(async (tx) => {
        await this.current(token, claim, tx);
        registerTransactionDeadline(
          tx,
          dispatch.deadline,
          'RATING_ASSISTANCE_UNAVAILABLE',
        );
        await this.records.generated(
          claim,
          dispatch.attempt,
          accepted.text,
          tx,
        );
      });
    } catch {
      // Provider accounting committed independently. Revocation/cancellation or
      // an uncertain DB result never releases it or retries the generation.
      await this.run((tx) =>
        this.records.finishClaim(claim, 'unavailable', tx),
      );
    }
  }
  private async account(
    claim: AssistanceAccountingClaim,
    attempt: number,
    ack: AssistanceAck,
  ) {
    if (ack.status === 'unknown') return;
    await this.run((tx) =>
      this.records.settle(
        claim,
        attempt,
        ack.status,
        ack.status === 'accepted'
          ? ack.usage
          : { inputTokens: 0, outputTokens: 0, monetaryMinorUnits: 0 },
        tx,
      ),
    );
  }
  /** Accounting survives cancellation and plaintext cleanup. Status-only work
   * uses opaque original keys and never requalifies an old session to dispatch. */
  async reconcilePending(): Promise<number> {
    if (
      this.runtime?.mode !== 'synthetic-only' ||
      this.runtime.profile !== C.ASSISTANCE_PROFILE
    )
      return 0;
    const runtime = this.runtime;
    const pending = await this.run((tx) => this.records.unsettled(tx));
    for (const claim of pending) {
      const admitted = await this.run((tx) =>
        this.records.reconcileAdmission(claim, tx),
      );
      if (!admitted) {
        await this.run((tx) =>
          this.records.settle(
            claim,
            claim.attempt,
            'conservatively_charged',
            { inputTokens: 512, outputTokens: 64, monetaryMinorUnits: 0 },
            tx,
          ),
        );
        await this.run((tx) => this.records.finishAccounting(claim, tx));
        continue;
      }
      const key = this.key(claim);
      let ack: AssistanceAck = { status: 'unknown' };
      try {
        ack = decodeAssistanceAck(
          await boundedAssistance(runtime.reconcile(key, claim.input_digest)),
          key,
          claim.input_digest,
        );
      } catch {
        /* Reservation remains held. */
      }
      await this.account(claim, claim.attempt, ack);
      if (ack.status !== 'unknown')
        await this.run((tx) => this.records.finishAccounting(claim, tx));
    }
    return pending.length;
  }
  cleanup() {
    return this.run((tx) => this.records.cleanup(tx));
  }
}
