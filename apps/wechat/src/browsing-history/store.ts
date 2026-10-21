import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import type { Storage } from '../platform/contracts';
import { isUuid } from '../profile/contract';

export interface HistoryEntry {
  readonly postId: string;
  readonly viewedAt: number;
}
export const HISTORY_LIMIT = 200;
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Device-local metadata only, not encrypted storage and not a server history.
 * Session binding prevents an old failed-delete record returning after a new login.
 * Never persist post bodies, authors, personas, media, tokens or account identifiers.
 */
export class BrowsingHistoryStore {
  private owner: SessionTicket;
  private blocked = false;
  private readonly key: string;
  constructor(
    private readonly sessions: SessionStore,
    private readonly storage: Storage,
    origin: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = `whaleu.browsing-history.v1.${sha256(origin)}`;
    this.owner = sessions.snapshot();
    sessions.subscribe(() => {
      const next = sessions.snapshot();
      if (
        next.epoch !== this.owner.epoch ||
        next.credentials?.accountId !== this.owner.credentials?.accountId
      ) {
        this.blocked = false;
        try {
          this.erase();
        } catch {
          this.blocked = true;
        }
        this.owner = next;
      }
    });
  }
  private binding(owner: SessionTicket): string {
    this.sessions.assertCurrent(owner);
    if (!owner.credentials)
      throw new ClientError('auth-required', 'Login required');
    return sha256(
      `${owner.credentials.accountId}:${owner.credentials.sessionId}`,
    );
  }
  private erase(): void {
    try {
      this.storage.remove(this.key);
    } catch {
      try {
        this.storage.set(this.key, null);
      } catch {
        throw new ClientError('storage', 'Local history could not be removed');
      }
    }
  }
  list(owner = this.sessions.snapshot()): readonly HistoryEntry[] {
    const binding = this.binding(owner);
    if (this.blocked)
      throw new ClientError('storage', 'Local history is unavailable');
    try {
      const value = this.storage.get(this.key);
      if (value === undefined || value === null || value === '') return [];
      if (
        !isRecord(value) ||
        Object.keys(value).sort().join(',') !== 'binding,entries,version' ||
        value.version !== 1 ||
        value.binding !== binding ||
        !Array.isArray(value.entries) ||
        value.entries.length > HISTORY_LIMIT
      ) {
        this.erase();
        return [];
      }
      const now = this.now();
      const entries: HistoryEntry[] = [];
      for (const item of value.entries) {
        if (
          !isRecord(item) ||
          Object.keys(item).sort().join(',') !== 'postId,viewedAt' ||
          !isUuid(item.postId) ||
          typeof item.viewedAt !== 'number' ||
          !Number.isSafeInteger(item.viewedAt) ||
          item.viewedAt <= 0
        ) {
          this.erase();
          return [];
        }
        if (
          item.viewedAt <= now &&
          now - item.viewedAt < HISTORY_RETENTION_MS &&
          !entries.some((entry) => entry.postId === item.postId)
        )
          entries.push({ postId: item.postId, viewedAt: item.viewedAt });
      }
      entries.sort((a, b) => b.viewedAt - a.viewedAt);
      if (entries.length !== value.entries.length) {
        if (!entries.length) this.erase();
        else this.storage.set(this.key, { version: 1, binding, entries });
      }
      return entries;
    } catch {
      throw new ClientError('storage', 'Local history could not be read');
    }
  }
  /** Call only from the committed, visible detail observer. Never from feed/fetch/navigation. */
  record(postId: string, owner: SessionTicket): boolean {
    try {
      if (!isUuid(postId) || this.blocked) return false;
      const binding = this.binding(owner);
      const viewedAt = this.now();
      if (!Number.isSafeInteger(viewedAt) || viewedAt <= 0) return false;
      const entries = [
        { postId, viewedAt },
        ...this.list(owner).filter((e) => e.postId !== postId),
      ].slice(0, HISTORY_LIMIT);
      this.sessions.assertCurrent(owner);
      this.storage.set(this.key, { version: 1, binding, entries });
      return true;
    } catch {
      return false;
    }
  }
  clear(): void {
    this.binding(this.sessions.snapshot());
    try {
      this.erase();
      this.blocked = false;
    } catch (error) {
      this.blocked = true;
      throw error;
    }
  }
}
