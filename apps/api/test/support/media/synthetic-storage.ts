import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, link, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  exactObjectSchema,
  mediaIdSchema,
  MEDIA_MAX_INPUT_BYTES,
} from '../../../src/media/contracts.js';
import type { ExactObject } from '../../../src/media/contracts.js';
import type {
  ImmutableMediaStorage,
  StoredObjectMeasurement,
} from '../../../src/media/storage-port.js';

/** TEST ONLY. No AppModule provider, environment flag, caller-supplied directory,
 * URL, bucket, filename or path. Every test gets an OS-private temporary root.
 * Not a decoder, a scanner, or a substitute for provider acceptance. */
export class SyntheticMediaStorage implements ImmutableMediaStorage {
  readonly provider = 'local-fixture';
  readonly environment = 'synthetic';
  private closed = false;
  private readonly retired = new Set<string>();
  private readonly activeWrites = new Map<string, Set<Promise<void>>>();
  private readonly quiescence = new WeakMap<object, string>();
  private constructor(private readonly root: string) {}
  static async create(): Promise<SyntheticMediaStorage> {
    return new SyntheticMediaStorage(
      await mkdtemp(join(tmpdir(), 'whaleu-synthetic-media-')),
    );
  }
  newObject(): ExactObject {
    return Object.freeze({
      provider: this.provider,
      environment: this.environment,
      bucket: 'synthetic',
      key: randomUUID(),
      version: randomUUID(),
    });
  }
  /** Each upload produces a NEW immutable version, even when simulating reuse
   * of a staging key. The worker seals the observed version, never "latest". */
  async upload(
    bytes: Uint8Array,
    key?: string,
  ): Promise<StoredObjectMeasurement> {
    const object = {
      ...this.newObject(),
      ...(key === undefined ? {} : { key }),
    };
    return this.write(object, Readable.from([bytes]));
  }
  /** Test worker only: caller persists this exact destination before the effect. */
  async writePlanned(
    object: ExactObject,
    bytes: Uint8Array,
  ): Promise<StoredObjectMeasurement> {
    return this.write(object, Readable.from([bytes]));
  }
  private path(object: ExactObject): string {
    if (this.closed) throw new Error('SYNTHETIC_STORAGE_CLOSED');
    const parsed = exactObjectSchema.parse(object);
    if (
      parsed.provider !== this.provider ||
      parsed.environment !== this.environment ||
      parsed.bucket !== 'synthetic'
    )
      throw new Error('SYNTHETIC_STORAGE_NAMESPACE');
    return join(
      this.root,
      `${mediaIdSchema.parse(parsed.key)}.${mediaIdSchema.parse(parsed.version)}`,
    );
  }
  /** Test-only process-local irrevocable writer retirement. This adapter is the
   * sole writer of its private root; no other process/provider is covered. */
  async retire(object: ExactObject): Promise<object> {
    const key = this.path(object);
    this.retired.add(key);
    await Promise.all([...(this.activeWrites.get(key) ?? [])]);
    const proof = Object.freeze({});
    this.quiescence.set(proof, key);
    return proof;
  }
  requireRetired(proof: unknown, object: ExactObject): void {
    const key = this.path(object);
    if (
      typeof proof !== 'object' ||
      proof === null ||
      this.quiescence.get(proof) !== key ||
      !this.retired.has(key) ||
      (this.activeWrites.get(key)?.size ?? 0) !== 0
    )
      throw new Error('SYNTHETIC_STORAGE_NOT_QUIESCENT');
  }
  private async write(
    object: ExactObject,
    source: AsyncIterable<Uint8Array>,
  ): Promise<StoredObjectMeasurement> {
    const key = this.path(object);
    if (this.retired.has(key)) throw new Error('SYNTHETIC_STORAGE_RETIRED');
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let pending = this.activeWrites.get(key);
    if (!pending) {
      pending = new Set();
      this.activeWrites.set(key, pending);
    }
    pending.add(done);
    try {
      return await this.writeEffect(object, source);
    } finally {
      pending.delete(done);
      if (!pending.size) this.activeWrites.delete(key);
      finish();
    }
  }
  private async writeEffect(
    object: ExactObject,
    source: AsyncIterable<Uint8Array>,
  ): Promise<StoredObjectMeasurement> {
    const destination = this.path(object);
    const temporary = join(this.root, `.pending-${randomUUID()}`);
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let bytes = 0;
    const hash = createHash('sha256');
    try {
      for await (const chunk of source) {
        bytes += chunk.byteLength;
        if (bytes > MEDIA_MAX_INPUT_BYTES)
          throw new Error('SYNTHETIC_STORAGE_SIZE_LIMIT');
        hash.update(chunk);
        // FileHandle.write can write fewer bytes than requested.
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await file.write(
            chunk,
            offset,
            chunk.byteLength - offset,
          );
          if (result.bytesWritten < 1)
            throw new Error('SYNTHETIC_STORAGE_SHORT_WRITE');
          offset += result.bytesWritten;
        }
      }
      if (bytes === 0) throw new Error('SYNTHETIC_STORAGE_EMPTY');
      await file.sync();
      await file.close();
      const sha256 = hash.digest('hex');
      try {
        // Hard link is atomic and exclusive: a crash never exposes partial bytes.
        await link(temporary, destination);
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        const existing = await this.measure(object);
        if (existing.bytes !== bytes || existing.sha256 !== sha256)
          throw new Error('SYNTHETIC_STORAGE_EFFECT_CONFLICT', {
            cause: error,
          });
      }
      return Object.freeze({
        object: Object.freeze({ ...object }),
        bytes,
        sha256,
      });
    } finally {
      await file.close().catch(() => undefined);
      await unlink(temporary).catch((error: unknown) => {
        if (!hasCode(error, 'ENOENT')) throw error;
      });
    }
  }
  async seal(
    source: ExactObject,
    destination: ExactObject,
  ): Promise<StoredObjectMeasurement> {
    if (
      source.key === destination.key &&
      source.version === destination.version
    )
      throw new Error('SYNTHETIC_STORAGE_NOT_A_SEAL');
    const opened = await this.openExact(source, MEDIA_MAX_INPUT_BYTES);
    try {
      return await this.write(destination, opened.stream);
    } finally {
      opened.stream.destroy();
    }
  }
  async openExact(
    object: ExactObject,
    maximumBytes: number,
  ): Promise<{ stream: Readable; bytes: number }> {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > MEDIA_MAX_INPUT_BYTES
    )
      throw new Error('SYNTHETIC_STORAGE_INVALID_BUDGET');
    const file = await open(
      this.path(object),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes)
        throw new Error('SYNTHETIC_STORAGE_SIZE_LIMIT');
      return {
        stream: file.createReadStream({
          autoClose: true,
          start: 0,
          end: stat.size - 1,
        }),
        bytes: stat.size,
      };
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async measure(object: ExactObject): Promise<StoredObjectMeasurement> {
    const opened = await this.openExact(object, MEDIA_MAX_INPUT_BYTES);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of opened.stream) {
        const value = chunk as Buffer;
        bytes += value.byteLength;
        if (bytes > MEDIA_MAX_INPUT_BYTES)
          throw new Error('SYNTHETIC_STORAGE_SIZE_LIMIT');
        hash.update(value);
      }
      if (bytes !== opened.bytes) throw new Error('SYNTHETIC_STORAGE_CHANGED');
      return { object, bytes, sha256: hash.digest('hex') };
    } finally {
      opened.stream.destroy();
    }
  }
  async deleteExact(object: ExactObject): Promise<'confirmed-absent'> {
    await unlink(this.path(object)).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error;
    });
    return 'confirmed-absent';
  }
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await rm(this.root, { recursive: true, force: true });
  }
}
function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
