import {
  RealDeletionProtocolError,
  type RealDeletionPhase,
  type RealDeletionReceipt,
} from './contracts.js';

/** Decision-only transition rules, NOT a database acceptance authority. All true
 * flags here must be recomputed by a qualified repository in the same managed TX.
 * No route accepts this object or treats a test-built decision as durable proof. */
export interface CurrentRequestDecision {
  readonly phase: RealDeletionPhase;
  readonly credentialCurrent: boolean;
  readonly generationCurrent: boolean;
  readonly preparationLive: boolean;
  readonly coolingBeforeDeadline: boolean;
  readonly irreversibleAbsent: boolean;
  readonly revision: string;
}
export interface ExactReceipt {
  readonly intentHash: string;
  readonly receipt: RealDeletionReceipt;
}
export function exactReplay(
  stored: ExactReceipt | null,
  intentHash: string,
): RealDeletionReceipt | null {
  if (!stored) return null;
  if (stored.intentHash !== intentHash)
    throw new RealDeletionProtocolError('INTENT_CONFLICT');
  return stored.receipt;
}
export function requireNewAcceptance(state: CurrentRequestDecision): void {
  if (
    !state.credentialCurrent ||
    !state.generationCurrent ||
    !state.preparationLive ||
    state.phase !== 'prepared'
  )
    throw new RealDeletionProtocolError('SCOPE_UNAVAILABLE');
}
export function requireNewCancellation(
  state: CurrentRequestDecision,
  expectedRevision: string,
): void {
  if (
    !state.credentialCurrent ||
    !state.generationCurrent ||
    state.phase !== 'cooling' ||
    !state.coolingBeforeDeadline ||
    !state.irreversibleAbsent ||
    state.revision !== expectedRevision
  )
    throw new RealDeletionProtocolError('CANCELLATION_UNAVAILABLE');
}
/** Installed entry remains non-activating. Never interpret configuration, a caller
 * Boolean or synthetic coverage as permission to advance the real account epoch. */
export function realDeletionActivation(): Readonly<{
  acceptance: 'unavailable';
  ownerCoverage: 'unproven';
  legacyReaderRetirement: 'unproven';
}> {
  return Object.freeze({
    acceptance: 'unavailable',
    ownerCoverage: 'unproven',
    legacyReaderRetirement: 'unproven',
  });
}
