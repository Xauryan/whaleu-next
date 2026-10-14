import { verifyOfficialSandboxHelper } from './official-browser-sandbox.mjs';
import { createRequire } from 'node:module';
import { readFileSync, createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const packagePath = require.resolve('playwright-core/package.json');
const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
if (manifest.version !== '1.58.2')
  throw Error('Official browser package version mismatch');
const browsers = JSON.parse(
  readFileSync(join(dirname(packagePath), 'browsers.json'), 'utf8'),
);
const expected = browsers.browsers.find((b) => b.name === 'chromium');
if (!expected?.browserVersion || !expected.revision)
  throw Error('Pinned Chromium metadata missing');
const { chromium } = require('playwright-core');
const executable = chromium.executablePath(),
  actual = execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
  }).trim();
if (!actual.includes(expected.browserVersion))
  throw Error(`Chromium version mismatch: ${actual}`);
const hash = createHash('sha256');
for await (const chunk of createReadStream(executable)) hash.update(chunk);
console.log(
  JSON.stringify({
    package: 'playwright-core',
    packageVersion: manifest.version,
    revision: expected.revision,
    browserVersion: expected.browserVersion,
    actual,
    executable,
    sha256: hash.digest('hex'),
  }),
);

if (process.env.CI || process.env.WHALEU_OFFICIAL_SANDBOX_HELPER)
  await verifyOfficialSandboxHelper();
