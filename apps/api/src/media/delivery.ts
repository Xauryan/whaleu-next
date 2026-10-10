import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { Readable, TransformCallback } from 'node:stream';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type {
  ExactObject,
  MediaParent,
  MediaVariantName,
} from './contracts.js';
import type { ImmutableMediaStorage } from './storage-port.js';

export interface InternalMediaDeliveryPlan {
  readonly bindingId: string;
  readonly parent: MediaParent;
  readonly viewerAccountId: string;
  readonly variant: MediaVariantName;
  readonly object: ExactObject;
  readonly sha256: string;
  readonly manifestDigest: string;
  readonly safetyRevision: string;
  readonly bytes: number;
  readonly mime: 'image/jpeg' | 'image/png';
}
export interface CurrentMediaDeliveryAuthorizer {
  /** Must resolve current session, typed parent and asset authority and enroll all
   * required owner facts/deadlines. No provider calls inside this transaction. */
  authorize(
    token: string,
    bindingId: string,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<InternalMediaDeliveryPlan>;
}
export interface MediaTransactionRunner {
  transaction<T>(
    operation: (tx: PoolClient) => Promise<T>,
    options: { isolationLevel: 'read committed' },
  ): Promise<T>;
}
export interface AuthorizedMediaStream {
  readonly stream: Readable;
  readonly headers: Readonly<Record<string, string>>;
  /** Controller calls this on client disconnect, deadline, and response close. */
  abort(): void;
}
/** Exact object open occurs outside locks; the stream remains paused until a
 * second current authorization and required final proof COMMIT succeed. There is
 * no redirect, signed read URL, public cache or original-file variant. */
export class MediaDeliveryService {
  private readonly active = new Map<string, number>();
  constructor(
    private readonly database: MediaTransactionRunner,
    private readonly authorizer: CurrentMediaDeliveryAuthorizer,
    private readonly storage: ImmutableMediaStorage,
  ) {}
  async open(
    token: string,
    bindingId: string,
    variant: MediaVariantName,
    range?: string,
  ): Promise<AuthorizedMediaStream> {
    if (range !== undefined) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const plan = await this.database.transaction(
      (tx) => this.authorizer.authorize(token, bindingId, variant, tx),
      { isolationLevel: 'read committed' },
    );
    if (plan.bytes < 1 || plan.bytes > 5 * 1024 * 1024)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const count = this.active.get(plan.viewerAccountId) ?? 0;
    if (count >= 2) throw new ApplicationError('MEDIA_UNAVAILABLE');
    this.active.set(plan.viewerAccountId, count + 1);
    let source: Readable | undefined;
    let output: Transform | undefined;
    let closed = false;
    const timer = setTimeout(() => abort(), 30_000);
    timer.unref();
    const abort = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      source?.destroy();
      output?.destroy();
      const active = (this.active.get(plan.viewerAccountId) ?? 1) - 1;
      if (active <= 0) this.active.delete(plan.viewerAccountId);
      else this.active.set(plan.viewerAccountId, active);
    };
    try {
      const opened = await this.storage.openExact(plan.object, plan.bytes);
      source = opened.stream;
      source.pause();
      // Attach an error observer before the final authorization is awaited.
      let upstreamFailed = false;
      source.on('error', () => {
        upstreamFailed = true;
        output?.destroy(new ApplicationError('MEDIA_UNAVAILABLE'));
      });
      if (closed || opened.bytes !== plan.bytes) {
        source.destroy();
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      }
      const current = await this.database.transaction(
        (tx) => this.authorizer.authorize(token, bindingId, variant, tx),
        { isolationLevel: 'read committed' },
      );
      if (
        closed ||
        upstreamFailed ||
        JSON.stringify(current) !== JSON.stringify(plan)
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      let bytes = 0;
      const hash = createHash('sha256');
      output = new Transform({
        transform(
          chunk: Buffer,
          _encoding: BufferEncoding,
          done: TransformCallback,
        ) {
          bytes += chunk.byteLength;
          if (bytes > plan.bytes)
            return done(new ApplicationError('MEDIA_UNAVAILABLE'));
          hash.update(chunk);
          done(null, chunk);
        },
        flush(done: TransformCallback) {
          if (bytes !== plan.bytes || hash.digest('hex') !== plan.sha256)
            return done(new ApplicationError('MEDIA_UNAVAILABLE'));
          done();
        },
      });
      output.once('close', abort);
      output.once('error', abort);
      // The final transaction has committed. Backpressure bounds buffering even
      // before the controller attaches a downstream consumer.
      source.pipe(output);
      return Object.freeze({
        stream: output,
        abort,
        headers: Object.freeze({
          'Cache-Control': 'private, no-store',
          Vary: 'Authorization',
          'X-Content-Type-Options': 'nosniff',
          'Content-Type': plan.mime,
          'Content-Length': String(plan.bytes),
          'Accept-Ranges': 'none',
        }),
      });
    } catch (error) {
      abort();
      throw error;
    }
  }
}
