import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const out = path.join(root, 'dist');
await rm(out, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    '--project',
    path.join(root, 'tsconfig.json'),
  ],
  { stdio: 'inherit' },
);
async function copyAssets(directory, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const from = path.join(directory, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyAssets(from, to);
    else if (/\.(json|wxml|wxss)$/.test(entry.name)) await cp(from, to);
  }
}
await copyAssets(path.join(root, 'src'), out);

// TypeScript emits CommonJS, not an npm bundle. Ship the vetted browser-only
// implementation under a relative Mini Program path (never Node's crypto entry).
const cryptoModule = path.join(out, 'community/view-contract.js');
const compiled = await readFile(cryptoModule, 'utf8');
if (!compiled.includes('require("js-sha256")'))
  throw new Error('Missing native SHA-256 import');
await writeFile(
  cryptoModule,
  compiled.replace('require("js-sha256")', 'require("../vendor/sha256")'),
);
await mkdir(path.join(out, 'vendor'), { recursive: true });
await cp(
  require.resolve('js-sha256/build/sha256.cjs'),
  path.join(out, 'vendor/sha256.js'),
);
await cp(
  path.join(
    path.dirname(require.resolve('js-sha256/package.json')),
    'LICENSE.txt',
  ),
  path.join(out, 'vendor/js-sha256-LICENSE.txt'),
);

execFileSync(process.execPath, [path.join(root, 'scripts/smoke-build.mjs')], {
  stdio: 'inherit',
});
