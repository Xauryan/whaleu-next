/** Device-only synthetic bridge: real loopback HTTP, actual response headers and
 * exclusive real files. No authorization, Review, owner or delivery service is
 * mocked. This cannot establish target-device redirect/domain/header behavior. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { request as nodeRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { nativeOrigin } from '../experience-native-bridge.js';

// Same narrow native boundary as the production adapter; do not import native
// source into this workspace's independent strict ESM TypeScript compilation.
interface DownloadInput {
  url: string;
  header: Record<string, string>;
  timeout: number;
  success(value: { statusCode: number; tempFilePath: string }): void;
  fail(error: unknown): void;
  complete(): void;
}
interface WxMediaDownloadTask {
  abort(): void;
  onHeadersReceived(listener: HeaderListener): void;
  offHeadersReceived(listener: HeaderListener): void;
  onProgressUpdate(listener: ProgressListener): void;
  offProgressUpdate(listener: ProgressListener): void;
}
interface WxMediaApi {
  downloadFile(input: DownloadInput): WxMediaDownloadTask;
  getFileSystemManager(): {
    getFileInfo(input: {
      filePath: string;
      success(value: { size: number }): void;
      fail(error: unknown): void;
    }): void;
    readFile(input: {
      filePath: string;
      encoding: 'utf8';
      position: number;
      length: number;
      success(value: { data: string }): void;
      fail(error: unknown): void;
    }): void;
    unlink(input: {
      filePath: string;
      success(): void;
      fail(error: unknown): void;
    }): void;
  };
  getImageInfo(input: {
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
type HeaderListener = (value: { header: Record<string, unknown> }) => void;
type ProgressListener = (value: { totalBytesWritten: number }) => void;
export class NativeMediaReadBridge {
  readonly exchanges: {
    path: string;
    authorized: boolean;
    status: number;
    bytes: number;
  }[] = [];
  readonly removed: string[] = [];
  readonly generated: string[] = [];
  beforeAbort: (() => void) | undefined;
  beforeUnlink: ((path: string) => void) | undefined;
  private readonly owned = new Map<string, string>();
  private readonly running = new Set<Promise<void>>();
  private readonly gates = new Set<() => void>();
  private hold: { arrived: () => void; released: Promise<void> } | null = null;
  private constructor(
    readonly port: number,
    private readonly root: string,
  ) {}
  static async create(port: number): Promise<NativeMediaReadBridge> {
    return new NativeMediaReadBridge(
      port,
      await mkdtemp(join(tmpdir(), 'whaleu-media-native-read-')),
    );
  }
  holdNext() {
    assert.equal(this.hold, null);
    let arrived!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resume = () => {
      release();
      this.gates.delete(resume);
    };
    this.gates.add(resume);
    this.hold = { arrived, released };
    return { arrived: reached, release: resume };
  }
  private local(path: string): string {
    const local = this.owned.get(path);
    assert.ok(
      local,
      'Only this bridge can resolve its exclusive temporary files',
    );
    return local;
  }
  async bytes(path: string): Promise<Buffer> {
    return readFile(this.local(path));
  }
  async fileCount(): Promise<number> {
    return (await readdir(this.root)).length;
  }
  async idle(): Promise<void> {
    await Promise.all([...this.running]);
  }
  async dispose(): Promise<void> {
    for (const resume of [...this.gates]) resume();
    await this.idle();
    await rm(this.root, { recursive: true, force: true });
  }
  private download(input: DownloadInput): WxMediaDownloadTask {
    const url = new URL(input.url);
    assert.equal(url.origin, nativeOrigin);
    assert.match(
      url.pathname,
      /^\/v1\/media\/bindings\/[a-f0-9-]{36}\/(display-v1|thumb-v1)$/i,
    );
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    let onHeader: HeaderListener | undefined;
    let onProgress: ProgressListener | undefined;
    const held = this.hold;
    this.hold = null;
    let request!: ReturnType<typeof nodeRequest>;
    const response = new Promise<{ bytes: Buffer; status: number }>(
      (resolve, reject) => {
        request = nodeRequest(
          {
            hostname: '127.0.0.1',
            port: this.port,
            path: url.pathname,
            method: 'GET',
            headers: input.header,
            agent: false,
          },
          (response) => {
            const headers: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(response.headers))
              if (value !== undefined)
                headers[key] = Array.isArray(value) ? value.join(', ') : value;
            onHeader?.({ header: headers });
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('data', (chunk: Buffer) => {
              chunks.push(chunk);
              bytes += chunk.length;
              onProgress?.({ totalBytesWritten: bytes });
            });
            response.once('error', reject);
            response.once('aborted', () =>
              reject(new Error('Loopback response interrupted')),
            );
            response.once('end', () =>
              resolve({
                bytes: Buffer.concat(chunks),
                status: response.statusCode ?? 0,
              }),
            );
          },
        );
        request.once('error', reject);
        request.setTimeout(input.timeout, () =>
          request.destroy(new Error('Loopback read deadline')),
        );
        request.end();
      },
    );
    const work = response
      .then(async (result) => {
        this.exchanges.push({
          path: url.pathname,
          authorized: typeof input.header['Authorization'] === 'string',
          status: result.status,
          bytes: result.bytes.length,
        });
        const id = randomUUID();
        const path = `wxfile://tmp/media-native-${id}.img`;
        const local = join(this.root, `${id}.img`);
        await writeFile(local, result.bytes, { flag: 'wx', mode: 0o600 });
        this.owned.set(path, local);
        this.generated.push(path);
        if (held) {
          held.arrived();
          await held.released;
        }
        // Native callbacks may arrive after abort. Keep that behavior observable.
        input.success({ statusCode: result.status, tempFilePath: path });
      })
      .catch(() => input.fail({ errMsg: 'Synthetic device transport failed' }))
      .finally(() => input.complete());
    this.running.add(work);
    void work.then(() => this.running.delete(work));
    return {
      abort: () => {
        this.beforeAbort?.();
        request.destroy();
      },
      onHeadersReceived: (listener) => {
        onHeader = listener;
      },
      offHeadersReceived: (listener) => {
        if (onHeader === listener) onHeader = undefined;
      },
      onProgressUpdate: (listener) => {
        onProgress = listener;
      },
      offProgressUpdate: (listener) => {
        if (onProgress === listener) onProgress = undefined;
      },
    };
  }
  readonly wx: WxMediaApi = {
    downloadFile: (input) => this.download(input),
    getFileSystemManager: () => ({
      getFileInfo: (input) => {
        void Promise.resolve()
          .then(() => stat(this.local(input.filePath)))
          .then((value) => input.success({ size: value.size }), input.fail);
      },
      readFile: (input) => {
        void Promise.resolve()
          .then(() => readFile(this.local(input.filePath)))
          .then((value) => {
            assert.equal(input.encoding, 'utf8');
            assert.equal(input.position, 0);
            assert.ok(input.length <= 8192);
            input.success({
              data: value.subarray(0, input.length).toString('utf8'),
            });
          }, input.fail);
      },
      unlink: (input) => {
        void Promise.resolve()
          .then(async () => {
            this.beforeUnlink?.(input.filePath);
            await unlink(this.local(input.filePath));
            this.owned.delete(input.filePath);
            this.removed.push(input.filePath);
          })
          .then(input.success, input.fail);
      },
    }),
    getImageInfo: (input) => {
      void Promise.resolve()
        .then(() => sharp(this.local(input.src)).metadata())
        .then((value) => {
          assert.ok(value.width && value.height && value.format);
          input.success({
            width: value.width,
            height: value.height,
            type: value.format,
            orientation: 'up',
            path: input.src,
          });
        }, input.fail);
    },
  };
}
