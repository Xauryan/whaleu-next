import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const out = path.join(root, 'dist');
execFileSync(
  process.execPath,
  [path.join(root, 'scripts/check-native-assets.mjs')],
  { stdio: 'inherit' },
);
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
    // Authoring vectors/contact sheets are not part of the native runtime package.
    if (from === path.join(root, 'src/assets/icons/source')) continue;
    if (entry.isDirectory()) await copyAssets(from, to);
    else if (/\.(json|wxml|wxss|png)$/.test(entry.name)) await cp(from, to);
  }
}
await copyAssets(path.join(root, 'src'), out);

// TypeScript emits CommonJS, not an npm bundle. Ship the vetted browser-only
// implementation under a relative Mini Program path (never Node's crypto entry).
for (const relative of [
  'community/view-contract.js',
  'major-discussion/v2-contract.js',
  'major-discussion/media-contract.js',
  'window-discussion/v2-contract.js',
  'window-discussion/media-contract.js',
  'verification/institutional-contract.js',
  'verification/evidence-contract.js',
  'verification/evidence-pending.js',
  'verification/student-contract.js',
  'verification/student-pending.js',
  'school-configuration/contract.js',
  'official-account-operations/contracts.js',
  'organizations/contract.js',
  'organizations/media-contract.js',
  'organizations/media-runtime.js',
  'errands/media-contract.js',
  'errands/media-runtime.js',
  'errands/publication-runtime.js',
  'activities/media-contract.js',
  'activities/media-runtime.js',
  'activities/publication/contract.js',
  'announcements/authoring/contract.js',
  'media/announcement-contract.js',
  'media/announcement-runtime.js',
  'school-posting-policy/contract.js',
  'school-configuration/qr-contract.js',
  'school-configuration/qr-runtime.js',
  'messaging/pending.js',
  'messaging/image-contract.js',
  'media/upload-contracts.js',
  'profile/avatar-contract.js',
  'profile/cover-contract.js',
  'browsing-history/store.js',
  'personal-timetable/contracts.js',
  'profile-avatar-moderation/contract.js',
  'admin-post-removal/contract.js',
  'school-admin-management/contract.js',
  'school-identity/contract.js',
  'account-moderation/contract.js',
  'admin-discussion-removal/contract.js',
  'media/upload-runtime.js',
  'media/batch-contracts.js',
  'media/discussion-batch-contracts.js',
  'media/batch-publication.js',
  'platform/wechat-upload.js',
  'ratings/assistance-contract.js',
  'ratings/assistance-controller.js',
  'community/rating-link-contract.js',
  'community/text-source-contract.js',
  'ratings/scoped-contract.js',
  'ratings/category-scoped-contract.js',
  'ratings/category-icon-media-contract.js',
  'ratings/category-icon-upload-scope.js',
  'ratings/category-icon-contract.js',
  'ratings/category-icon-pending.js',
  'ratings/target-cover-contract.js',
  'ratings/target-cover-media-contract.js',
  'ratings/target-cover-upload-scope.js',
  'ratings/discussion-media-contract.js',
  'ratings/discussion-media-batch-contract.js',
  'ratings/discussion-media-wire.js',
]) {
  const cryptoModule = path.join(out, relative);
  const compiled = await readFile(cryptoModule, 'utf8');
  if (!compiled.includes('require("js-sha256")'))
    throw new Error('Missing native SHA-256 import');
  await writeFile(
    cryptoModule,
    compiled.replace(
      'require("js-sha256")',
      `require("${path.posix.relative(path.posix.dirname(relative), 'vendor/sha256')}")`,
    ),
  );
}
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

execFileSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    path.join(root, 'test/native-press-emitted.smoke.mjs'),
  ],
  {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, WHALEU_WECHAT_DIST: out },
  },
);

execFileSync(
  process.execPath,
  [
    '--import',
    'tsx',
    path.join(root, 'test/rating-target-cover-page-smoke.mjs'),
  ],
  { stdio: 'inherit', cwd: root },
);

execFileSync(
  process.execPath,
  [path.join(root, 'test/rating-discussion-media-page-smoke.mjs')],
  { stdio: 'inherit', cwd: root },
);

execFileSync(
  process.execPath,
  ['--import', 'tsx', path.join(root, 'test/category-icon-emitted.smoke.ts')],
  { stdio: 'inherit', cwd: root },
);

execFileSync(
  process.execPath,
  ['--import', 'tsx', path.join(root, 'test/text-review-emitted.smoke.ts')],
  { stdio: 'inherit', cwd: root },
);

execFileSync(
  process.execPath,
  [path.join(root, 'test/school-services-emitted-smoke.mjs')],
  { stdio: 'inherit', cwd: root },
);

execFileSync(
  process.execPath,
  [path.join(root, 'scripts/smoke-school-uid.mjs')],
  {
    stdio: 'inherit',
  },
);

execFileSync(
  process.execPath,
  ['--import', 'tsx', path.join(root, 'test/campus-tools-emitted-smoke.mjs')],
  { stdio: 'inherit', cwd: root },
);

execFileSync(
  process.execPath,
  [path.join(root, 'scripts/smoke-institutional-sso.mjs')],
  { stdio: 'inherit', cwd: root },
);

execFileSync(
  process.execPath,
  [
    '--import',
    'tsx',
    path.join(root, 'test/ratings-assistance-emitted.smoke.ts'),
  ],
  { stdio: 'inherit', cwd: root },
);
execFileSync(
  process.execPath,
  [path.join(root, 'scripts/smoke-official-account-operations.mjs')],
  { stdio: 'inherit', cwd: root },
);
