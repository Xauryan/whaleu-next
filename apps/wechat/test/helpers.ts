import { SessionStore, type Credentials } from '../src/auth/session';
import type {
  Clock,
  HttpRequest,
  HttpResponse,
  Storage,
  Transport,
} from '../src/platform/contracts';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}
export function credentials(accountId = '12', suffix = 'a'): Credentials {
  return {
    accountId,
    sessionId: `synthetic-session-${accountId}`,
    expiresAt: 900_000,
    refreshExpiresAt: 1_800_000,
    accessToken: `synthetic-access-${suffix}`,
    refreshToken: `synthetic-refresh-${suffix}`,
  };
}
export function signedIn(accountId = '12'): SessionStore {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), credentials(accountId));
  return sessions;
}
export function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): HttpResponse {
  return { status, headers, body };
}
export class MemoryStorage implements Storage {
  readonly data = new Map<string, unknown>();
  failWrite = false;
  failRemove = false;
  get(key: string): unknown {
    return this.data.get(key);
  }
  set(key: string, value: unknown): void {
    if (this.failWrite) throw new Error('synthetic');
    this.data.set(key, value);
  }
  remove(key: string): void {
    if (this.failRemove) throw new Error('synthetic');
    this.data.delete(key);
  }
}
export class FakeClock implements Clock {
  private timestamp = 1_000;
  private nextId = 0;
  private pending = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.timestamp;
  }
  schedule(fn: () => void, delayMs: number): () => void {
    const id = this.nextId++;
    this.pending.set(id, { at: this.timestamp + delayMs, fn });
    return () => {
      this.pending.delete(id);
    };
  }
  advance(ms: number): void {
    this.timestamp += ms;
    for (const [id, item] of [...this.pending])
      if (item.at <= this.timestamp) {
        this.pending.delete(id);
        item.fn();
      }
  }
  get timers(): number {
    return this.pending.size;
  }
}
export class ScriptedTransport implements Transport {
  readonly requests: HttpRequest[] = [];
  readonly steps: Array<(request: HttpRequest) => Promise<HttpResponse>> = [];
  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const next = this.steps.shift();
    if (!next) throw new Error('No synthetic response scripted');
    return next(request);
  }
  reply(
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ): void {
    this.steps.push(async () => response(body, status, headers));
  }
}
