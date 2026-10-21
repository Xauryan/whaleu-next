/** I/O-free guard-adapter regressions, not emitted Page or PostgreSQL evidence. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkedNoticeTransport } from './support/notice-exposure-native-transport.js';
import type { NoticeTransportRequest } from './support/notice-exposure-native-transport.js';

const origin = 'https://native-experience.invalid';
const noticeId = '11111111-1111-4111-8111-111111111111';
const credentials = { accessToken: 'synthetic-owner' };
const valid: NoticeTransportRequest = {
  url: `${origin}/v1/me/social-updates/${noticeId}/read?category=likes`,
  method: 'PUT',
  headers: { Authorization: `Bearer ${credentials.accessToken}` },
  body: {},
};
const invalidRequests: readonly [string, NoticeTransportRequest][] = [
  [
    'replacement owner',
    { ...valid, headers: { Authorization: 'Bearer replacement' } },
  ],
  [
    'wrong category',
    {
      ...valid,
      url: valid.url.replace('category=likes', 'category=followers'),
    },
  ],
  [
    'wrong owner route',
    { ...valid, url: valid.url.replace('/social-updates/', '/wrong-owner/') },
  ],
  ['unexpected body', { ...valid, body: { unexpected: true } }],
  ['GET acknowledgment', { ...valid, method: 'GET' }],
  ['malformed URL', { ...valid, url: 'not a URL' }],
  [
    'non-fixture origin',
    {
      ...valid,
      url: valid.url.replace('native-experience.invalid', 'refused.invalid'),
    },
  ],
];

for (const [label, request] of invalidRequests) {
  test(`native exposure adapter: ${label} remains a failed attempt after application catch`, () => {
    let sends = 0;
    const audit = checkedNoticeTransport(
      {
        send() {
          sends++;
        },
      },
      credentials,
      { qualifying: noticeId },
      origin,
    );
    try {
      audit.transport.send(request);
    } catch {
      // Deliberately model the production reader catching a transport failure.
      // This cannot turn an invalid attempted acknowledgment into noWrite(0).
    }
    assert.equal(audit.attempts.length, 1);
    assert.equal(audit.writes.length, 1);
    assert.equal(sends, 0, 'Invalid ownership/scope is refused before any I/O');
    assert.throws(
      () => audit.assertHealthy(),
      /swallowed by production error handling/,
    );
    assert.throws(
      () => audit.assertHealthy(),
      /swallowed by production error handling/,
      'The audit violation is sticky, not consumed by the first assertion',
    );
  });
}

test('native exposure adapter: caught real-response assertion remains a sticky failure', () => {
  const audit = checkedNoticeTransport(
    {
      send() {
        assert.fail('This response-assertion probe performs no I/O');
      },
    },
    credentials,
    { qualifying: noticeId },
    origin,
  );
  try {
    audit.validate(() => assert.fail('Rejected real response invariant'));
  } catch {
    // The real bridge calls its response check inside the production catch path.
  }
  assert.equal(audit.attempts.length, 0);
  assert.throws(
    () => audit.assertHealthy(),
    /Rejected real response invariant/,
  );
});

test('native exposure adapter: exact valid owner request passes through unchanged once', () => {
  const sent: NoticeTransportRequest[] = [];
  const result = Symbol('opaque transport result');
  const audit = checkedNoticeTransport(
    {
      send(request) {
        sent.push(request);
        return result;
      },
    },
    credentials,
    { qualifying: noticeId },
    origin,
  );
  assert.equal(audit.transport.send(valid), result);
  audit.assertHealthy();
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0],
    valid,
    'The adapter does not synthesize or rewrite a request',
  );
  assert.deepEqual(audit.writes, [
    { noticeId, category: 'likes', method: 'PUT' },
  ]);
  assert.equal(audit.attempts.length, 1);
});
