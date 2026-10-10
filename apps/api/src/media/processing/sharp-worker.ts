/** Isolated executable, never imported by API request handling. No credentials,
 * provider clients, database connections, arbitrary filenames or remote URLs. */
import {
  MEDIA_MAX_INPUT_BYTES,
  MEDIA_MAX_OUTPUT_BYTES,
  MEDIA_MAX_PIXELS,
  mediaMimeSchema,
} from '../contracts.js';
import { assertLinuxProcessingBoundary } from './linux-boundary.js';
import { MediaProcessingError, sha256 } from './protocol.js';

type Metadata = {
  format?: string;
  width?: number;
  height?: number;
  pages?: number;
  channels?: number;
  orientation?: number;
};
type Output = {
  data: Buffer;
  info: { width: number; height: number; channels: number };
};
interface SharpImage {
  metadata(): Promise<Metadata>;
  rotate(): SharpImage;
  toColourspace(space: string): SharpImage;
  raw(): SharpImage;
  resize(options: {
    width: number;
    height: number;
    fit: 'inside';
    withoutEnlargement: true;
  }): SharpImage;
  jpeg(options: { quality: number; chromaSubsampling: string }): SharpImage;
  png(options: {
    compressionLevel: number;
    adaptiveFiltering: boolean;
    palette: false;
  }): SharpImage;
  toBuffer(options: { resolveWithObject: true }): Promise<Output>;
}
interface SharpFactory {
  (input: Buffer, options: Record<string, unknown>): SharpImage;
  cache(enabled: false): unknown;
  concurrency(threads: number): unknown;
}
const rejectInput = () => new MediaProcessingError('MEDIA_INPUT_REJECTED');

// APNG may otherwise be exposed by a PNG decoder as only its first frame.
function rejectAnimatedPng(bytes: Buffer): void {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (
      size > bytes.length - offset - 12 ||
      ['acTL', 'fcTL', 'fdAT'].includes(type)
    )
      throw rejectInput();
    offset += size + 12;
    if (type === 'IEND') {
      if (offset !== bytes.length) throw rejectInput();
      return;
    }
  }
  throw rejectInput();
}
// Reject MPO/concatenated JPEG instead of silently selecting its first image.
function rejectMultipleJpeg(bytes: Buffer): void {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw rejectInput();
  let offset = 2;
  let entropy = false;
  while (offset < bytes.length) {
    if (entropy) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
    }
    if (bytes[offset++] !== 0xff) throw rejectInput();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) throw rejectInput();
    if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)))
      continue;
    if (marker === 0xd9) {
      if (offset !== bytes.length) throw rejectInput();
      return;
    }
    if (marker === 0xd8 || marker === 0 || offset + 2 > bytes.length)
      throw rejectInput();
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || size > bytes.length - offset) throw rejectInput();
    if (
      marker === 0xe2 &&
      bytes.toString('ascii', offset + 2, offset + 6) === 'MPF\0'
    )
      throw rejectInput();
    offset += size;
    entropy = marker === 0xda;
  }
  throw rejectInput();
}
async function main(): Promise<void> {
  const fixtureDigest =
    process.argv[3] === '--registered-synthetic-fixture'
      ? process.argv[4]
      : undefined;
  if (fixtureDigest !== undefined && !/^[a-f0-9]{64}$/.test(fixtureDigest))
    throw rejectInput();
  if (fixtureDigest === undefined) await assertLinuxProcessingBoundary();
  const expectedMime = mediaMimeSchema.parse(process.argv[2]);
  const boundedInput = Buffer.allocUnsafe(MEDIA_MAX_INPUT_BYTES);
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    if (bytes.length > MEDIA_MAX_INPUT_BYTES - length) throw rejectInput();
    boundedInput.set(bytes, length);
    length += bytes.length;
  }
  if (!length) throw rejectInput();
  const input = boundedInput.subarray(0, length);
  // Synthetic mode is trusted test data only; never decode an unregistered digest.
  if (fixtureDigest !== undefined && sha256(input) !== fixtureDigest)
    throw rejectInput();
  let sharp: SharpFactory;
  try {
    // Deliberately optional until an approved pinned dependency is installed.
    // A variable specifier avoids inventing a declaration for an absent module.
    const packageName = 'sharp';
    const imported: unknown = await import(packageName);
    sharp = (imported as { default: SharpFactory }).default;
    if (typeof sharp !== 'function') throw new Error('unavailable');
  } catch {
    throw new MediaProcessingError('MEDIA_PROCESSOR_UNAVAILABLE');
  }
  sharp.cache(false);
  sharp.concurrency(1);

  const options = {
    failOn: 'warning',
    limitInputPixels: MEDIA_MAX_PIXELS,
    limitInputChannels: 4,
    sequentialRead: true,
    unlimited: false,
  };
  const metadata = await sharp(input, options).metadata();
  const mime =
    metadata.format === 'jpeg'
      ? 'image/jpeg'
      : metadata.format === 'png'
        ? 'image/png'
        : null;
  if (
    mime !== expectedMime ||
    !metadata.width ||
    !metadata.height ||
    metadata.width > 8192 ||
    metadata.height > 8192 ||
    metadata.width * metadata.height > MEDIA_MAX_PIXELS ||
    (metadata.pages ?? 1) !== 1 ||
    !metadata.channels ||
    metadata.channels > 4
  )
    throw rejectInput();
  if (mime === 'image/png') rejectAnimatedPng(input);
  else rejectMultipleJpeg(input);
  // Full raw decoding prevents a successful header read or shrink-on-load alone
  // from satisfying the decode gate. All eight EXIF orientations are normalized.
  const raw = await sharp(input, options)
    .rotate()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    raw.info.channels < 1 ||
    raw.info.channels > 4 ||
    raw.info.width * raw.info.height > MEDIA_MAX_PIXELS ||
    Math.max(raw.info.width, raw.info.height) > 8192
  )
    throw rejectInput();
  const variants = [];
  let total = 0;
  for (const [name, edge] of [
    ['thumb-v1', 400],
    ['display-v1', 2048],
  ] as const) {
    let pipeline = sharp(raw.data, {
      raw: {
        width: raw.info.width,
        height: raw.info.height,
        channels: raw.info.channels,
      },
    }).resize({
      width: edge,
      height: edge,
      fit: 'inside',
      withoutEnlargement: true,
    });
    // No keepMetadata/withMetadata: sharp strips EXIF, GPS, XMP and ICC.
    pipeline =
      mime === 'image/jpeg'
        ? pipeline.jpeg({ quality: 85, chromaSubsampling: '4:2:0' })
        : pipeline.png({
            compressionLevel: 9,
            adaptiveFiltering: true,
            palette: false,
          });
    const output = await pipeline.toBuffer({ resolveWithObject: true });
    total += output.data.length;
    if (
      !output.data.length ||
      output.data.length > MEDIA_MAX_INPUT_BYTES ||
      total > MEDIA_MAX_OUTPUT_BYTES
    )
      throw new MediaProcessingError('MEDIA_OUTPUT_REJECTED');
    variants.push({
      name,
      sha256: sha256(output.data),
      bytes: output.data.length,
      mime,
      width: output.info.width,
      height: output.info.height,
      data: output.data.toString('base64'),
    });
  }
  process.stdout.write(
    JSON.stringify({
      original: {
        sha256: sha256(input),
        bytes: length,
        mime,
        width: metadata.width,
        height: metadata.height,
      },
      variants,
    }),
  );
}
void main().catch((error: unknown) => {
  // Fixed exit codes only. Never return raw native errors or image metadata.
  process.exitCode =
    error instanceof MediaProcessingError &&
    error.code === 'MEDIA_PROCESSOR_UNAVAILABLE'
      ? 78
      : error instanceof MediaProcessingError &&
          error.code === 'MEDIA_OUTPUT_REJECTED'
        ? 66
        : 65;
  process.stdin.destroy();
});
