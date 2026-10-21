/** Rebuild native Mini Program icons from original vector sources. */
import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const root = path.dirname(fileURLToPath(import.meta.url));
const names = (await readdir(path.join(root, 'source')))
  .filter((file) => file.endsWith('.svg'))
  .map((file) => file.slice(0, -4))
  .sort();
const tones = {
  light: '#1d1d1f',
  dark: '#f5f5f7',
  accent: '#007aff',
  blue: '#007aff',
  orange: '#f28b00',
  purple: '#af52de',
  green: '#248a3d',
  pink: '#e94b78',
  coral: '#ff6570',
  socialblue: '#3e8bff',
  mint: '#32cc98',
  white: '#ffffff',
  muted: '#8e8e93',
};
for (const [tone, color] of Object.entries(tones)) {
  await mkdir(path.join(root, tone), { recursive: true });
  for (const name of names) {
    const source = await readFile(
      path.join(root, 'source', `${name}.svg`),
      'utf8',
    );
    await sharp(
      Buffer.from(source.replace('color="#1d1d1f"', `color="${color}"`)),
      { density: 216 },
    )
      .resize(72, 72)
      .png({ compressionLevel: 9, palette: true })
      .toFile(path.join(root, tone, `${name}.png`));
  }
}
await writeFile(
  path.join(root, 'manifest.json'),
  JSON.stringify(
    {
      design: 'WhaleU original rounded-line icon system',
      grid: 24,
      nativePixels: 72,
      stroke: 1.7,
      names,
      tones,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Generated ${names.length} icons × ${Object.keys(tones).length} tones at 3×.`,
);
