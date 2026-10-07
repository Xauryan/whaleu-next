import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { responseError } from '../src/api/envelopes';
import { SessionStore } from '../src/auth/session';
import { HttpReportGateway } from '../src/community/report-gateway';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { postId, requestId } from './community-helpers';
import {
  reportIntent,
  voteIntent,
  reportReceipt,
  reportProgress,
} from './report-helpers';
function setup() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  return {
    sessions,
    transport,
    gateway: new HttpReportGateway(
      new ApiClient('https://api.example', transport, sessions, {
        refresh: async () => sessions.snapshot(),
      }),
    ),
  };
}
test('authenticated report/vote writes omit client operation metadata and progress/recovery reads are independent', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const intent of [reportIntent(), voteIntent()]) {
    s.transport.reply(reportReceipt(intent));
    await s.gateway.apply(intent, cancel);
  }
  s.transport.reply(reportProgress());
  await s.gateway.progress({ kind: 'post', id: postId }, cancel);
  s.transport.reply(reportReceipt());
  await s.gateway.receipt(requestId, cancel);
  assert.deepEqual(s.transport.requests[0]!.body, {
    clientRequestId: requestId,
    target: { kind: 'post', id: postId },
  });
  const vote = voteIntent();
  assert.equal(vote.operation, 'vote');
  if (vote.operation !== 'vote') throw Error();
  assert.deepEqual(s.transport.requests[1]!.body, {
    clientRequestId: requestId,
    postId,
    juryId: vote.juryId,
    vote: 'keep',
  });
  assert.match(s.transport.requests[0]!.url, /\/v1\/me\/safety\/reports$/);
  assert.match(s.transport.requests[1]!.url, /jury-votes$/);
  assert.match(
    s.transport.requests[2]!.url,
    new RegExp('/report-progress/post/' + postId + '$'),
  );
  assert.match(s.transport.requests[3]!.url, /report-requests\//);
  for (const req of s.transport.requests)
    assert.equal(
      req.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
});
test('mismatched target/operation/recovery receipts and injected queries are rejected', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(reportReceipt(voteIntent()));
  await assert.rejects(s.gateway.apply(reportIntent(), cancel));
  s.transport.reply({ ...reportProgress(), kind: 'reply' });
  await assert.rejects(
    s.gateway.progress({ kind: 'post', id: postId }, cancel),
  );
  const before = s.transport.requests.length;
  await assert.rejects(
    s.gateway.progress({ kind: 'post', id: postId + '?owner=true' }, cancel),
  );
  assert.equal(s.transport.requests.length, before);
});
test('report HTTP error status mappings reject forged code/status pairs', () => {
  for (const [code, status] of Object.entries({
    REPORT_TARGET_UNAVAILABLE: 404,
    REPORT_SELF_NOT_ALLOWED: 403,
    REPORT_ALREADY_REPORTED: 409,
    REPORTING_CLOSED: 409,
    REPORT_SCOPE_UNAVAILABLE: 503,
    AFFILIATION_VERIFICATION_REQUIRED: 403,
    JURY_NOT_FOUND: 404,
    JURY_INELIGIBLE: 403,
    JURY_ALREADY_VOTED: 409,
    JURY_CLOSED: 409,
  })) {
    assert.notEqual(
      responseError({ status, headers: {}, body: { error: { code } } })?.kind,
      'protocol',
    );
    assert.equal(
      responseError({ status: 500, headers: {}, body: { error: { code } } })
        ?.kind,
      'protocol',
    );
  }
});
test('expired access replays only the exact original report once and receipt queries remain bounded', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpReportGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  const expired = {
    error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'ignored', requestId },
  };
  transport.reply(expired, 401);
  transport.reply(reportReceipt());
  await gateway.apply(reportIntent(), new Cancellation());
  assert.equal(refreshes, 1);
  assert.deepEqual(transport.requests[0]!.body, transport.requests[1]!.body);
  transport.reply(expired, 401);
  transport.reply(expired, 401);
  await assert.rejects(gateway.receipt(requestId, new Cancellation()));
  assert.equal(refreshes, 2);
  assert.equal(transport.requests.length, 4);
});
