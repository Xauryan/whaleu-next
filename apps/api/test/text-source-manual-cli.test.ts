import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const cli = fileURLToPath(
  new URL('../src/community/text-review/cli.ts', import.meta.url),
);
const env = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://invalid:unused@127.0.0.1:9/whaleu_test',
  PG_SSL_MODE: 'verify-full',
  COMMUNITY_TEXT_REVIEW: 'source_manual',
  COMMUNITY_TEXT_REVIEW_SPACE_ID: '11111111-1111-4111-8111-111111111111',
  COMMUNITY_TEXT_REVIEW_REGION_ID: '22222222-2222-4222-8222-222222222222',
  COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID:
    '33333333-3333-4333-8333-333333333333',
  COMMUNITY_TEXT_REVIEW_OPERATOR:
    'manual:deliberately-wrong-host:deliberately-wrong-user',
};
for (const [label, args] of [
  ['missing command', []],
  ['unknown or bulk command', [JSON.stringify({ command: 'allow-all' })]],
  [
    'show with non-TTY stdout',
    [
      JSON.stringify({
        command: 'show',
        accountId: '11111111-1111-4111-8111-111111111111',
        requestId: '22222222-2222-4222-8222-222222222222',
      }),
    ],
  ],
  [
    'wrong actual OS identity before pool creation',
    [JSON.stringify({ command: 'list' })],
  ],
] as const)
  test(`human review CLI fails closed: ${label}`, () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', cli, ...args],
      {
        env,
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Human review failed;/);
    assert.ok(!result.stderr.includes('invalid:unused'));
    assert.ok(!result.stderr.includes('deliberately-wrong'));
  });
// Successful private TTY show and separate database-role privileges are NOT
// simulated here. Those require an actual deployment/terminal acceptance lane.
