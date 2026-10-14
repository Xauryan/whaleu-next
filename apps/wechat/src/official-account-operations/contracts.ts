import { sha256 } from 'js-sha256';
import { ClientError } from '../api/errors';
export const base = '/v1/me/official-account-operations';
export function invalid(): never {
  throw new ClientError('protocol', 'Invalid official-account response');
}
export function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.prototype.hasOwnProperty.call(v, k))
  )
    return invalid();
  return v;
}
export function literal(v: unknown, max: number): string {
  if (
    typeof v !== 'string' ||
    [...v].length > max ||
    v.includes('\0') ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      v,
    )
  )
    return invalid();
  return v;
}
export function uuid(v: unknown): string {
  if (
    typeof v !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      v,
    )
  )
    return invalid();
  return v;
}
export function hash(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) return invalid();
  return v;
}
function time(v: unknown): string {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    return invalid();
  return v;
}
function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') return invalid();
  return v;
}
function integer(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    return invalid();
  return v;
}
function choice<T extends string>(v: unknown, values: readonly T[]): T {
  if (typeof v !== 'string' || !values.includes(v as T)) return invalid();
  return v as T;
}
function nullableUuid(v: unknown) {
  return v === null ? null : uuid(v);
}
export type Artwork =
  { action: 'keep' | 'clear' } | { action: 'replace'; appearanceId: string };
export type ConfigCommand = {
  requestId: string;
  programId: string;
  expectedRevision: string;
  author: string;
  cover: Artwork;
  title: Artwork;
};
export type DraftCommand = {
  requestId: string;
  programId: string;
  previewId: string;
  manifestHash: string;
  expectedConfigRevision: string;
  acknowledgement: 'synthetic_draft_only';
};
export type Command = ConfigCommand | DraftCommand;
export type Operation = 'config_save' | 'test_draft';
function artwork(input: unknown): Artwork {
  const a = input as Record<string, unknown>;
  if (a?.action === 'replace') {
    const v = object(input, ['action', 'appearanceId']);
    return { action: 'replace', appearanceId: uuid(v.appearanceId) };
  }
  const v = object(input, ['action']);
  return { action: choice(v.action, ['keep', 'clear']) };
}
export function decodeCommand(input: unknown, operation: Operation): Command {
  if (operation === 'config_save') {
    const v = object(input, [
      'requestId',
      'programId',
      'expectedRevision',
      'author',
      'cover',
      'title',
    ]);
    return {
      requestId: uuid(v.requestId),
      programId: uuid(v.programId),
      expectedRevision: hash(v.expectedRevision),
      author: literal(v.author, 64),
      cover: artwork(v.cover),
      title: artwork(v.title),
    };
  }
  const v = object(input, [
    'requestId',
    'programId',
    'previewId',
    'manifestHash',
    'expectedConfigRevision',
    'acknowledgement',
  ]);
  return {
    requestId: uuid(v.requestId),
    programId: uuid(v.programId),
    previewId: uuid(v.previewId),
    manifestHash: hash(v.manifestHash),
    expectedConfigRevision: hash(v.expectedConfigRevision),
    acknowledgement: choice(v.acknowledgement, ['synthetic_draft_only']),
  };
}
export function commandHash(command: Command) {
  return sha256(JSON.stringify(command));
}
export function decodeCapabilities(input: unknown) {
  const v = object(input, [
    'mode',
    'programId',
    'canManage',
    'canPreview',
    'canTest',
    'canManualCreate',
    'canPublish',
    'reason',
  ]);
  if (
    v.mode === 'disabled' &&
    [
      'canManage',
      'canPreview',
      'canTest',
      'canManualCreate',
      'canPublish',
    ].some((k) => v[k] === true)
  )
    invalid();
  return {
    mode: choice(v.mode, ['disabled', 'synthetic']),
    programId: uuid(v.programId),
    canManage: bool(v.canManage),
    canPreview: bool(v.canPreview),
    canTest: bool(v.canTest),
    canManualCreate: bool(v.canManualCreate),
    canPublish: bool(v.canPublish),
    reason: choice(v.reason, [
      'ready',
      'disabled',
      'scope_unavailable',
      'authority_required',
    ]),
  };
}
export type Capabilities = ReturnType<typeof decodeCapabilities>;
export function decodeConfig(input: unknown) {
  const v = object(input, [
    'programId',
    'accountRef',
    'accountLabel',
    'revision',
    'author',
    'coverAppearanceId',
    'titleAppearanceId',
    'readiness',
    'schedule',
  ]);
  const s = object(v.schedule, ['zone', 'slotTime', 'automatic']);
  if (
    s.zone !== 'Etc/UTC' ||
    s.slotTime !== '00:00:00' ||
    s.automatic !== false
  )
    invalid();
  return {
    programId: uuid(v.programId),
    accountRef: uuid(v.accountRef),
    accountLabel: literal(v.accountLabel, 100),
    revision: hash(v.revision),
    author: literal(v.author, 64),
    coverAppearanceId: nullableUuid(v.coverAppearanceId),
    titleAppearanceId: nullableUuid(v.titleAppearanceId),
    readiness: choice(v.readiness, [
      'disabled',
      'unavailable',
      'synthetic_ready',
    ]),
    schedule: {
      zone: 'Etc/UTC' as const,
      slotTime: '00:00:00' as const,
      automatic: false as const,
    },
  };
}
export type Config = ReturnType<typeof decodeConfig>;
export function decodePreview(input: unknown) {
  const v = object(input, [
    'previewId',
    'programId',
    'accountRef',
    'accountLabel',
    'kind',
    'selectionAt',
    'expiresAt',
    'configRevision',
    'manifestHash',
    'eligibleCount',
    'mode',
    'article',
    'actions',
    'sourceState',
  ]);
  const a = object(v.article, [
    'title',
    'author',
    'items',
    'coverAppearanceId',
    'titleAppearanceId',
  ]);
  const actions = object(v.actions, ['createDraft']);
  const kind = choice(v.kind, ['daily_hot', 'test', 'manual_newest']);
  if (v.mode !== 'synthetic' || !Array.isArray(a.items)) invalid();
  const count = integer(v.eligibleCount, 0, kind === 'manual_newest' ? 10 : 30);
  if (a.items.length !== count || (kind === 'test' && count !== 1)) invalid();
  const items = a.items.map((input) => {
    const i = object(input, [
      'excerpt',
      'publishedAt',
      'publicCounts',
      'locator',
      'mediaAppearanceRefs',
    ]);
    const c = object(i.publicCounts, ['likes', 'comments', 'subscriptions']);
    const counter = (n: unknown) => {
      if (
        typeof n !== 'string' ||
        !/^(0|[1-9][0-9]{0,18})$/.test(n) ||
        BigInt(n) > 9223372036854775807n
      )
        return invalid();
      return n;
    };
    if (
      !Array.isArray(i.mediaAppearanceRefs) ||
      i.mediaAppearanceRefs.length > 32
    )
      invalid();
    const locator = literal(i.locator, 120);
    if (
      !/^pages\/community-detail\/community-detail\?postId=[0-9a-f-]{36}$/.test(
        locator,
      )
    )
      invalid();
    uuid(locator.split('=')[1]);
    return {
      excerpt: literal(i.excerpt, 61),
      publishedAt: time(i.publishedAt),
      publicCounts: {
        likes: counter(c.likes),
        comments: counter(c.comments),
        subscriptions: counter(c.subscriptions),
      },
      locator,
      mediaAppearanceRefs: i.mediaAppearanceRefs.map(uuid),
    };
  });
  const assets = new Set(
    [
      nullableUuid(a.coverAppearanceId),
      nullableUuid(a.titleAppearanceId),
      ...items.flatMap((i) => i.mediaAppearanceRefs),
    ].filter((x) => x !== null),
  );
  if (assets.size > 32) invalid();
  const selectionAt = time(v.selectionAt),
    expiresAt = time(v.expiresAt);
  if (Date.parse(expiresAt) - Date.parse(selectionAt) !== 300000) invalid();
  const sourceState = choice(v.sourceState, ['complete', 'known_empty']);
  if (
    (sourceState === 'known_empty') !== (count === 0) ||
    (count === 0 && actions.createDraft !== false)
  )
    invalid();
  return {
    previewId: uuid(v.previewId),
    programId: uuid(v.programId),
    accountRef: uuid(v.accountRef),
    accountLabel: literal(v.accountLabel, 100),
    kind,
    selectionAt,
    expiresAt,
    configRevision: hash(v.configRevision),
    manifestHash: hash(v.manifestHash),
    eligibleCount: count,
    mode: 'synthetic' as const,
    article: {
      title: literal(a.title, kind === 'test' ? 54 : 50),
      author: literal(a.author, 64),
      items,
      coverAppearanceId: nullableUuid(a.coverAppearanceId),
      titleAppearanceId: nullableUuid(a.titleAppearanceId),
    },
    actions: { createDraft: bool(actions.createDraft) },
    sourceState,
  };
}
export type Preview = ReturnType<typeof decodePreview>;
export function decodeReceipt(input: unknown) {
  const v = object(input, [
    'requestId',
    'intentHash',
    'operation',
    'programId',
    'accountRef',
    'acceptedAt',
    'outcome',
    'configRevision',
  ]);
  return {
    requestId: uuid(v.requestId),
    intentHash: hash(v.intentHash),
    operation: choice(v.operation, [
      'config_save',
      'test_draft',
      'manual_draft',
      'manual_publish',
    ]),
    programId: uuid(v.programId),
    accountRef: uuid(v.accountRef),
    acceptedAt: time(v.acceptedAt),
    outcome: choice(v.outcome, ['admitted', 'config_applied']),
    configRevision: v.configRevision === null ? null : hash(v.configRevision),
  };
}
export function decodeStatus(input: unknown) {
  const v = object(input, [
    'state',
    'cancelRequested',
    'acceptedMaterialCount',
    'draftRef',
    'withdrawal',
    'nextAction',
    'updatedAt',
  ]);
  return {
    state: choice(v.state, [
      'config_applied',
      'pending',
      'preparing',
      'dispatch_unknown',
      'parked_unknown',
      'draft_confirmed',
      'publish_submitted',
      'published_confirmed',
      'rejected',
      'suppressed',
      'expired',
      'cancelled',
    ]),
    cancelRequested: bool(v.cancelRequested),
    acceptedMaterialCount: integer(v.acceptedMaterialCount, 0, 32),
    draftRef: nullableUuid(v.draftRef),
    withdrawal: choice(v.withdrawal, [
      'none',
      'local_withdrawn_remote_unverified',
      'retraction_needed',
    ]),
    nextAction: choice(v.nextAction, [
      'wait',
      'recover_same_key',
      'resume_same_key',
      'new_preview',
      'none',
    ]),
    updatedAt: time(v.updatedAt),
  };
}
export type Status = ReturnType<typeof decodeStatus>;
export function decodeResult(input: unknown) {
  const v = object(input, ['receipt', 'status']);
  const receipt = decodeReceipt(v.receipt),
    status = decodeStatus(v.status);
  if (
    (receipt.outcome === 'config_applied') !==
    (status.state === 'config_applied')
  )
    invalid();
  return { receipt, status };
}
export type Result = ReturnType<typeof decodeResult>;
export function decodeCancellationTombstone(input: unknown) {
  const v = object(input, ['state', 'requestId', 'intentHash']);
  if (v.state !== 'cancelled_before_admission') invalid();
  return {
    state: 'cancelled_before_admission' as const,
    requestId: uuid(v.requestId),
    intentHash: hash(v.intentHash),
  };
}
export type CancellationTombstone = ReturnType<
  typeof decodeCancellationTombstone
>;
export function decodeControl(input: unknown): Result | CancellationTombstone {
  return (input as { state?: unknown })?.state === 'cancelled_before_admission'
    ? decodeCancellationTombstone(input)
    : decodeResult(input);
}
export function decodeRecovery(
  input: unknown,
):
  | { state: 'not_recorded' }
  | CancellationTombstone
  | ({ state: 'recorded' } & Result) {
  if ((input as { state?: unknown })?.state === 'cancelled_before_admission')
    return decodeCancellationTombstone(input);
  if ((input as { state?: unknown })?.state === 'not_recorded') {
    object(input, ['state']);
    return { state: 'not_recorded' };
  }
  const v = object(input, ['state', 'receipt', 'status']);
  if (v.state !== 'recorded') invalid();
  return {
    state: 'recorded',
    ...decodeResult({ receipt: v.receipt, status: v.status }),
  };
}
export type Recovery = ReturnType<typeof decodeRecovery>;
export const terminal = (status: Status) =>
  [
    'config_applied',
    'draft_confirmed',
    'published_confirmed',
    'rejected',
    'suppressed',
    'expired',
    'cancelled',
  ].includes(status.state);
export function statusLabel(status: Status): string {
  switch (status.state) {
    case 'config_applied':
      return '配置已保存';
    case 'draft_confirmed':
      return '草稿已生成，未发布';
    case 'publish_submitted':
      return '已提交发布，等待结果';
    case 'published_confirmed':
      return '发布已确认';
    case 'dispatch_unknown':
    case 'parked_unknown':
      return '结果未确认，请恢复原请求';
    case 'cancelled':
      return '尚未执行的操作已取消';
    case 'expired':
      return '请求已过期';
    case 'suppressed':
      return '后续操作已停止';
    case 'rejected':
      return '请求已拒绝';
    default:
      return '请求处理中';
  }
}
