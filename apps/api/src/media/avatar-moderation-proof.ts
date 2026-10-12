import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  transactionReadEpoch,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { mediaCountProofOwner } from './required-proof.js';
import type { MediaParent } from './contracts.js';

type Target = { kind: 'post' | 'comment' | 'reply'; id: string };
type State = {
  tx: PoolClient;
  target: Target;
  phase: 'initial' | 'final' | 'closed';
  active: boolean;
  observed: boolean;
  finalized: boolean;
  images: Map<string, string>;
  finalImages: Map<string, string>;
  source: string;
  originalEpoch: string;
  parents: readonly string[];
  result: string;
  rerun: (() => Promise<unknown>) | null;
  epoch?: object;
  media?: string;
};
const states = new WeakMap<PoolClient, State>();
const fail = (): never => {
  throw new ApplicationError('MEDIA_UNAVAILABLE');
};
const proof: RequiredTransactionProof<State> = {
  maximumFacts: 1,
  failureCode: 'MEDIA_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'MEDIA_UNAVAILABLE', async (read) => {
      if (!(await mediaCountProofOwner.fence(read))) fail();
      const final = ownerFingerprint(await mediaCountProofOwner.capture(read));
      for (const state of facts) {
        if (
          state.tx !== tx ||
          !state.finalized ||
          state.phase !== 'closed' ||
          state.epoch !== transactionReadEpoch(tx) ||
          state.media !== final
        )
          fail();
        if ((await mediaFacts(state.target, read)) !== state.source) fail();
      }
    }),
};
async function mediaFacts(target: Target, tx: PoolClient): Promise<string> {
  const row = (
    await tx.query<{ fingerprint: string }>(
      'SELECT whaleu_profile.moderation_hash(whaleu_profile.avatar_moderation_media_facts($1,$2)) fingerprint',
      [target.kind, target.id],
    )
  ).rows[0];
  return row?.fingerprint ?? fail();
}

/** One content-bound negative action. Only its exact target authorization callback
 * can defer Media epoch enrollment. Existing ordinary Media facts are untouched.
 * Target bindings/assets/intents/Safety/variants and row versions are captured
 * before authorization, checked after the permitted avatar retirement, and kept
 * through the final bounded fence. This scope grants no byte capability. */
export async function withAvatarModerationMediaMutation<T>(
  tx: PoolClient,
  target: Target,
  run: () => Promise<T>,
): Promise<T> {
  if (!transactionReadEpoch(tx) || states.has(tx)) fail();
  const state: State = {
    tx,
    target: Object.freeze({ ...target }),
    phase: 'initial',
    active: false,
    observed: false,
    finalized: false,
    images: new Map(),
    finalImages: new Map(),
    originalEpoch: await epochHash(tx),
    source: await mediaFacts(target, tx),
    parents: Object.freeze(
      (
        await tx.query<{ kind: string; id: string }>(
          'SELECT kind,id FROM whaleu_community.profile_moderation_nodes($1,$2)',
          [target.kind, target.id],
        )
      ).rows.map((node) => JSON.stringify([node.kind, node.id, 1])),
    ),
    result: '',
    rerun: null,
  };
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    `avatar-moderation:${randomUUID()}`,
    state,
  );
  states.set(tx, state);
  try {
    const result = await run();
    if (!state.observed || !state.rerun) fail();
    state.phase = 'final';
    state.active = true;
    const current = await state.rerun!();
    state.active = false;
    if (
      ownerFingerprint(current) !== state.result ||
      ownerFingerprint([...state.images].sort()) !==
        ownerFingerprint([...state.finalImages].sort()) ||
      (await mediaFacts(target, tx)) !== state.source
    )
      fail();
    state.media = ownerFingerprint(await mediaCountProofOwner.capture(tx));
    state.epoch = transactionReadEpoch(tx) ?? fail();
    state.finalized = true;
    return result;
  } finally {
    state.active = false;
    state.phase = 'closed';
    states.delete(tx);
  }
}
export async function avatarModerationTargetAuthorization<T>(
  tx: PoolClient,
  target: Target,
  run: () => Promise<T>,
): Promise<T> {
  const state = states.get(tx);
  if (!state) return run();
  if (
    state.phase !== 'initial' ||
    state.active ||
    state.observed ||
    state.target.kind !== target.kind ||
    state.target.id !== target.id
  )
    fail();
  state.observed = true;
  state.active = true;
  state.rerun = run;
  try {
    const result = await run();
    state.result = ownerFingerprint(result);
    return result;
  } finally {
    state.active = false;
  }
}
/** At most the exact target plus its two ancestors. No ordinary descriptor call
 * or another owner's authorization can replace its pre-mutation facts. */
export function collectAvatarModerationMedia(
  tx: PoolClient,
  parent: MediaParent,
  images: readonly { assetId: string; digest: string }[],
): boolean {
  const state = states.get(tx);
  if (!state?.active || state.phase === 'closed') return false;
  if (
    parent.ownerKind !== 'community' ||
    !state.parents.includes(
      JSON.stringify([
        parent.resourceKind,
        parent.resourceId,
        parent.contentVersion,
      ]),
    )
  )
    fail();
  const map = state.phase === 'initial' ? state.images : state.finalImages;
  const key = JSON.stringify(parent),
    value = JSON.stringify(images),
    old = map.get(key);
  if (
    (old !== undefined && old !== value) ||
    (old === undefined && map.size >= 3)
  )
    fail();
  map.set(key, value);
  return true;
}

async function epochHash(tx: PoolClient): Promise<string> {
  const row = (
    await tx.query<{ fingerprint: string }>(
      `SELECT whaleu_profile.moderation_hash(jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot)) fingerprint FROM whaleu_media.media_owner_states`,
    )
  ).rows[0];
  return row?.fingerprint ?? fail();
}
/** This immutable original epoch is compared inside the SQL command INSERT.
 * Its causal guard then permits only the declared exact retirement statements.
 * Thus a zero-row Media writer before command insertion is not rebased away. */
export function avatarModerationOriginalMediaEpoch(tx: PoolClient): string {
  const state = states.get(tx);
  if (!state || state.phase !== 'initial' || state.active || !state.observed)
    return fail();
  return state.originalEpoch;
}
