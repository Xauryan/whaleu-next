import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { MediaLocalFiles } from '../src/media/local-files';
import {
  initialRatingCategoryScopedView,
  RatingCategoryScopedController,
  ratingCategoryScopedError,
} from '../src/ratings/category-scoped-controller';
import {
  categoryIconPrepareHash,
  type CategoryIconMediaStatus,
  type CategoryIconPrepare,
} from '../src/ratings/category-icon-media-contract';
import type { CategoryIconMediaGateway } from '../src/ratings/category-icon-media-gateway';
import {
  categoryIconScopeRequestHash,
  type CategoryIconScope,
  type CategoryIconScopeInput,
} from '../src/ratings/category-icon-upload-scope';
import type { CategoryIconUploadTransfer } from '../src/ratings/category-icon-upload';
import { CategoryIconUploadWindow } from '../src/ratings/category-icon-window';
import {
  categoryIconHarness,
  iconCategory,
  iconId,
} from './category-icon-helpers';
import { categoryScopedHarness, managedRoute } from './category-scoped-helpers';
import { accountId } from './identity-helpers';

function rateLimitHarness(
  stage: 'scope' | 'prepare',
  error = new ClientError('http', 'Media operation budget exceeded', {
    httpStatus: 429,
    serverCode: 'MEDIA_RATE_LIMITED',
  }),
) {
  const h = categoryIconHarness();
  h.controller.dispose();
  const resident = new Set<string>(),
    owner = {},
    scopeInputs: CategoryIconScopeInput[] = [],
    prepareInputs: CategoryIconPrepare[] = [],
    recoveryInputs: { requestId: string; requestHash: string }[] = [];
  let sequence = 0,
    picks = 0,
    limited = true,
    expired = false;
  const scope: CategoryIconScope = {
    editScopeId: iconId(100),
    scopeRevision: 'd'.repeat(64),
    categoryId: iconCategory().id,
    identityId: iconId(101),
    expiresAt: new Date(h.current.now + 300000).toISOString(),
  };
  const localFiles = new MediaLocalFiles({
    stat: async (path) => (resident.has(path) ? 24 : 0),
    image: async () => ({ width: 1, height: 1, type: 'png' }),
    readError: async () => null,
    unlink: async (path) => {
      resident.delete(path);
    },
  });
  const unexpected = async (): Promise<never> => {
    throw Error('Unexpected media effect');
  };
  const media: CategoryIconMediaGateway = {
    descriptor: unexpected,
    scope: async (input) => {
      scopeInputs.push(input);
      const member = h.store.load(accountId).uploads!.members[0]!;
      assert.deepEqual(member.scopeInput, input);
      if (limited && stage === 'scope') throw error;
      return scope;
    },
    prepare: async (input) => {
      prepareInputs.push(input);
      if (limited && stage === 'prepare') throw error;
      if (expired)
        throw new ClientError('business', 'Original scope expired', {
          httpStatus: 409,
          serverCode: 'RATING_SCOPED_CONTEXT_CHANGED',
        });
      return {
        protocol: 'ratings-category-icon-media-v1',
        editScopeId: input.editScopeId,
        intentId: iconId(102),
        requestId: input.clientRequestId,
        requestHash: categoryIconPrepareHash(accountId, input),
        serverNow: h.current.now,
        status: 'ready_unbound',
        assetId: iconId(103),
        readyRetentionUntil: h.current.now + 300000,
        editExpiresAt: Date.parse(scope.expiresAt),
        bindBefore: Date.parse(scope.expiresAt),
        mediaProof: 'current',
      } satisfies CategoryIconMediaStatus;
    },
    recover: async (requestId) => ({
      protocol: 'ratings-category-icon-media-v1',
      requestId,
      serverNow: h.current.now,
      state: 'not_recorded',
      requestHash: null,
    }),
    recoverScope: async (requestId, requestHash) => {
      assert.equal(h.calls[h.calls.length - 1], 'receipt');
      recoveryInputs.push({ requestId, requestHash });
      return stage === 'scope'
        ? { state: 'unknown', scope: null, recovery: null }
        : { state: 'known', scope, recovery: null };
    },
    status: unexpected,
    grant: unexpected,
    finalize: unexpected,
    cancelScope: unexpected,
    cancelRequest: unexpected,
  };
  const transfer: CategoryIconUploadTransfer = {
    localFiles,
    pick: async (session) => {
      const reservation = localFiles.reserve(),
        path = `wxfile://tmp/rate-limited-${++picks}.png`;
      resident.add(path);
      return localFiles.adopt(path, 24, owner, session.current(), reservation);
    },
    inspect: async () => ({
      mime: 'image/png',
      bytes: 24,
      sha256: 'a'.repeat(64),
    }),
    remove: (file) => localFiles.release(file),
    upload: unexpected,
    settled: () => true,
    clearSession: () => undefined,
  };
  const runtime: CommunityRuntime = {
    ...h.runtime,
    newRequestId: async () => iconId(++sequence),
    ratingCategoryIconMedia: media,
    ratingCategoryIconUpload: transfer,
  };
  let view = initialRatingCategoryScopedView();
  const controller = new RatingCategoryScopedController(
    runtime,
    (value) => {
      view = value;
    },
    true,
    { now: () => h.current.now, schedule: () => () => undefined },
  );
  return {
    ...h,
    controller,
    view: () => view,
    scopeInputs,
    prepareInputs,
    recoveryInputs,
    resident,
    transfer,
    sequence: () => sequence,
    allow: () => {
      limited = false;
    },
    expire: () => {
      expired = true;
      limited = false;
    },
  };
}

for (const stage of ['scope', 'prepare'] as const) {
  test(`native icon ${stage} 429 preserves the original journal and resumes the same keys after waiting`, async () => {
    const h = rateLimitHarness(stage),
      slot = `base:${iconCategory().id}`;
    try {
      await h.controller.load(managedRoute);
      h.controller.selectOperation('edit_category_base_scoped');
      h.controller.chooseIcon(slot, 'replace');
      await h.controller.prepare();
      const original = h.store.load(accountId).uploads!;
      await h.controller.uploadIcon(slot);
      const pending = h.store.load(accountId).uploads!,
        member = pending.members[0]!,
        requestCount = h.sequence();
      assert.match(h.view().error, /限流.*等待.*继续原请求/);
      assert.match(h.view().status, /原草稿、上传编号和已完成图标均已保留/);
      assert.match(h.view().status, /查询原回执/);
      assert.match(h.view().status, /选择原图并上传此节点/);
      assert.match(h.view().status, /不会延长.*5 分钟/);
      assert.match(h.view().status, /若已过期.*确认原请求关闭/);
      assert.equal(h.view().busy, false);
      assert.equal(h.view().iconFrozen, true);
      assert.deepEqual(pending.identity, original.identity);
      assert.equal(pending.identityHash, original.identityHash);
      assert.equal(pending.members.length, 1);
      assert.equal(h.resident.size, 0);
      assert.equal(h.prepared.length, 0);
      assert.equal(h.committed.length, 0);

      h.current.now += 60000;
      h.allow();
      await h.controller.recover();
      assert.deepEqual(h.recoveryInputs, [
        {
          requestId: member.scopeInput.clientRequestId,
          requestHash: categoryIconScopeRequestHash(member.scopeInput),
        },
      ]);
      await h.controller.uploadIcon(slot);
      const continued = h.store.load(accountId).uploads!;
      assert.equal(h.view().error, '');
      assert.equal(continued.members.length, 1);
      assert.equal(continued.members[0]!.state, 'ready');
      assert.deepEqual(continued.identity, original.identity);
      assert.equal(continued.identityHash, original.identityHash);
      assert.deepEqual(continued.members[0]!.scopeInput, member.scopeInput);
      assert.equal(h.sequence(), requestCount);
      assert.equal(h.calls.filter((call) => call === 'entry').length, 1);
      assert.equal(h.calls.includes('context'), false);
      assert.ok(
        h.scopeInputs.every(
          (input) =>
            categoryIconScopeRequestHash(input) ===
            categoryIconScopeRequestHash(member.scopeInput),
        ),
      );
      if (stage === 'prepare') {
        assert.equal(h.scopeInputs.length, 1);
        assert.deepEqual(h.prepareInputs[1], h.prepareInputs[0]);
      }
      await h.controller.preparePending();
      assert.ok(h.view().preview);
      assert.equal(h.prepared.length, 1);
      assert.equal(h.committed.length, 0);
    } finally {
      h.controller.dispose();
    }
  });
}

test('an expired original icon scope stays pending after rate-limit waiting without a replacement context or key', async () => {
  const h = rateLimitHarness('prepare'),
    slot = `base:${iconCategory().id}`;
  try {
    await h.controller.load(managedRoute);
    h.controller.selectOperation('edit_category_base_scoped');
    h.controller.chooseIcon(slot, 'replace');
    await h.controller.prepare();
    await h.controller.uploadIcon(slot);
    const pending = h.store.load(accountId).uploads!,
      requestCount = h.sequence();
    h.current.now += 300001;
    h.expire();
    await h.controller.uploadIcon(slot);
    assert.deepEqual(h.store.load(accountId).uploads, pending);
    assert.equal(h.sequence(), requestCount);
    assert.equal(h.scopeInputs.length, 1);
    assert.deepEqual(h.prepareInputs[1], h.prepareInputs[0]);
    assert.equal(h.calls.filter((call) => call === 'entry').length, 1);
    assert.equal(h.calls.includes('context'), false);
    assert.match(h.view().error, /原请求须先确认关闭/);
    assert.equal(h.view().iconFrozen, true);
    assert.equal(h.resident.size, 0);
  } finally {
    h.controller.dispose();
  }
});

test('icon recovery recognizes HTTP-only 429 and Media code-only limits without changing the pending request', async () => {
  for (const details of [
    { httpStatus: 429 },
    { serverCode: 'MEDIA_RATE_LIMITED' },
  ]) {
    const h = categoryIconHarness();
    try {
      await h.controller.load(managedRoute);
      h.controller.selectOperation('edit_category_base_scoped');
      await h.controller.prepare();
      const pending = h.store.load(accountId);
      h.gateway.receipt = async () => {
        throw new ClientError('http', 'Limited', details);
      };
      await h.controller.recover();
      assert.match(h.view().error, /限流.*等待/);
      assert.deepEqual(h.store.load(accountId), pending);
      assert.equal(h.view().iconFrozen, true);
    } finally {
      h.controller.dispose();
    }
  }
});

test('completed native uploads preserve rate-limit metadata without exposing raw error messages', async () => {
  for (const failure of [
    new ClientError('http', 'Raw provider text must not escape', {
      httpStatus: 429,
      serverCode: 'MEDIA_RATE_LIMITED',
    }),
    new Error('Raw provider text must not escape'),
  ]) {
    const h = rateLimitHarness('prepare'),
      window = new CategoryIconUploadWindow(
        h.runtime.sessions,
        h.transfer.localFiles,
        h.transfer,
        {
          start: async () => ({
            result: Promise.reject(failure),
            complete: Promise.resolve(),
          }),
          ready: () => assert.fail('A limited upload cannot become ready'),
        },
        () => undefined,
      );
    try {
      await assert.rejects(window.append(0), (error: unknown) => {
        assert.ok(error instanceof ClientError);
        assert.equal(error.message, 'Original upload requires recovery');
        assert.equal(
          error.kind,
          failure instanceof ClientError ? failure.kind : 'network',
        );
        assert.deepEqual(
          error.details,
          failure instanceof ClientError ? failure.details : {},
        );
        return true;
      });
      assert.equal(h.resident.size, 0);
    } finally {
      window.dispose();
      h.controller.dispose();
    }
  }
});

test('unknown native completion does not turn a rate-limit response into a retryable completed upload', async () => {
  const h = rateLimitHarness('prepare'),
    window = new CategoryIconUploadWindow(
      h.runtime.sessions,
      h.transfer.localFiles,
      h.transfer,
      {
        start: async () => ({
          result: Promise.reject(
            new ClientError('http', 'Limited', {
              httpStatus: 429,
              serverCode: 'MEDIA_RATE_LIMITED',
            }),
          ),
          complete: Promise.reject(new Error('Completion is unknown')),
        }),
        ready: () => assert.fail('Unknown completion cannot become ready'),
      },
      () => undefined,
    );
  try {
    await assert.rejects(window.append(0), (error: unknown) => {
      assert.ok(error instanceof ClientError);
      assert.equal(error.kind, 'network');
      assert.deepEqual(error.details, {});
      return true;
    });
    assert.equal(h.resident.size, 1);
    await assert.rejects(window.append(0), (error: unknown) => {
      assert.ok(error instanceof ClientError);
      assert.equal(error.kind, 'configuration');
      return true;
    });
  } finally {
    window.dispose();
    h.controller.dispose();
  }
});

test('text-only category failures keep their existing rate-limit presentation', async () => {
  const h = categoryScopedHarness(),
    error = new ClientError('http', 'Limited', {
      httpStatus: 429,
      serverCode: 'RATE_LIMITED',
    });
  try {
    await h.controller.load(managedRoute);
    h.controller.selectOperation('edit_category_base_scoped');
    h.gateway.prepare = async () => {
      throw error;
    };
    await h.controller.prepare();
    assert.equal(h.view().iconFrozen, false);
    assert.equal(h.view().error, ratingCategoryScopedError(error));
    assert.doesNotMatch(h.view().status, /图标|5 分钟/);
  } finally {
    h.controller.dispose();
  }
});
