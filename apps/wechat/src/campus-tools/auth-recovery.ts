import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import type { SessionStore } from '../auth/session';
import type { Storage } from '../platform/contracts';
/** A tools-only, origin-bound latch. Credential loss is never automatic guest
 * authorization. Successful latch writes survive a new process; write failures
 * stay blocked in this process. No credentials are stored here. */
export class ToolAuthRecovery {
  private blocked = false;
  private readonly key: string;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly storage: Storage,
    origin: string,
    startupFailure = false,
  ) {
    this.key = `whaleu.campus-tools.auth-recovery.v1:${normalizeOrigin(origin)}`;
    try {
      const value = storage.get(this.key);
      this.blocked = value !== undefined && value !== null && value !== '';
    } catch {
      this.block();
    }
    if (startupFailure) this.block();
    let ticket = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const now = sessions.snapshot();
      if (ticket.credentials && !now.credentials) this.block();
      else if (
        now.credentials &&
        (ticket.epoch !== now.epoch || !ticket.credentials)
      )
        this.clear();
      ticket = now;
    });
  }
  private block() {
    this.blocked = true;
    try {
      this.storage.set(this.key, true);
    } catch {
      /* Fail closed in this process; no credential manipulation. */
    }
  }
  private clear(): boolean {
    try {
      this.storage.remove(this.key);
      this.blocked = false;
      return true;
    } catch {
      this.blocked = true;
      return false;
    }
  }
  needsRecovery(): boolean {
    return this.blocked && !this.sessions.snapshot().credentials;
  }
  assertAllowed() {
    if (this.needsRecovery())
      throw new ClientError(
        'auth-required',
        'Explicit sign-in or guest continuation required',
      );
  }
  continueGuest(): boolean {
    return !this.sessions.snapshot().credentials && this.clear();
  }
  dispose() {
    this.unsubscribe();
  }
}
