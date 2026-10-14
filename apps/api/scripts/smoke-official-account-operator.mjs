import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
const emitted = new URL(
  '../dist/official-account-operations/',
  import.meta.url,
);
for (const name of [
  'controller.js',
  'operator-controller.js',
  'module.js',
  'operator/assets.js',
])
  await access(new URL(name, emitted));
const {
  officialOperatorShell,
  officialOperatorScript,
  officialOperatorHeaders,
} = await import(new URL('operator/assets.js', emitted));
assert.match(officialOperatorShell, /\/operator\/official-articles\/app.js/);
assert.match(officialOperatorShell, /运营登录暂不可用/);
assert.equal(officialOperatorHeaders['Cache-Control'], 'no-store');
assert.doesNotMatch(
  officialOperatorHeaders['Content-Security-Policy'],
  /unsafe-inline|unsafe-eval/,
);
const contracts = await import(
  'data:text/javascript;base64,' +
    Buffer.from(officialOperatorScript).toString('base64')
);
assert.equal(typeof contracts.mountOfficialOperator, 'function');
assert.equal(typeof contracts.decodeControl, 'function');
console.log(
  'Official operator emitted assets smoke passed; real browser/HTTP acceptance remains separate.',
);
