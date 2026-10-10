import type { SessionStore, SessionTicket } from '../auth/session';
import type { Clock } from '../platform/contracts';
import { invalidRating } from './contract';
import {
  canonicalRatingScopedJson,
  decodeRatingScopedContextRequest,
  type RatingScopedContextRequest,
} from './scoped-contract';
import {
  decodeRatingTargetCoverContext,
  type RatingTargetCoverContext,
} from './target-cover-context';
import {
  decodeRatingDiscussionMediaContext,
  ratingDiscussionMediaCommandContext,
  type RatingDiscussionMediaContext,
  type RatingDiscussionMediaCommandContext,
} from './discussion-media-contract';

/** A cover context may co-observe the same catalog but cannot lend its token,
 * capability or generation to command4. No cover-v2 interaction wrapper exists. */
export function matchRatingDiscussionCoverObservation(
  discussionRaw: RatingDiscussionMediaContext,
  coverRaw: RatingTargetCoverContext,
): void {
  const discussion = decodeRatingDiscussionMediaContext(discussionRaw),
    cover = decodeRatingTargetCoverContext(coverRaw);
  if (
    discussion.id === cover.id ||
    discussion.actorId !== cover.actorId ||
    discussion.sessionGeneration !== cover.sessionGeneration ||
    discussion.identityCampusId !== cover.identityCampusId ||
    discussion.protocolGeneration !== cover.protocolGeneration ||
    discussion.sourceDigest !== cover.sourceDigest ||
    canonicalRatingScopedJson(discussion.selector) !==
      canonicalRatingScopedJson(cover.selector) ||
    canonicalRatingScopedJson(discussion.heads) !==
      canonicalRatingScopedJson(cover.heads)
  )
    invalidRating();
}
export class RatingDiscussionMediaContextLease {
  private generation = 0;
  private owner: SessionTicket;
  private context: RatingDiscussionMediaContext | null = null;
  private expiry: (() => void) | undefined;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly clock: Clock,
    private readonly invalidated: () => void,
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
    raw: RatingDiscussionMediaContext,
    request: RatingScopedContextRequest,
    generation: number,
  ): RatingDiscussionMediaContext {
    this.sessions.assertCurrent(this.owner);
    const context = decodeRatingDiscussionMediaContext(raw),
      expected = decodeRatingScopedContextRequest(request);
    if (
      generation !== this.generation ||
      context.actorId !== this.owner.credentials?.accountId ||
      context.purpose !== expected.purpose ||
      context.mode !== expected.mode ||
      canonicalRatingScopedJson(context.selector) !==
        canonicalRatingScopedJson(expected.selector) ||
      Date.parse(context.expiresAt) <= this.clock.now() ||
      Date.parse(context.discussionMedia.validUntil) <= this.clock.now()
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
  current(): RatingDiscussionMediaContext {
    this.sessions.assertCurrent(this.owner);
    if (
      !this.context ||
      Date.parse(this.context.expiresAt) <= this.clock.now() ||
      Date.parse(this.context.discussionMedia.validUntil) <= this.clock.now()
    )
      invalidRating();
    return this.context;
  }
  matches(raw: RatingDiscussionMediaCommandContext): boolean {
    try {
      return (
        canonicalRatingScopedJson(
          ratingDiscussionMediaCommandContext(this.current()),
        ) === canonicalRatingScopedJson(raw)
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
