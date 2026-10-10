import { ClientError } from '../api/errors';
import type { Clock } from './contracts';
import { bounded } from './deadline';

/** Narrow structural subset of the official wechat-miniprogram/api-typings.
 * downloadFile success has NO response headers. onHeadersReceived requires 2.1.0.
 * No uploadFile, saveFile or previewImage capability is exposed here. */
export interface WxMediaDownloadTask {
  abort(): void;
  onProgressUpdate?(
    listener: (value: { totalBytesWritten: number }) => void,
  ): void;
  offProgressUpdate?(
    listener: (value: { totalBytesWritten: number }) => void,
  ): void;
  onHeadersReceived?(
    listener: (value: { header: Record<string, unknown> }) => void,
  ): void;
  offHeadersReceived?(
    listener: (value: { header: Record<string, unknown> }) => void,
  ): void;
}
export interface WxMediaApi {
  downloadFile?(options: {
    url: string;
    header: Record<string, string>;
    timeout: number;
    success(value: { statusCode: number; tempFilePath: string }): void;
    fail(error: unknown): void;
    complete(): void;
  }): WxMediaDownloadTask;
  getFileSystemManager?(): {
    getFileInfo(options: {
      filePath: string;
      success(value: { size: number }): void;
      fail(error: unknown): void;
    }): void;
    readFile(options: {
      filePath: string;
      encoding: 'utf8';
      position: number;
      length: number;
      success(value: { data: string | ArrayBuffer }): void;
      fail(error: unknown): void;
    }): void;
    unlink(options: {
      filePath: string;
      success(): void;
      fail(error: unknown): void;
    }): void;
  };
  getImageInfo?(options: {
    src: string;
    success(value: {
      width: number;
      height: number;
      type: string;
      orientation: string;
      path: string;
    }): void;
    fail(error: unknown): void;
  }): void;
}
export interface LocalImageInfo {
  readonly width: number;
  readonly height: number;
  readonly type: string;
}
export interface MediaFiles {
  stat(path: string): Promise<number>;
  image(path: string): Promise<LocalImageInfo>;
  readError(path: string, size: number): Promise<unknown>;
  unlink(path: string): Promise<void>;
}
/** Files originate only from downloadFile callbacks, never business DTOs or storage. */
export function isNativeTemporaryPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length < 1024 &&
    /^(?:wxfile:\/\/tmp(?:[/_])|http:\/\/tmp\/)[a-zA-Z0-9_./-]+$/.test(path) &&
    !path.split('/').includes('..')
  );
}
export class WechatMediaFiles implements MediaFiles {
  constructor(
    private readonly wx: WxMediaApi,
    private readonly clock: Clock,
  ) {}
  private call<T>(
    action: (resolve: (value: T) => void, reject: () => void) => void,
  ): Promise<T> {
    return bounded(
      () =>
        new Promise<T>((resolve, reject) => {
          try {
            action(resolve, () =>
              reject(
                new ClientError('storage', 'Temporary media file unavailable'),
              ),
            );
          } catch {
            reject(
              new ClientError(
                'configuration',
                'Temporary media platform unavailable',
              ),
            );
          }
        }),
      5000,
      this.clock,
    );
  }
  stat(path: string): Promise<number> {
    return this.call((resolve, reject) => {
      if (!this.wx.getFileSystemManager) return reject();
      this.wx.getFileSystemManager().getFileInfo({
        filePath: path,
        success: (value) => resolve(value.size),
        fail: reject,
      });
    });
  }
  image(path: string): Promise<LocalImageInfo> {
    return this.call((resolve, reject) => {
      if (!this.wx.getImageInfo) return reject();
      this.wx.getImageInfo({
        src: path,
        success: (value) =>
          resolve({
            width: value.width,
            height: value.height,
            type: value.type,
          }),
        fail: reject,
      });
    });
  }
  async readError(path: string, size: number): Promise<unknown> {
    if (!Number.isSafeInteger(size) || size < 1 || size > 8192)
      throw new ClientError('protocol', 'Invalid media error body');
    const data = await this.call<string | ArrayBuffer>((resolve, reject) => {
      if (!this.wx.getFileSystemManager) return reject();
      this.wx.getFileSystemManager().readFile({
        filePath: path,
        encoding: 'utf8',
        position: 0,
        length: size,
        success: (value) => resolve(value.data),
        fail: reject,
      });
    });
    if (typeof data !== 'string')
      throw new ClientError('protocol', 'Invalid media error body');
    try {
      return JSON.parse(data) as unknown;
    } catch {
      throw new ClientError('protocol', 'Invalid media error body');
    }
  }
  unlink(path: string): Promise<void> {
    return this.call((resolve, reject) => {
      if (!this.wx.getFileSystemManager) return reject();
      this.wx
        .getFileSystemManager()
        .unlink({ filePath: path, success: () => resolve(), fail: reject });
    });
  }
}
