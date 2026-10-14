import type { PoolClient } from 'pg';
import type { DatabaseService } from '../database/database.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { OFFICIAL_PROFILE as P, officialUuid } from './profile.js';
import {
  CallbackRejection,
  parseCallbackBody,
  parseSyntheticChallenge,
  syntheticChallengeBytes,
  verifySyntheticSignature,
  callbackLogicalHash,
  callbackSemanticHash,
} from './callback-auth.js';

export type CallbackDatabase = Pick<DatabaseService, 'transaction'>;
const runtimes = new WeakSet<object>();
export interface SyntheticCallbackRuntime {
  readonly profile: 'synthetic-official-v1';
}
/** Explicit test DI only; not registered in AppModule and never selected by env. */
export function createSyntheticCallbackRuntimeForTest(): SyntheticCallbackRuntime {
  const runtime = Object.freeze({ profile: P.name });
  runtimes.add(runtime);
  return runtime;
}
export function acceptedSyntheticCallbackRuntime(
  value: SyntheticCallbackRuntime | null,
): boolean {
  return value !== null && runtimes.has(value);
}
export interface CallbackResult {
  status: number;
  body:
    | { profile: 'synthetic-official-v1'; eventId: string; status: 'received' }
    | { profile: 'synthetic-official-v1'; challenge: string }
    | { error: 'callback_unavailable' };
  retryAfter?: number;
}
export interface CallbackRawRequest {
  rawBody: Buffer;
  contentType?: string;
  contentEncoding?: string;
  signature?: string;
}
export interface CallbackRegistry {
  account_ref: string;
  registration_id: string;
  mini_app_ref: string;
  union_namespace: string;
  revision: string;
  deleted: boolean;
}
export async function callbackTransactionBudget(tx: PoolClient): Promise<void> {
  await tx.query(
    `SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('transaction_timeout',$3,true)`,
    [`${P.statementMs}ms`, `${P.lockMs}ms`, `${P.transactionMs}ms`],
  );
}
export async function callbackClock(tx: PoolClient): Promise<number> {
  const r = await tx.query<{ now: string }>(
    'SELECT (extract(epoch from clock_timestamp()) * 1000)::text AS now',
  );
  return Number(r.rows[0]!.now);
}
export async function lockCallbackAccount(
  tx: PoolClient,
  accountRef: string,
): Promise<CallbackRegistry | undefined> {
  return (
    await tx.query<CallbackRegistry>(
      'SELECT * FROM whaleu_official_callbacks.accounts WHERE account_ref=$1 FOR UPDATE',
      [accountRef],
    )
  ).rows[0];
}
function rejection(error: unknown): CallbackResult {
  const status =
    error instanceof CallbackRejection
      ? error.status
      : error instanceof ApplicationError &&
          error.code === 'OFFICIAL_ACCOUNT_UNAVAILABLE'
        ? 401
        : 503;
  return {
    status,
    body: { error: 'callback_unavailable' },
    ...(status === 429
      ? { retryAfter: 60 }
      : status === 503
        ? { retryAfter: 5 }
        : {}),
  };
}

export class OfficialCallbackBoundary {
  constructor(
    private readonly db: CallbackDatabase,
    private readonly runtime: SyntheticCallbackRuntime | null = null,
  ) {}
  private enabled(): void {
    if (!acceptedSyntheticCallbackRuntime(this.runtime))
      throw new CallbackRejection(503);
  }
  /** Committed before parsing/MAC, including failed requests. Unknown IDs share one bucket. */
  private async debit(registrationId: string): Promise<void> {
    const allowed = await this.db.transaction(async (tx) => {
      await callbackTransactionBudget(tx);
      const known =
        officialUuid.safeParse(registrationId).success &&
        (
          await tx.query(
            'SELECT 1 FROM whaleu_official_callbacks.registrations WHERE registration_id=$1',
            [registrationId],
          )
        ).rowCount === 1;
      const bucket = known ? registrationId : 'unknown';
      await tx.query(
        'INSERT INTO whaleu_official_callbacks.rate_buckets(bucket,tokens,sampled_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT DO NOTHING',
        [bucket, P.callbackBurst],
      );
      const result = await tx.query<{ allowed: boolean }>(
        `WITH locked AS MATERIALIZED (
        SELECT bucket,least($2::float8,tokens+greatest(0,extract(epoch from clock_timestamp()-sampled_at))) AS available
        FROM whaleu_official_callbacks.rate_buckets WHERE bucket=$1 FOR UPDATE)
        UPDATE whaleu_official_callbacks.rate_buckets b SET tokens=CASE WHEN l.available>=1 THEN l.available-1 ELSE l.available END,sampled_at=clock_timestamp()
        FROM locked l WHERE b.bucket=l.bucket RETURNING l.available>=1 AS allowed`,
        [bucket, P.callbackBurst],
      );
      return result.rows[0]?.allowed === true;
    });
    if (!allowed) throw new CallbackRejection(429);
  }
  private async authenticate(
    tx: PoolClient,
    registrationId: string,
    accountRef: string,
    keyEpoch: number,
    issuedAt: number,
    method: 'GET' | 'POST',
    bytes: Buffer,
    signature: string | undefined,
  ): Promise<void> {
    if (
      !officialUuid.safeParse(registrationId).success ||
      (keyEpoch !== 1 && keyEpoch !== 2)
    )
      throw new CallbackRejection(401);
    const registry = (
      await tx.query<CallbackRegistry>(
        `SELECT a.*,r.registration_id FROM whaleu_official_callbacks.registrations r
      JOIN whaleu_official_callbacks.accounts a USING(account_ref) WHERE r.registration_id=$1 FOR UPDATE OF a`,
        [registrationId],
      )
    ).rows[0];
    if (!registry || registry.deleted || registry.account_ref !== accountRef)
      throw new CallbackRejection(401);
    const now = await callbackClock(tx);
    const key = (
      await tx.query<{ expires_at: Date }>(
        `SELECT expires_at FROM whaleu_official_callbacks.epochs WHERE registration_id=$1 AND epoch=$2
      AND valid_from<=clock_timestamp() AND expires_at>clock_timestamp()`,
        [registrationId, keyEpoch],
      )
    ).rows[0];
    if (!key || Math.abs(now - issuedAt) > P.callbackSkewMs)
      throw new CallbackRejection(401);
    verifySyntheticSignature(
      method,
      registrationId,
      bytes,
      signature,
      keyEpoch,
    );
    registerTransactionDeadline(
      tx,
      Math.min(key.expires_at.getTime(), issuedAt + P.callbackSkewMs),
      'OFFICIAL_ACCOUNT_UNAVAILABLE',
    );
  }
  async challenge(
    registrationId: string,
    query: unknown,
    signature?: string,
  ): Promise<CallbackResult> {
    try {
      this.enabled();
      await this.debit(registrationId);
      const challenge = parseSyntheticChallenge(query);
      await this.db.transaction(async (tx) => {
        await callbackTransactionBudget(tx);
        await this.authenticate(
          tx,
          registrationId,
          challenge.accountRef,
          challenge.keyEpoch,
          challenge.issuedAt,
          'GET',
          syntheticChallengeBytes(challenge),
          signature,
        );
      });
      return {
        status: 200,
        body: { profile: P.name, challenge: challenge.challenge },
      };
    } catch (error) {
      return rejection(error);
    }
  }
  async receive(
    registrationId: string,
    request: CallbackRawRequest,
  ): Promise<CallbackResult> {
    try {
      this.enabled();
      await this.debit(registrationId);
      const e = parseCallbackBody(
        request.rawBody,
        request.contentType,
        request.contentEncoding,
      );
      const collision = await this.db.transaction(async (tx) => {
        await callbackTransactionBudget(tx);
        await this.authenticate(
          tx,
          registrationId,
          e.accountRef,
          e.keyEpoch,
          e.issuedAt,
          'POST',
          request.rawBody,
          request.signature,
        );
        const hash = callbackLogicalHash(e);
        const old = (
          await tx.query<{ logical_hash: string; official_subject: string }>(
            'SELECT logical_hash,official_subject FROM whaleu_official_callbacks.events WHERE account_ref=$1 AND event_id=$2',
            [e.accountRef, e.eventId],
          )
        ).rows[0];
        if (old && old.logical_hash !== hash) {
          await tx.query(
            'INSERT INTO whaleu_official_callbacks.conflicts VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [e.accountRef, e.eventId, hash],
          );
          for (const subject of new Set([
            old.official_subject,
            e.officialSubject,
          ])) {
            await ensureFollow(tx, e.accountRef, subject);
            await tx.query(
              `UPDATE whaleu_official_callbacks.follow SET state='unknown',mapping_state='quarantined',
              generation=generation+1,binding_revision=binding_revision+1 WHERE account_ref=$1 AND official_subject=$2`,
              [e.accountRef, subject],
            );
          }
          return true; // Commit quarantine/conflict, then return 409 outside transaction.
        }
        if (!old) {
          await tx.query(
            `INSERT INTO whaleu_official_callbacks.events(account_ref,event_id,official_subject,kind,sequence,occurred_at,logical_hash,semantic_hash)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              e.accountRef,
              e.eventId,
              e.officialSubject,
              e.kind,
              e.sequence,
              e.occurredAt,
              hash,
              callbackSemanticHash(e),
            ],
          );
          await tx.query(
            'INSERT INTO whaleu_official_callbacks.jobs(account_ref,event_id) VALUES($1,$2)',
            [e.accountRef, e.eventId],
          );
        }
        await tx.query(
          `INSERT INTO whaleu_official_callbacks.admissions(account_ref,event_id,registration_id,epoch) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [e.accountRef, e.eventId, registrationId, e.keyEpoch],
        );
        return false;
      });
      if (collision) throw new CallbackRejection(409);
      return {
        status: 200,
        body: { profile: P.name, eventId: e.eventId, status: 'received' },
      };
    } catch (error) {
      return rejection(error);
    }
  }
}
export async function ensureFollow(
  tx: PoolClient,
  accountRef: string,
  subject: string,
): Promise<void> {
  await tx.query(
    'INSERT INTO whaleu_official_callbacks.follow(account_ref,official_subject) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [accountRef, subject],
  );
}
export interface CallbackFollow {
  account_ref: string;
  official_subject: string;
  latest_sequence: string;
  latest_semantic_hash: string | null;
  latest_logical_hash: string | null;
  state: 'unknown' | 'followed' | 'unfollowed';
  generation: string;
  binding_revision: string;
  revocation_watermark: string;
  mapping_state: 'unknown' | 'accepted' | 'revoked' | 'quarantined';
  local_account_ref: string | null;
  union_subject: string | null;
  mini_subject: string | null;
  proof_id: string | null;
  mini_assertion_ref: string | null;
  proof_expires_at: Date | null;
}
export async function callbackFollow(
  tx: PoolClient,
  account: string,
  subject: string,
): Promise<CallbackFollow | undefined> {
  return (
    await tx.query<CallbackFollow>(
      'SELECT * FROM whaleu_official_callbacks.follow WHERE account_ref=$1 AND official_subject=$2 FOR UPDATE',
      [account, subject],
    )
  ).rows[0];
}
/** Explicit bounded worker; row locks and receipt settle in one transaction. No startup work. */
export class OfficialCallbackProjectionWorker {
  constructor(
    private readonly db: CallbackDatabase,
    private readonly runtime: SyntheticCallbackRuntime | null = null,
  ) {}
  async runOnce(): Promise<number> {
    if (!acceptedSyntheticCallbackRuntime(this.runtime)) return 0;
    let processed = 0;
    for (; processed < P.claims; processed++) {
      const didWork = await this.db.transaction(async (tx) => {
        await callbackTransactionBudget(tx);
        let admitted = false;
        for (let slot = 0; slot < P.globalConcurrency; slot++) {
          if (
            (
              await tx.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_xact_lock(1464355981,$1) AS locked',
                [slot],
              )
            ).rows[0]?.locked
          ) {
            admitted = true;
            break;
          }
        }
        if (!admitted) return false;
        // Account first, same lock order as admission/mapping/consumer. No lease escapes this transaction.
        const account = (
          await tx.query<{
            account_ref: string;
            deleted: boolean;
          }>(`SELECT a.account_ref,a.deleted FROM whaleu_official_callbacks.accounts a
          WHERE EXISTS(SELECT 1 FROM whaleu_official_callbacks.jobs j WHERE j.account_ref=a.account_ref AND j.processed_at IS NULL)
          ORDER BY a.account_ref LIMIT 1 FOR UPDATE OF a SKIP LOCKED`)
        ).rows[0];
        if (!account) return false;
        const event = (
          await tx.query<{
            event_id: string;
            official_subject: string;
            sequence: string;
            kind: 'subscribe' | 'unsubscribe';
            semantic_hash: string;
            logical_hash: string;
          }>(
            `SELECT e.* FROM whaleu_official_callbacks.jobs j JOIN whaleu_official_callbacks.events e USING(account_ref,event_id)
          WHERE j.account_ref=$1 AND j.processed_at IS NULL ORDER BY e.sequence,e.event_id LIMIT 1 FOR UPDATE OF j`,
            [account.account_ref],
          )
        ).rows[0]!;
        await ensureFollow(tx, account.account_ref, event.official_subject);
        const f = (await callbackFollow(
          tx,
          account.account_ref,
          event.official_subject,
        ))!;
        let outcome = 'account_deleted';
        if (!account.deleted) {
          const sequence = BigInt(event.sequence),
            current = BigInt(f.latest_sequence);
          if (sequence < current) outcome = 'ignored_ordered';
          else if (
            sequence === current &&
            event.semantic_hash === f.latest_semantic_hash
          )
            outcome = 'duplicate_semantic';
          else if (sequence === current) {
            outcome = 'quarantined';
            await tx.query(
              `UPDATE whaleu_official_callbacks.follow SET state='unknown',mapping_state='quarantined',generation=generation+1,
              binding_revision=binding_revision+1,revocation_watermark=greatest(revocation_watermark,$3) WHERE account_ref=$1 AND official_subject=$2`,
              [account.account_ref, event.official_subject, event.sequence],
            );
          } else {
            outcome = 'applied';
            await tx.query(
              `UPDATE whaleu_official_callbacks.follow SET latest_sequence=$3,latest_semantic_hash=$4,latest_logical_hash=$6,state=$5,generation=generation+1,
              binding_revision=binding_revision+CASE WHEN $5='unfollowed' THEN 1 ELSE 0 END,
              revocation_watermark=CASE WHEN $5='unfollowed' THEN greatest(revocation_watermark,$3) ELSE revocation_watermark END
              WHERE account_ref=$1 AND official_subject=$2`,
              [
                account.account_ref,
                event.official_subject,
                event.sequence,
                event.semantic_hash,
                event.kind === 'subscribe' ? 'followed' : 'unfollowed',
                event.logical_hash,
              ],
            );
          }
        }
        await tx.query(
          'UPDATE whaleu_official_callbacks.jobs SET outcome=$3,processed_at=clock_timestamp() WHERE account_ref=$1 AND event_id=$2',
          [account.account_ref, event.event_id, outcome],
        );
        return true;
      });
      if (!didWork) break;
    }
    return processed;
  }
}

export interface SyntheticCallbackRegistration {
  accountRef: string;
  registrationId: string;
  miniAppRef: string;
  unionNamespace: string;
  revision: string;
  epochs: readonly { epoch: 1 | 2; validFrom: number; expiresAt: number }[];
}
/** Fixture-only provisioning: never reads or imports production registry/credentials. */
export async function registerSyntheticCallbackFixture(
  db: CallbackDatabase,
  runtime: SyntheticCallbackRuntime,
  r: SyntheticCallbackRegistration,
): Promise<void> {
  if (
    !acceptedSyntheticCallbackRuntime(runtime) ||
    ![r.accountRef, r.registrationId, r.miniAppRef, r.unionNamespace].every(
      (v) => officialUuid.safeParse(v).success,
    ) ||
    !/^[0-9a-f]{64}$/.test(r.revision) ||
    r.epochs.length < 1 ||
    r.epochs.length > 2
  )
    throw new CallbackRejection(400);
  for (const e of r.epochs)
    if (
      ![1, 2].includes(e.epoch) ||
      !Number.isSafeInteger(e.validFrom) ||
      !Number.isSafeInteger(e.expiresAt) ||
      e.validFrom >= e.expiresAt
    )
      throw new CallbackRejection(400);
  const [a, b] = r.epochs;
  if (
    a &&
    b &&
    (a.epoch === b.epoch ||
      Math.min(a.expiresAt, b.expiresAt) - Math.max(a.validFrom, b.validFrom) >
        P.callbackOverlapMs)
  )
    throw new CallbackRejection(400);
  await db.transaction(async (tx) => {
    await callbackTransactionBudget(tx);
    await tx.query(
      'INSERT INTO whaleu_official_callbacks.accounts(account_ref,mini_app_ref,union_namespace,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [r.accountRef, r.miniAppRef, r.unionNamespace, r.revision],
    );
    const existing = await lockCallbackAccount(tx, r.accountRef);
    if (
      !existing ||
      existing.deleted ||
      existing.mini_app_ref !== r.miniAppRef ||
      existing.union_namespace !== r.unionNamespace ||
      existing.revision !== r.revision
    )
      throw new CallbackRejection(409);
    await tx.query(
      'INSERT INTO whaleu_official_callbacks.registrations VALUES($1,$2)',
      [r.registrationId, r.accountRef],
    );
    // Overlap checked across every registration of the same stable account, not just this URL.
    for (const e of r.epochs) {
      const overlaps = await tx.query(
        `SELECT 1 FROM whaleu_official_callbacks.epochs e JOIN whaleu_official_callbacks.registrations r USING(registration_id)
        WHERE r.account_ref=$1 AND e.epoch<>$2 AND least(e.expires_at,to_timestamp($4/1000.0))-greatest(e.valid_from,to_timestamp($3/1000.0))>interval '600 seconds' LIMIT 1`,
        [r.accountRef, e.epoch, e.validFrom, e.expiresAt],
      );
      if (overlaps.rowCount) throw new CallbackRejection(400);
      await tx.query(
        'INSERT INTO whaleu_official_callbacks.epochs VALUES($1,$2,to_timestamp($3/1000.0),to_timestamp($4/1000.0))',
        [r.registrationId, e.epoch, e.validFrom, e.expiresAt],
      );
    }
  });
}
