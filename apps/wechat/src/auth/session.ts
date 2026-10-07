import { ClientError, isRecord } from '../api/errors';
import type { Storage } from '../platform/contracts';

export interface Credentials {
  readonly accountId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt?: number;
}
export interface SessionTicket {
  readonly epoch: number;
  readonly revision: number;
  readonly credentials: Readonly<Credentials> | null;
}
const STORAGE_KEY = 'whaleu.session.v1';
const validText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 16_384;
export function validateCredentials(value: unknown): Credentials {
  if (
    !isRecord(value) ||
    !validText(value.accountId) ||
    !validText(value.accessToken) ||
    !validText(value.refreshToken) ||
    (value.expiresAt !== undefined &&
      (typeof value.expiresAt !== 'number' ||
        !Number.isFinite(value.expiresAt) ||
        value.expiresAt <= 0))
  ) {
    throw new ClientError('protocol', 'Invalid session credentials');
  }
  return Object.freeze({
    accountId: value.accountId,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
  });
}

/** All credential replacement goes through this store. Login/logout change epoch, refresh changes revision. */
export class SessionStore {
  private epoch = 0;
  private revision = 0;
  private credentials: Readonly<Credentials> | null = null;
  constructor(private readonly storage?: Storage) {}

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
      const saved = this.storage.get(STORAGE_KEY);
      if (saved === undefined || saved === null || saved === '') return;
      if (!isRecord(saved) || saved.version !== 1)
        throw new ClientError('protocol', 'Invalid saved session');
      this.credentials = validateCredentials(saved.credentials);
    } catch {
      this.credentials = null;
      try {
        this.storage.remove(STORAGE_KEY);
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
    this.save(validateCredentials(credentials));
  }
  rotate(ticket: SessionTicket, credentials: Credentials): SessionTicket {
    this.assertCurrent(ticket);
    if (ticket.revision !== this.revision) return this.snapshot();
    const checked = validateCredentials(credentials);
    if (checked.accountId !== ticket.credentials?.accountId)
      throw new ClientError('protocol', 'Refresh cannot change the account');
    this.save(checked);
    this.revision += 1;
    return this.snapshot();
  }
  logout(): void {
    this.clearMemory();
    try {
      this.storage?.remove(STORAGE_KEY);
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
  }
  private save(credentials: Credentials): void {
    try {
      this.storage?.set(STORAGE_KEY, { version: 1, credentials });
    } catch {
      this.clearMemory();
      try {
        this.storage?.remove(STORAGE_KEY);
      } catch {
        /* Report storage failure; never retain partial memory credentials. */
      }
      throw new ClientError('storage', 'Login could not be saved');
    }
    this.credentials = credentials;
  }
}
