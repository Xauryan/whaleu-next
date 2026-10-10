import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import type { Clock, Cancellation } from './contracts';
import { bounded } from './deadline';
import {
  isNativeTemporaryPath,
  type LocalImageInfo,
  type MediaFiles,
} from './wechat-media';

export interface WxUploadTask {
  abort(): void;
  onProgressUpdate?(
    listener: (value: {
      progress: number;
      totalBytesSent: number;
      totalBytesExpectedToSend: number;
    }) => void,
  ): void;
  offProgressUpdate?(
    listener: (value: {
      progress: number;
      totalBytesSent: number;
      totalBytesExpectedToSend: number;
    }) => void,
  ): void;
}
/** Actual uploadFile POST API. No method/raw-PUT or arbitrary form fields are exposed. */
export interface WxUploadApi {
  chooseMedia?(options: {
    count: 1;
    mediaType: ['image'];
    sizeType: ['original'];
    success(value: {
      tempFiles: readonly {
        tempFilePath: string;
        size: number;
        fileType?: string;
      }[];
    }): void;
    fail(error: unknown): void;
    complete(): void;
  }): void;
  uploadFile?(options: {
    url: string;
    filePath: string;
    name: 'file';
    header: Record<string, string>;
    timeout: number;
    success(value: { statusCode: number; data: string }): void;
    fail(error: unknown): void;
    complete(): void;
  }): WxUploadTask;
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
  getFileSystemManager?(): {
    getFileInfo(options: {
      filePath: string;
      success(value: { size: number }): void;
      fail(error: unknown): void;
    }): void;
    readFile(options: {
      filePath: string;
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
}
export interface UploadFiles extends MediaFiles {
  digest(
    path: string,
    bytes: number,
    current: () => void,
    cancel: Cancellation,
  ): Promise<string>;
}
/** Bounded ArrayBuffer chunks, reusing js-sha256 streaming. Never load a whole image into JS. */
export class WechatUploadFiles implements UploadFiles {
  constructor(
    private readonly wx: WxUploadApi,
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
              reject(new ClientError('storage', 'Selected image unavailable')),
            );
          } catch {
            reject(
              new ClientError('configuration', 'Image platform unavailable'),
            );
          }
        }),
      5000,
      this.clock,
    );
  }
  stat(path: string): Promise<number> {
    return this.call((resolve, reject) => {
      if (!isNativeTemporaryPath(path) || !this.wx.getFileSystemManager)
        return reject();
      this.wx.getFileSystemManager().getFileInfo({
        filePath: path,
        success: (value) => resolve(value.size),
        fail: reject,
      });
    });
  }
  image(path: string): Promise<LocalImageInfo> {
    return this.call((resolve, reject) => {
      if (!isNativeTemporaryPath(path) || !this.wx.getImageInfo)
        return reject();
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
  async readError(): Promise<never> {
    throw new ClientError(
      'configuration',
      'Upload adapter does not read error files',
    );
  }
  unlink(path: string): Promise<void> {
    return this.call((resolve, reject) => {
      if (!isNativeTemporaryPath(path) || !this.wx.getFileSystemManager)
        return reject();
      this.wx
        .getFileSystemManager()
        .unlink({ filePath: path, success: () => resolve(), fail: reject });
    });
  }
  async digest(
    path: string,
    bytes: number,
    current: () => void,
    cancel: Cancellation,
  ): Promise<string> {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > 5 * 1024 * 1024 ||
      !isNativeTemporaryPath(path)
    )
      throw new ClientError('protocol', 'Invalid image length');
    const hash = sha256.create();
    const assert = () => {
      current();
      if (cancel.isCancelled)
        throw new ClientError('cancelled', 'Image inspection cancelled');
    };
    assert();
    for (let position = 0; position < bytes; position += 65536) {
      assert();
      const length = Math.min(65536, bytes - position);
      const chunk = await this.call<string | ArrayBuffer>((resolve, reject) => {
        if (!this.wx.getFileSystemManager) return reject();
        assert();
        this.wx.getFileSystemManager().readFile({
          filePath: path,
          position,
          length,
          success: (value) => resolve(value.data),
          fail: reject,
        });
      });
      assert();
      if (!(chunk instanceof ArrayBuffer) || chunk.byteLength !== length)
        throw new ClientError('protocol', 'Incomplete image read');
      hash.update(chunk);
    }
    if ((await this.stat(path)) !== bytes)
      throw new ClientError('storage', 'Selected image changed');
    assert();
    return hash.hex();
  }
}
export function pickerCancelled(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.errMsg === 'string' &&
    /^chooseMedia:fail cancel(?:\s|$)/.test(value.errMsg)
  );
}
