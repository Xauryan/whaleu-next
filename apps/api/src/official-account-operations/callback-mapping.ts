import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  transactionReadEpoch,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import {
  OFFICIAL_PROFILE as P,
  officialUuid,
  officialHash,
  officialDigest,
} from './profile.js';
import {
  acceptedSyntheticCallbackRuntime,
  callbackTransactionBudget,
  callbackClock,
  lockCallbackAccount,
  callbackFollow,
} from './callback-ledger.js';
import type {
  CallbackDatabase,
  CallbackFollow,
  CallbackRegistry,
  SyntheticCallbackRuntime,
} from './callback-ledger.js';

const proofSchema = z.strictObject({
  issuer: z.literal('synthetic-identity-v1'),
  proofId: officialUuid,
  accountRef: officialUuid,
  officialSubject: z
    .string()
    .regex(
      /^synthetic:official:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  unionNamespace: officialUuid,
  unionSubject: z
    .string()
    .regex(
      /^synthetic:union:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  miniAppRef: officialUuid,
  miniSubject: z
    .string()
    .regex(
      /^synthetic:mini:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  localAccountRef: officialUuid,
  officialAssertionHash: officialHash,
  miniIdentityAssertionRef: officialUuid,
  registryRevision: officialHash,
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().positive().safe(),
});
export type SyntheticOfficialIdentityProof = Readonly<
  z.infer<typeof proofSchema>
>;
export interface SyntheticIdentityResolutionRequest {
  accountRef: string;
  officialSubject: string;
  followSequence: number;
  registrationRevision: string;
}
export interface SyntheticOfficialIdentityProofPort {
  resolve(
    request: SyntheticIdentityResolutionRequest,
  ): Promise<SyntheticOfficialIdentityProof | 'unknown'>;
}
const trustedProofs = new WeakSet<object>();
/** Only the explicit fixture issuer can mint proofs. HTTP JSON copies lose provenance. */
export function createSyntheticIdentityProofIssuerForTest(
  runtime: SyntheticCallbackRuntime,
  resolve: (
    request: SyntheticIdentityResolutionRequest,
  ) => Promise<SyntheticOfficialIdentityProof | 'unknown'>,
): SyntheticOfficialIdentityProofPort {
  if (!acceptedSyntheticCallbackRuntime(runtime))
    throw new Error('Synthetic issuer unavailable');
  return Object.freeze({
    resolve: async (request: SyntheticIdentityResolutionRequest) => {
      const raw = await resolve(request);
      if (raw === 'unknown') return raw;
      const proof = Object.freeze(proofSchema.parse(raw));
      trustedProofs.add(proof);
      return proof;
    },
  });
}
export function syntheticOfficialAssertionHash(
  request: SyntheticIdentityResolutionRequest,
): string {
  return officialDigest([
    request.accountRef,
    request.officialSubject,
    request.followSequence,
    request.registrationRevision,
  ]);
}
async function hasPending(
  tx: PoolClient,
  account: string,
  subject: string,
): Promise<boolean> {
  return (
    (
      await tx.query(
        `SELECT 1 FROM whaleu_official_callbacks.jobs j JOIN whaleu_official_callbacks.events e USING(account_ref,event_id)
    WHERE j.account_ref=$1 AND e.official_subject=$2 AND j.processed_at IS NULL LIMIT 1`,
        [account, subject],
      )
    ).rowCount === 1
  );
}
async function proveMini(
  tx: PoolClient,
  registry: CallbackRegistry,
  p: SyntheticOfficialIdentityProof,
): Promise<boolean> {
  // Both sides are required: protected synthetic assertion AND the actual current Identity-owned binding.
  const result = await tx.query(
    `SELECT 1 FROM whaleu_official_callbacks.mini_assertions s
    JOIN whaleu_identity.accounts a ON a.id=s.local_account_ref
    JOIN whaleu_identity.provider_identities i ON i.account_id=a.id AND i.provider='wechat' AND i.app_id=s.mini_app_ref::text AND i.subject=s.mini_subject
    WHERE s.assertion_ref=$1 AND NOT s.revoked AND s.mini_app_ref=$2 AND s.mini_subject=$3 AND s.local_account_ref=$4
    AND s.union_namespace=$5 AND s.union_subject=$6 AND i.union_subject=s.union_subject AND i.xmin::text=s.identity_binding_version AND a.status='active' FOR SHARE OF s,a,i`,
    [
      p.miniIdentityAssertionRef,
      registry.mini_app_ref,
      p.miniSubject,
      p.localAccountRef,
      registry.union_namespace,
      p.unionSubject,
    ],
  );
  return result.rowCount === 1;
}
async function resolverWithinBudget(
  port: SyntheticOfficialIdentityProofPort,
  request: SyntheticIdentityResolutionRequest,
): Promise<SyntheticOfficialIdentityProof | 'unknown'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      port.resolve(request),
      new Promise<'unknown'>((resolve) => {
        timer = setTimeout(() => resolve('unknown'), P.prepareMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export class OfficialCallbackMappingOwner {
  constructor(
    private readonly db: CallbackDatabase,
    private readonly runtime: SyntheticCallbackRuntime | null = null,
    private readonly issuer: SyntheticOfficialIdentityProofPort | null = null,
  ) {}
  async resolve(
    accountRef: string,
    officialSubject: string,
  ): Promise<'accepted' | 'unknown' | 'quarantined'> {
    if (!acceptedSyntheticCallbackRuntime(this.runtime) || !this.issuer)
      return 'unknown';
    const before = await this.db.transaction(async (tx) => {
      await callbackTransactionBudget(tx);
      const registry = await lockCallbackAccount(tx, accountRef),
        follow = await callbackFollow(tx, accountRef, officialSubject);
      if (
        !registry ||
        registry.deleted ||
        !follow ||
        follow.state !== 'followed' ||
        ['revoked', 'quarantined'].includes(follow.mapping_state) ||
        (await hasPending(tx, accountRef, officialSubject))
      )
        return null;
      return { registry, follow };
    });
    if (!before) return 'unknown';
    const request = {
      accountRef,
      officialSubject,
      followSequence: Number(before.follow.latest_sequence),
      registrationRevision: before.registry.revision,
    };
    let proof: SyntheticOfficialIdentityProof | 'unknown';
    try {
      proof = await resolverWithinBudget(this.issuer, request);
    } catch {
      return 'unknown';
    }
    if (proof === 'unknown' || !trustedProofs.has(proof)) return 'unknown';
    return this.db.transaction(async (tx) => {
      await callbackTransactionBudget(tx);
      const registry = await lockCallbackAccount(tx, accountRef),
        follow = await callbackFollow(tx, accountRef, officialSubject),
        now = await callbackClock(tx);
      if (
        !registry ||
        registry.deleted ||
        !follow ||
        follow.state !== 'followed' ||
        follow.generation !== before.follow.generation ||
        follow.binding_revision !== before.follow.binding_revision ||
        follow.revocation_watermark !== before.follow.revocation_watermark ||
        registry.revision !== before.registry.revision ||
        ['revoked', 'quarantined'].includes(follow.mapping_state) ||
        (await hasPending(tx, accountRef, officialSubject)) ||
        proof.accountRef !== accountRef ||
        proof.officialSubject !== officialSubject ||
        proof.registryRevision !== registry.revision ||
        proof.unionNamespace !== registry.union_namespace ||
        proof.miniAppRef !== registry.mini_app_ref ||
        proof.officialAssertionHash !==
          syntheticOfficialAssertionHash(request) ||
        proof.issuedAt > now ||
        proof.expiresAt <= now ||
        proof.expiresAt <= proof.issuedAt ||
        !(await proveMini(tx, registry, proof))
      )
        return 'unknown';
      const conflicts = await tx.query<{ official_subject: string }>(
        `SELECT official_subject FROM whaleu_official_callbacks.follow
        WHERE account_ref=$1 AND official_subject<>$2 AND (local_account_ref=$3 OR union_subject=$4 OR mini_subject=$5) FOR UPDATE`,
        [
          accountRef,
          officialSubject,
          proof.localAccountRef,
          proof.unionSubject,
          proof.miniSubject,
        ],
      );
      const ownConflict =
        follow.local_account_ref !== null &&
        (follow.local_account_ref !== proof.localAccountRef ||
          follow.union_subject !== proof.unionSubject ||
          follow.mini_subject !== proof.miniSubject);
      if (conflicts.rowCount || ownConflict) {
        await tx.query(
          `UPDATE whaleu_official_callbacks.follow SET mapping_state='quarantined',binding_revision=binding_revision+1
          WHERE account_ref=$1 AND official_subject=ANY($2::text[])`,
          [
            accountRef,
            [officialSubject, ...conflicts.rows.map((r) => r.official_subject)],
          ],
        );
        return 'quarantined';
      }
      await tx.query(
        `INSERT INTO whaleu_official_callbacks.mapping_proofs(proof_id,account_ref,official_subject,assertion_ref,assertion_hash,registry_revision,expires_at,proof_hash) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),$8) ON CONFLICT DO NOTHING`,
        [
          proof.proofId,
          accountRef,
          officialSubject,
          proof.miniIdentityAssertionRef,
          proof.officialAssertionHash,
          proof.registryRevision,
          proof.expiresAt,
          officialDigest(proof),
        ],
      );
      const acceptedProof = (
        await tx.query<{ proof_hash: string }>(
          'SELECT proof_hash FROM whaleu_official_callbacks.mapping_proofs WHERE proof_id=$1',
          [proof.proofId],
        )
      ).rows[0];
      if (acceptedProof?.proof_hash !== officialDigest(proof)) {
        await tx.query(
          `UPDATE whaleu_official_callbacks.follow SET mapping_state='quarantined',binding_revision=binding_revision+1 WHERE account_ref=$1 AND official_subject=$2`,
          [accountRef, officialSubject],
        );
        return 'quarantined';
      }
      await tx.query(
        `UPDATE whaleu_official_callbacks.follow SET mapping_state='accepted',local_account_ref=$3,union_subject=$4,mini_subject=$5,
        proof_id=$6,proof_expires_at=to_timestamp($7/1000.0),mini_assertion_ref=$8,binding_revision=binding_revision+1 WHERE account_ref=$1 AND official_subject=$2`,
        [
          accountRef,
          officialSubject,
          proof.localAccountRef,
          proof.unionSubject,
          proof.miniSubject,
          proof.proofId,
          proof.expiresAt,
          proof.miniIdentityAssertionRef,
        ],
      );
      registerTransactionDeadline(
        tx,
        proof.expiresAt,
        'OFFICIAL_ACCOUNT_UNAVAILABLE',
      );
      return 'accepted';
    });
  }
  async revoke(accountRef: string, officialSubject: string): Promise<void> {
    if (!acceptedSyntheticCallbackRuntime(this.runtime)) return;
    await this.db.transaction(async (tx) => {
      await callbackTransactionBudget(tx);
      await lockCallbackAccount(tx, accountRef);
      await tx.query(
        `UPDATE whaleu_official_callbacks.follow SET mapping_state='revoked',binding_revision=binding_revision+1
        WHERE account_ref=$1 AND official_subject=$2`,
        [accountRef, officialSubject],
      );
    });
  }
  async deleteAccount(accountRef: string): Promise<void> {
    if (!acceptedSyntheticCallbackRuntime(this.runtime)) return;
    await this.db.transaction(async (tx) => {
      await callbackTransactionBudget(tx);
      await lockCallbackAccount(tx, accountRef);
      await tx.query(
        'UPDATE whaleu_official_callbacks.accounts SET deleted=true WHERE account_ref=$1',
        [accountRef],
      );
      await tx.query(
        `UPDATE whaleu_official_callbacks.follow SET mapping_state='revoked',state='unknown',generation=generation+1,binding_revision=binding_revision+1 WHERE account_ref=$1`,
        [accountRef],
      );
    });
  }
}

const capabilityBrand: unique symbol = Symbol(
  'transaction-only-synthetic-destination',
);
export interface OfficialNotificationDestinationCapability {
  readonly [capabilityBrand]: true;
}
interface Destination {
  tx: PoolClient;
  epoch: object;
  follow: CallbackFollow;
  until: number;
  used: boolean;
}
const destinations = new WeakMap<
  OfficialNotificationDestinationCapability,
  Destination
>();
export interface OfficialNotificationDestinationRequest {
  localAccountRef: string;
  notificationAccountRef: string;
  purpose: 'synthetic-notification-v1';
}
export interface OfficialNotificationDestinationCapabilityPort {
  current(
    request: OfficialNotificationDestinationRequest,
    tx: PoolClient,
  ): Promise<OfficialNotificationDestinationCapability | null>;
}
/** No live message transport consumes this port. Capabilities cannot be serialized or reused. */
export class SyntheticOfficialNotificationDestinationPort implements OfficialNotificationDestinationCapabilityPort {
  constructor(
    private readonly runtime: SyntheticCallbackRuntime | null = null,
  ) {}
  async current(
    request: OfficialNotificationDestinationRequest,
    tx: PoolClient,
  ): Promise<OfficialNotificationDestinationCapability | null> {
    const epoch = transactionReadEpoch(tx);
    if (
      !acceptedSyntheticCallbackRuntime(this.runtime) ||
      !epoch ||
      request.purpose !== 'synthetic-notification-v1'
    )
      return null;
    const started = performance.now();
    await tx.query(
      `SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)`,
      [`${P.finalStatementMs}ms`, `${P.finalLockMs}ms`],
    );
    const registry = await lockCallbackAccount(
      tx,
      request.notificationAccountRef,
    );
    if (!registry || registry.deleted) return null;
    const rows = await tx.query<CallbackFollow>(
      `SELECT * FROM whaleu_official_callbacks.follow WHERE account_ref=$1 AND local_account_ref=$2 LIMIT 2 FOR UPDATE`,
      [request.notificationAccountRef, request.localAccountRef],
    );
    const f = rows.rows[0],
      now = await callbackClock(tx);
    if (
      rows.rows.length !== 1 ||
      !f ||
      f.state !== 'followed' ||
      f.mapping_state !== 'accepted' ||
      !f.proof_id ||
      !f.mini_assertion_ref ||
      !f.proof_expires_at ||
      f.proof_expires_at.getTime() <= now ||
      BigInt(f.latest_sequence) <= BigInt(f.revocation_watermark) ||
      (await hasPending(tx, f.account_ref, f.official_subject))
    )
      return null;
    const proof = {
      miniIdentityAssertionRef: f.mini_assertion_ref,
      miniSubject: f.mini_subject!,
      localAccountRef: f.local_account_ref!,
      unionSubject: f.union_subject!,
    } as SyntheticOfficialIdentityProof;
    if (
      !(await proveMini(tx, registry, proof)) ||
      performance.now() - started >= P.finalProofMs
    )
      return null;
    const until = Math.min(f.proof_expires_at.getTime(), now + P.finalProofMs);
    registerTransactionDeadline(tx, until, 'OFFICIAL_ACCOUNT_UNAVAILABLE');
    const capability = Object.freeze({ [capabilityBrand]: true as const });
    destinations.set(capability, { tx, epoch, follow: f, until, used: false });
    return capability;
  }
}
/** Synthetic acceptance is a local durable effect in the SAME final-proof transaction. */
export class SyntheticOfficialNotificationConsumer {
  constructor(
    private readonly db: CallbackDatabase,
    private readonly port: OfficialNotificationDestinationCapabilityPort,
  ) {}
  async send(
    request: OfficialNotificationDestinationRequest,
    prepare: () => Promise<void> = async () => {},
  ): Promise<boolean> {
    await prepare();
    return this.db.transaction(async (tx) => {
      await callbackTransactionBudget(tx);
      const capability = await this.port.current(request, tx);
      if (!capability) return false;
      const destination = destinations.get(capability);
      if (
        !destination ||
        destination.used ||
        destination.tx !== tx ||
        destination.epoch !== transactionReadEpoch(tx) ||
        (await callbackClock(tx)) >= destination.until
      )
        return false;
      destination.used = true;
      const f = destination.follow;
      if (
        f.account_ref !== request.notificationAccountRef ||
        f.local_account_ref !== request.localAccountRef
      )
        return false;
      await tx.query(
        `INSERT INTO whaleu_official_callbacks.synthetic_acceptances(acceptance_id,account_ref,official_subject,local_account_ref,purpose,follow_generation,binding_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          f.account_ref,
          f.official_subject,
          f.local_account_ref,
          request.purpose,
          f.generation,
          f.binding_revision,
        ],
      );
      return true;
    });
  }
}
