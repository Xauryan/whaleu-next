import { ClientError } from '../api/errors';
import {
  decodePostIntent,
  decodeReceipt,
  exact,
  invalid,
  type PostIntent,
  type Receipt,
} from './contract';
import type { Storage } from '../platform/contracts';
import { ratingId } from '../ratings/contract';
import { ratingLinkPublicationHash } from './rating-link-contract';
export interface PendingRatingLinkAttempt {
  readonly kind: 'community_rating_target_link_v5';
  readonly version: 5;
  readonly accountId: string;
  readonly operation: 'publish_post';
  readonly payload: PostIntent;
  readonly viewSpaceId?: string;
}
export function decodePendingRatingLink(
  v: unknown,
  accountId: string,
): PendingRatingLinkAttempt {
  exact(v, [
    'kind',
    'version',
    'accountId',
    'operation',
    'payload',
    ...(typeof v === 'object' && v !== null && 'viewSpaceId' in v
      ? ['viewSpaceId']
      : []),
  ]);
  if (
    v.kind !== 'community_rating_target_link_v5' ||
    v.version !== 5 ||
    !ratingId(accountId) ||
    v.accountId !== accountId ||
    v.operation !== 'publish_post' ||
    (v.viewSpaceId !== undefined && !ratingId(v.viewSpaceId))
  )
    invalid();
  const payload = decodePostIntent(v.payload);
  if (
    payload.component?.kind !== 'rating_target_link' ||
    (v.viewSpaceId !== undefined && v.viewSpaceId !== payload.spaceId)
  )
    invalid();
  return Object.freeze({
    kind: 'community_rating_target_link_v5',
    version: 5,
    accountId,
    operation: 'publish_post',
    payload,
    ...(v.viewSpaceId === undefined
      ? {}
      : { viewSpaceId: v.viewSpaceId as string }),
  });
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const failed = (): ClientError =>
  new ClientError('storage', 'Rating link publication journal unavailable');
/** Separate key and discriminant; never migrates or rewrites historical Community attempts. */
export class PendingRatingLinkStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string): string {
    if (!ratingId(accountId)) throw failed();
    return `whaleu.community.rating-target-link.v5:${this.namespace}:${accountId}`;
  }
  load(accountId: string): PendingRatingLinkAttempt | null {
    try {
      const raw = this.storage.get(this.key(accountId));
      return raw === null || raw === undefined || raw === ''
        ? null
        : decodePendingRatingLink(raw, accountId);
    } catch {
      throw failed();
    }
  }
  freeze(raw: PendingRatingLinkAttempt): PendingRatingLinkAttempt {
    try {
      const value = decodePendingRatingLink(raw, raw.accountId),
        old = this.load(raw.accountId);
      if (old && !equal(old, value)) throw failed();
      if (!old) this.storage.set(this.key(raw.accountId), value);
      const saved = this.load(raw.accountId);
      if (!saved || !equal(saved, value)) throw failed();
      return saved;
    } catch {
      throw failed();
    }
  }
  private clear(attempt: PendingRatingLinkAttempt): void {
    try {
      if (!equal(this.load(attempt.accountId), attempt)) throw failed();
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw failed();
    } catch {
      throw failed();
    }
  }
  settle(attempt: PendingRatingLinkAttempt, raw: Receipt): void {
    const receipt = decodeReceipt(raw);
    if (
      receipt.requestId !== attempt.payload.clientRequestId ||
      receipt.operation !== 'publish_post'
    )
      invalid();
    this.clear(attempt);
  }
  settleCancelled(attempt: PendingRatingLinkAttempt, raw: unknown): void {
    exact(raw, ['requestId', 'operation', 'outcome', 'intentHash']);
    if (
      raw.requestId !== attempt.payload.clientRequestId ||
      raw.operation !== 'publish_post' ||
      raw.outcome !== 'cancelled' ||
      raw.intentHash !== ratingLinkPublicationHash(attempt.payload)
    )
      invalid();
    this.clear(attempt);
  }
}
