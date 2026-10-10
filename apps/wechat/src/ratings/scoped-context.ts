import { ClientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import type { Clock } from '../platform/contracts';
import { systemClock } from '../platform/clock';
import {
  decodeRatingScopedContext,
  decodeRatingScopedContextRequest,
  canonicalRatingScopedJson,
  ratingScopedCommandContext,
  type RatingScopedCommandContext,
  type RatingScopedContext,
  type RatingScopedContextRequest,
} from './scoped-contract';

const changed = (): never => {
  throw new ClientError('business', 'Scoped rating context changed', {
    serverCode: 'RATING_SCOPED_CONTEXT_CHANGED',
    httpStatus: 409,
  });
};
export type RatingScopedCommandPurpose =
  'interact' | 'create_target' | 'edit_target';
/** Context IDs, tokens, scopeRevision and capabilities are purpose-specific.
 * The public authority/source/head vector must still describe exactly one view. */
export function matchRatingScopedContextPair(
  rawRead: RatingScopedContext,
  rawCommand: RatingScopedContext,
  purpose: RatingScopedCommandPurpose,
): void {
  const read = decodeRatingScopedContext(rawRead),
    command = decodeRatingScopedContext(rawCommand);
  if (
    read.purpose !== 'read' ||
    command.purpose !== purpose ||
    read.mode !== 'public' ||
    command.mode !== 'public' ||
    read.id === command.id ||
    read.actorId !== command.actorId ||
    read.sessionGeneration !== command.sessionGeneration ||
    read.identityCampusId !== command.identityCampusId ||
    read.sourceDigest !== command.sourceDigest ||
    read.protocolGeneration !== command.protocolGeneration ||
    canonicalRatingScopedJson(read.selector) !==
      canonicalRatingScopedJson(command.selector) ||
    canonicalRatingScopedJson(read.heads) !==
      canonicalRatingScopedJson(command.heads)
  )
    changed();
}
/** A page owns this transient lease. It never owns, deletes, refreshes, or rewrites the durable journal. */
export class RatingScopedContextLease {
  private generation = 0;
  private owner: SessionTicket;
  private context: RatingScopedContext | null = null;
  private expiry: (() => void) | undefined;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly invalidated: () => void,
    private readonly clock: Clock = systemClock,
  ) {
    this.owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (
        current.epoch !== this.owner.epoch ||
        current.credentials?.accountId !== this.owner.credentials?.accountId
      ) {
        this.clear();
        this.owner = current;
        this.invalidated();
      }
    });
  }
  capture(): number {
    return this.generation;
  }
  isCurrent(generation: number): boolean {
    try {
      this.sessions.assertCurrent(this.owner);
    } catch {
      return false;
    }
    return generation === this.generation && !!this.owner.credentials;
  }
  accept(
    raw: RatingScopedContext,
    request: RatingScopedContextRequest,
    generation: number,
  ): RatingScopedContext {
    if (!this.isCurrent(generation)) return changed();
    const context = decodeRatingScopedContext(raw),
      expected = decodeRatingScopedContextRequest(request);
    if (
      context.actorId !== this.owner.credentials?.accountId ||
      context.purpose !== expected.purpose ||
      context.mode !== expected.mode ||
      canonicalRatingScopedJson(context.selector) !==
        canonicalRatingScopedJson(expected.selector) ||
      Date.parse(context.expiresAt) <= this.clock.now()
    )
      return changed();
    this.context = context;
    this.expiry?.();
    this.expiry = this.clock.schedule(
      () => {
        if (!this.isCurrent(generation) || this.context?.id !== context.id)
          return;
        this.clear();
        this.invalidated();
      },
      Date.parse(context.expiresAt) - this.clock.now(),
    );
    return context;
  }
  current(): RatingScopedContext {
    if (
      !this.context ||
      !this.isCurrent(this.generation) ||
      Date.parse(this.context.expiresAt) <= this.clock.now()
    )
      return changed();
    return this.context;
  }
  command(
    purpose: 'interact' | 'create_target' | 'edit_target',
  ): RatingScopedCommandContext {
    const context = this.current();
    if (context.purpose !== purpose || context.mode !== 'public')
      return changed();
    return ratingScopedCommandContext(context);
  }
  matches(other: RatingScopedCommandContext): boolean {
    try {
      const context = this.current();
      return (
        canonicalRatingScopedJson(ratingScopedCommandContext(context)) ===
        canonicalRatingScopedJson(other)
      );
    } catch {
      return false;
    }
  }
  clear(): void {
    this.generation++;
    this.expiry?.();
    this.expiry = undefined;
    this.context = null;
  }
  dispose(): void {
    this.clear();
    this.unsubscribe();
  }
}
