import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';
import { DatabaseService } from '../database/database.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import type { SnapshotRecord } from './contracts.js';
import {
  WECHAT_PHONE_PROVIDER,
  type PhoneProvider,
} from './wechat-phone-provider.js';

export const PHONE_CONSENT = 'wechat-phone-verification-v1' as const;
export interface PhoneReceipt {
  readonly requestId: string;
  readonly state:
    | 'reserved'
    | 'processing'
    | 'unknown'
    | 'verified'
    | 'closed'
    | 'expired'
    | 'not_found';
}
interface RequestRow {
  account_id: string;
  request_id: string;
  app_id: string;
  state: 'reserved' | 'claimed' | 'unknown' | 'verified' | 'closed';
  replaces_request_id: string | null;
  created_at: Date;
  claim_deadline: Date | null;
  claimed_session_id: string | null;
  base_revision: number | null;
}
const projection =
  'account_id,request_id,app_id,state,replaces_request_id,created_at,claim_deadline,claimed_session_id,base_revision';
const unavailable = () => new ApplicationError('VERIFICATION_UNAVAILABLE');
function receipt(
  row: RequestRow | undefined,
  id: string,
  now: number,
): PhoneReceipt {
  if (!row) return { requestId: id, state: 'not_found' };
  return {
    requestId: id,
    state:
      row.state === 'claimed'
        ? row.claim_deadline && row.claim_deadline.getTime() > now
          ? 'processing'
          : 'unknown'
        : row.state === 'reserved' && row.created_at.getTime() + 300_000 <= now
          ? 'expired'
          : row.state,
  };
}
@Injectable()
export class PhoneBindingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(WECHAT_PHONE_PROVIDER) private readonly provider: PhoneProvider,
  ) {}
  private enabled() {
    if (
      this.config.WECHAT_PHONE_BINDING !== 'enabled' ||
      !this.config.WECHAT_APP_ID ||
      !this.config.WECHAT_PHONE_PROOF_TTL_SECONDS
    )
      throw unavailable();
  }
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    }
  }
  private async now(tx: PoolClient): Promise<number> {
    return (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now.getTime();
  }
  private async lock(account: string, tx: PoolClient) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `phone-binding:${account}`,
    ]);
  }
  private async row(account: string, id: string, tx: PoolClient, lock = false) {
    return (
      await tx.query<RequestRow>(
        `SELECT ${projection} FROM whaleu_verification.phone_requests WHERE account_id=$1 AND request_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [account, id],
      )
    ).rows[0];
  }
  async reserve(
    token: string,
    id: string,
    replaces: string | null,
  ): Promise<PhoneReceipt> {
    this.enabled();
    return this.guard(() =>
      this.database.transaction(async (tx) => {
        const actor = await this.identity.session(token, tx);
        await this.lock(actor.accountId, tx);
        const old = await this.row(actor.accountId, id, tx, true);
        if (old) {
          if (old.replaces_request_id !== replaces) throw unavailable();
          return receipt(old, id, await this.now(tx));
        }
        if (
          !(await this.identity.wechatAppAccount(
            actor.accountId,
            this.config.WECHAT_APP_ID!,
            tx,
          ))
        )
          throw unavailable();
        const active = (
          await tx.query<RequestRow>(
            `SELECT ${projection} FROM whaleu_verification.phone_requests WHERE account_id=$1 AND state IN ('reserved','claimed','unknown') FOR UPDATE`,
            [actor.accountId],
          )
        ).rows[0];
        if (active && active.request_id !== replaces) throw unavailable();
        if (replaces) {
          const prior = await this.row(actor.accountId, replaces, tx, true);
          if (
            !prior ||
            ['verified', 'processing'].includes(
              receipt(prior, replaces, await this.now(tx)).state,
            )
          )
            throw unavailable();
          if (prior.state !== 'closed')
            await tx.query(
              "UPDATE whaleu_verification.phone_requests SET state='closed' WHERE account_id=$1 AND request_id=$2",
              [actor.accountId, replaces],
            );
        }
        const recent = await tx.query(
          "SELECT request_id FROM whaleu_verification.phone_requests WHERE account_id=$1 AND created_at>clock_timestamp()-interval '1 hour' LIMIT 5",
          [actor.accountId],
        );
        if (recent.rows.length >= 5) throw new ApplicationError('RATE_LIMITED');
        const inserted = (
          await tx.query<RequestRow>(
            `INSERT INTO whaleu_verification.phone_requests(account_id,request_id,app_id,consent,replaces_request_id) VALUES($1,$2,$3,$4,$5) RETURNING ${projection}`,
            [
              actor.accountId,
              id,
              this.config.WECHAT_APP_ID,
              PHONE_CONSENT,
              replaces,
            ],
          )
        ).rows[0]!;
        await this.identity.session(token, tx);
        return receipt(inserted, id, await this.now(tx));
      }),
    );
  }
  async read(token: string, id: string): Promise<PhoneReceipt> {
    return this.guard(() =>
      this.database.transaction(async (tx) => {
        const actor = await this.identity.session(token, tx);
        const row = await this.row(actor.accountId, id, tx);
        await this.identity.session(token, tx);
        return receipt(row, id, await this.now(tx));
      }),
    );
  }
  async close(token: string, id: string): Promise<PhoneReceipt> {
    return this.guard(() =>
      this.database.transaction(async (tx) => {
        const actor = await this.identity.session(token, tx);
        await this.lock(actor.accountId, tx);
        const row = await this.row(actor.accountId, id, tx, true);
        if (!row) return receipt(undefined, id, await this.now(tx));
        if (
          !['verified', 'closed', 'processing'].includes(
            receipt(row, id, await this.now(tx)).state,
          )
        ) {
          await tx.query(
            "UPDATE whaleu_verification.phone_requests SET state='closed' WHERE account_id=$1 AND request_id=$2",
            [actor.accountId, id],
          );
          row.state = 'closed';
        }
        await this.identity.session(token, tx);
        return receipt(row, id, await this.now(tx));
      }),
    );
  }
  async authorize(
    token: string,
    id: string,
    code: string,
  ): Promise<PhoneReceipt> {
    this.enabled();
    const claim = await this.guard(() =>
      this.database.transaction(async (tx) => {
        const actor = await this.identity.session(token, tx);
        await this.lock(actor.accountId, tx);
        const row = await this.row(actor.accountId, id, tx, true);
        if (!row || receipt(row, id, await this.now(tx)).state !== 'reserved')
          return {
            actor,
            dispatch: false,
            result: receipt(row, id, await this.now(tx)),
          };
        if (
          row.app_id !== this.config.WECHAT_APP_ID ||
          !(await this.identity.wechatAppAccount(
            actor.accountId,
            row.app_id,
            tx,
          ))
        )
          throw unavailable();
        const head = (
          await tx.query<{ revision: number }>(
            'SELECT revision FROM whaleu_verification.account_heads WHERE account_id=$1 FOR UPDATE',
            [actor.accountId],
          )
        ).rows[0];
        await tx.query(
          "UPDATE whaleu_verification.phone_requests SET state='claimed',base_revision=$3,claimed_session_id=$4 WHERE account_id=$1 AND request_id=$2",
          [actor.accountId, id, head?.revision ?? 0, actor.sessionId],
        );
        await this.identity.session(token, tx);
        return {
          actor,
          dispatch: true,
          result: { requestId: id, state: 'processing' } as PhoneReceipt,
        };
      }),
    );
    if (!claim.dispatch) return claim.result;
    // Claim committed BEFORE dispatch. Every retry/other process now only recovers.
    // A crash after this point leaves claimed/unknown; it never replays this code.
    try {
      const proof = await this.provider.exchange(code);
      return await this.guard(() =>
        this.database.transaction(async (tx) => {
          const actor = await this.identity.session(token, tx);
          if (
            actor.accountId !== claim.actor.accountId ||
            actor.sessionId !== claim.actor.sessionId
          )
            throw unavailable();
          await this.lock(actor.accountId, tx);
          const row = await this.row(actor.accountId, id, tx, true);
          const now = await this.now(tx);
          if (
            !row ||
            row.state !== 'claimed' ||
            !row.claim_deadline ||
            row.claim_deadline.getTime() <= now ||
            proof.appId !== row.app_id ||
            !(await this.identity.wechatAppAccount(
              actor.accountId,
              row.app_id,
              tx,
            ))
          )
            throw unavailable();
          registerTransactionDeadline(
            tx,
            row.claim_deadline.getTime(),
            'VERIFICATION_UNAVAILABLE',
          );
          await tx.query(
            'INSERT INTO whaleu_verification.account_heads(account_id) VALUES($1) ON CONFLICT DO NOTHING',
            [actor.accountId],
          );
          const head = (
            await tx.query<{ revision: number; snapshot_id: string | null }>(
              'SELECT revision,snapshot_id FROM whaleu_verification.account_heads WHERE account_id=$1 FOR UPDATE',
              [actor.accountId],
            )
          ).rows[0]!;
          const prior = head.snapshot_id
            ? (
                await tx.query<SnapshotRecord>(
                  'SELECT * FROM whaleu_verification.snapshots WHERE id=$1 AND account_id=$2',
                  [head.snapshot_id, actor.accountId],
                )
              ).rows[0]
            : undefined;
          if (head.snapshot_id && !prior) throw unavailable();
          // Other independent writers may append while the provider is running.
          // A changed phone pointer conflicts; affiliation/application updates do not.
          const base =
            row.base_revision && row.base_revision > 0
              ? (
                  await tx.query<{ phone_assertion_id: string | null }>(
                    'SELECT phone_assertion_id FROM whaleu_verification.snapshots WHERE account_id=$1 AND revision=$2',
                    [actor.accountId, row.base_revision],
                  )
                ).rows[0]
              : undefined;
          if (
            (row.base_revision !== 0 && !base) ||
            (base?.phone_assertion_id ?? null) !==
              (prior?.phone_assertion_id ?? null)
          )
            throw unavailable();

          const proofId = randomUUID(),
            assertion = randomUUID(),
            snapshot = randomUUID(),
            event = randomUUID();
          await tx.query(
            `INSERT INTO whaleu_verification.phone_proofs(id,account_id,request_id,app_id,authorized_at,valid_until,assertion_id,snapshot_id,event_id,revision)
          VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 second',$7,$8,$9,$10)`,
            [
              proofId,
              actor.accountId,
              id,
              row.app_id,
              new Date(proof.authorizedAt),
              this.config.WECHAT_PHONE_PROOF_TTL_SECONDS,
              assertion,
              snapshot,
              event,
              head.revision + 1,
            ],
          );
          // Keep the protected proof's exact PostgreSQL timestamps in PostgreSQL.
          // A JS Date round-trip truncates microseconds and violates the exact
          // proof/assertion guard even when provider authorization really succeeded.
          const inserted = await tx.query(
            `INSERT INTO whaleu_verification.assertions(id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,phone_binding_reference,verified_at,expiry_kind,expires_at,previous_assertion_id)
          SELECT assertion_id,account_id,'phone','verified','complete','accepted','phone_provider',
            'wechat_phone_request:'||request_id::text,'wechat-phone-authorization/v1',account_id,id,verified_at,'at',valid_until,$4
          FROM whaleu_verification.phone_proofs WHERE id=$1 AND account_id=$2 AND request_id=$3`,
            [proofId, actor.accountId, id, prior?.phone_assertion_id ?? null],
          );
          if (inserted.rowCount !== 1) throw unavailable();
          await tx.query(
            `INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              snapshot,
              actor.accountId,
              head.revision + 1,
              prior?.affiliation_assertion_id ?? null,
              prior?.student_number_assertion_id ?? null,
              assertion,
              prior?.application_state ?? 'unavailable',
              prior?.application_coverage ?? 'missing',
            ],
          );
          await tx.query(
            `INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,fact_kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code) VALUES($1,$2,$3,'phone_binding','phone',$2,$4,$5,$6,'wechat_phone_authorized')`,
            [
              event,
              actor.accountId,
              id,
              head.revision,
              snapshot,
              head.revision + 1,
            ],
          );
          await tx.query(
            'UPDATE whaleu_verification.account_heads SET revision=$2,snapshot_id=$3 WHERE account_id=$1',
            [actor.accountId, head.revision + 1, snapshot],
          );
          await tx.query(
            "UPDATE whaleu_verification.phone_requests SET state='verified' WHERE account_id=$1 AND request_id=$2",
            [actor.accountId, id],
          );
          await this.identity.session(token, tx);
          return { requestId: id, state: 'verified' as const };
        }),
      );
    } catch {
      // Do not disclose provider bodies or turn an uncertain external outcome into
      // a false rejection/success. Status is recoverable under the original key.
      // Best-effort closure failure leaves claimed, which reads unknown at deadline.
      try {
        await this.database.transaction(async (tx) => {
          const actor = await this.identity.session(token, tx);
          if (actor.accountId !== claim.actor.accountId) return;
          await this.lock(actor.accountId, tx);
          const row = await this.row(actor.accountId, id, tx, true);
          if (row?.state === 'claimed')
            await tx.query(
              "UPDATE whaleu_verification.phone_requests SET state='unknown' WHERE account_id=$1 AND request_id=$2",
              [actor.accountId, id],
            );
        });
      } catch {
        /* Original durable claim is the safe recovery state. */
      }
      return this.read(token, id);
    }
  }
}
