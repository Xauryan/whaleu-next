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
import {
  RatingsMediaContentSnapshotFacade,
  ratingsMediaContentKey,
} from './ratings-content-snapshot.facade.js';
import type {
  MediaSnapshotReadBudget,
  RatingsMediaContentReference,
  RatingsMediaContentFact,
} from './ratings-content-snapshot.facade.js';
import {
  RatingsDiscussionMediaContentSnapshotFacade,
  ratingsDiscussionMediaContentKey,
} from './ratings-discussion-content-snapshot.facade.js';
import type {
  RatingsDiscussionMediaContentReference,
  RatingsDiscussionMediaContentFact,
} from './ratings-discussion-content-snapshot.facade.js';

const brand: unique symbol = Symbol('ratings-media-mutation');
export interface RatingsMediaMutation {
  readonly [brand]: true;
}
type Reference =
  RatingsMediaContentReference | RatingsDiscussionMediaContentReference;
type Fact = RatingsMediaContentFact | RatingsDiscussionMediaContentFact;
interface Obligation {
  reference: Reference;
  fingerprint: string;
}
interface State {
  tx: PoolClient;
  epoch: object;
  phase: 'collecting' | 'checking' | 'closed';
  finished: boolean;
  obligations: Map<string, Obligation>;
  budget: MediaSnapshotReadBudget | null;
  after: string | null;
}
const active = new WeakMap<PoolClient, State>(),
  issued = new WeakMap<RatingsMediaMutation, State>();
function fail(): never {
  throw new ApplicationError('MEDIA_UNAVAILABLE');
}
const keyOf = (reference: Reference) =>
  reference.parent.resourceKind === 'target_cover'
    ? `6:${ratingsMediaContentKey(reference.parent)}`
    : `7:${ratingsDiscussionMediaContentKey(reference.parent)}`;
const completion: RequiredTransactionProof<State> = {
  maximumFacts: 8,
  failureCode: 'MEDIA_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'MEDIA_UNAVAILABLE', async (read) => {
      if (!(await mediaCountProofOwner.fence(read))) fail();
      const current = ownerFingerprint(
        await mediaCountProofOwner.capture(read),
      );
      for (const state of facts)
        if (
          state.tx !== tx ||
          state.epoch !== transactionReadEpoch(tx) ||
          !state.finished ||
          state.phase !== 'closed' ||
          state.after !== current
        )
          fail();
    }),
};
/** Only a Ratings owner command/auth wrapper may begin this narrow mutation.
 * It never removes, changes, checkpoints or restores earlier transaction facts. */
export function beginRatingsMediaMutation(
  tx: PoolClient,
): RatingsMediaMutation {
  const epoch = transactionReadEpoch(tx),
    old = active.get(tx);
  if (!epoch || (old && old.epoch === epoch)) fail();
  // A genuine savepoint rollback changes epoch and prunes its obligations.
  const state: State = {
    tx,
    epoch,
    phase: 'collecting',
    finished: false,
    obligations: new Map(),
    budget: null,
    after: null,
  };
  const cap = Object.freeze({ [brand]: true as const });
  enableRequiredTransactionProof(tx, completion);
  registerRequiredTransactionFact(
    tx,
    completion,
    `ratings-media-mutation:${randomUUID()}`,
    state,
  );
  active.set(tx, state);
  issued.set(cap, state);
  return cap;
}
export function ratingsMediaMutationActive(tx: PoolClient): boolean {
  const state = active.get(tx);
  return Boolean(
    state &&
    state.tx === tx &&
    state.epoch === transactionReadEpoch(tx) &&
    state.phase === 'collecting',
  );
}
/** Registers only immutable snapshot expectations newly read by this command.
 * The owner still authorizes session, source, Review and real ancestors itself. */
export function collectRatingsMediaMutationRead(
  tx: PoolClient,
  references: readonly Reference[],
  facts: ReadonlyMap<string, Fact>,
  budget: MediaSnapshotReadBudget,
): boolean {
  const state = active.get(tx);
  if (
    !state ||
    state.epoch !== transactionReadEpoch(tx) ||
    state.phase !== 'collecting'
  )
    return false;
  if (references.length > 256) fail();
  state.budget ??= budget;
  for (const reference of references) {
    const key = keyOf(reference),
      sourceKey = key.slice(2),
      fact = facts.get(sourceKey);
    if (!fact) fail();
    const fingerprint = ownerFingerprint(fact),
      old = state.obligations.get(key);
    if (
      old &&
      (old.fingerprint !== fingerprint ||
        JSON.stringify(old.reference) !== JSON.stringify(reference))
    )
      fail();
    if (!old) {
      if (state.obligations.size >= 256) fail();
      state.obligations.set(key, {
        reference: Object.freeze({
          parent: Object.freeze({ ...reference.parent }),
          expected: Object.freeze(
            reference.expected.map((x) => Object.freeze({ ...x })),
          ),
        }) as Reference,
        fingerprint,
      });
    }
  }
  return true;
}
/** Re-read at most two bounded batches after all own writes, compare the whole
 * ordered fact including negative/absence/Review-independent safety head, then
 * capture after. No business/remote read is deferred into final validators. */
export async function finishRatingsMediaMutation(
  capability: RatingsMediaMutation,
  tx: PoolClient,
): Promise<void> {
  const state = issued.get(capability);
  if (
    !state ||
    state.tx !== tx ||
    state.epoch !== transactionReadEpoch(tx) ||
    active.get(tx) !== state ||
    state.phase !== 'collecting' ||
    state.finished
  )
    fail();
  state.phase = 'checking';
  const obligations = [...state.obligations.values()],
    covers: RatingsMediaContentReference[] = [],
    discussion: RatingsDiscussionMediaContentReference[] = [];
  for (const { reference } of obligations) {
    if (reference.parent.resourceKind === 'target_cover')
      covers.push(reference as RatingsMediaContentReference);
    else discussion.push(reference as RatingsDiscussionMediaContentReference);
  }
  if (obligations.length && !state.budget) fail();
  const current = new Map<string, Fact>();
  if (covers.length)
    for (const [
      key,
      fact,
    ] of await new RatingsMediaContentSnapshotFacade().readBatch(
      covers,
      tx,
      state.budget!,
    ))
      current.set(`6:${key}`, fact);
  if (discussion.length)
    for (const [
      key,
      fact,
    ] of await new RatingsDiscussionMediaContentSnapshotFacade().readBatch(
      discussion,
      tx,
      state.budget!,
    ))
      current.set(`7:${key}`, fact);
  for (const [key, obligation] of state.obligations)
    if (
      !current.has(key) ||
      ownerFingerprint(current.get(key)) !== obligation.fingerprint
    )
      fail();
  state.after = ownerFingerprint(await mediaCountProofOwner.capture(tx));
  state.finished = true;
  state.phase = 'closed';
  active.delete(tx);
}
/** Call only on failure. The unfinished required fact remains and rejects commit
 * unless its actual database savepoint and all its tentative output roll back. */
export function abortRatingsMediaMutation(
  capability: RatingsMediaMutation,
  tx: PoolClient,
): void {
  const state = issued.get(capability);
  if (state && state.tx === tx && active.get(tx) === state) {
    state.phase = 'closed';
    active.delete(tx);
  }
}
export async function withRatingsMediaMutation<T>(
  tx: PoolClient,
  run: () => Promise<T>,
): Promise<T> {
  const cap = beginRatingsMediaMutation(tx);
  try {
    const result = await run();
    await finishRatingsMediaMutation(cap, tx);
    return result;
  } catch (error) {
    abortRatingsMediaMutation(cap, tx);
    throw error;
  }
}
