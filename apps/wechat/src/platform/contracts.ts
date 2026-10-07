export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  readonly url: string;
  readonly method: Method;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Json;
  readonly timeoutMs: number;
  readonly cancellation?: Cancellation;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface Transport {
  send(request: HttpRequest): Promise<HttpResponse>;
}
export interface Storage {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}
export interface Clock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
export interface LoginProvider {
  login(): Promise<string>;
}

/** Small cancellation primitive that does not depend on browser AbortController. */
export class Cancellation {
  private listeners = new Set<() => void>();
  private cancelled = false;
  get isCancelled(): boolean {
    return this.cancelled;
  }
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
  subscribe(listener: () => void): () => void {
    if (this.cancelled) {
      listener();
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
