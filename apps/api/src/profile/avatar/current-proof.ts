import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';

interface AvatarFact {
  readonly actor: string;
  readonly editId: string | null;
  readonly profileId: string | null;
  readonly fingerprint: string;
}
async function state(
  actor: string,
  editId: string | null,
  tx: PoolClient,
  profileId: string | null = null,
): Promise<string> {
  const profile = (
    await tx.query(
      `SELECT to_jsonb(p) row,xmin::text version FROM whaleu_profile.profiles p WHERE account_id=$1`,
      [actor],
    )
  ).rows;
  if (
    profileId !== null &&
    (profile.length !== 1 || profile[0]?.row?.public_id !== profileId)
  )
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  const pointer = (
    await tx.query(
      `SELECT to_jsonb(p) row,p.xmin::text version,to_jsonb(d) definition,d.xmin::text definition_version FROM whaleu_profile.avatar_current p JOIN whaleu_profile.avatar_definitions d ON d.id=p.appearance_id AND d.actor_id=p.actor_id WHERE p.actor_id=$1`,
      [actor],
    )
  ).rows;
  const edit =
    editId === null
      ? null
      : (
          await tx.query(
            `SELECT to_jsonb(e) row,xmin::text version FROM whaleu_profile.avatar_edits e WHERE id=$1 AND actor_id=$2`,
            [editId, actor],
          )
        ).rows;
  return ownerFingerprint({ profile, pointer, edit });
}
const proof: RequiredTransactionProof<AvatarFact> = {
  maximumFacts: 128,
  failureCode: 'MEDIA_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'MEDIA_UNAVAILABLE', async (read) => {
      for (const actor of [
        ...new Set(facts.map((fact) => fact.actor)),
      ].sort()) {
        const locked = (
          await read.query<{ locked: boolean }>(
            `SELECT pg_try_advisory_xact_lock_shared(hashtextextended('whaleu:profile-avatar:actor:v1:'||$1,0)) locked`,
            [actor],
          )
        ).rows[0]?.locked;
        if (locked !== true) throw new ApplicationError('MEDIA_UNAVAILABLE');
      }
      for (const fact of facts)
        if (
          (await state(fact.actor, fact.editId, read, fact.profileId)) !==
          fact.fingerprint
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
    }),
};
/** Mutation callers enroll only their completed state. Existing outer facts are
 * never removed or rewritten; a contradictory outer projection fails closed. */
export async function requireAvatarCurrent(
  actor: string,
  tx: PoolClient,
  editId: string | null = null,
  profileId: string | null = null,
): Promise<string> {
  enableRequiredTransactionProof(tx, proof);
  const fingerprint = await state(actor, editId, tx, profileId);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${actor}:${editId}:${profileId}:${fingerprint}`,
    Object.freeze({ actor, editId, profileId, fingerprint }),
  );
  return fingerprint;
}
export async function lockAvatarActor(
  actor: string,
  tx: PoolClient,
): Promise<void> {
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('whaleu:profile-avatar:actor:v1:'||$1,0))`,
    [actor],
  );
}
