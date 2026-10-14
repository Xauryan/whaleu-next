import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import { boundedText, exact, uuid4 } from '../community/contract';
import { isUuid } from '../profile/contract';

export const institutionalConsent = 'institutional-verification-link/v1';
export const institutionalPurpose = 'institutional_verification';
export type InstitutionalFact = 'affiliation' | 'student_number';
export const institutionalCapabilityStates = [
  'eligible',
  'not_applicable',
  'provider_unconfigured',
  'provider_unavailable',
  'account_restricted',
  'verification_conflict',
] as const;
export interface InstitutionalCapability {
  readonly campusId: string;
  readonly state: (typeof institutionalCapabilityStates)[number];
  readonly schoolName: string | null;
  readonly capabilityVersion: string | null;
  readonly consent: typeof institutionalConsent | null;
  readonly purpose: typeof institutionalPurpose;
  readonly supportedFacts: readonly InstitutionalFact[];
}
export interface InstitutionalCommand {
  readonly requestId: string;
  readonly campusId: string;
  readonly capabilityVersion: string;
  readonly consent: typeof institutionalConsent;
}
export interface InstitutionalContext {
  readonly campusId: string;
  readonly capabilityVersion: string;
  readonly consent: typeof institutionalConsent;
}
export const institutionalTerminalStates = [
  'completed',
  'cancelled',
  'expired',
  'rejected',
  'challenge_required',
  'provider_unavailable',
  'conflict',
  'stale',
] as const;
export type InstitutionalReceipt =
  | {
      readonly requestId: string;
      readonly requestHash: null;
      readonly state: 'not_recorded';
    }
  | {
      readonly requestId: string;
      readonly requestHash: string;
      readonly state: 'prepared';
      readonly context: InstitutionalContext;
      readonly expiresAt: string;
    }
  | {
      readonly requestId: string;
      readonly requestHash: string;
      readonly state: 'completed';
      readonly changedFacts: readonly InstitutionalFact[];
      readonly uidOutcome: 'issued' | 'retained' | 'deferred_unavailable';
      readonly uidReason:
        null | 'inventory_unknown' | 'account_history_unknown';
    }
  | {
      readonly requestId: string;
      readonly requestHash: string;
      readonly state:
        | 'processing'
        | 'outcome_unknown'
        | 'ready_to_finalize'
        | 'cancelled'
        | 'expired'
        | 'rejected'
        | 'challenge_required'
        | 'provider_unavailable'
        | 'conflict'
        | 'stale';
    };
export function invalidInstitutional(): never {
  throw new ClientError(
    'protocol',
    'Invalid institutional verification response',
  );
}
export const institutionalHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function facts(value: unknown): readonly InstitutionalFact[] {
  if (
    !Array.isArray(value) ||
    value.length > 2 ||
    value.some((item) => item !== 'affiliation' && item !== 'student_number') ||
    new Set(value).size !== value.length
  )
    invalidInstitutional();
  return Object.freeze([...value]) as readonly InstitutionalFact[];
}
export function decodeInstitutionalCapability(
  raw: unknown,
): InstitutionalCapability {
  exact(raw, [
    'campusId',
    'state',
    'schoolName',
    'capabilityVersion',
    'consent',
    'purpose',
    'supportedFacts',
  ]);
  if (
    !isUuid(raw.campusId) ||
    !(institutionalCapabilityStates as readonly unknown[]).includes(
      raw.state,
    ) ||
    !(raw.schoolName === null || boundedText(raw.schoolName, 1, 200)) ||
    !(
      raw.capabilityVersion === null || institutionalHash(raw.capabilityVersion)
    ) ||
    !(raw.consent === null || raw.consent === institutionalConsent) ||
    raw.purpose !== institutionalPurpose
  )
    invalidInstitutional();
  const supportedFacts = facts(raw.supportedFacts);
  if (
    raw.state === 'eligible' &&
    (!supportedFacts.includes('affiliation') ||
      raw.schoolName === null ||
      raw.capabilityVersion === null ||
      raw.consent === null)
  )
    invalidInstitutional();
  return Object.freeze({
    ...raw,
    supportedFacts,
  }) as unknown as InstitutionalCapability;
}
export function decodeInstitutionalContext(raw: unknown): InstitutionalContext {
  exact(raw, ['campusId', 'capabilityVersion', 'consent']);
  if (
    !isUuid(raw.campusId) ||
    !institutionalHash(raw.capabilityVersion) ||
    raw.consent !== institutionalConsent
  )
    invalidInstitutional();
  return Object.freeze({
    campusId: raw.campusId,
    capabilityVersion: raw.capabilityVersion,
    consent: institutionalConsent,
  });
}
export function decodeInstitutionalCommand(raw: unknown): InstitutionalCommand {
  exact(raw, ['requestId', 'campusId', 'capabilityVersion', 'consent']);
  if (!uuid4(raw.requestId)) invalidInstitutional();
  return Object.freeze({
    requestId: raw.requestId,
    ...decodeInstitutionalContext({
      campusId: raw.campusId,
      capabilityVersion: raw.capabilityVersion,
      consent: raw.consent,
    }),
  });
}
/** The response is never part of this identity. The server recomputes the same hash. */
export function institutionalCommandHash(
  actor: string,
  input: InstitutionalCommand,
): string {
  if (!isUuid(actor)) invalidInstitutional();
  const command = decodeInstitutionalCommand(input);
  return sha256(
    'whaleu:institutional-sso-command:v1\n' +
      [
        actor,
        command.requestId,
        command.campusId,
        command.capabilityVersion,
        command.consent,
        institutionalPurpose,
      ].join('\n'),
  );
}
export function institutionalActorScope(actor: string): string {
  if (!isUuid(actor)) invalidInstitutional();
  return sha256('whaleu:institutional-sso-actor:v1\n' + actor);
}
export function decodeInstitutionalReceipt(raw: unknown): InstitutionalReceipt {
  if (!isRecord(raw)) invalidInstitutional();
  const keys = ['requestId', 'requestHash', 'state'];
  exact(raw, [
    ...keys,
    ...(raw.state === 'prepared'
      ? ['context', 'expiresAt']
      : raw.state === 'completed'
        ? ['changedFacts', 'uidOutcome', 'uidReason']
        : []),
  ]);
  if (!uuid4(raw.requestId)) invalidInstitutional();
  if (raw.state === 'not_recorded') {
    if (raw.requestHash !== null) invalidInstitutional();
    return Object.freeze({
      requestId: raw.requestId,
      requestHash: null,
      state: 'not_recorded',
    });
  }
  if (!institutionalHash(raw.requestHash)) invalidInstitutional();
  if (raw.state === 'prepared') {
    // Preserve authoritative DB text. Native milliseconds never decide issuance expiry.
    if (
      typeof raw.expiresAt !== 'string' ||
      raw.expiresAt.length > 80 ||
      !Number.isFinite(Date.parse(raw.expiresAt))
    )
      invalidInstitutional();
    return Object.freeze({
      requestId: raw.requestId,
      requestHash: raw.requestHash,
      state: 'prepared',
      context: decodeInstitutionalContext(raw.context),
      expiresAt: raw.expiresAt,
    });
  }
  if (raw.state === 'completed') {
    if (
      raw.uidOutcome === 'deferred_unavailable'
        ? raw.uidReason !== 'inventory_unknown' &&
          raw.uidReason !== 'account_history_unknown'
        : (raw.uidOutcome !== 'issued' && raw.uidOutcome !== 'retained') ||
          raw.uidReason !== null
    )
      invalidInstitutional();
    return Object.freeze({
      requestId: raw.requestId,
      requestHash: raw.requestHash,
      state: 'completed',
      changedFacts: facts(raw.changedFacts),
      uidOutcome: raw.uidOutcome,
      uidReason: raw.uidReason,
    }) as InstitutionalReceipt;
  }
  if (
    ![
      'processing',
      'outcome_unknown',
      'ready_to_finalize',
      ...institutionalTerminalStates,
    ].includes(raw.state as string)
  )
    invalidInstitutional();
  return Object.freeze({ ...raw }) as InstitutionalReceipt;
}
export function matchInstitutionalReceipt(
  command: InstitutionalCommand,
  hash: string,
  receipt: InstitutionalReceipt,
): void {
  if (
    receipt.requestId !== command.requestId ||
    (receipt.state !== 'not_recorded' && receipt.requestHash !== hash) ||
    (receipt.state === 'prepared' &&
      (receipt.context.campusId !== command.campusId ||
        receipt.context.capabilityVersion !== command.capabilityVersion ||
        receipt.context.consent !== command.consent))
  )
    invalidInstitutional();
}
export function institutionalTerminal(receipt: InstitutionalReceipt): boolean {
  return (institutionalTerminalStates as readonly string[]).includes(
    receipt.state,
  );
}
