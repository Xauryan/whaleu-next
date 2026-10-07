import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
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

execFileSync(process.execPath, [path.join(root, 'scripts/smoke-build.mjs')], {
  stdio: 'inherit',
});
