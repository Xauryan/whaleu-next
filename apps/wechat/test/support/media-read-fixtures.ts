import assert from 'node:assert/strict';
import { ClientError, type ErrorKind } from '../../src/api/errors';
import { AuthService, type AuthGateway } from '../../src/auth/auth-service';
import type { SessionTicket } from '../../src/auth/session';
import { AuthenticatedMediaDownload } from '../../src/media/authenticated-download';
import type { MediaAttachment, MediaSession } from '../../src/media/contracts';
import { MediaLocalFiles } from '../../src/media/local-files';
import { Cancellation } from '../../src/platform/contracts';
import type {
  LocalImageInfo,
  MediaFiles,
  WxMediaApi,
} from '../../src/platform/wechat-media';
import { credentials, FakeClock, flush, signedIn } from '../helpers';

export const attachment: MediaAttachment = Object.freeze({
  version: 1,
  kind: 'authenticated-media',
  assetId: '11111111-1111-4111-8111-111111111111',
  bindingId: '22222222-2222-4222-8222-222222222222',
  variants: ['thumb-v1', 'display-v1'] as const,
  width: 80,
  height: 60,
});
export const imageHeaders = (size = 100): Record<string, string> => ({
  'content-type': 'image/png',
  'content-length': String(size),
  'cache-control': 'private, no-store',
});
export const expiredBody = () => ({
  error: {
    code: 'ACCESS_TOKEN_EXPIRED',
    message: 'Not exposed',
    requestId: '33333333-3333-4333-8333-333333333333',
  },
});
export function failure(kind: ErrorKind) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ClientError);
    assert.equal(error.kind, kind);
    return true;
  };
}
export interface StoredImage {
  size: number;
  info: LocalImageInfo;
  body?: unknown;
}
/** Deliberately rejects a second unlink, like a real temporary filesystem. */
export class ReadFiles implements MediaFiles {
  readonly values = new Map<string, StoredImage>();
  readonly deleted: string[] = [];
  readonly stats: string[] = [];
  readonly decoded: string[] = [];
  readonly errors: string[] = [];
  failUnlink = false;
  beforeUnlink: ((path: string) => void) | undefined;
  async stat(path: string): Promise<number> {
    this.stats.push(path);
    const value = this.values.get(path);
    if (!value) throw new ClientError('storage', 'Missing test temporary file');
    return value.size;
  }
  async image(path: string): Promise<LocalImageInfo> {
    this.decoded.push(path);
    const value = this.values.get(path);
    if (!value)
      throw new ClientError('storage', 'Missing test temporary image');
    return value.info;
  }
  async readError(path: string): Promise<unknown> {
    this.errors.push(path);
    return this.values.get(path)?.body;
  }
  async unlink(path: string): Promise<void> {
    this.beforeUnlink?.(path);
    this.deleted.push(path);
    if (this.failUnlink || !this.values.delete(path))
      throw new ClientError('storage', 'Temporary file unlink failed');
  }
  put(path: string, patch: Partial<StoredImage> = {}): void {
    this.values.set(path, {
      size: 100,
      info: { width: 80, height: 60, type: 'png' },
      ...patch,
    });
  }
}
type DownloadOptions = Parameters<NonNullable<WxMediaApi['downloadFile']>>[0];
type HeaderListener = (event: { header: Record<string, unknown> }) => void;
type ProgressListener = (event: { totalBytesWritten: number }) => void;
export class DownloadCall {
  aborted = 0;
  detachedHeaders = 0;
  detachedProgress = 0;
  header: HeaderListener | undefined;
  progress: ProgressListener | undefined;
  constructor(readonly options: DownloadOptions) {}
  abort(): void {
    this.aborted += 1;
  }
  onHeadersReceived(listener: HeaderListener): void {
    this.header = listener;
  }
  offHeadersReceived(listener: HeaderListener): void {
    this.detachedHeaders += 1;
    if (this.header === listener) this.header = undefined;
  }
  onProgressUpdate(listener: ProgressListener): void {
    this.progress = listener;
  }
  offProgressUpdate(listener: ProgressListener): void {
    this.detachedProgress += 1;
    if (this.progress === listener) this.progress = undefined;
  }
  headers(value: Record<string, unknown>): void {
    this.header?.({ header: value });
  }
  success(path: string, status = 200): void {
    this.options.success({ statusCode: status, tempFilePath: path });
  }
  complete(): void {
    this.options.complete();
  }
}
export function downloadHarness() {
  const sessions = signedIn('reader');
  const clock = new FakeClock();
  const files = new ReadFiles();
  const registry = new MediaLocalFiles(files);
  const calls: DownloadCall[] = [];
  const refreshes: SessionTicket[] = [];
  const authGateway: AuthGateway = {
    async login() {
      throw new Error('Read must never initiate login');
    },
    async logout() {
      throw new Error('Read must never initiate remote logout');
    },
    async refresh() {
      refreshes.push(sessions.snapshot());
      return credentials('reader', 'refreshed');
    },
  };
  const auth = new AuthService(
    sessions,
    authGateway,
    {
      async login() {
        throw new Error('No login');
      },
    },
    clock,
  );
  const wx: WxMediaApi = {
    downloadFile(options) {
      const call = new DownloadCall(options);
      calls.push(call);
      harness.construct?.(call);
      return call;
    },
  };
  const transfer = new AuthenticatedMediaDownload(
    'https://media-reader.invalid',
    wx,
    files,
    registry,
    sessions,
    auth,
    clock,
  );
  const ticket = sessions.snapshot();
  const session: MediaSession = {
    current: () => {
      sessions.assertCurrent(ticket);
      return sessions.snapshot();
    },
  };
  const owner = {};
  const harness = {
    sessions,
    clock,
    files,
    registry,
    calls,
    refreshes,
    authGateway,
    auth,
    wx,
    transfer,
    session,
    owner,
    construct: undefined as ((call: DownloadCall) => void) | undefined,
    read: (cancel = new Cancellation()) =>
      transfer.download(attachment, 'display-v1', owner, session, cancel),
    async finish(
      index = 0,
      patch: Partial<StoredImage> = {},
      headers: Record<string, unknown> | null = imageHeaders(),
      status = 200,
    ) {
      for (let i = 0; i < 4; i++) await flush();
      const path = `wxfile://tmp/media-read-${index}.png`;
      files.put(path, patch);
      const call = calls[index]!;
      if (headers) call.headers(headers);
      call.success(path, status);
      call.complete();
      for (let i = 0; i < 4; i++) await flush();
      return path;
    },
  };
  return harness;
}
