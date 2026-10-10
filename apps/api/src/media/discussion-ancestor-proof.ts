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

type Obligation = {
  identity: string;
  rerun: () => Promise<unknown>;
  fingerprint: (value: unknown) => string;
  result: string;
  images: Map<string, string>;
};
type Collector = {
  tx: PoolClient;
  input: string;
  obligations: Obligation[];
  active: Obligation | null;
  phase: 'initial' | 'final' | 'closed';
  currentImages: Map<string, string> | null;
  finalized: boolean;
  epoch?: object;
  media?: string;
};
const collectors = new WeakMap<PoolClient, Collector>();
const fail = (): never => {
  throw new ApplicationError('MEDIA_UNAVAILABLE');
};
const proof: RequiredTransactionProof<Collector> = {
  maximumFacts: 64,
  failureCode: 'MEDIA_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'MEDIA_UNAVAILABLE', async (read) => {
      if (!(await mediaCountProofOwner.fence(read))) fail();
      const fingerprint = ownerFingerprint(
        await mediaCountProofOwner.capture(read),
      );
      for (const fact of facts)
        if (
          fact.tx !== tx ||
          !fact.finalized ||
          fact.phase !== 'closed' ||
          fact.epoch !== transactionReadEpoch(tx) ||
          fact.media !== fingerprint
        )
          fail();
    }),
};
/** Explicit mutation scope. It never restores or removes another owner's facts.
 * Only the original discussion authorization callback can collect ancestor reads.
 * Final authorization happens before transaction finalization, not inside a validator. */
export async function withDiscussionMediaMutation<T>(
  tx: PoolClient,
  input: unknown,
  run: () => Promise<T>,
): Promise<T> {
  if (!transactionReadEpoch(tx) || collectors.has(tx)) fail();
  const state: Collector = {
    tx,
    input: JSON.stringify(input),
    obligations: [],
    active: null,
    phase: 'initial',
    currentImages: null,
    finalized: false,
  };
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    `discussion:${randomUUID()}`,
    state,
  );
  collectors.set(tx, state);
  try {
    const result = await run();
    state.phase = 'final';
    for (const obligation of state.obligations) {
      state.active = obligation;
      state.currentImages = new Map();
      const current = await obligation.rerun();
      if (
        obligation.fingerprint(current) !== obligation.result ||
        ownerFingerprint([...state.currentImages].sort()) !==
          ownerFingerprint([...obligation.images].sort())
      )
        fail();
      state.active = null;
      state.currentImages = null;
    }
    state.media = ownerFingerprint(await mediaCountProofOwner.capture(tx));
    state.epoch = transactionReadEpoch(tx) ?? fail();
    state.finalized = true;
    return result;
  } finally {
    state.phase = 'closed';
    state.active = null;
    state.currentImages = null;
    collectors.delete(tx);
  }
}
export async function discussionAncestorAuthorization<T>(
  tx: PoolClient,
  identity: unknown,
  run: () => Promise<T>,
  fingerprint: (value: T) => string,
): Promise<T> {
  const state = collectors.get(tx);
  if (!state) return run();
  if (
    state.tx !== tx ||
    state.phase !== 'initial' ||
    state.active ||
    state.obligations.length >= 64
  )
    fail();
  const obligation: Obligation = {
    identity: JSON.stringify(identity),
    rerun: run,
    fingerprint: fingerprint as (value: unknown) => string,
    result: '',
    images: new Map(),
  };
  state.obligations.push(obligation);
  state.active = obligation;
  state.currentImages = obligation.images;
  try {
    const result = await run();
    obligation.result = fingerprint(result);
    return result;
  } finally {
    state.active = null;
    state.currentImages = null;
  }
}
/** Returns true only inside the qualified ancestor callback. Ordinary Media
 * descriptors and all other consumers keep their original epoch proof. */
export function collectDiscussionAncestorMedia(
  tx: PoolClient,
  parent: MediaParent,
  images: readonly { assetId: string; digest: string }[],
): boolean {
  const state = collectors.get(tx);
  if (!state?.active || !state.currentImages || state.phase === 'closed')
    return false;
  const key = JSON.stringify(parent),
    value = JSON.stringify(images);
  const previous = state.currentImages.get(key);
  if (previous !== undefined && previous !== value) fail();
  if (previous === undefined && state.currentImages.size >= 3) fail();
  state.currentImages.set(key, value);
  return true;
}
