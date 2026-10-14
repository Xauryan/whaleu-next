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

export const OFFICIAL_USERNS_PROFILE = 'ubuntu22-userns-v1';
export const OFFICIAL_USERNS_RETIRE_BEFORE = '2027-03-01T00:00:00Z';

/** Pure admission checks, shared with the lightweight CI contract tests. */
export function assertOfficialUsernsHost(facts) {
  assert.equal(facts.platform, 'linux');
  assert.equal(facts.arch, 'x64');
  assert.equal(facts.osId, 'ubuntu');
  assert.equal(facts.osVersion, '22.04');
  assert.ok(
    Number.isInteger(facts.euid) && facts.euid > 0,
    'Userns browser requires non-root',
  );
  assert.equal(
    facts.helperConfigured,
    false,
    'Userns profile must not inherit a vendor helper',
  );
  assert.equal(
    facts.chromeHelperConfigured,
    false,
    'Userns profile must not inherit CHROME_DEVEL_SANDBOX',
  );
  assert.ok(
    Number.isFinite(facts.now) &&
      facts.now < Date.parse(OFFICIAL_USERNS_RETIRE_BEFORE),
    'Temporary Ubuntu22 browser runner must migrate before 2027-03-01',
  );
}

/** Select an explicitly admitted sandbox without changing any host policy.
 * The vendor helper integrity checks above are deliberately unchanged. */
export async function verifyOfficialBrowserSandbox() {
  const profile = process.env.WHALEU_OFFICIAL_BROWSER_SANDBOX;
  if (profile === undefined || profile === 'vendor-helper-v1')
    return verifyOfficialSandboxHelper();
  assert.equal(
    profile,
    OFFICIAL_USERNS_PROFILE,
    'Unknown official sandbox profile',
  );
  const release = Object.fromEntries(
    (await readFile('/etc/os-release', 'utf8'))
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const split = line.indexOf('=');
        return [
          line.slice(0, split),
          line.slice(split + 1).replace(/^"|"$/g, ''),
        ];
      }),
  );
  const facts = {
    platform: process.platform,
    arch: process.arch,
    osId: release.ID,
    osVersion: release.VERSION_ID,
    euid: process.geteuid?.(),
    now: Date.now(),
    helperConfigured: 'WHALEU_OFFICIAL_SANDBOX_HELPER' in process.env,
    chromeHelperConfigured: 'CHROME_DEVEL_SANDBOX' in process.env,
  };
  assertOfficialUsernsHost(facts);
  const readKernelValue = async (path) => {
    try {
      return (await readFile(path, 'utf8')).trim();
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const kernel = await readKernelValue('/proc/sys/kernel/osrelease');
  const namespaceLimit = await readKernelValue(
    '/proc/sys/user/max_user_namespaces',
  );
  const unprivilegedUserns = await readKernelValue(
    '/proc/sys/kernel/unprivileged_userns_clone',
  );
  const apparmorRestriction = await readKernelValue(
    '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
  );
  assert.ok(kernel && /^\d/.test(kernel));
  assert.ok(
    namespaceLimit &&
      /^\d+$/.test(namespaceLimit) &&
      BigInt(namespaceLimit) > 0n,
  );
  assert.ok(unprivilegedUserns === null || unprivilegedUserns === '1');
  console.log(
    JSON.stringify({
      officialUsernsHost: {
        ...facts,
        kernel,
        namespaceLimit,
        unprivilegedUserns,
        apparmorRestriction,
      },
    }),
  );
  // This creates only a short-lived unprivileged child namespace. It does not
  // write sysctls, install a helper, change permissions or relax AppArmor.
  execFileSync(
    '/usr/bin/unshare',
    ['--user', '--map-root-user', '--pid', '--fork', '--net', '/usr/bin/true'],
    { timeout: 10000, stdio: 'pipe' },
  );
  console.log(JSON.stringify({ officialUsernsProbe: 'passed', profile }));
  return undefined;
}
