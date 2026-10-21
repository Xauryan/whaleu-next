/** Actual Page/DTO/projection/native press, synthetic transport only. No PG or build. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import { ApiClient } from '../src/api/client';
import { HttpSystemNoticesGateway } from '../src/community/system-notices-gateway';
import { HttpFeedbackNoticesGateway } from '../src/community/feedback-notices-gateway';
import { HttpErrandNoticesGateway } from '../src/errands/notices';
import type { HttpRequest } from '../src/platform/contracts';
import type { SystemTimelineView } from '../src/notifications/system-timeline';
import { flush, response } from './helpers';
import { systemNoticesSetup } from './system-notices-helpers';

const requireNative = createRequire(__filename);
const root = path.resolve(
  process.env.WHALEU_WECHAT_DIST ?? path.join(__dirname, '../src'),
);
const extension = process.env.WHALEU_WECHAT_DIST ? 'js' : 'ts';
const emitted = (name: string): unknown =>
  requireNative(path.join(root, `${name}.${extension}`));
const worker = ts.createSourceFile(
  'admin-post-removal-native-child.mjs',
  readFileSync(
    path.resolve(
      __dirname,
      '../../api/test/support/admin-post-removal-native-child.mjs',
    ),
    'utf8',
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
function check(name: string, ...args: unknown[]) {
  const declaration = worker.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(declaration);
  runInThisContext(
    `(assert, emitted, args) => (${declaration.getText(worker)})(...args)`,
  )(assert, emitted, args);
}
interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: (Node | string)[];
}
interface PageInstance {
  data: SystemTimelineView & {
    items: (SystemTimelineView['items'][number] & { observationId: string })[];
  };
  setData(patch: object, committed?: () => void): void;
  onShow(): void;
  onHide(): void;
  onRead(event: { currentTarget: { dataset: { id: string } } }): void;
}
const { parse, render } = requireNative('../scripts/smoke-ratings.mjs') as {
  parse(source: string): Node;
  render(
    nodes: (Node | string)[],
    data: object,
    templates: Record<string, Node>,
  ): (Node | string)[];
};
const { createNativePgControls } = requireNative(
  '../../api/test/support/native-pg-control-adapter.mjs',
) as {
  createNativePgControls(options: {
    page: PageInstance;
    pageFile: string;
    dist: string;
    extension: string;
    renderNodes(): (Node | string)[];
  }): {
    dispatch(handler: string, dataset: Record<string, string>): void;
    press: {
      sync(): void;
      lifecycle(event: string): void;
      emissions: unknown[];
    };
  };
};
const flatten = (nodes: (Node | string)[]): Node[] =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [] : [node, ...flatten(node.children)],
  );
const rawPage = {
  items: Array.from({ length: 6 }, (_, index) => ({
    noticeId: `77777777-7777-4777-8777-77777777777${index}`,
    kind: 'admin_post_removed' as const,
    createdAt: `2026-10-20T10:0${index}:00.123Z`,
    readAt: null,
  })).reverse(),
  nextCursor: null,
  unreadCount: 6,
};
const { systemNoticesPageSchema } = requireNative(
  '../../api/src/notifications/system-notices/contracts.ts',
) as {
  systemNoticesPageSchema: { parse(value: unknown): unknown };
};
const { decodeSystemNoticesList } = emitted(
  'community/system-notices-contract',
) as typeof import('../src/community/system-notices-contract');

function fixture() {
  const h = systemNoticesSetup();
  const requests: HttpRequest[] = [];
  const receipts: unknown[] = [];
  const api = new ApiClient(
    'https://synthetic-admin-notices.invalid',
    {
      async send(request) {
        requests.push(request);
        const route = new URL(request.url).pathname;
        if (request.method === 'PUT') {
          assert.equal(
            route,
            `/v1/me/system-notices/${rawPage.items[0]!.noticeId}/read`,
          );
          const receipt = {
            noticeId: rawPage.items[0]!.noticeId,
            readAt: '2026-10-21T10:00:00.123Z',
            unreadCount: 5,
          };
          receipts.push(receipt);
          return response(receipt);
        }
        assert.equal(request.method, 'GET');
        if (route === '/v1/me/system-notices')
          return response(structuredClone(rawPage));
        if (route === '/v1/me/student-verification/notices')
          return response({ items: [], page: 1, hasNext: false });
        assert.ok(
          ['/v1/me/errand-notices', '/v1/me/feedback-notices'].includes(route),
        );
        return response({ items: [], nextCursor: null, unreadCount: 0 });
      },
    },
    h.sessions,
    {
      async refresh() {
        throw Error('No credential refresh expected');
      },
    },
  );
  const runtime = {
    ...h.runtime,
    systemNotices: new HttpSystemNoticesGateway(api),
    errandNotices: new HttpErrandNoticesGateway(api),
    feedbackNotices: new HttpFeedbackNoticesGateway(api),
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    Page: globals.Page,
    getApp: globals.getApp,
    wx: globals.wx,
  };
  let page: PageInstance | undefined;
  Object.assign(globals, {
    Page: (definition: PageInstance) => {
      page = definition;
    },
    getApp: () => ({ community: runtime, identity: { api } }),
    // Like the PG worker, this platform has no intersection observer. Loading
    // cannot fabricate a dwell acknowledgement; the explicit native action remains.
    wx: { nextTick: queueMicrotask },
  });
  const pageFile = path.join(root, 'pages/system-notices/system-notices');
  delete requireNative.cache[requireNative.resolve(`${pageFile}.${extension}`)];
  requireNative(`${pageFile}.${extension}`);
  assert.ok(page);
  const owner = page;
  owner.data = structuredClone(owner.data);
  owner.setData = (patch, committed) => {
    Object.assign(owner.data, structuredClone(patch));
    controls?.press.sync();
    committed?.();
  };
  const templates: Record<string, Node> = {};
  const visited = new Set<string>();
  function tree(file: string): Node {
    visited.add(file);
    const result = parse(readFileSync(file, 'utf8'));
    for (const node of flatten(result.children)) {
      if (node.tag === 'import') {
        const next = path.resolve(path.dirname(file), node.attrs.src!);
        if (!visited.has(next)) tree(next);
      }
      if (node.tag === 'template' && node.attrs.name)
        templates[node.attrs.name] = node;
    }
    return result;
  }
  const wxml = tree(`${pageFile}.wxml`);
  const controls = createNativePgControls({
    page: owner,
    pageFile,
    dist: root,
    extension,
    renderNodes: () =>
      render(
        wxml.children.filter(
          (node) =>
            typeof node === 'string' ||
            node.tag !== 'template' ||
            !node.attrs.name,
        ),
        owner.data,
        templates,
      ),
  });
  owner.onShow();
  return {
    page: owner,
    controls,
    receipts,
    calls: () =>
      requests.map((request) => ({
        path: new URL(request.url).pathname,
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
      })),
    async idle() {
      for (let i = 0; i < 12; i++) await flush();
    },
    close() {
      owner.onHide();
      controls.press.lifecycle('detach');
      Object.assign(globals, previous);
    },
  };
}

test('admin-removal journey checks actual raw DTO and finite actual Page presentation independently', async () => {
  const h = fixture();
  try {
    await h.idle();
    assert.equal(h.page.data.loaded, true);
    assert.equal(h.page.data.busy, false);
    assert.equal(h.page.data.error, '');
    assert.deepEqual(systemNoticesPageSchema.parse(rawPage), rawPage);
    assert.deepEqual(decodeSystemNoticesList(rawPage), rawPage);
    check('assertAdminNoticePresentation', [rawPage], h.page.data);
    check('assertSystemNoticeReads', h.calls(), []);
    for (const field of [
      'postId',
      'authorId',
      'preview',
      'identity',
      'target',
    ]) {
      const contaminated = structuredClone(h.page.data);
      Object.assign(contaminated.items[0]!, { [field]: 'must-not-leak' });
      assert.throws(() =>
        check('assertAdminNoticePresentation', [rawPage], contaminated),
      );
    }
    for (const [field, value] of [
      ['timeLabel', 'wrong date'],
      ['summary', 'secret content'],
      ['source', 'feedback'],
      ['key', rawPage.items[0]!.noticeId],
      ['observationId', 'unscoped-id'],
    ]) {
      const changed = structuredClone(h.page.data);
      Object.assign(changed.items[0]!, { [field!]: value });
      assert.throws(() =>
        check('assertAdminNoticePresentation', [rawPage], changed),
      );
    }
    const key = h.page.data.items[0]!.key;
    assert.throws(
      () => h.controls.dispatch('onRead', { id: rawPage.items[0]!.noticeId }),
      'A raw UUID cannot select a namespaced rendered button',
    );
    check('assertSystemNoticeReads', h.calls(), []);
    h.controls.dispatch('onRead', { id: key });
    await h.idle();
    assert.equal(
      h.controls.press.emissions.length,
      1,
      'Actual Component press emits once',
    );
    check('assertSystemNoticeReads', h.calls(), [rawPage.items[0]!.noticeId]);
    check('assertAdminNoticeReadState', h.page.data, rawPage.items, h.receipts);
    assert.equal(h.page.data.unreadCount, null);
    assert.equal(
      (
        h.page.data.sources.find(
          (source) => source.source === 'system',
        ) as unknown as { unreadCount: number }
      ).unreadCount,
      5,
    );
    assert.throws(
      () => h.controls.dispatch('onRead', { id: key }),
      'The read row no longer renders an unread action',
    );
    const readAt = h.page.data.items[0]!.readAt;
    // Match the existing PG anti-replay callback test, never a hidden UI click.
    h.page.onRead({ currentTarget: { dataset: { id: key } } });
    await h.idle();
    check('assertSystemNoticeReads', h.calls(), [rawPage.items[0]!.noticeId]);
    check('assertAdminNoticeReadState', h.page.data, rawPage.items, h.receipts);
    assert.equal(h.page.data.items[0]!.readAt, readAt);
    assert.throws(() =>
      check(
        'assertSystemNoticeReads',
        [
          {
            path: `/v1/me/system-notices/${rawPage.items[0]!.noticeId}/read`,
            method: 'PUT',
            body: { target: 'forbidden' },
          },
        ],
        [rawPage.items[0]!.noticeId],
      ),
    );
  } finally {
    h.close();
  }
});

test('actual API schema and actual native decoder both reject identity/content and presentation fields in the raw owner DTO', () => {
  for (const field of [
    'postId',
    'authorId',
    'preview',
    'identity',
    'target',
    'source',
    'summary',
    'timeLabel',
    'observationId',
  ]) {
    const contaminated = structuredClone(rawPage);
    Object.assign(contaminated.items[0]!, { [field]: 'must-not-leak' });
    assert.throws(() => systemNoticesPageSchema.parse(contaminated));
    assert.throws(() => decodeSystemNoticesList(contaminated));
  }
});
