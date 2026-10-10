import type { MediaDeliveryBudgetPool } from './delivery-budget.js';
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
import { exactObjectSchema } from './contracts.js';
import type { ImmutableMediaStorage } from './storage-port.js';

export interface ExactMediaDeliveryPlan {
  readonly object: ExactObject;
  readonly sha256: string;
  readonly attachmentSetRevision: string;
  readonly bytes: number;
  readonly mime: 'image/jpeg' | 'image/png';
}
export interface InternalMediaDeliveryPlan extends ExactMediaDeliveryPlan {
  readonly bindingId: string;
  readonly parent: MediaParent;
  readonly viewerAccountId: string;
  readonly variant: MediaVariantName;
  readonly object: ExactObject;
  readonly sha256: string;
  readonly manifestDigest: string;
  readonly safetyRevision: string;
  /** Whole ordered set, including non-target safety dependencies. */
  readonly attachmentSetRevision: string;
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
export class ExactMediaDeliveryService {
  constructor(
    private readonly database: MediaTransactionRunner,
    private readonly storage: ImmutableMediaStorage,
    private readonly budget: MediaDeliveryBudgetPool,
  ) {}
  async open<Plan extends ExactMediaDeliveryPlan>(
    authorize: (tx: PoolClient) => Promise<Plan>,
    budgetKeyOf: (plan: Plan) => string,
    range?: string,
  ): Promise<AuthorizedMediaStream> {
    if (range !== undefined) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const plan = await this.database.transaction(authorize, {
      isolationLevel: 'read committed',
    });
    if (
      !Number.isSafeInteger(plan.bytes) ||
      plan.bytes < 1 ||
      plan.bytes > 5 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(plan.attachmentSetRevision) ||
      !/^[a-f0-9]{64}$/.test(plan.sha256) ||
      !['image/jpeg', 'image/png'].includes(plan.mime) ||
      !exactObjectSchema.safeParse(plan.object).success
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const release = this.budget.acquire(budgetKeyOf(plan));
    let source: Readable | undefined;
    let output: Transform | undefined;
    let closed = false,
      opening = true,
      setupPending = true,
      sourceClosed = true,
      outputClosed = true;
    const releaseIfQuiet = () => {
      if (!opening && !setupPending && sourceClosed && outputClosed) release();
    };
    const abort = () => {
      if (!closed) {
        closed = true;
        clearTimeout(timer);
        source?.destroy();
        output?.destroy();
      }
      releaseIfQuiet();
    };
    let rejectTimeout!: (error: ApplicationError) => void;
    const timedOut = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      abort();
      rejectTimeout(new ApplicationError('MEDIA_UNAVAILABLE'));
    }, 30_000);
    timer.unref();
    // Race only the caller's result. The effect continues to own its credit and
    // adopts/destroys a late stream; Promise.race observes late rejections too.
    const openingWork = async (): Promise<AuthorizedMediaStream> => {
      try {
        const opened = await this.storage.openExact(plan.object, plan.bytes);
        opening = false;
        source = opened.stream;
        sourceClosed = source.closed;
        source.once('close', () => {
          sourceClosed = true;
          releaseIfQuiet();
        });
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
        const current = await this.database.transaction(authorize, {
          isolationLevel: 'read committed',
        });
        if (
          closed ||
          upstreamFailed ||
          sourceClosed ||
          source.destroyed ||
          JSON.stringify(current) !== JSON.stringify(plan)
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        let bytes = 0;
        const hash = createHash('sha256');
        outputClosed = false;
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
        output.once('close', () => {
          outputClosed = true;
          abort();
        });
        output.once('error', abort);
        // The final transaction has committed. Backpressure bounds buffering even
        // before the controller attaches a downstream consumer.
        setupPending = false;
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
        opening = false;
        setupPending = false;
        if (!output) outputClosed = true;
        abort();
        throw error;
      }
    };
    return Promise.race([openingWork(), timedOut]);
  }
}

/** The existing authenticated Community interface retains its own owner proof,
 * principal and route. Profile never makes these credentials optional. */
export class MediaDeliveryService {
  private readonly exact: ExactMediaDeliveryService;
  constructor(
    database: MediaTransactionRunner,
    private readonly authorizer: CurrentMediaDeliveryAuthorizer,
    storage: ImmutableMediaStorage,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.exact = new ExactMediaDeliveryService(database, storage, budget);
  }
  open(
    token: string,
    bindingId: string,
    variant: MediaVariantName,
    range?: string,
  ): Promise<AuthorizedMediaStream> {
    return this.exact.open(
      (tx) => this.authorizer.authorize(token, bindingId, variant, tx),
      (plan) => `account:${plan.viewerAccountId}`,
      range,
    );
  }
}
