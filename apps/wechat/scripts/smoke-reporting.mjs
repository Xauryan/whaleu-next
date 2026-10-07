import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
/** Real emitted native handlers/gateway/decoders/journals; every API row is synthetic. */
export async function smokeReporting({
  app,
  dist,
  mountPage,
  flush,
  postWire,
  rootWire,
  replyWire,
}) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { HttpReportGateway } = require(
    path.join(dist, 'community/report-gateway.js'),
  );
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const { decodePost, decodeComment } = require(
    path.join(dist, 'community/contract.js'),
  );
  const { decodeReply } = require(
    path.join(dist, 'community/discussion-contract.js'),
  );
  const original = {
    gateway: app.community.gateway,
    reports: app.community.reports,
    privacy: app.community.identityPrivacy,
    newRequestId: app.community.newRequestId,
  };
  const nonself = (value) => ({
    ...value,
    viewer: { ...value.viewer, isSelf: false, canDelete: false },
  });
  const post = decodePost({
      ...nonself(postWire()),
      component: { kind: 'none' },
    }),
    reply = decodeReply(nonself(replyWire())),
    root = decodeComment({
      ...nonself(rootWire()),
      replyPreview: { items: [reply], nextCursor: null },
    });
  const accountId = app.identity.sessions.snapshot().credentials.accountId;
  const juryId = 'f1111111-1111-4111-8111-111111111111';
  const createdAt = '2026-10-07T00:00:00.000Z',
    deadline = '2026-10-08T00:00:00.000Z';
  const allow = { status: 'allow', code: null, evaluatedAt: createdAt };
  const denied = (code) => ({ status: 'deny', code, evaluatedAt: createdAt });
  let phase = 'unknown',
    lost = true,
    sequence = 0,
    contentReads = 0;
  const requests = [],
    receipts = new Map();
  const progress = (kind, id) => {
    if (phase === 'unknown')
      throw new ClientError('http', 'coverage', {
        serverCode: 'SAFETY_UNAVAILABLE',
        httpStatus: 503,
      });
    if (phase === 'removed')
      throw new ClientError('http', 'unavailable', {
        serverCode: 'REPORT_TARGET_UNAVAILABLE',
        httpStatus: 404,
      });
    const base = {
      kind,
      id,
      reportCount: 0,
      hasReported: false,
      isSelf: false,
      reportCapability: allow,
    };
    if (kind !== 'post')
      return { ...base, reportCount: 1, review: 'provider_disabled' };
    if (phase === 'empty') return { ...base, effectiveWeight: 0, jury: null };
    return {
      ...base,
      reportCount: 5,
      effectiveWeight: 5,
      reportCapability: denied('REPORTING_CLOSED'),
      jury: {
        juryId,
        state: phase === 'kept' ? 'kept' : 'pending',
        createdAt,
        deadline,
        keepVotes: phase === 'kept' ? 6 : 0,
        removeVotes: 0,
        ownVote: phase === 'kept' ? 'keep' : null,
        voteCapability: phase === 'kept' ? denied('JURY_CLOSED') : allow,
      },
    };
  };
  app.community.reports = new HttpReportGateway(
    new ApiClient(
      'https://reporting.example',
      {
        send: async (request) => {
          requests.push(request);
          const url = new URL(request.url),
            body = request.body;
          if (request.method === 'POST') {
            const operation = url.pathname.endsWith('/reports')
              ? 'report'
              : 'vote';
            assert.deepEqual(
              Object.keys(body).sort(),
              (operation === 'report'
                ? ['clientRequestId', 'target']
                : ['clientRequestId', 'postId', 'juryId', 'vote']
              ).sort(),
            );
            if (operation === 'report')
              assert.deepEqual(Object.keys(body.target).sort(), ['id', 'kind']);
            else {
              assert.equal(body.postId, post.id);
              assert.equal(body.juryId, juryId);
              assert.equal(body.vote, 'keep');
              phase = 'kept';
            }
            const receipt = {
              requestId: body.clientRequestId,
              operation,
              outcome: 'accepted',
              receiptId: 'f2222222-2222-4222-8222-222222222222',
            };
            receipts.set(body.clientRequestId, receipt);
            if (lost) {
              lost = false;
              throw new ClientError('timeout', 'synthetic lost response');
            }
            return { status: 200, headers: {}, body: receipt };
          }
          if (url.pathname.includes('/report-requests/')) {
            const receipt = receipts.get(url.pathname.split('/').at(-1));
            assert.ok(receipt);
            return { status: 200, headers: {}, body: receipt };
          }
          const parts = url.pathname.split('/');
          return {
            status: 200,
            headers: {},
            body: progress(parts.at(-2), parts.at(-1)),
          };
        },
      },
      app.identity.sessions,
      { refresh: async () => app.identity.sessions.snapshot() },
    ),
  );
  app.community.identityPrivacy = undefined;
  app.community.newRequestId = async () =>
    `f3333333-3333-4333-8333-${String(++sequence).padStart(12, '0')}`;
  app.community.gateway = {
    ...original.gateway,
    post: async () => {
      contentReads++;
      return post;
    },
    comments: async () => ({ items: [root], nextCursor: null }),
    comment: async () => root,
    replies: async () => ({ items: [reply], nextCursor: null }),
    discussionContext: async () => ({
      comment: root,
      reply,
      replies: { items: [reply], nextCursor: null },
    }),
  };
  let current;
  try {
    current = mountPage(
      path.join(dist, 'pages/community-detail/community-detail.js'),
      { postId: post.id },
    );
    await flush();
    assert.equal(current.data.loaded, true);
    assert.equal(current.data.reportProgress.loaded, false);
    assert.equal(current.data.reportProgress.progress, null);
    current.onReportPost();
    assert.equal(current.data.report.confirmation.target.id, post.id);
    current.onDismissReport();
    current.onConfirmReport();
    await flush();
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
    current.onReportComment({ currentTarget: { dataset: { id: root.id } } });
    assert.equal(current.data.report.confirmation.target.kind, 'comment');
    current.onConfirmReport();
    current.onConfirmReport();
    await flush();
    assert.equal(requests.filter((r) => r.method === 'POST').length, 1);
    assert.equal(current.data.report.frozen, true);
    assert.ok(app.community.pendingReports.load(accountId));
    current.onHide();
    const readsBeforeRecovery = contentReads;
    current = mountPage(
      path.join(dist, 'pages/report-progress/report-progress.js'),
      {},
    );
    await flush();
    assert.equal(current.data.report.frozen, true);
    current.onReportReceipt();
    await flush();
    assert.equal(current.data.report.frozen, false);
    assert.match(current.data.report.receiptStatus, /不代表已审核或已删除/);
    assert.equal(contentReads, readsBeforeRecovery);
    current.onHide();
    phase = 'empty';
    current = mountPage(
      path.join(dist, 'pages/community-thread/community-thread.js'),
      { postId: post.id, rootCommentId: root.id },
    );
    await flush();
    assert.equal(current.data.loaded, true);
    current.onReportReply({ currentTarget: { dataset: { id: reply.id } } });
    assert.equal(current.data.report.confirmation.target.kind, 'reply');
    current.onConfirmReport();
    await flush();
    assert.equal(current.data.report.frozen, false);
    current.onHide();
    phase = 'jury';
    current = mountPage(
      path.join(dist, 'pages/community-detail/community-detail.js'),
      { postId: post.id },
    );
    await flush();
    assert.equal(current.data.loaded, true);
    assert.equal(current.data.reportProgress.canVote, true);
    assert.equal(current.data.reportProgress.showTallies, false);
    current.onJuryChoice({ currentTarget: { dataset: { vote: 'keep' } } });
    assert.equal(current.data.juryVote.confirmation.juryId, juryId);
    current.onConfirmJuryVote();
    await flush();
    assert.equal(current.data.juryVote.frozen, false);
    assert.match(current.data.juryVote.receiptStatus, /最终结果/);
    assert.equal(current.data.reportProgress.progress.jury.state, 'kept');
    assert.equal(current.data.reportProgress.canVote, false);
    current.onHide();
    phase = 'removed';
    current = mountPage(
      path.join(dist, 'pages/report-progress/report-progress.js'),
      { kind: 'post', id: post.id },
    );
    await flush();
    assert.equal(current.data.reportProgress.progress, null);
    assert.equal(current.data.reportProgress.loaded, false);
    assert.equal(current.data.reportProgress.canVote, false);
    assert.equal(app.community.pendingJuryVotes.load(accountId), null);
    for (const file of [
      'community/report-recovery.wxml',
      'community/report-progress.wxml',
    ]) {
      const template = readFileSync(path.join(dist, file), 'utf8');
      for (const match of template.matchAll(/bindtap="([^"]+)"/g))
        assert.equal(typeof current[match[1]], 'function', match[1]);
      assert.equal(
        /reason-input|evidence|ownerAccountId|reporterId|jurorId|studentNumber|requestSubscribeMessage/.test(
          template,
        ),
        false,
      );
    }
    for (const name of [
      'community-detail',
      'community-thread',
      'community-feed',
    ]) {
      const template = readFileSync(
        path.join(dist, `pages/${name}/${name}.wxml`),
        'utf8',
      );
      assert.match(template, /onReport/);
      assert.match(template, /!\w+\.viewer\.isSelf/);
    }
    console.log(
      'Reporting compiled native smoke passed: anonymous post/root/reply confirmations, independent unavailable progress, immutable jury choice, lost-response target-free recovery, exact transport, current kept/removed status and separated journals',
    );
  } finally {
    current?.onUnload();
    app.community.gateway = original.gateway;
    app.community.reports = original.reports;
    app.community.identityPrivacy = original.privacy;
    app.community.newRequestId = original.newRequestId;
  }
}
