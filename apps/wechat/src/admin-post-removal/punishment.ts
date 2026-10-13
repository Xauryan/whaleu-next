import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp } from '../community/contract';
import { isUuid } from '../profile/contract';
export type RemovalPunishmentKind = 'interaction_mute' | 'access_suspension';
export interface RemovalPunishmentSelection {
  readonly kind: RemovalPunishmentKind;
  readonly duration:
    | { readonly kind: 'permanent' }
    | {
        readonly kind: 'finite';
        readonly unit: 'minutes' | 'hours' | 'days';
        readonly value: number;
      };
  readonly reason: string;
  readonly expectedRevision: string;
}
export interface RemovalPunishmentReference {
  readonly punishmentId: string;
  readonly kind: RemovalPunishmentKind;
  readonly revision: string;
}
interface Option {
  readonly revision: string;
  readonly current: null | {
    readonly punishmentId: string;
    readonly endsAt: string | null;
  };
}
export interface RemovalPunishmentOptions {
  readonly interaction_mute: Option;
  readonly access_suspension: Option;
}
const fail = (): never => {
  throw new ClientError('protocol', 'Invalid causal account punishment');
};
const revision = (v: unknown): v is string =>
  typeof v === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(v);
const kind = (v: unknown): v is RemovalPunishmentKind =>
  v === 'interaction_mute' || v === 'access_suspension';
export function decodeRemovalPunishmentSelection(
  raw: unknown,
  post = false,
): RemovalPunishmentSelection {
  exact(raw, ['kind', 'duration', 'reason', 'expectedRevision']);
  if (
    !kind(raw.kind) ||
    !revision(raw.expectedRevision) ||
    typeof raw.reason !== 'string' ||
    !raw.reason.trim() ||
    raw.reason !== raw.reason.trim() ||
    raw.reason.length > 255 ||
    !isRecord(raw.duration)
  )
    fail();
  if (!isRecord(raw.duration)) return fail();
  const d = raw.duration;
  if (d.kind === 'permanent') exact(d, ['kind']);
  else {
    exact(d, ['kind', 'unit', 'value']);
    if (
      d.kind !== 'finite' ||
      !['minutes', 'hours', 'days'].includes(String(d.unit)) ||
      (post && d.unit === 'minutes') ||
      typeof d.value !== 'number' ||
      !Number.isInteger(d.value) ||
      d.value < 1 ||
      d.value > 2147483647
    )
      fail();
  }
  return Object.freeze({
    ...raw,
    duration: Object.freeze({ ...d }),
  }) as unknown as RemovalPunishmentSelection;
}
export function decodeRemovalPunishmentReference(
  raw: unknown,
): RemovalPunishmentReference {
  exact(raw, ['punishmentId', 'kind', 'revision']);
  if (
    !isUuid(raw.punishmentId) ||
    !kind(raw.kind) ||
    !revision(raw.revision) ||
    raw.revision === '0'
  )
    fail();
  return Object.freeze({ ...raw }) as unknown as RemovalPunishmentReference;
}
export function decodeRemovalPunishmentOptions(
  raw: unknown,
): RemovalPunishmentOptions {
  exact(raw, ['interaction_mute', 'access_suspension']);
  const decode = (value: unknown): Option => {
    exact(value, ['revision', 'current']);
    if (!revision(value.revision)) fail();
    if (value.current !== null) {
      exact(value.current, ['punishmentId', 'endsAt']);
      if (
        !isUuid(value.current.punishmentId) ||
        (value.current.endsAt !== null && !timestamp(value.current.endsAt))
      )
        fail();
    }
    return Object.freeze({
      ...value,
      current:
        value.current === null ? null : Object.freeze({ ...value.current }),
    }) as Option;
  };
  return Object.freeze({
    interaction_mute: decode(raw.interaction_mute),
    access_suspension: decode(raw.access_suspension),
  });
}
