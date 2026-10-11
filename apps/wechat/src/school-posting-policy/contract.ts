import { sha256 } from 'js-sha256';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import { isUuid } from '../profile/contract';

export const postingPolicyCategories = [
  'discussion',
  'confession',
  'companions',
  'pets',
  'internships',
  'scenery',
  'dorms',
  'research',
  'deep_sea',
] as const;
export type PostingPolicyCategory = (typeof postingPolicyCategories)[number];
export const postingPolicyLabels: Record<PostingPolicyCategory, string> = {
  discussion: '校园日常',
  confession: '表白心事',
  companions: '找搭子',
  pets: '校园萌宠',
  internships: '实习工作',
  scenery: '校园风景',
  dorms: '宿舍生活',
  research: '学术科研',
  deep_sea: '深海树洞',
};
export type PostingPolicyExpiry =
  | { readonly kind: 'policy_exempt' }
  | { readonly kind: 'at'; readonly validUntil: string };
export interface PostingPolicyInput {
  readonly unverifiedPostEnabled: boolean;
  readonly unverifiedCommentEnabled: boolean;
  readonly unverifiedCategories: readonly PostingPolicyCategory[];
  readonly expiry: PostingPolicyExpiry;
}
export interface PostingPolicyCommand {
  readonly clientRequestId: string;
  readonly expectedRevision: number;
  readonly policy: PostingPolicyInput;
}
export interface PostingPolicyView {
  readonly context: {
    readonly regionId: string;
    readonly regionName: string;
    readonly management: 'fixed' | 'global';
  };
  readonly revision: number;
  readonly revisionId: string | null;
  readonly state: 'unconfigured' | 'active' | 'expired' | 'unavailable';
  readonly editable: boolean;
  readonly blocker: null | 'untrusted_source' | 'related_sync_unsupported';
  readonly policy:
    (PostingPolicyInput & { readonly effectiveAt: string }) | null;
}
export interface PostingPolicyReceipt {
  readonly requestId: string;
  readonly requestHash: string;
  readonly regionId: string;
  readonly revision: number;
  readonly revisionId: string;
  readonly outcome: 'saved';
}
export type PostingPolicyRecovery =
  | { readonly state: 'not_recorded'; readonly requestId: string }
  | {
      readonly state: 'recorded';
      readonly requestId: string;
      readonly receipt: PostingPolicyReceipt;
    }
  | {
      readonly state: 'cancelled';
      readonly requestId: string;
      readonly requestHash: string;
    };
export function invalidPostingPolicy(): never {
  throw new ClientError('protocol', 'Invalid school posting policy data');
}
export function postingPolicyUuid(value: unknown): string {
  if (!isUuid(value) || value !== value.toLowerCase()) invalidPostingPolicy();
  return value;
}
export function postingPolicyRequestId(value: unknown): string {
  const id = postingPolicyUuid(value);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id,
    )
  )
    invalidPostingPolicy();
  return id;
}
function revision(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2147483647
  )
    invalidPostingPolicy();
  return value;
}
export function postingPolicyHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    invalidPostingPolicy();
  return value;
}
/** Require explicit UTC; preserve the exact submitted spelling for durable replay. */
export function postingPolicyInstant(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  )
    invalidPostingPolicy();
  const instant = new Date(value);
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    invalidPostingPolicy();
  return value;
}
export function decodePostingPolicyExpiry(value: unknown): PostingPolicyExpiry {
  exact(
    value,
    value && typeof value === 'object' && 'kind' in value && value.kind === 'at'
      ? ['kind', 'validUntil']
      : ['kind'],
  );
  if (value.kind === 'policy_exempt')
    return Object.freeze({ kind: 'policy_exempt' });
  if (value.kind !== 'at') invalidPostingPolicy();
  return Object.freeze({
    kind: 'at',
    validUntil: postingPolicyInstant(value.validUntil),
  });
}
export function decodePostingPolicyInput(value: unknown): PostingPolicyInput {
  exact(value, [
    'unverifiedPostEnabled',
    'unverifiedCommentEnabled',
    'unverifiedCategories',
    'expiry',
  ]);
  if (
    typeof value.unverifiedPostEnabled !== 'boolean' ||
    typeof value.unverifiedCommentEnabled !== 'boolean' ||
    !Array.isArray(value.unverifiedCategories) ||
    value.unverifiedCategories.length > postingPolicyCategories.length ||
    new Set(value.unverifiedCategories).size !==
      value.unverifiedCategories.length ||
    value.unverifiedCategories.some(
      (category: unknown) =>
        typeof category !== 'string' ||
        !(postingPolicyCategories as readonly string[]).includes(category),
    )
  )
    invalidPostingPolicy();
  return Object.freeze({
    unverifiedPostEnabled: value.unverifiedPostEnabled,
    unverifiedCommentEnabled: value.unverifiedCommentEnabled,
    unverifiedCategories: Object.freeze([
      ...value.unverifiedCategories,
    ] as PostingPolicyCategory[]),
    expiry: decodePostingPolicyExpiry(value.expiry),
  });
}
export function decodePostingPolicyCommand(
  value: unknown,
): PostingPolicyCommand {
  exact(value, ['clientRequestId', 'expectedRevision', 'policy']);
  const clientRequestId = postingPolicyRequestId(value.clientRequestId),
    expectedRevision = revision(value.expectedRevision);
  if (expectedRevision >= 2147483647) invalidPostingPolicy();
  return Object.freeze({
    clientRequestId,
    expectedRevision,
    policy: decodePostingPolicyInput(value.policy),
  });
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
  return invalidPostingPolicy();
}
export function postingPolicyCommandHash(
  actorId: string,
  regionId: string,
  command: PostingPolicyCommand,
): string {
  return sha256(
    'whaleu-school-posting-policy-command:v1\n' +
      canonical({
        actorId: postingPolicyUuid(actorId),
        regionId: postingPolicyUuid(regionId),
        command: decodePostingPolicyCommand(command),
      }),
  );
}
export function decodePostingPolicyView(value: unknown): PostingPolicyView {
  exact(value, [
    'context',
    'revision',
    'revisionId',
    'state',
    'editable',
    'blocker',
    'policy',
  ]);
  exact(value.context, ['regionId', 'regionName', 'management']);
  if (
    typeof value.context.regionName !== 'string' ||
    value.context.regionName.length > 500 ||
    !['fixed', 'global'].includes(String(value.context.management)) ||
    typeof value.editable !== 'boolean' ||
    !['unconfigured', 'active', 'expired', 'unavailable'].includes(
      String(value.state),
    ) ||
    (value.blocker !== null &&
      value.blocker !== 'untrusted_source' &&
      value.blocker !== 'related_sync_unsupported')
  )
    invalidPostingPolicy();
  const currentRevision = revision(value.revision),
    revisionId =
      value.revisionId === null ? null : postingPolicyUuid(value.revisionId);
  let policy: PostingPolicyView['policy'] = null;
  if (value.policy !== null) {
    exact(value.policy, [
      'unverifiedPostEnabled',
      'unverifiedCommentEnabled',
      'unverifiedCategories',
      'expiry',
      'effectiveAt',
    ]);
    const { effectiveAt, ...input } = value.policy;
    policy = Object.freeze({
      ...decodePostingPolicyInput(input),
      effectiveAt: postingPolicyInstant(effectiveAt),
    });
    if (
      policy.expiry.kind === 'at' &&
      Date.parse(policy.expiry.validUntil) <= Date.parse(policy.effectiveAt)
    )
      invalidPostingPolicy();
  }
  if (value.state === 'unconfigured') {
    if (
      currentRevision !== 0 ||
      revisionId !== null ||
      policy !== null ||
      !value.editable ||
      value.blocker !== null
    )
      invalidPostingPolicy();
  } else {
    if (currentRevision < 1 || revisionId === null) invalidPostingPolicy();
    if (value.state === 'unavailable') {
      if (
        policy !== null ||
        value.editable ||
        value.blocker !== 'untrusted_source'
      )
        invalidPostingPolicy();
    } else if (
      !policy ||
      value.blocker === 'untrusted_source' ||
      value.editable !== (value.blocker === null) ||
      (value.state === 'expired' && policy.expiry.kind !== 'at')
    )
      invalidPostingPolicy();
  }
  return Object.freeze({
    context: Object.freeze({
      regionId: postingPolicyUuid(value.context.regionId),
      regionName: value.context.regionName,
      management: value.context.management as 'fixed' | 'global',
    }),
    revision: currentRevision,
    revisionId,
    state: value.state as PostingPolicyView['state'],
    editable: value.editable,
    blocker: value.blocker,
    policy,
  });
}
export function decodePostingPolicyReceipt(
  value: unknown,
): PostingPolicyReceipt {
  exact(value, [
    'requestId',
    'requestHash',
    'regionId',
    'revision',
    'revisionId',
    'outcome',
  ]);
  const savedRevision = revision(value.revision);
  if (savedRevision === 0 || value.outcome !== 'saved') invalidPostingPolicy();
  return Object.freeze({
    requestId: postingPolicyRequestId(value.requestId),
    requestHash: postingPolicyHash(value.requestHash),
    regionId: postingPolicyUuid(value.regionId),
    revision: savedRevision,
    revisionId: postingPolicyUuid(value.revisionId),
    outcome: 'saved',
  });
}
export function decodePostingPolicyRecovery(
  value: unknown,
): PostingPolicyRecovery {
  exact(
    value,
    value &&
      typeof value === 'object' &&
      'state' in value &&
      value.state === 'recorded'
      ? ['state', 'requestId', 'receipt']
      : value &&
          typeof value === 'object' &&
          'state' in value &&
          value.state === 'cancelled'
        ? ['state', 'requestId', 'requestHash']
        : ['state', 'requestId'],
  );
  const requestId = postingPolicyRequestId(value.requestId);
  if (value.state === 'not_recorded')
    return Object.freeze({ state: 'not_recorded', requestId });
  if (value.state === 'cancelled')
    return Object.freeze({
      state: 'cancelled',
      requestId,
      requestHash: postingPolicyHash(value.requestHash),
    });
  if (value.state !== 'recorded') invalidPostingPolicy();
  const receipt = decodePostingPolicyReceipt(value.receipt);
  if (receipt.requestId !== requestId) invalidPostingPolicy();
  return Object.freeze({ state: 'recorded', requestId, receipt });
}
