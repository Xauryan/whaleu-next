import sharp from 'sharp';
import { deflateSync } from 'node:zlib';

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
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

/** Exact indexed RGBA encoding, never colour quantization or alpha rounding. */
function indexedPng({ data, info }) {
  if (info.channels !== 4) return null;
  const colors = new Map();
  const rows = Buffer.alloc((info.width + 1) * info.height);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const rgba = data.readUInt32BE((y * info.width + x) * 4);
      if (!colors.has(rgba)) {
        if (colors.size === 256) return null;
        colors.set(rgba, colors.size);
      }
      rows[y * (info.width + 1) + x + 1] = colors.get(rgba);
    }
  }
  const palette = Buffer.alloc(colors.size * 3);
  const alpha = Buffer.alloc(colors.size);
  for (const [rgba, index] of colors) {
    palette[index * 3] = rgba >>> 24;
    palette[index * 3 + 1] = (rgba >>> 16) & 255;
    palette[index * 3 + 2] = (rgba >>> 8) & 255;
    alpha[index] = rgba & 255;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(info.width, 0);
  header.writeUInt32BE(info.height, 4);
  header[8] = 8;
  header[9] = 3;
  const deflated = [deflateSync(rows, { level: 9 })];
  for (const filter of [1, 2]) {
    const filtered = Buffer.from(rows);
    for (let y = 0; y < info.height; y++) {
      filtered[y * (info.width + 1)] = filter;
      for (let x = 0; x < info.width; x++) {
        const offset = y * (info.width + 1) + x + 1;
        const predictor =
          filter === 1
            ? x
              ? rows[offset - 1]
              : 0
            : y
              ? rows[offset - info.width - 1]
              : 0;
        filtered[offset] = (rows[offset] - predictor) & 255;
      }
    }
    for (const strategy of [0, 1, 3])
      deflated.push(deflateSync(filtered, { level: 9, strategy }));
  }
  deflated.sort((a, b) => a.length - b.length);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('PLTE', palette),
    pngChunk('tRNS', alpha),
    pngChunk('IDAT', deflated[0]),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Recompress repository icons only. Never accept a change to a decoded pixel. */
export async function losslessIconPng(original) {
  if (!original.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return original;
  try {
    const decode = (buffer) =>
      sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const before = await decode(original);
    const recompressed = await sharp(original)
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer();
    const candidates = [recompressed, indexedPng(before)]
      .filter((candidate) => candidate && candidate.length < original.length)
      .sort((a, b) => a.length - b.length);
    for (const candidate of candidates) {
      const after = await decode(candidate);
      if (
        before.info.width === after.info.width &&
        before.info.height === after.info.height &&
        before.info.channels === after.info.channels &&
        before.data.equals(after.data)
      )
        return candidate;
    }
    return original;
  } catch {
    // Keep bytes unchanged when recompression/verification cannot be established.
    return original;
  }
}
