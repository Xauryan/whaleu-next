import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import {
  IsolatedSharpProcessor,
  RegisteredSyntheticSharpProcessor,
} from '../src/media/processing/isolated-sharp.js';
import {
  MediaProcessingError,
  parseWorkerResult,
  sha256,
} from '../src/media/processing/protocol.js';
import { sealProcessedManifest } from '../src/media/processing/processed-manifest.js';
import type { ExactObject } from '../src/media/contracts.js';

const originalBytes = Buffer.from(
  'synthetic-protocol-source-not-a-decoder-fixture',
);
function envelope() {
  const image = (data: Buffer, width: number, height: number) => ({
    sha256: sha256(data),
    bytes: data.length,
    mime: 'image/png' as const,
    width,
    height,
  });
  const thumb = Buffer.from('protocol-thumb');
  const display = Buffer.from('protocol-display');
  return {
    original: image(originalBytes, 800, 600),
    variants: [
      {
        ...image(thumb, 400, 300),
        name: 'thumb-v1' as const,
        data: thumb.toString('base64'),
      },
      {
        ...image(display, 800, 600),
        name: 'display-v1' as const,
        data: display.toString('base64'),
      },
    ],
  };
}
const source = {
  bytes: originalBytes.length,
  sha256: sha256(originalBytes),
  mime: 'image/png',
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
function object(key: string): ExactObject {
  return {
    provider: 'local-fixture',
    environment: 'synthetic',
    bucket: 'synthetic',
    key,
    version: 'v1',
  };
}
test('production processor without hard resource launcher fails closed before reading', async () => {
  const stream = Readable.from([Buffer.from('not decoded')]);
  await assert.rejects(
    new IsolatedSharpProcessor().process(stream, 'image/png'),
    (error: unknown) =>
      error instanceof MediaProcessingError &&
      error.code === 'MEDIA_PROCESSOR_UNAVAILABLE',
  );
  stream.destroy();
});
test('synthetic processor refuses unregistered bytes before spawning sharp', async () => {
  const processor = new RegisteredSyntheticSharpProcessor([
    sha256(Buffer.from('registered')),
  ]);
  await assert.rejects(
    processor.process(
      Readable.from([Buffer.from('unregistered')]),
      'image/png',
    ),
    (error: unknown) =>
      error instanceof MediaProcessingError &&
      error.code === 'MEDIA_INPUT_REJECTED',
  );
});
test('synthetic registration is copied and cannot be expanded by caller mutation', async () => {
  const digests = [sha256(Buffer.from('registered'))];
  const processor = new RegisteredSyntheticSharpProcessor(digests);
  digests.push(sha256(Buffer.from('unregistered')));
  await assert.rejects(
    processor.process(
      Readable.from([Buffer.from('unregistered')]),
      'image/png',
    ),
    { message: 'MEDIA_INPUT_REJECTED' },
  );
});
test('protocol byte hashes and ordered dimensions are independently validated (not decoder acceptance)', () => {
  const parsed = parseWorkerResult(encode(envelope()), source);
  assert.equal(parsed.variants[0].data.toString(), 'protocol-thumb');
  for (const mutate of [
    (value: ReturnType<typeof envelope>) => {
      value.original.sha256 = '0'.repeat(64);
    },
    (value: ReturnType<typeof envelope>) => {
      value.variants[0]!.sha256 = '0'.repeat(64);
    },
    (value: ReturnType<typeof envelope>) => {
      value.variants[0]!.width = 401;
    },
    (value: ReturnType<typeof envelope>) => {
      value.variants.reverse();
    },
    (value: ReturnType<typeof envelope>) => {
      value.variants[1]!.bytes++;
    },
  ]) {
    const value = envelope();
    mutate(value);
    assert.throws(() => parseWorkerResult(encode(value), source));
  }
});
test('manifest binds actual output measurements and refuses postprocessing mutation', () => {
  const parsed = parseWorkerResult(encode(envelope()), source);
  const stored = parsed.variants.map((variant) => ({
    object: object(variant.name),
    bytes: variant.bytes,
    sha256: variant.sha256,
  }));
  const sealed = sealProcessedManifest(parsed, object('source'), [
    stored[0]!,
    stored[1]!,
  ]);
  assert.equal(
    sealed.manifest.variants[0].sha256,
    sha256(parsed.variants[0].data),
  );
  parsed.variants[0].data[0] = 0;
  assert.throws(() =>
    sealProcessedManifest(parsed, object('source'), [stored[0]!, stored[1]!]),
  );
});
// These real-decoder tests are mandatory. Missing sharp is a test failure,
// not a skip or a fake-success decoder. Authoring does not imply execution.
interface FixtureMetadata {
  format?: string;
  width?: number;
  height?: number;
  channels?: number;
  exif?: Buffer;
  icc?: Buffer;
  xmp?: Buffer;
  iptc?: Buffer;
  orientation?: number;
  isPalette?: boolean;
}
interface FixturePixels {
  data: Buffer;
  info: { width: number; height: number; channels: number };
}
interface FixtureSharpImage {
  png(options?: {
    compressionLevel?: number;
    adaptiveFiltering?: boolean;
    palette?: boolean;
    colours?: number;
    dither?: number;
  }): FixtureSharpImage;
  jpeg(options?: {
    quality?: number;
    chromaSubsampling?: string;
  }): FixtureSharpImage;
  withMetadata(options: { orientation: number }): FixtureSharpImage;
  withExif(exif: Record<string, Record<string, string>>): FixtureSharpImage;
  withXmp(xmp: string): FixtureSharpImage;
  rotate(): FixtureSharpImage;
  toColourspace(space: string): FixtureSharpImage;
  raw(): FixtureSharpImage;
  resize(options: {
    width: number;
    height: number;
    fit: 'inside';
    withoutEnlargement: true;
  }): FixtureSharpImage;
  toBuffer(): Promise<Buffer>;
  toBuffer(options: { resolveWithObject: true }): Promise<FixturePixels>;
  metadata(): Promise<FixtureMetadata>;
}
type FixtureSharp = (
  input:
    | Buffer
    | {
        create: {
          width: number;
          height: number;
          channels: 3 | 4;
          background: { r: number; g: number; b: number; alpha?: number };
        };
      },
  options?: {
    raw?: { width: number; height: number; channels: 3 | 4 };
    failOn?: 'warning';
  },
) => FixtureSharpImage;
type FixtureMime = 'image/jpeg' | 'image/png';
async function realSharp(): Promise<FixtureSharp> {
  const packageName = 'sharp';
  const loaded: unknown = await import(packageName);
  return (loaded as { default: FixtureSharp }).default;
}
async function processFixture(bytes: Buffer, mime: FixtureMime) {
  return new RegisteredSyntheticSharpProcessor([sha256(bytes)]).process(
    Readable.from([bytes]),
    mime,
  );
}
async function rejectFixture(
  bytes: Buffer,
  mime: FixtureMime,
  code:
    'MEDIA_INPUT_REJECTED' | 'MEDIA_OUTPUT_REJECTED' = 'MEDIA_INPUT_REJECTED',
) {
  await assert.rejects(processFixture(bytes, mime), { message: code });
}
async function solidFixture(
  sharp: FixtureSharp,
  width: number,
  height: number,
  mime: FixtureMime,
  color = { r: 20, g: 80, b: 160 },
) {
  const created = sharp({
    create: { width, height, channels: 3, background: color },
  });
  return await (
    mime === 'image/jpeg' ? created.jpeg() : created.png()
  ).toBuffer();
}
const cornerColors = [
  [220, 30, 30],
  [30, 220, 30],
  [30, 30, 220],
  [220, 220, 30],
] as const;
function quadrantPixels(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color =
        cornerColors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)]!;
      pixels.set(color, (y * width + x) * 3);
    }
  }
  return pixels;
}
function assertOrientedCorners(
  decoded: FixturePixels,
  order: readonly number[],
): void {
  assert.equal(decoded.info.channels, 3);
  const { width, height } = decoded.info;
  for (const [corner, [x, y]] of [
    [Math.floor(width / 4), Math.floor(height / 4)],
    [Math.floor((3 * width) / 4), Math.floor(height / 4)],
    [Math.floor(width / 4), Math.floor((3 * height) / 4)],
    [Math.floor((3 * width) / 4), Math.floor((3 * height) / 4)],
  ].entries()) {
    const expected = cornerColors[order[corner]!]!;
    for (let channel = 0; channel < 3; channel++) {
      const actual = decoded.data[(y! * width + x!) * 3 + channel]!;
      assert.ok(
        Math.abs(actual - expected[channel]!) <= 15,
        `orientation corner ${corner}, channel ${channel}: ${actual} versus ${expected[channel]}`,
      );
    }
  }
}

function hasGpsExif(exif: Buffer): boolean {
  const offset = exif.subarray(0, 6).equals(Buffer.from('Exif\0\0')) ? 6 : 0;
  const tiff = exif.subarray(offset);
  const little = tiff.toString('ascii', 0, 2) === 'II';
  const u16 = (position: number) =>
    little ? tiff.readUInt16LE(position) : tiff.readUInt16BE(position);
  const u32 = (position: number) =>
    little ? tiff.readUInt32LE(position) : tiff.readUInt32BE(position);
  const ifd = u32(4);
  for (let index = 0; index < u16(ifd); index++) {
    const entry = ifd + 2 + index * 12;
    if (u16(entry) !== 0x8825) continue;
    const gps = u32(entry + 8);
    const tags = new Set<number>();
    for (let gpsIndex = 0; gpsIndex < u16(gps); gpsIndex++)
      tags.add(u16(gps + 2 + gpsIndex * 12));
    return [1, 2, 3, 4].every((tag) => tags.has(tag));
  }
  return false;
}

test('real sharp fully decodes JPEG/PNG, all eight EXIF orientations, and strips GPS/EXIF/ICC/XMP', async () => {
  const sharp = await realSharp();
  const orders = [
    [0, 1, 2, 3],
    [1, 0, 3, 2],
    [3, 2, 1, 0],
    [2, 3, 0, 1],
    [0, 2, 1, 3],
    [2, 0, 3, 1],
    [3, 1, 2, 0],
    [1, 3, 0, 2],
  ];
  for (const mime of ['image/jpeg', 'image/png'] as const) {
    for (let orientation = 1; orientation <= 8; orientation++) {
      const created = sharp(quadrantPixels(96, 64), {
        raw: { width: 96, height: 64, channels: 3 },
      });
      const fixture = await (
        mime === 'image/jpeg' ? created.jpeg({ quality: 95 }) : created.png()
      )
        .withExif({
          IFD0: { Copyright: 'SYNTHETIC-GPS-ONLY' },
          IFD3: {
            GPSLatitudeRef: 'N',
            GPSLatitude: '0/1 0/1 0/1',
            GPSLongitudeRef: 'E',
            GPSLongitude: '0/1 0/1 0/1',
          },
        })
        .withMetadata({ orientation })
        .withXmp(
          '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" dc:description="synthetic-only"/></rdf:RDF></x:xmpmeta>',
        )
        .toBuffer();
      const before = await sharp(fixture).metadata();
      assert.equal(before.orientation, orientation);
      assert.ok(before.exif?.includes(Buffer.from('SYNTHETIC-GPS-ONLY')));
      assert.ok(
        before.exif && hasGpsExif(before.exif),
        'fixture must actually contain GPS tags',
      );
      assert.ok(before.icc?.length);
      assert.ok(before.xmp?.length);
      // Actual compressed bytes and both reencoded variants must completely decode.
      await sharp(fixture, { failOn: 'warning' }).raw().toBuffer();
      const processed = await processFixture(fixture, mime);
      assert.equal(processed.original.sha256, sha256(fixture));
      assert.equal(processed.original.bytes, fixture.length);
      for (const variant of processed.variants) {
        const metadata = await sharp(variant.data).metadata();
        assert.equal(metadata.exif, undefined);
        assert.equal(metadata.icc, undefined);
        assert.equal(metadata.xmp, undefined);
        assert.equal(metadata.iptc, undefined);
        assert.equal(metadata.orientation, undefined);
        assert.deepEqual(
          [metadata.width, metadata.height],
          orientation >= 5 ? [64, 96] : [96, 64],
        );
        const decoded = await sharp(variant.data, { failOn: 'warning' })
          .raw()
          .toBuffer({ resolveWithObject: true });
        assert.equal(
          decoded.data.length,
          decoded.info.width * decoded.info.height * 3,
        );
        assertOrientedCorners(decoded, orders[orientation - 1]!);
      }
    }
  }
});

test('real sharp enforces thumb400/display2048, no upscaling, stable exact-byte hashes and manifest measurements', async () => {
  const sharp = await realSharp();
  for (const mime of ['image/jpeg', 'image/png'] as const) {
    for (const [width, height, expected] of [
      [
        4096,
        2048,
        [
          [400, 200],
          [2048, 1024],
        ],
      ],
      [
        1024,
        4096,
        [
          [100, 400],
          [512, 2048],
        ],
      ],
      [
        31,
        17,
        [
          [31, 17],
          [31, 17],
        ],
      ],
    ] as const) {
      const fixture = await solidFixture(sharp, width, height, mime);
      const processed = await processFixture(fixture, mime);
      assert.deepEqual(
        processed.variants.map((variant) => [variant.width, variant.height]),
        expected,
      );
      const stored = processed.variants.map((variant) => ({
        object: object(
          `${mime === 'image/png' ? 'png' : 'jpeg'}-${width}-${variant.name}`,
        ),
        sha256: sha256(variant.data),
        bytes: variant.data.length,
      }));
      const sealed = sealProcessedManifest(
        processed,
        object(`source-${width}-${height}`),
        [stored[0]!, stored[1]!],
      );
      for (const [index, variant] of processed.variants.entries()) {
        const decoded = await sharp(variant.data, { failOn: 'warning' })
          .raw()
          .toBuffer({ resolveWithObject: true });
        assert.deepEqual(
          [decoded.info.width, decoded.info.height],
          expected[index],
        );
        assert.equal(variant.sha256, sha256(variant.data));
        assert.equal(variant.bytes, variant.data.length);
        assert.equal(
          sealed.manifest.variants[index]!.sha256,
          sha256(variant.data),
        );
        assert.ok(variant.bytes <= 5 * 1024 * 1024);
      }
      assert.ok(
        processed.variants.reduce(
          (bytes, variant) => bytes + variant.bytes,
          0,
        ) <=
          10 * 1024 * 1024,
      );
      const repeated = await processFixture(fixture, mime);
      assert.deepEqual(
        repeated.variants.map((variant) => variant.sha256),
        processed.variants.map((variant) => variant.sha256),
      );
    }
  }
});

interface PngChunk {
  readonly type: string;
  readonly data: Buffer;
}
function pngChunks(png: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    chunks.push({
      type: png.toString('ascii', offset + 4, offset + 8),
      data: png.subarray(offset + 8, offset + 8 + length),
    });
    offset += length + 12;
  }
  return chunks;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function animatedPng(first: Buffer, second: Buffer): Buffer {
  const firstChunks = pngChunks(first);
  const secondChunks = pngChunks(second);
  const ihdr = firstChunks.find((chunk) => chunk.type === 'IHDR')!.data;
  assert.deepEqual(
    ihdr,
    secondChunks.find((chunk) => chunk.type === 'IHDR')!.data,
  );
  const control = Buffer.alloc(8);
  control.writeUInt32BE(2, 0);
  const frameControl = (sequence: number) => {
    const frame = Buffer.alloc(26);
    frame.writeUInt32BE(sequence, 0);
    ihdr.copy(frame, 4, 0, 8);
    frame.writeUInt16BE(1, 20);
    frame.writeUInt16BE(10, 22);
    return pngChunk('fcTL', frame);
  };
  const secondSequence = Buffer.alloc(4);
  secondSequence.writeUInt32BE(2);
  return Buffer.concat([
    first.subarray(0, 8),
    pngChunk('IHDR', ihdr),
    pngChunk('acTL', control),
    frameControl(0),
    ...firstChunks
      .filter((chunk) => chunk.type === 'IDAT')
      .map((chunk) => pngChunk('IDAT', chunk.data)),
    frameControl(1),
    pngChunk(
      'fdAT',
      Buffer.concat([
        secondSequence,
        ...secondChunks
          .filter((chunk) => chunk.type === 'IDAT')
          .map((chunk) => chunk.data),
      ]),
    ),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function multiPictureJpeg(first: Buffer, second: Buffer): Buffer {
  // MPF APP2 index with two real sharp-produced JPEG images. Offsets are relative
  // to the TIFF header inside the APP2 segment, per the MPF container format.
  const tiff = Buffer.alloc(82);
  tiff.write('II', 0);
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(3, 8);
  const entry = (
    offset: number,
    tag: number,
    type: number,
    count: number,
    value: number,
  ) => {
    tiff.writeUInt16LE(tag, offset);
    tiff.writeUInt16LE(type, offset + 2);
    tiff.writeUInt32LE(count, offset + 4);
    tiff.writeUInt32LE(value, offset + 8);
  };
  entry(10, 0xb000, 7, 4, 0x30303130); // MPFVersion "0100".
  entry(22, 0xb001, 4, 1, 2);
  entry(34, 0xb002, 7, 32, 50);
  const app2Length = 2 + 2 + 4 + tiff.length;
  const firstSize = first.length + app2Length;
  tiff.writeUInt32LE(0x20030000, 50);
  tiff.writeUInt32LE(firstSize, 54);
  tiff.writeUInt32LE(second.length, 70);
  tiff.writeUInt32LE(firstSize - 10, 74);
  const app2 = Buffer.alloc(app2Length);
  app2[0] = 0xff;
  app2[1] = 0xe2;
  app2.writeUInt16BE(app2Length - 2, 2);
  app2.write('MPF\0', 4);
  tiff.copy(app2, 8);
  return Buffer.concat([first.subarray(0, 2), app2, first.subarray(2), second]);
}

test('real sharp rejects actual truncation, declared MIME mismatch, APNG, MPO and concatenated JPEG', async () => {
  const sharp = await realSharp();
  const png = await solidFixture(sharp, 64, 32, 'image/png');
  const png2 = await solidFixture(sharp, 64, 32, 'image/png', {
    r: 160,
    g: 40,
    b: 10,
  });
  const jpeg = await solidFixture(sharp, 64, 32, 'image/jpeg');
  const jpeg2 = await solidFixture(sharp, 64, 32, 'image/jpeg', {
    r: 160,
    g: 40,
    b: 10,
  });
  for (const [fixture, mime] of [
    [png, 'image/png'],
    [jpeg, 'image/jpeg'],
  ] as const) {
    await sharp(fixture, { failOn: 'warning' }).raw().toBuffer();
    // End truncation and missing compressed pixel data are separate failures.
    await rejectFixture(fixture.subarray(0, fixture.length - 9), mime);
    await rejectFixture(
      fixture.subarray(0, Math.floor(fixture.length / 2)),
      mime,
    );
    await rejectFixture(
      fixture,
      mime === 'image/png' ? 'image/jpeg' : 'image/png',
    );
  }
  const apng = animatedPng(png, png2);
  const mpo = multiPictureJpeg(jpeg, jpeg2);
  // The legacy/default decoder can expose the first picture. Media must refuse
  // the container, rather than interpreting first-picture success as static.
  await sharp(apng).raw().toBuffer();
  await sharp(mpo).raw().toBuffer();
  await rejectFixture(apng, 'image/png');
  await rejectFixture(mpo, 'image/jpeg');
  await rejectFixture(Buffer.concat([jpeg, jpeg2]), 'image/jpeg');
});

test('real sharp rejects over-24MP and over-8192-edge images despite small compressed input', async () => {
  const sharp = await realSharp();
  for (const mime of ['image/jpeg', 'image/png'] as const) {
    for (const [width, height] of [
      [6000, 4001],
      [8193, 1],
    ] as const) {
      const fixture = await solidFixture(sharp, width, height, mime);
      assert.ok(fixture.length < 5 * 1024 * 1024);
      assert.deepEqual(
        await sharp(fixture)
          .metadata()
          .then((metadata) => [metadata.width, metadata.height]),
        [width, height],
      );
      await rejectFixture(fixture, mime);
    }
  }
});

test('real sharp rejects a bounded palette PNG whose actual RGBA display reencode exceeds 5 MiB', async () => {
  const sharp = await realSharp();
  // Fixed PRNG and 256 RGBA colors: indexed source is <=5 MiB, while a full
  // RGBA PNG expands. Assert both measured preconditions instead of assuming
  // a particular encoder size or replacing the decoder/output with a mock.
  let state = 0x48a7c291;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const palette = Buffer.alloc(256 * 4);
  for (let index = 0; index < 256; index++) {
    palette[index * 4] = next() & 255;
    palette[index * 4 + 1] = next() & 255;
    palette[index * 4 + 2] = next() & 255;
    palette[index * 4 + 3] = 128 + (next() & 127);
  }
  const raw = Buffer.alloc(2048 * 2048 * 4);
  for (let pixel = 0; pixel < 2048 * 2048; pixel++) {
    const index = (next() & 255) * 4;
    palette.copy(raw, pixel * 4, index, index + 4);
  }
  const fixture = await sharp(raw, {
    raw: { width: 2048, height: 2048, channels: 4 },
  })
    .png({ palette: true, colours: 256, dither: 0, compressionLevel: 9 })
    .toBuffer();
  const metadata = await sharp(fixture).metadata();
  assert.equal(metadata.isPalette, true);
  assert.equal(metadata.channels, 4);
  assert.ok(
    fixture.length <= 5 * 1024 * 1024,
    `source bytes: ${fixture.length}`,
  );
  const decoded = await sharp(fixture, { failOn: 'warning' })
    .rotate()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const display = await sharp(decoded.data, {
    raw: { width: 2048, height: 2048, channels: 4 },
  })
    .resize({
      width: 2048,
      height: 2048,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png({ palette: false, compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  assert.ok(
    display.length > 5 * 1024 * 1024,
    `display bytes: ${display.length}`,
  );
  await rejectFixture(fixture, 'image/png', 'MEDIA_OUTPUT_REJECTED');
});

// Dedicated production resource acceptance is tracked in docs/MEDIA_FOUNDATION.md:
// native-memory pressure, watchdog, bounded temp storage and process cleanup.
// Trusted fixtures provide no evidence of hostile-input isolation.

test('synthetic source limit rejects excessive actual bytes without decoder startup', async () => {
  const processor = new RegisteredSyntheticSharpProcessor([
    sha256(Buffer.from('registered')),
  ]);
  await assert.rejects(
    processor.process(
      Readable.from([Buffer.alloc(5 * 1024 * 1024 + 1)]),
      'image/png',
    ),
    { message: 'MEDIA_INPUT_REJECTED' },
  );
});
