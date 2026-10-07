import { ClientError, isRecord } from '../api/errors';
import type {
  Clock,
  HttpRequest,
  HttpResponse,
  LoginProvider,
  Storage,
  Transport,
} from './contracts';

export interface WxRequestTask {
  abort(): void;
}
export interface WxApi {
  getRandomValues?(options: {
    length: number;
    success(result: { randomValues: ArrayBuffer }): void;
    fail(error: unknown): void;
  }): void;
  request(options: {
    url: string;
    method: HttpRequest['method'];
    header: Record<string, string>;
    data?: HttpRequest['body'];
    timeout: number;
    success(response: {
      statusCode: number;
      header?: Record<string, unknown>;
      data: unknown;
    }): void;
    fail(error: unknown): void;
  }): WxRequestTask;
  login(options: {
    timeout: number;
    success(result: { code?: string }): void;
    fail(error: unknown): void;
  }): void;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
}

function nativeFailure(value: unknown): ClientError {
  // Never retain errMsg: native errors may contain a request URL or sensitive payload.
  const message =
    isRecord(value) && typeof value.errMsg === 'string' ? value.errMsg : '';
  if (/timeout/i.test(message))
    return new ClientError('timeout', 'The request timed out');
  if (/abort|cancel/i.test(message))
    return new ClientError('cancelled', 'The request was cancelled');
  return new ClientError('network', 'The network request failed');
}

export class WechatTransport implements Transport {
  constructor(
    private readonly wx: Pick<WxApi, 'request'>,
    private readonly clock: Clock,
  ) {}

  send(request: HttpRequest): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      if (request.cancellation?.isCancelled) {
        reject(new ClientError('cancelled', 'The request was cancelled'));
        return;
      }
      let settled = false;
      let task: WxRequestTask | undefined;
      let stopTimer = () => undefined as void;
      let stopCancel = () => undefined as void;
      const finish = (result: HttpResponse | ClientError) => {
        if (settled) return;
        settled = true;
        stopTimer();
        stopCancel();
        if (result instanceof ClientError) reject(result);
        else resolve(result);
      };
      const abort = (kind: 'timeout' | 'cancelled') => {
        finish(
          new ClientError(
            kind,
            kind === 'timeout'
              ? 'The request timed out'
              : 'The request was cancelled',
          ),
        );
        try {
          task?.abort();
        } catch {
          /* Best effort only; promise has already settled. */
        }
      };
      if (
        !Number.isFinite(request.timeoutMs) ||
        request.timeoutMs <= 0 ||
        request.timeoutMs > 120_000
      ) {
        finish(new ClientError('configuration', 'Invalid request timeout'));
        return;
      }
      stopTimer = this.clock.schedule(
        () => abort('timeout'),
        request.timeoutMs,
      );
      stopCancel =
        request.cancellation?.subscribe(() => abort('cancelled')) ?? stopCancel;
      if (settled) {
        stopTimer();
        stopCancel();
        return;
      }
      try {
        task = this.wx.request({
          url: request.url,
          method: request.method,
          header: { ...request.headers },
          ...(request.body === undefined ? {} : { data: request.body }),
          timeout: request.timeoutMs,
          success: (response) => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.header ?? {})) {
              if (typeof value === 'string')
                headers[name.toLowerCase()] = value;
            }
            finish({
              status: response.statusCode,
              headers,
              body: response.data,
            });
          },
          fail: (error) => finish(nativeFailure(error)),
        });
        // Some test doubles/native bridges synchronously cancel while creating a task.
        if (request.cancellation?.isCancelled) {
          try {
            task.abort();
          } catch {
            /* settled */
          }
        }
      } catch {
        finish(
          new ClientError('network', 'The network request could not start'),
        );
      }
    });
  }
}

export class WechatLogin implements LoginProvider {
  constructor(
    private readonly wx: Pick<WxApi, 'login'>,
    private readonly clock: Clock,
    private readonly timeoutMs = 10_000,
  ) {}
  login(): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value: string | ClientError) => {
        if (settled) return;
        settled = true;
        clear();
        if (value instanceof ClientError) reject(value);
        else resolve(value);
      };
      const clear = this.clock.schedule(
        () => finish(new ClientError('timeout', 'WeChat login timed out')),
        this.timeoutMs,
      );
      try {
        this.wx.login({
          timeout: this.timeoutMs,
          success: (result) =>
            finish(
              typeof result.code === 'string' && result.code.length > 0
                ? result.code
                : new ClientError(
                    'protocol',
                    'WeChat did not return a login code',
                  ),
            ),
          fail: (error) => finish(nativeFailure(error)),
        });
      } catch {
        finish(new ClientError('network', 'WeChat login could not start'));
      }
    });
  }
}

export class WechatStorage implements Storage {
  constructor(
    private readonly wx: Pick<
      WxApi,
      'getStorageSync' | 'setStorageSync' | 'removeStorageSync'
    >,
  ) {}
  get(key: string): unknown {
    return this.wx.getStorageSync(key);
  }
  set(key: string, value: unknown): void {
    this.wx.setStorageSync(key, value);
  }
  remove(key: string): void {
    this.wx.removeStorageSync(key);
  }
}
