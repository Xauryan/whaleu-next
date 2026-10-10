import { ClientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';

/** A guest has only a local generation capability, never fabricated credentials. */
export type AvatarPrincipal =
  | { readonly kind: 'guest'; readonly generation: object }
  | {
      readonly kind: 'session';
      readonly generation: object;
      readonly ticket: SessionTicket;
    };
export interface AvatarPrincipalContext {
  current(): AvatarPrincipal;
}
export class AvatarPrincipalOwner {
  private ticket: SessionTicket;
  private generation: object = {};
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly sessions: SessionStore) {
    this.ticket = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const next = sessions.snapshot();
      if (
        next.epoch !== this.ticket.epoch ||
        next.credentials?.accountId !== this.ticket.credentials?.accountId
      ) {
        this.generation = {};
        this.ticket = next;
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            /* Continue revoking every viewer. */
          }
        }
      } else this.ticket = next;
    });
  }
  snapshot(): AvatarPrincipal {
    return this.ticket.credentials
      ? Object.freeze({
          kind: 'session',
          generation: this.generation,
          ticket: this.sessions.snapshot(),
        })
      : Object.freeze({ kind: 'guest', generation: this.generation });
  }
  assertCurrent(principal: AvatarPrincipal): void {
    if (
      principal.generation !== this.generation ||
      (principal.kind === 'guest') !== !this.ticket.credentials
    )
      throw new ClientError(
        'stale-session',
        'Profile avatar principal changed',
      );
    if (principal.kind === 'session')
      this.sessions.assertCurrent(principal.ticket);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose(): void {
    this.unsubscribe();
    this.generation = {};
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Continue revoking every viewer. */
      }
    }
    this.listeners.clear();
  }
}
