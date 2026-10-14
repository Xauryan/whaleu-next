import type { PoolClient } from 'pg';
import {
  consumeCommittedFinalTransactionProofStamp,
  registerFinalTransactionProofStamp,
  type FinalTransactionProofStamp,
} from '../../database/database.js';
import {
  effectIdentity,
  digest,
  type EffectIdentity,
  type Permit,
} from '../../ratings/group-promotion/contracts.js';
const issued = new WeakMap<
  object,
  { identity: EffectIdentity; authorityDigest: string; expiresAt: number }
>();
declare const capsuleBrand: unique symbol;
export interface RatingGroupPermitCapsule {
  readonly [capsuleBrand]: true;
}
const capsules = new WeakMap<
  object,
  {
    identity: EffectIdentity;
    authorityDigest: string;
    binding: string;
    stamp: FinalTransactionProofStamp;
  }
>();
/** Freeze and bind all serialization inside the exact final transaction. */
export function prepareRatingGroupPermit(
  client: PoolClient,
  identity: EffectIdentity,
  authorityDigest: string,
): RatingGroupPermitCapsule {
  const exact = Object.freeze(effectIdentity(identity));
  const binding = digest([exact, authorityDigest]);
  const stamp = registerFinalTransactionProofStamp(client, binding);
  const capsule = Object.freeze({}) as RatingGroupPermitCapsule;
  capsules.set(capsule, { identity: exact, authorityDigest, binding, stamp });
  return capsule;
}
/** Release the original pre-COMMIT instant without serialization or freshening. */
export function issueRatingGroupPermit(
  capsule: RatingGroupPermitCapsule,
): Permit {
  const record = capsules.get(capsule);
  if (!record) throw new Error('Exact permit capsule unavailable');
  capsules.delete(capsule);
  const { identity: exact, authorityDigest, binding, stamp } = record;
  const proofAt = consumeCommittedFinalTransactionProofStamp(stamp, binding);
  if (proofAt === null)
    throw new Error('Committed exact proof stamp unavailable');
  const expiresAt = proofAt + 100;
  const permit = Object.freeze({ ...exact, authorityDigest, expiresAt });
  issued.set(permit, { identity: exact, authorityDigest, expiresAt });
  return permit;
}
export function consumeRatingGroupPermit(
  permit: Permit,
  identity: EffectIdentity,
): boolean {
  const record = issued.get(permit);
  if (!record) return false;
  issued.delete(permit);
  return (
    record.expiresAt > performance.now() &&
    record.authorityDigest === permit.authorityDigest &&
    Object.keys(record.identity).every(
      (key) =>
        record.identity[key as keyof EffectIdentity] ===
        identity[key as keyof EffectIdentity],
    )
  );
}
