import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('icon compression preserves every RGBA pixel and never enlarges or repairs unknown input', () => {
  const module = pathToFileURL(
    path.join(__dirname, '../scripts/lossless-icon-png.mjs'),
  ).href;
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import sharp from 'sharp';
    import { losslessIconPng } from ${JSON.stringify(module)};
    const pixels = Buffer.alloc(64 * 64 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 36; pixels[i + 1] = 58; pixels[i + 2] = 80;
      pixels[i + 3] = (i / 4 * 17) % 256;
    }
    const original = await sharp(pixels, {raw:{width:64,height:64,channels:4}})
      .png({compressionLevel:0}).toBuffer();
    const compressed = await losslessIconPng(original);
    assert.ok(compressed.length < original.length);
    const decoded = await sharp(compressed).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(decoded.info.width, 64); assert.equal(decoded.info.height, 64);
    assert.equal(decoded.info.channels, 4); assert.deepEqual(decoded.data, pixels);
    const again = await losslessIconPng(compressed);
    assert.ok(again.length <= compressed.length);
    assert.deepEqual(await sharp(again).ensureAlpha().raw().toBuffer(), pixels);
    const flat = Buffer.alloc(96 * 96 * 4);
    for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 4;
      flat[i] = x < 48 ? 10 : 220; flat[i+1] = 90; flat[i+2] = 180;
      flat[i+3] = (x + y) % 7 === 0 ? 0 : (x + y) % 3 === 0 ? 127 : 255;
    }
    const flatPng = await sharp(flat, {raw:{width:96,height:96,channels:4}})
      .png({compressionLevel:0}).toBuffer();
    const indexed = await losslessIconPng(flatPng);
    assert.equal(indexed[25], 3, 'exact low-colour fixture uses PNG indexed colour');
    assert.deepEqual(await sharp(indexed).ensureAlpha().raw().toBuffer(), flat,
      'transparent RGB and partial alpha are preserved exactly');
    const varied = Buffer.from(flat);
    for(let i=0;i<varied.length;i+=4) { varied[i] = (i/4)%256; varied[i+1] = Math.floor(i/1024)%256; }
    const variedPng = await sharp(varied, {raw:{width:96,height:96,channels:4}})
      .png({compressionLevel:0}).toBuffer();
    assert.deepEqual(await sharp(await losslessIconPng(variedPng)).ensureAlpha().raw().toBuffer(), varied,
      'more than 256 exact colours cannot be quantized');
    for (const invalid of [Buffer.from('not a PNG'), Buffer.from('89504e470d0a1a0a', 'hex')])
      assert.equal(await losslessIconPng(invalid), invalid);
    console.log('pixel-identical');
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.match(output, /pixel-identical/);
});
