import { isRecord } from '../api/errors';
import { invalidRating } from './contract';
import {
  decodeRatingScopedContext,
  decodeRatingScopedCommandContext,
  type RatingScopedContext,
  type RatingScopedCommandContext,
} from './scoped-contract';
type VersionThree<T> = T extends RatingScopedContext
  ? Omit<T, 'protocolVersion'> & { readonly protocolVersion: 3 }
  : never;
export type RatingTargetCoverContext = VersionThree<RatingScopedContext>;
/** Independent v3 acceptance. The historical v2 decoder still rejects this wire object. */
export function decodeRatingTargetCoverContext(
  value: unknown,
): RatingTargetCoverContext {
  if (!isRecord(value) || value.protocolVersion !== 3) invalidRating();
  const context = decodeRatingScopedContext({ ...value, protocolVersion: 2 });
  return Object.freeze({ ...context, protocolVersion: 3 });
}
export function ratingTargetCoverCommandContext(
  raw: RatingTargetCoverContext,
): RatingScopedCommandContext {
  const context = decodeRatingTargetCoverContext(raw);
  if (
    (context.purpose !== 'create_target' &&
      context.purpose !== 'edit_target') ||
    context.mode !== 'public' ||
    context.heads.length !== 1 ||
    !context.capabilities.includes('target_cover')
  )
    invalidRating();
  return decodeRatingScopedCommandContext({
    id: context.id,
    token: context.token,
    tokenDigest: context.tokenDigest,
    selector: context.selector,
    scopeRevision: context.scopeRevision,
    protocolGeneration: context.protocolGeneration,
    catalogRevision: context.heads[0]!.catalogRevision,
    headRevision: context.heads[0]!.headRevision,
    sourceDigest: context.sourceDigest,
  });
}

import type { SessionStore, SessionTicket } from '../auth/session';
import type { Clock } from '../platform/contracts';
import {
  canonicalRatingScopedJson,
  decodeRatingScopedContextRequest,
  type RatingScopedContextRequest,
} from './scoped-contract';
/** Co-observation only: neither token nor write capability is borrowed across brands. */
export function matchRatingCoverScopePair(
  legacy: RatingScopedContext,
  raw: RatingTargetCoverContext,
): void {
  const left = decodeRatingScopedContext(legacy),
    right = decodeRatingTargetCoverContext(raw);
  if (
    left.mode !== 'public' ||
    right.mode !== 'public' ||
    left.id === right.id ||
    left.actorId !== right.actorId ||
    left.sessionGeneration !== right.sessionGeneration ||
    left.identityCampusId !== right.identityCampusId ||
    left.sourceDigest !== right.sourceDigest ||
    left.protocolGeneration !== right.protocolGeneration ||
    canonicalRatingScopedJson(left.selector) !==
      canonicalRatingScopedJson(right.selector) ||
    canonicalRatingScopedJson(left.heads) !==
      canonicalRatingScopedJson(right.heads)
  )
    invalidRating();
}
export class RatingTargetCoverContextLease {
  private generation = 0;
  private owner: SessionTicket;
  private context: RatingTargetCoverContext | null = null;
  private expiry: (() => void) | undefined;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly invalidated: () => void,
    private readonly clock: Clock,
  ) {
    this.owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const now = sessions.snapshot();
      if (
        now.epoch !== this.owner.epoch ||
        now.credentials?.accountId !== this.owner.credentials?.accountId
      ) {
        this.clear();
        this.owner = now;
        this.invalidated();
      }
    });
  }
  capture(): number {
    return this.generation;
  }
  accept(
    raw: RatingTargetCoverContext,
    request: RatingScopedContextRequest,
    generation: number,
  ): RatingTargetCoverContext {
    this.sessions.assertCurrent(this.owner);
    const context = decodeRatingTargetCoverContext(raw),
      expected = decodeRatingScopedContextRequest(request);
    if (
      generation !== this.generation ||
      context.actorId !== this.owner.credentials?.accountId ||
      context.purpose !== expected.purpose ||
      context.mode !== expected.mode ||
      canonicalRatingScopedJson(context.selector) !==
        canonicalRatingScopedJson(expected.selector) ||
      Date.parse(context.expiresAt) <= this.clock.now()
    )
      invalidRating();
    this.context = context;
    this.expiry?.();
    this.expiry = this.clock.schedule(
      () => {
        this.clear();
        this.invalidated();
      },
      Date.parse(context.expiresAt) - this.clock.now(),
    );
    return context;
  }
  current(): RatingTargetCoverContext {
    this.sessions.assertCurrent(this.owner);
    if (!this.context || Date.parse(this.context.expiresAt) <= this.clock.now())
      invalidRating();
    return this.context;
  }
  matches(context: RatingScopedCommandContext): boolean {
    try {
      return (
        canonicalRatingScopedJson(
          ratingTargetCoverCommandContext(this.current()),
        ) === canonicalRatingScopedJson(context)
      );
    } catch {
      return false;
    }
  }
  clear(): void {
    ++this.generation;
    this.context = null;
    this.expiry?.();
    this.expiry = undefined;
  }
  dispose(): void {
    this.clear();
    this.unsubscribe();
  }
}
