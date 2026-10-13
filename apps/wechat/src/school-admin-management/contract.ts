import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import { boundedText, exact, timestamp, uuid4 } from '../community/contract';
import { isUuid } from '../profile/contract';

export type SchoolAdminAction = 'appoint' | 'reassign' | 'revoke';
export interface SchoolAdminRegion {
  readonly id: string;
  readonly name: string;
}
export interface SchoolAdminManagement {
  readonly target: { readonly profileId: string; readonly displayName: string };
  readonly stateVersion: string;
  readonly currentAssignment: {
    readonly regionId: string;
    readonly name: string;
    readonly status: 'active' | 'future' | 'expired' | 'unavailable';
  } | null;
  readonly eligibility: {
    readonly status: 'known' | 'unavailable' | 'unverified' | 'protected';
    readonly reason: string | null;
    readonly regions: readonly SchoolAdminRegion[];
    readonly defaultRegionId: string | null;
  };
  readonly actions: Readonly<Record<SchoolAdminAction, boolean>>;
}
export type SchoolAdminManagementCommand = {
  readonly clientRequestId: string;
  readonly targetProfileId: string;
  readonly expectedStateVersion: string;
} & (
  | { readonly action: 'appoint' | 'reassign'; readonly regionId: string }
  | { readonly action: 'revoke' }
);
export type SchoolAdminManagementReceipt = Omit<
  SchoolAdminManagementCommand,
  'clientRequestId'
> &
  (
    | { readonly action: 'appoint' | 'reassign'; readonly regionId: string }
    | { readonly action: 'revoke' }
  ) & { readonly requestId: string } & (
    | {
        readonly outcome: 'applied' | 'unchanged';
        readonly eventId: string;
        readonly recordedAt: string;
        readonly titleGranted: boolean;
      }
    | {
        readonly outcome: 'rejected';
        readonly code:
          'SCHOOL_ADMIN_MANAGEMENT_STALE' | 'SCHOOL_ADMIN_MANAGEMENT_CANCELLED';
      }
  );
export type SchoolAdminManagementRecovery =
  | {
      readonly state: 'recorded';
      readonly receipt: SchoolAdminManagementReceipt;
    }
  | { readonly state: 'not_recorded' };
export function invalidSchoolAdminManagement(): never {
  throw new ClientError(
    'protocol',
    'Invalid school administrator management response',
  );
}
const version = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function decodeSchoolAdminManagement(
  raw: unknown,
): SchoolAdminManagement {
  exact(raw, [
    'target',
    'stateVersion',
    'currentAssignment',
    'eligibility',
    'actions',
  ]);
  exact(raw.target, ['profileId', 'displayName']);
  if (
    !isUuid(raw.target.profileId) ||
    !boundedText(raw.target.displayName, 1, 20) ||
    !version(raw.stateVersion)
  )
    invalidSchoolAdminManagement();
  let currentAssignment: SchoolAdminManagement['currentAssignment'] = null;
  if (raw.currentAssignment !== null) {
    exact(raw.currentAssignment, ['regionId', 'name', 'status']);
    if (
      !isUuid(raw.currentAssignment.regionId) ||
      !boundedText(raw.currentAssignment.name, 1, 200) ||
      !['active', 'future', 'expired', 'unavailable'].includes(
        String(raw.currentAssignment.status),
      )
    )
      invalidSchoolAdminManagement();
    currentAssignment = Object.freeze({
      regionId: raw.currentAssignment.regionId,
      name: raw.currentAssignment.name,
      status: raw.currentAssignment.status as NonNullable<
        SchoolAdminManagement['currentAssignment']
      >['status'],
    });
  }
  exact(raw.eligibility, ['status', 'reason', 'regions', 'defaultRegionId']);
  const eligibility = raw.eligibility;
  if (
    !['known', 'unavailable', 'unverified', 'protected'].includes(
      String(eligibility.status),
    ) ||
    !(eligibility.reason === null || boundedText(eligibility.reason, 1, 200)) ||
    !Array.isArray(eligibility.regions) ||
    eligibility.regions.length > 512
  )
    invalidSchoolAdminManagement();
  const regions = eligibility.regions.map((item): SchoolAdminRegion => {
    exact(item, ['id', 'name']);
    if (!isUuid(item.id) || !boundedText(item.name, 1, 200))
      invalidSchoolAdminManagement();
    return Object.freeze({ id: item.id, name: item.name });
  });
  if (
    new Set(regions.map((item) => item.id)).size !== regions.length ||
    !(
      eligibility.defaultRegionId === null ||
      (isUuid(eligibility.defaultRegionId) &&
        regions.some((item) => item.id === eligibility.defaultRegionId))
    ) ||
    (eligibility.status !== 'known' &&
      (regions.length !== 0 || eligibility.defaultRegionId !== null))
  )
    invalidSchoolAdminManagement();
  exact(raw.actions, ['appoint', 'reassign', 'revoke']);
  const actions = raw.actions;
  if (
    typeof actions.appoint !== 'boolean' ||
    typeof actions.reassign !== 'boolean' ||
    typeof actions.revoke !== 'boolean' ||
    (actions.appoint && actions.reassign) ||
    ((actions.appoint || actions.reassign) &&
      (eligibility.status !== 'known' || regions.length === 0)) ||
    (actions.reassign && !currentAssignment) ||
    (eligibility.status === 'protected' &&
      (actions.appoint || actions.reassign || actions.revoke))
  )
    invalidSchoolAdminManagement();
  return Object.freeze({
    target: Object.freeze({
      profileId: raw.target.profileId,
      displayName: raw.target.displayName,
    }),
    stateVersion: raw.stateVersion,
    currentAssignment,
    eligibility: Object.freeze({
      status:
        eligibility.status as SchoolAdminManagement['eligibility']['status'],
      reason: eligibility.reason as string | null,
      regions: Object.freeze(regions),
      defaultRegionId: eligibility.defaultRegionId as string | null,
    }),
    actions: Object.freeze({
      appoint: actions.appoint,
      reassign: actions.reassign,
      revoke: actions.revoke,
    }),
  });
}
function checkIntent(raw: Record<string, unknown>): void {
  if (
    !isUuid(raw.targetProfileId) ||
    !version(raw.expectedStateVersion) ||
    !['appoint', 'reassign', 'revoke'].includes(String(raw.action)) ||
    (raw.action !== 'revoke' && !isUuid(raw.regionId))
  )
    invalidSchoolAdminManagement();
}
export function decodeSchoolAdminManagementCommand(
  raw: unknown,
): SchoolAdminManagementCommand {
  if (!isRecord(raw)) invalidSchoolAdminManagement();
  exact(raw, [
    'clientRequestId',
    'targetProfileId',
    'expectedStateVersion',
    'action',
    ...(raw.action === 'revoke' ? [] : ['regionId']),
  ]);
  checkIntent(raw);
  if (!uuid4(raw.clientRequestId)) invalidSchoolAdminManagement();
  return Object.freeze({ ...raw }) as SchoolAdminManagementCommand;
}
export function decodeSchoolAdminManagementReceipt(
  raw: unknown,
): SchoolAdminManagementReceipt {
  if (!isRecord(raw)) invalidSchoolAdminManagement();
  exact(raw, [
    'requestId',
    'targetProfileId',
    'expectedStateVersion',
    'action',
    ...(raw.action === 'revoke' ? [] : ['regionId']),
    'outcome',
    ...(raw.outcome === 'rejected'
      ? ['code']
      : ['eventId', 'recordedAt', 'titleGranted']),
  ]);
  checkIntent(raw);
  if (!uuid4(raw.requestId)) invalidSchoolAdminManagement();
  if (raw.outcome === 'applied' || raw.outcome === 'unchanged') {
    if (
      !isUuid(raw.eventId) ||
      !timestamp(raw.recordedAt) ||
      typeof raw.titleGranted !== 'boolean' ||
      (raw.action === 'revoke' && raw.titleGranted)
    )
      invalidSchoolAdminManagement();
  } else if (
    raw.outcome !== 'rejected' ||
    ![
      'SCHOOL_ADMIN_MANAGEMENT_STALE',
      'SCHOOL_ADMIN_MANAGEMENT_CANCELLED',
    ].includes(String(raw.code))
  )
    invalidSchoolAdminManagement();
  return Object.freeze({ ...raw }) as SchoolAdminManagementReceipt;
}
export function matchSchoolAdminManagementReceipt(
  command: SchoolAdminManagementCommand,
  receipt: SchoolAdminManagementReceipt,
): void {
  if (
    command.clientRequestId !== receipt.requestId ||
    command.targetProfileId !== receipt.targetProfileId ||
    command.expectedStateVersion !== receipt.expectedStateVersion ||
    command.action !== receipt.action ||
    (command.action !== 'revoke' &&
      (receipt.action === 'revoke' || command.regionId !== receipt.regionId))
  )
    invalidSchoolAdminManagement();
}
export function decodeSchoolAdminManagementRecovery(
  raw: unknown,
): SchoolAdminManagementRecovery {
  if (!isRecord(raw)) invalidSchoolAdminManagement();
  if (raw.state === 'recorded') {
    exact(raw, ['state', 'receipt']);
    return Object.freeze({
      state: 'recorded',
      receipt: decodeSchoolAdminManagementReceipt(raw.receipt),
    });
  }
  exact(raw, ['state']);
  if (raw.state !== 'not_recorded') invalidSchoolAdminManagement();
  return Object.freeze({ state: 'not_recorded' });
}
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && value !== null)
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return invalidSchoolAdminManagement();
}
export function schoolAdminManagementCommandHash(
  actor: string,
  command: SchoolAdminManagementCommand,
): string {
  if (!isUuid(actor)) invalidSchoolAdminManagement();
  return sha256(
    'whaleu:school-admin-management-command:v1\n' +
      canonical({
        actor,
        command: decodeSchoolAdminManagementCommand(command),
      }),
  );
}
