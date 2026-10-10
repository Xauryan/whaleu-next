/** Test-only device bridge. Real files and real localhost multipart HTTP; no business/Review mocks.
 * API tests can load this via createRequire without crossing native/API compilation boundaries. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import {
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  WxUploadApi,
  WxUploadTask,
} from '../../src/platform/wechat-upload';
type UploadInput = Parameters<NonNullable<WxUploadApi['uploadFile']>>[0];
type Progress = Parameters<NonNullable<WxUploadTask['onProgressUpdate']>>[0];
interface OwnedFile {
  local: string;
  mime: 'image/png' | 'image/jpeg';
  info: { width: number; height: number; type: string };
}
export class NativeMediaUploadBridge {
  readonly exchanges: {
    path: string;
    status: number;
    bytes: number;
    authorized: boolean;
  }[] = [];
  readonly removed: string[] = [];
  readonly readLengths: number[] = [];
  dropUploadResponse = false;
  beforeSuccess: (() => Promise<void>) | undefined;
  private readonly owned = new Map<string, OwnedFile>();
  private readonly queue: string[] = [];
  private readonly running = new Set<Promise<void>>();
  private readonly active = new Set<AbortController>();
  private constructor(
    readonly port: number,
    readonly origin: string,
    private readonly root: string,
  ) {}
  static async create(
    port: number,
    origin = 'https://native-experience.invalid',
  ): Promise<NativeMediaUploadBridge> {
    return new NativeMediaUploadBridge(
      port,
      origin,
      await mkdtemp(join(tmpdir(), 'whaleu-native-upload-')),
    );
  }
  /** Info is obtained by the API fixture's real sharp decoder, never used as Review evidence. */
  async select(
    bytes: Uint8Array,
    mime: 'image/png' | 'image/jpeg',
    info: { width: number; height: number; type: string },
  ): Promise<string> {
    const id = randomUUID(),
      local = join(this.root, id),
      path = `wxfile://tmp/native-upload-${id}`;
    await writeFile(local, bytes, { flag: 'wx', mode: 0o600 });
    this.owned.set(path, { local, mime, info });
    this.queue.push(path);
    return path;
  }
  private file(path: string): OwnedFile {
    const file = this.owned.get(path);
    assert.ok(file, 'Only bridge-owned picker files are readable');
    return file;
  }
  async fileCount(): Promise<number> {
    return (await readdir(this.root)).length;
  }
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }
  async dispose(): Promise<void> {
    for (const controller of this.active) controller.abort();
    await this.idle();
    await rm(this.root, { recursive: true, force: true });
  }
  readonly wx: WxUploadApi = {
    chooseMedia: (input) => {
      assert.equal(input.count, 1);
      assert.deepEqual(input.mediaType, ['image']);
      assert.deepEqual(input.sizeType, ['original']);
      const path = this.queue.shift();
      if (!path) {
        input.fail({ errMsg: 'chooseMedia:fail cancel' });
        input.complete();
        return;
      }
      void stat(this.file(path).local)
        .then(
          (value) =>
            input.success({
              tempFiles: [
                { tempFilePath: path, size: value.size, fileType: 'image' },
              ],
            }),
          input.fail,
        )
        .finally(input.complete);
    },
    getImageInfo: (input) => {
      try {
        const value = this.file(input.src);
        input.success({ ...value.info, orientation: 'up', path: input.src });
      } catch (error) {
        input.fail(error);
      }
    },
    getFileSystemManager: () => ({
      getFileInfo: (input) => {
        void stat(this.file(input.filePath).local).then(
          (value) => input.success({ size: value.size }),
          input.fail,
        );
      },
      readFile: (input) => {
        assert.ok(input.length > 0 && input.length <= 65536);
        this.readLengths.push(input.length);
        void (async () => {
          const file = await open(this.file(input.filePath).local, 'r');
          try {
            const buffer = Buffer.alloc(input.length);
            const read = await file.read(
              buffer,
              0,
              input.length,
              input.position,
            );
            input.success({
              data: buffer.buffer.slice(
                buffer.byteOffset,
                buffer.byteOffset + read.bytesRead,
              ) as ArrayBuffer,
            });
          } finally {
            await file.close();
          }
        })().catch(input.fail);
      },
      unlink: (input) => {
        const file = this.file(input.filePath);
        void unlink(file.local).then(() => {
          this.owned.delete(input.filePath);
          this.removed.push(input.filePath);
          input.success();
        }, input.fail);
      },
    }),
    uploadFile: (input) => this.upload(input),
  };
  private upload(input: UploadInput): WxUploadTask {
    const url = new URL(input.url);
    assert.equal(url.origin, this.origin);
    assert.match(
      url.pathname,
      /^\/v2\/media\/upload-intents\/[a-f0-9-]{36}\/uploads\/[a-f0-9-]{36}$/i,
    );
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.equal(input.name, 'file');
    assert.deepEqual(Object.keys(input.header), ['Authorization']);
    assert.equal('formData' in input, false);
    assert.equal('method' in input, false);
    const controller = new AbortController();
    this.active.add(controller);
    let listener: Progress | undefined;
    const work = (async () => {
      const owned = this.file(input.filePath),
        bytes = (await stat(owned.local)).size;
      const form = new FormData();
      form.append(
        'file',
        await openAsBlob(owned.local, { type: owned.mime }),
        'ignored-image',
      );
      // Standard multipart encoder, actual socket. Fixed test origin mapping is confined to this test file.
      const response = await fetch(
        `http://127.0.0.1:${this.port}${url.pathname}`,
        {
          method: 'POST',
          headers: input.header,
          body: form,
          redirect: 'error',
          signal: controller.signal,
        },
      );
      const data = await response.text();
      this.exchanges.push({
        path: url.pathname,
        status: response.status,
        bytes,
        authorized: typeof input.header.Authorization === 'string',
      });
      listener?.({
        progress: 100,
        totalBytesSent: bytes,
        totalBytesExpectedToSend: bytes,
      });
      await this.beforeSuccess?.();
      if (this.dropUploadResponse) {
        this.dropUploadResponse = false;
        input.fail({ errMsg: 'Synthetic response loss after real HTTP' });
      } else input.success({ statusCode: response.status, data });
    })()
      .catch(() => input.fail({ errMsg: 'Synthetic device HTTP failed' }))
      .finally(() => {
        this.active.delete(controller);
        input.complete();
      });
    this.running.add(work);
    void work.then(() => this.running.delete(work));
    return {
      abort: () => controller.abort(),
      onProgressUpdate: (value) => {
        listener = value;
      },
      offProgressUpdate: (value) => {
        if (listener === value) listener = undefined;
      },
    };
  }
}
