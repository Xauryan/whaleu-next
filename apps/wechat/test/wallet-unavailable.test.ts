import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';

test('wallet has no fabricated financial state or payment action while provider is unavailable', () => {
  const source = readFileSync(
    path.join(__dirname, '../src/pages/wallet/wallet.ts'),
    'utf8',
  );
  const template = readFileSync(
    path.join(__dirname, '../src/pages/wallet/wallet.wxml'),
    'utf8',
  );
  assert.match(source, /钱包服务暂未接入/u);
  assert.doesNotMatch(source, /balance\s*:|requestPayment|points\s*:/u);
  assert.doesNotMatch(template, /bindtap|¥|￥|充值|提现/u);
  const app = JSON.parse(
    readFileSync(path.join(__dirname, '../src/app.json'), 'utf8'),
  ) as { pages: string[] };
  assert.ok(app.pages.includes('pages/wallet/wallet'));
  assert.ok(app.pages.includes('pages/browsing-history/browsing-history'));
});
