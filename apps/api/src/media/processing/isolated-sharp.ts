import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import {
  MEDIA_MAX_INPUT_BYTES,
  mediaDigestSchema,
  mediaMimeSchema,
} from '../contracts.js';
import {
  MediaProcessingError,
  PROCESS_DEADLINE_MS,
  PROCESS_PROTOCOL_BYTES,
  parseWorkerResult,
  sha256,
} from './protocol.js';
import type { ProcessedImage } from './protocol.js';

/** Internal deployment config, NEVER populated from an upload/API request.
 * The launcher execs the supplied Node command in pre-provisioned isolation:
 * <=256 MiB cgroup-v2 memory.max, swap=0, OOM-group kill, private <=32 MiB
 * /media-work tmpfs; read-only code/dependencies, no writable host paths/network.
 * It must preserve the process group, enforce a 10 s external watchdog and
 * clean up the cgroup/mount on success, failure, timeout or parent death.
 * Existing container services may provide it; this module never changes OS
 * security settings. No default launcher is available or silently emulated.
 */
export interface MediaSandboxLauncher {
  readonly executable: string;
  readonly arguments: readonly string[];
}
let active = false;
function killGroup(child: ChildProcess): void {
  try {
    if (process.platform === 'linux' && child.pid !== undefined)
      process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    /* Already gone; exit handling still decides success/failure. */
  }
}
async function execute(
  source: Readable,
  mimeInput: string,
  launcher: MediaSandboxLauncher | undefined,
  fixtureDigests: ReadonlySet<string> | undefined,
): Promise<ProcessedImage> {
  const parsedMime = mediaMimeSchema.safeParse(mimeInput);
  if (!parsedMime.success) {
    source.destroy();
    throw new MediaProcessingError('MEDIA_INPUT_REJECTED');
  }
  const mime = parsedMime.data;
  if (!fixtureDigests && !launcher) {
    source.destroy();
    throw new MediaProcessingError('MEDIA_PROCESSOR_UNAVAILABLE');
  }
  if (active) {
    source.destroy();
    throw new MediaProcessingError('MEDIA_PROCESSOR_BUSY');
  }
  active = true;
  const started = performance.now();
  let child: ChildProcess | undefined;
  let childClosed: Promise<void> | undefined;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    source.destroy();
    if (child) killGroup(child);
    rejectDeadline(new MediaProcessingError('MEDIA_PROCESSING_TIMEOUT'));
  }, PROCESS_DEADLINE_MS);
  const work = async () => {
    const boundedInput = Buffer.allocUnsafe(MEDIA_MAX_INPUT_BYTES);
    let bytes = 0;
    for await (const chunk of source) {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))
        throw new MediaProcessingError('MEDIA_INPUT_REJECTED');
      if (performance.now() - started >= PROCESS_DEADLINE_MS)
        throw new MediaProcessingError('MEDIA_PROCESSING_TIMEOUT');
      if (chunk.length > MEDIA_MAX_INPUT_BYTES - bytes)
        throw new MediaProcessingError('MEDIA_INPUT_REJECTED');
      boundedInput.set(chunk, bytes);
      bytes += chunk.length;
    }
    if (!bytes) throw new MediaProcessingError('MEDIA_INPUT_REJECTED');
    const input = boundedInput.subarray(0, bytes);
    const digest = sha256(input);
    if (fixtureDigests && !fixtureDigests.has(digest))
      throw new MediaProcessingError('MEDIA_INPUT_REJECTED');
    // Never spawn late when the source completed concurrently with expiration.
    if (performance.now() - started >= PROCESS_DEADLINE_MS)
      throw new MediaProcessingError('MEDIA_PROCESSING_TIMEOUT');
    const typescript = import.meta.url.endsWith('.ts');
    const worker = fileURLToPath(
      new URL(
        typescript ? './sharp-worker.ts' : './sharp-worker.js',
        import.meta.url,
      ),
    );
    const nodeArgs = [
      ...(typescript ? ['--import', 'tsx'] : []),
      worker,
      mime,
      ...(fixtureDigests ? ['--registered-synthetic-fixture', digest] : []),
    ];
    child = spawn(
      launcher?.executable ?? process.execPath,
      launcher
        ? [...launcher.arguments, process.execPath, ...nodeArgs]
        : nodeArgs,
      {
        detached: process.platform === 'linux',
        stdio: ['pipe', 'pipe', 'ignore'],
        // Deliberately do not inherit credentials, NODE_OPTIONS or provider config.
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          TMPDIR: fixtureDigests ? '/tmp' : '/media-work',
          UV_THREADPOOL_SIZE: '1',
          VIPS_CONCURRENCY: '1',
        },
      },
    );
    const running = child;
    childClosed = new Promise<void>((resolve) => {
      running.once('close', () => resolve());
    });
    return await new Promise<ProcessedImage>((resolve, reject) => {
      const output: Buffer[] = [];
      let outputBytes = 0;
      let failed = false;
      const fail = (error: Error) => {
        if (!failed) {
          failed = true;
          killGroup(running);
          reject(error);
        }
      };
      running.on('error', () =>
        fail(new MediaProcessingError('MEDIA_PROCESSOR_UNAVAILABLE')),
      );
      running.stdin!.on('error', () => {
        /* A worker rejection may close stdin early. close decides. */
      });
      running.stdout!.on('data', (chunk: Buffer) => {
        if (failed) return;
        outputBytes += chunk.length;
        if (outputBytes > PROCESS_PROTOCOL_BYTES)
          fail(new MediaProcessingError('MEDIA_OUTPUT_REJECTED'));
        else output.push(chunk);
      });
      running.on('close', (code, signal) => {
        if (failed) return;
        try {
          if (performance.now() - started >= PROCESS_DEADLINE_MS)
            throw new MediaProcessingError('MEDIA_PROCESSING_TIMEOUT');
          if (code !== 0 || signal)
            throw new MediaProcessingError(
              code === 78
                ? 'MEDIA_PROCESSOR_UNAVAILABLE'
                : code === 65
                  ? 'MEDIA_INPUT_REJECTED'
                  : code === 66
                    ? 'MEDIA_OUTPUT_REJECTED'
                    : 'MEDIA_PROCESSING_FAILED',
            );
          const result = parseWorkerResult(Buffer.concat(output, outputBytes), {
            bytes,
            sha256: digest,
            mime,
          });
          if (performance.now() - started >= PROCESS_DEADLINE_MS)
            throw new MediaProcessingError('MEDIA_PROCESSING_TIMEOUT');
          resolve(result);
        } catch (error) {
          reject(
            error instanceof MediaProcessingError
              ? error
              : new MediaProcessingError('MEDIA_OUTPUT_REJECTED'),
          );
        }
      });
      running.stdin!.end(input);
    });
  };
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
    if (child) killGroup(child);
    source.destroy();
    try {
      if (childClosed) await childClosed;
    } finally {
      active = false;
    }
  }
}

/** Production/untrusted-input path, fail-closed with no supported launcher. */
export class IsolatedSharpProcessor {
  constructor(private readonly launcher?: MediaSandboxLauncher) {}
  process(source: Readable, mime: string): Promise<ProcessedImage> {
    return execute(source, mime, this.launcher, undefined);
  }
}

/** TEST-ONLY: real decoding correctness for exact registered synthetic bytes.
 * Does NOT certify native RSS/temp-disk containment for hostile uploads. Never
 * register this in AppModule, accept digests from requests, or use user photos.
 * Whitelist and buffers are copied so callers cannot expand authority in place. */
export class RegisteredSyntheticSharpProcessor {
  private readonly digests: ReadonlySet<string>;
  constructor(digests: readonly string[]) {
    if (!digests.length || digests.length > 64)
      throw new MediaProcessingError('MEDIA_PROCESSOR_UNAVAILABLE');
    this.digests = new Set(
      digests.map((digest) => mediaDigestSchema.parse(digest)),
    );
  }
  process(source: Readable, mime: string): Promise<ProcessedImage> {
    return execute(source, mime, undefined, this.digests);
  }
}
