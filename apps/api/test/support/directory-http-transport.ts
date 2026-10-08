/** Only platform HTTP I/O is bridged; no authorization or response replacement. */
import assert from 'node:assert/strict';
import { request as nodeRequest } from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ClientError } = require('../../../wechat/src/api/errors.ts');
export const directoryNativeOrigin =
  'https://native-directory-contract.invalid';
const nativeOrigin = directoryNativeOrigin;
interface NativeRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs: number;
  readonly cancellation?: {
    readonly isCancelled: boolean;
    subscribe(listener: () => void): () => void;
  };
}
interface NativeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}
interface Exchange {
  readonly path: string;
  readonly method: string;
  readonly authorized: boolean;
  readonly status: number;
}
export class DirectoryHttpTransport {
  readonly exchanges: Exchange[] = [];
  dropSuccess: { path: string; method: string } | null = null;
  corruptNext: { path: string; transform: (body: unknown) => unknown } | null =
    null;
  failNext: string | null = null;
  private gate: {
    path: string;
    method: string;
    received: () => void;
    release: Promise<void>;
  } | null = null;
  holdNext(path: string, method = 'GET') {
    let received!: () => void, release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = { path, method, received, release: released };
    return { arrived, release };
  }
  checkResponse:
    ((path: string, status: number, body: unknown) => void) | null = null;

  constructor(private readonly port: number) {}

  send(input: NativeRequest): Promise<NativeResponse> {
    const url = new URL(input.url);
    assert.equal(url.origin, nativeOrigin, 'Refuse a non-fixture API origin');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.hash, '');
    if (input.cancellation?.isCancelled)
      return Promise.reject(new ClientError('cancelled', 'Request cancelled'));
    if (this.failNext === url.pathname) {
      this.failNext = null;
      return Promise.reject(
        new ClientError('network', 'Synthetic offline read'),
      );
    }
    const body =
      input.body === undefined ? undefined : JSON.stringify(input.body);
    return new Promise((resolve, reject) => {
      const request = nodeRequest(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path: `${url.pathname}${url.search}`,
          method: input.method,
          // DELETE carries a receipt key too. Node otherwise omits framing for
          // DELETE bodies; the native transport always sends the complete JSON.
          headers: {
            ...input.headers,
            ...(body === undefined
              ? {}
              : { 'content-length': Buffer.byteLength(body) }),
          },
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', () =>
            reject(new Error('Local HTTP read failed')),
          );
          response.once('end', async () => {
            unsubscribe?.();
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const headers: Record<string, string> = {};
              for (const [name, value] of Object.entries(response.headers)) {
                if (value !== undefined)
                  headers[name] = Array.isArray(value)
                    ? value.join(', ')
                    : value;
              }
              const status = response.statusCode ?? 0;
              // Deliberately record no request/response bodies or credential values.
              this.exchanges.push({
                path: `${url.pathname}${url.search}`,
                method: input.method,
                authorized: input.headers['Authorization'] !== undefined,
                status,
              });
              if (
                status >= 200 &&
                status < 300 &&
                this.dropSuccess?.path === url.pathname &&
                this.dropSuccess.method === input.method
              ) {
                this.dropSuccess = null;
                reject(
                  new ClientError(
                    'network',
                    'Synthetic response loss after commit',
                  ),
                );
                return;
              }
              if (
                this.gate?.path === url.pathname &&
                this.gate.method === input.method
              ) {
                const gate = this.gate;
                this.gate = null;
                gate.received();
                // Deliberately hold a fully received real response even after cancellation.
                // Controllers must reject stale callbacks, not rely on cooperative I/O.
                await gate.release;
              }
              let result = raw === '' ? '' : JSON.parse(raw);
              // Check the real server payload before deliberate decoder corruption.
              this.checkResponse?.(url.pathname, status, result);
              if (this.corruptNext?.path === url.pathname) {
                result = this.corruptNext.transform(result);
                this.corruptNext = null;
              }
              if (status === 200 && url.pathname.startsWith('/v1/directory')) {
                assert.equal(headers['cache-control'], 'no-store');
                assert.equal(headers['vary'], 'Authorization');
              }
              resolve({ status, headers, body: result });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.once('error', () => {
        unsubscribe?.();
        reject(new Error('Local HTTP request failed'));
      });
      request.setTimeout(input.timeoutMs, () => request.destroy());
      const unsubscribe = input.cancellation?.subscribe(() =>
        request.destroy(),
      );
      if (body !== undefined) request.write(body);
      request.end();
    });
  }
}
