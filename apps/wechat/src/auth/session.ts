import { ClientError, isRecord } from '../api/errors';
import type { Storage } from '../platform/contracts';

import { validateCredentials, type Credentials } from './session-contract';
export { validateCredentials, type Credentials } from './session-contract';

export interface SessionTicket {
  readonly epoch: number;
  readonly revision: number;
  readonly credentials: Readonly<Credentials> | null;
}
const STORAGE_KEY = 'whaleu.session.v1';

/** All credential replacement goes through this store. Login/logout change epoch, refresh changes revision. */
export class SessionStore {
  private epoch = 0;
  private revision = 0;
  private credentials: Readonly<Credentials> | null = null;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly storage?: Storage,
    private readonly storageKey = STORAGE_KEY,
    private readonly validate: (
      value: unknown,
    ) => Credentials = validateCredentials,
  ) {}

  /** Account-bound pages immediately clear private drafts when login ownership changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Rendering cannot interrupt credential invalidation. */
      }
    }
  }
  snapshot(): SessionTicket {
    return Object.freeze({
      epoch: this.epoch,
      revision: this.revision,
      credentials: this.credentials,
    });
  }
  assertCurrent(ticket: SessionTicket): void {
    if (
      ticket.epoch !== this.epoch ||
      ticket.credentials?.accountId !== this.credentials?.accountId
    ) {
      throw new ClientError(
        'stale-session',
        'The account or login session changed',
      );
    }
  }

  /** Call once at startup. Invalid/corrupt storage is removed rather than partially restored. */
  restore(): void {
    if (!this.storage) return;
    this.clearMemory();
    try {
      const saved = this.storage.get(this.storageKey);
      if (saved === undefined || saved === null || saved === '') return;
      if (!isRecord(saved) || saved.version !== 1)
        throw new ClientError('protocol', 'Invalid saved session');
      this.credentials = this.validate(saved.credentials);
      this.notify();
    } catch {
      this.credentials = null;
      try {
        this.storage.remove(this.storageKey);
      } catch {
        /* Memory remains logged out. */
      }
      throw new ClientError('storage', 'Saved login could not be restored');
    }
  }

  /** Invalidates old in-flight requests even when signing back into the same account. */
  beginLogin(): number {
    this.logout();
    return this.epoch;
  }
  completeLogin(epoch: number, credentials: Credentials): void {
    if (epoch !== this.epoch || this.credentials !== null)
      throw new ClientError(
        'stale-session',
        'This login attempt is no longer current',
      );
    this.save(this.validate(credentials));
  }
  rotate(ticket: SessionTicket, credentials: Credentials): SessionTicket {
    this.assertCurrent(ticket);
    if (ticket.revision !== this.revision) return this.snapshot();
    const checked = this.validate(credentials);
    if (
      checked.accountId !== ticket.credentials?.accountId ||
      checked.sessionId !== ticket.credentials?.sessionId
    )
      throw new ClientError(
        'protocol',
        'Refresh cannot change the account or session',
      );
    this.save(checked);
    this.revision += 1;
    return this.snapshot();
  }
  logout(): void {
    this.clearMemory();
    try {
      this.storage?.remove(this.storageKey);
    } catch {
      throw new ClientError('storage', 'Saved login could not be removed');
    }
  }
  logoutIfCurrent(ticket: SessionTicket): void {
    this.assertCurrent(ticket);
    if (ticket.revision === this.revision) this.logout();
  }
  private clearMemory(): void {
    this.epoch += 1;
    this.revision = 0;
    this.credentials = null;
    this.notify();
  }
  private save(credentials: Credentials): void {
    try {
      this.storage?.set(this.storageKey, { version: 1, credentials });
    } catch {
      this.clearMemory();
      try {
        this.storage?.remove(this.storageKey);
      } catch {
        /* Report storage failure; never retain partial memory credentials. */
      }
      throw new ClientError('storage', 'Login could not be saved');
    }
    this.credentials = credentials;
    this.notify();
  }
}
