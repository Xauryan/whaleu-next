import { MEDIA_DISCUSSION_BATCH_APPLICATION } from './application-v4.js';
import type { MediaDiscussionBatchApplication } from './application-v4.js';
import {
  BadRequestException,
  Inject,
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface.js';
import type { Request } from 'express';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { defer, lastValueFrom } from 'rxjs';
import { ApplicationError } from '../http/application-error.js';
import { bearerToken } from '../identity/tokens.js';
import { MEDIA_MAX_INPUT_BYTES } from './contracts.js';
import { MEDIA_UPLOAD_APPLICATION_V2 } from './application-v2.js';
import type { MediaUploadApplicationV2 } from './application-v2.js';
import { MEDIA_BATCH_APPLICATION } from './application-v3.js';
import type { MediaBatchApplication } from './application-v3.js';
import { MEDIA_INGRESS_STORAGE } from './ingress-storage.js';
import type { MediaIngressStorage } from './ingress-storage.js';
import type { StoredObjectMeasurement } from './storage-port.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import type { MediaUploadObserved } from './contracts-v2.js';

const WIRE_LIMIT = MEDIA_MAX_INPUT_BYTES + 64 * 1024;
const admissions = new WeakMap<MediaIngressStorage, { active: number }>();
const results = new WeakMap<Request, MediaUploadObserved>();
export function observedMultipart(request: Request): MediaUploadObserved {
  const result = results.get(request);
  if (!result) throw new ApplicationError('MEDIA_UNAVAILABLE');
  return result;
}
interface MulterFile {
  readonly stream: Readable;
  readonly mimetype: string;
}

/** Admission precedes Nest's actual Multer middleware. File end never commits
 * observation: the entire parser and whole wire budget must finish first. */
@Injectable()
export class MediaMultipartInterceptor implements NestInterceptor {
  private readonly admission: { active: number };
  constructor(
    @Inject(MEDIA_UPLOAD_APPLICATION_V2)
    private readonly media: Pick<
      MediaUploadApplicationV2,
      'admit' | 'observe' | 'retire'
    >,
    @Inject(MEDIA_INGRESS_STORAGE)
    private readonly storage: MediaIngressStorage | null,
  ) {
    const shared = storage ? admissions.get(storage) : undefined;
    this.admission = shared ?? { active: 0 };
    if (storage && !shared) admissions.set(storage, this.admission);
  }
  intercept(context: ExecutionContext, next: CallHandler) {
    return defer(() => this.execute(context, next));
  }
  private async execute(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(request.headers.authorization);
    // Default AppModule authenticates then fails closed here, before parser,
    // stream timers, scratch, or provider effects exist.
    const intentId = mediaV2IdSchema.safeParse(request.params['id']);
    const grantId = mediaV2IdSchema.safeParse(request.params['grantId']);
    if (!intentId.success || !grantId.success) throw new BadRequestException();
    const claim = await this.media.admit(token, intentId.data, grantId.data);
    let counted = false;
    let measurement: StoredObjectMeasurement | undefined;
    let fileWrites: Promise<StoredObjectMeasurement> | undefined;
    let wire: Promise<void> | undefined;
    let wireBytes = 0;
    let wireComplete = false;
    let fileCount = 0;
    let proof: object | undefined;
    const abort = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let parser: Writable | undefined;
    const terminate = () => {
      abort.abort();
      // Terminate the whole request, not just its file part. A destroyed socket
      // may have no JSON error response; it still cannot become observed.
      request.destroy(new Error('MEDIA_UPLOAD_TERMINATED'));
    };
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(terminate, 15_000);
      idleTimer.unref();
    };
    const onAborted = () => abort.abort();
    try {
      if (!this.storage || this.admission.active >= 2)
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      this.admission.active++;
      counted = true;
      if (Object.keys(request.query).length || request.url.includes('?'))
        throw new BadRequestException();
      const contentType = request.headers['content-type'];
      if (
        typeof contentType !== 'string' ||
        contentType.length > 1024 ||
        !/^multipart\/form-data(?:;|$)/i.test(contentType)
      )
        throw new UnsupportedMediaTypeException();
      if (
        request.rawHeaders.reduce(
          (bytes, value) => bytes + Buffer.byteLength(value),
          0,
        ) >
        16 * 1024
      )
        throw new PayloadTooLargeException();
      const length = request.headers['content-length'];
      if (
        length !== undefined &&
        (!/^[0-9]+$/.test(length) || Number(length) > WIRE_LIMIT)
      )
        throw new PayloadTooLargeException();
      const remaining = Math.min(120_000, claim.writerDeadline - Date.now());
      if (remaining <= 0) throw new ApplicationError('MEDIA_UNAVAILABLE');
      totalTimer = setTimeout(terminate, remaining);
      totalTimer.unref();
      resetIdle();
      request.once('aborted', onAborted);
      const storage = this.storage;
      const options: MulterOptions & {
        highWaterMark: number;
        fileHwm: number;
        streamHandler(req: Request, multipart: Writable): void;
      } = {
        preservePath: false,
        highWaterMark: 16 * 1024,
        fileHwm: 16 * 1024,
        limits: {
          files: 1,
          fields: 0,
          parts: 1,
          fileSize: MEDIA_MAX_INPUT_BYTES,
          fieldNameSize: 16,
          fieldSize: 0,
        },
        // Locked busboy 1.6.0 hard-caps each part header at 16 KiB and
        // stores at most its fixed 2000 header pairs. Its documented
        // headerPairs option is not honored; do not claim a 16-pair cap.
        fileFilter: (_req, file, callback) =>
          callback(
            file.mimetype === claim.expectedMime
              ? null
              : new UnsupportedMediaTypeException(),
            file.mimetype === claim.expectedMime,
          ),
        storage: {
          _handleFile: (
            _req: Request,
            file: MulterFile,
            callback: (error: Error | null, info?: { size: number }) => void,
          ) => {
            fileCount++;
            if (fileCount !== 1) {
              callback(new BadRequestException());
              return;
            }
            fileWrites = storage.write(claim, file.stream, abort.signal);
            void fileWrites.then(
              (value) => {
                measurement = value;
                callback(null, { size: value.bytes });
              },
              (error: unknown) => {
                callback(
                  error instanceof Error
                    ? error
                    : new Error('MEDIA_UPLOAD_FAILED'),
                );
                terminate();
              },
            );
          },
          // Multer calls this on a parser error AFTER file storage. Do not delete
          // the immutable shared destination. The finally block stops the exact
          // writer and deletes only its durable request-owned scratch.
          _removeFile: (
            _req: Request,
            _file: MulterFile,
            callback: (error: Error | null) => void,
          ) => callback(null),
        },
        streamHandler: (req, multipart) => {
          parser = multipart;
          const budget = new Transform({
            highWaterMark: 16 * 1024,
            transform(chunk: Buffer, _encoding, callback) {
              wireBytes += chunk.length;
              resetIdle();
              callback(
                wireBytes > WIRE_LIMIT ? new PayloadTooLargeException() : null,
                chunk,
              );
            },
          });
          wire = pipeline(req, budget, multipart).then(() => {
            wireComplete = true;
          });
          // Attach immediately: an early parser error may reject before Nest's
          // middleware callback resolves. Awaited again before success/finally.
          void wire.catch(() => {
            abort.abort();
          });
        },
      };
      const NativeMultipart = FileInterceptor('file', options);
      const native = new NativeMultipart();
      const observable = await native.intercept(context, {
        handle: () =>
          defer(async () => {
            await wire;
            if (
              !wireComplete ||
              !request.complete ||
              !request.readableEnded ||
              fileCount !== 1 ||
              !measurement ||
              measurement.bytes !== claim.expectedBytes ||
              measurement.sha256 !== claim.expectedSha256 ||
              abort.signal.aborted ||
              Date.now() >= claim.writerDeadline
            )
              throw new BadRequestException();
            proof = await storage.quiesce(claim);
            const observed = await this.media.observe(
              token,
              claim,
              measurement,
            );
            results.set(request, observed);
            return lastValueFrom(next.handle());
          }),
      });
      return await lastValueFrom(observable);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      request.removeListener('aborted', onAborted);
      abort.abort();
      // These waits, not abort/lease expiry, retain the IO slot until our actual
      // parser and writer finish. A non-cooperating provider keeps it occupied.
      parser?.destroy();
      await wire?.catch(() => undefined);
      await fileWrites?.catch(() => undefined);
      let scratchAbsent = false;
      if (this.storage) {
        proof ??= await this.storage.quiesce(claim).catch(() => undefined);
        if (proof)
          scratchAbsent = await this.storage.removeScratch(claim).then(
            () => true,
            () => false,
          );
      }
      await this.media
        .retire(claim, proof, Math.min(wireBytes, WIRE_LIMIT + 64 * 1024))
        .catch(() => undefined);
      // Unknown writers or failed scratch deletion keep their bounded slot.
      if (counted && proof && scratchAbsent) this.admission.active--;
      results.delete(request);
    }
  }
}

/** Same Multer engine; only the DI application is version-controlled. */
@Injectable()
export class MediaMultipartInterceptorV3 extends MediaMultipartInterceptor {
  constructor(
    @Inject(MEDIA_BATCH_APPLICATION) media: MediaBatchApplication,
    @Inject(MEDIA_INGRESS_STORAGE) storage: MediaIngressStorage | null,
  ) {
    super(media, storage);
  }
}

/** V4 uses the same storage-keyed process admission and single-file parser. */
@Injectable()
export class MediaMultipartInterceptorV4 extends MediaMultipartInterceptor {
  constructor(
    @Inject(MEDIA_DISCUSSION_BATCH_APPLICATION)
    media: MediaDiscussionBatchApplication,
    @Inject(MEDIA_INGRESS_STORAGE) storage: MediaIngressStorage | null,
  ) {
    super(media, storage);
  }
}
