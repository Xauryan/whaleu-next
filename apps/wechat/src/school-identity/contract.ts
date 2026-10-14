import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import { boundedText, exact, timestamp, uuid4 } from '../community/contract';
import { isUuid } from '../profile/contract';
import {
  decodeSchoolUid,
  decodeSchoolUidSchool,
  type SchoolUid,
  type SchoolUidSchool,
} from '../school-uid/contract';
export type SchoolIdentityAction = 'correct_school' | 'complete_uid';
export type SchoolIdentityIntent = {
  readonly version: 1;
  readonly targetProfileId: string;
  readonly expectedStateVersion: string;
} & (
  | {
      readonly action: 'correct_school';
      readonly destinationCampusId: string;
      readonly expectedDestinationVersion: string;
    }
  | { readonly action: 'complete_uid' }
);
export type SchoolIdentityCommand = SchoolIdentityIntent & {
  readonly clientRequestId: string;
};
export type SchoolIdentityReceipt = SchoolIdentityIntent & {
  readonly requestId: string;
} & (
    | {
        readonly outcome: 'applied' | 'unchanged';
        readonly eventId: string;
        readonly recordedAt: string;
      }
    | {
        readonly outcome: 'rejected';
        readonly code: 'SCHOOL_IDENTITY_STALE' | 'SCHOOL_IDENTITY_CANCELLED';
      }
  );
export type SchoolIdentityRecovery =
  | { readonly state: 'recorded'; readonly receipt: SchoolIdentityReceipt }
  | { readonly state: 'not_recorded' };
export interface SchoolIdentityManagement {
  readonly target: { readonly profileId: string; readonly displayName: string };
  readonly stateVersion: string;
  readonly current: {
    readonly schoolUid: SchoolUid;
    readonly school: SchoolUidSchool | null;
  };
  readonly destination: {
    readonly campusId: string;
    readonly campusName: string;
    readonly school: SchoolUidSchool;
    readonly destinationVersion: string;
  } | null;
  readonly actions: {
    readonly correctSchool: boolean;
    readonly completeUid: boolean;
  };
}
export function invalidSchoolIdentity(): never {
  throw new ClientError('protocol', 'Invalid school identity response');
}
const version = (raw: unknown): raw is string =>
  typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw);
export function decodeSchoolIdentityManagement(
  raw: unknown,
): SchoolIdentityManagement {
  exact(raw, ['target', 'stateVersion', 'current', 'destination', 'actions']);
  exact(raw.target, ['profileId', 'displayName']);
  exact(raw.current, ['schoolUid', 'school']);
  exact(raw.actions, ['correctSchool', 'completeUid']);
  if (
    !isUuid(raw.target.profileId) ||
    !boundedText(raw.target.displayName, 1, 100) ||
    !version(raw.stateVersion) ||
    typeof raw.actions.correctSchool !== 'boolean' ||
    typeof raw.actions.completeUid !== 'boolean'
  )
    invalidSchoolIdentity();
  const schoolUid = decodeSchoolUid(raw.current.schoolUid),
    school =
      raw.current.school === null
        ? null
        : decodeSchoolUidSchool(raw.current.school);
  if (
    (schoolUid.status === 'assigned' &&
      (schoolUid.school.code !== school?.code ||
        schoolUid.school.name !== school?.name)) ||
    (raw.actions.completeUid && schoolUid.status === 'assigned') ||
    ((raw.actions.correctSchool || raw.actions.completeUid) && school === null)
  )
    invalidSchoolIdentity();
  let destination: SchoolIdentityManagement['destination'] = null;
  if (raw.destination !== null) {
    exact(raw.destination, [
      'campusId',
      'campusName',
      'school',
      'destinationVersion',
    ]);
    if (
      !isUuid(raw.destination.campusId) ||
      !boundedText(raw.destination.campusName, 1, 200) ||
      !version(raw.destination.destinationVersion)
    )
      invalidSchoolIdentity();
    destination = Object.freeze({
      campusId: raw.destination.campusId,
      campusName: raw.destination.campusName,
      school: decodeSchoolUidSchool(raw.destination.school),
      destinationVersion: raw.destination.destinationVersion,
    });
  }
  return Object.freeze({
    target: Object.freeze({
      profileId: raw.target.profileId,
      displayName: raw.target.displayName,
    }),
    stateVersion: raw.stateVersion,
    current: Object.freeze({ schoolUid, school }),
    destination,
    actions: Object.freeze({
      correctSchool: raw.actions.correctSchool,
      completeUid: raw.actions.completeUid,
    }),
  });
}
const intentKeys = [
  'version',
  'targetProfileId',
  'expectedStateVersion',
  'action',
];
function checkIntent(raw: Record<string, unknown>): void {
  if (
    raw.version !== 1 ||
    !isUuid(raw.targetProfileId) ||
    !version(raw.expectedStateVersion) ||
    (raw.action !== 'correct_school' && raw.action !== 'complete_uid') ||
    (raw.action === 'correct_school' &&
      (!isUuid(raw.destinationCampusId) ||
        !version(raw.expectedDestinationVersion)))
  )
    invalidSchoolIdentity();
}
const destinationKeys = (raw: Record<string, unknown>) =>
  raw.action === 'correct_school'
    ? ['destinationCampusId', 'expectedDestinationVersion']
    : [];
export function decodeSchoolIdentityCommand(
  raw: unknown,
): SchoolIdentityCommand {
  if (!isRecord(raw)) invalidSchoolIdentity();
  exact(raw, [...intentKeys, 'clientRequestId', ...destinationKeys(raw)]);
  checkIntent(raw);
  if (!uuid4(raw.clientRequestId)) invalidSchoolIdentity();
  return Object.freeze({ ...raw }) as SchoolIdentityCommand;
}
export function decodeSchoolIdentityReceipt(
  raw: unknown,
): SchoolIdentityReceipt {
  if (!isRecord(raw)) invalidSchoolIdentity();
  exact(raw, [
    ...intentKeys,
    'requestId',
    ...destinationKeys(raw),
    'outcome',
    ...(raw.outcome === 'rejected' ? ['code'] : ['eventId', 'recordedAt']),
  ]);
  checkIntent(raw);
  if (!uuid4(raw.requestId)) invalidSchoolIdentity();
  if (raw.outcome === 'rejected') {
    if (
      raw.code !== 'SCHOOL_IDENTITY_STALE' &&
      raw.code !== 'SCHOOL_IDENTITY_CANCELLED'
    )
      invalidSchoolIdentity();
  } else if (
    (raw.outcome !== 'applied' && raw.outcome !== 'unchanged') ||
    !isUuid(raw.eventId) ||
    !timestamp(raw.recordedAt)
  )
    invalidSchoolIdentity();
  return Object.freeze({ ...raw }) as SchoolIdentityReceipt;
}
export function matchSchoolIdentityReceipt(
  command: SchoolIdentityCommand,
  receipt: SchoolIdentityReceipt,
): void {
  if (
    command.version !== receipt.version ||
    command.clientRequestId !== receipt.requestId ||
    command.targetProfileId !== receipt.targetProfileId ||
    command.expectedStateVersion !== receipt.expectedStateVersion ||
    command.action !== receipt.action ||
    (command.action === 'correct_school' &&
      (receipt.action !== 'correct_school' ||
        command.destinationCampusId !== receipt.destinationCampusId ||
        command.expectedDestinationVersion !==
          receipt.expectedDestinationVersion))
  )
    invalidSchoolIdentity();
}
export function decodeSchoolIdentityRecovery(
  raw: unknown,
): SchoolIdentityRecovery {
  if (!isRecord(raw)) invalidSchoolIdentity();
  if (raw.state === 'recorded') {
    exact(raw, ['state', 'receipt']);
    return Object.freeze({
      state: 'recorded',
      receipt: decodeSchoolIdentityReceipt(raw.receipt),
    });
  }
  exact(raw, ['state']);
  if (raw.state !== 'not_recorded') invalidSchoolIdentity();
  return Object.freeze({ state: 'not_recorded' });
}
export function schoolIdentityCommandCanonical(
  raw: SchoolIdentityCommand,
): string {
  const command = decodeSchoolIdentityCommand(raw);
  return (
    'whaleu:school-identity-command:v1\n' +
    [
      String(command.version),
      command.action,
      command.targetProfileId,
      command.expectedStateVersion,
      ...(command.action === 'correct_school'
        ? [command.destinationCampusId, command.expectedDestinationVersion]
        : []),
    ].join('\n')
  );
}
export function schoolIdentityCommandHash(
  command: SchoolIdentityCommand,
): string {
  return sha256(schoolIdentityCommandCanonical(command));
}
export function schoolIdentityJournalHash(
  actor: string,
  command: SchoolIdentityCommand,
): string {
  if (!isUuid(actor)) invalidSchoolIdentity();
  return sha256(
    'whaleu:school-identity-journal:v1\n' +
      actor +
      '\n' +
      command.clientRequestId +
      '\n' +
      schoolIdentityCommandCanonical(command),
  );
}
/** Local actor scope is pseudonymous; no raw account identifier is written to this journal. */
export function schoolIdentityActorScope(actor: string): string {
  if (!isUuid(actor)) invalidSchoolIdentity();
  return sha256('whaleu:school-identity-actor:v1\n' + actor);
}
