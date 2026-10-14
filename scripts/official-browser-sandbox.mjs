import assert from 'node:assert/strict';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** Read-only use of the runner's existing vendor sandbox. No installation,
 * permissions, AppArmor, sysctl or Chromium sandbox flags are changed. */
export async function verifyOfficialSandboxHelper() {
  const helper = process.env.WHALEU_OFFICIAL_SANDBOX_HELPER;
  assert.equal(helper, '/opt/google/chrome/chrome-sandbox');
  assert.notEqual(
    process.geteuid?.(),
    0,
    'Sandboxed Chromium must run as non-root',
  );
  for (const directory of ['/', '/opt', '/opt/google', '/opt/google/chrome']) {
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(info.uid, 0, 'Vendor sandbox parent must be root-owned');
    assert.equal(
      info.mode & 0o022,
      0,
      'Vendor sandbox parent must not be writable by group/others',
    );
  }
  assert.equal(
    await realpath(helper),
    helper,
    'Sandbox helper must have its exact vendor path',
  );
  const info = await lstat(helper);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.equal(info.uid, 0, 'Sandbox helper must already be root-owned');
  assert.equal(
    info.mode & 0o7777,
    0o4755,
    'Sandbox helper must already have vendor4755 mode',
  );
  const chrome = '/opt/google/chrome/chrome';
  assert.equal(await realpath(chrome), chrome);
  const browserInfo = await lstat(chrome);
  assert.ok(browserInfo.isFile() && !browserInfo.isSymbolicLink());
  assert.equal(browserInfo.uid, 0);
  assert.equal(browserInfo.mode & 0o022, 0);
  const version = execFileSync(chrome, ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
  }).trim();
  assert.match(version, /^Google Chrome [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/);
  const sha256 = createHash('sha256')
    .update(await readFile(helper))
    .digest('hex');
  console.log(
    JSON.stringify({
      officialExistingSandbox: {
        helper,
        uid: info.uid,
        gid: info.gid,
        mode: (info.mode & 0o7777).toString(8),
        sha256,
        installedChrome: version,
        processEuid: process.geteuid?.(),
      },
    }),
  );
  return helper;
}
