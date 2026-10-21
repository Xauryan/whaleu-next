import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Pure UI guard, source by default or an explicitly selected prebuilt artifact.
// No build, HTTP, PG or provider runs. Initial view fixtures
// are explicit here, never injected into a PG worker. The real Page disclosure,
// WXML, Component and triggerEvent execute.
const require = createRequire(__filename);
const sourceRoot = path.resolve(__dirname, '../src');
const root = path.resolve(process.env.WHALEU_WECHAT_DIST ?? sourceRoot);
const extension = process.env.WHALEU_WECHAT_DIST ? 'js' : 'ts';
const workerRoot = path.resolve(__dirname, '../../api/test/support');
type Dataset = Record<string, string>;
interface Owner {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  [name: string]: unknown;
}
interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: (Node | string)[];
}
interface Bridge {
  capture(
    handler: string,
    dataset?: Dataset,
  ): {
    press(): boolean;
    detach(): void;
  };
  lifecycle(event: string): void;
  sync(): void;
  emissions: { currentTarget: { dataset: Dataset } }[];
}
const { parse, render } = require('../scripts/smoke-ratings.mjs') as {
  parse(source: string): Node;
  render(
    nodes: (Node | string)[],
    data: object,
    templates: Record<string, Node>,
  ): (Node | string)[];
};
const { createNativePgControls } =
  require('../../api/test/support/native-pg-control-adapter.mjs') as {
    createNativePgControls(options: {
      page: Owner;
      pageFile: string;
      dist: string;
      extension: 'ts' | 'js';
      renderNodes(): (Node | string)[];
    }): { press: Bridge; dispatch(handler: string, dataset?: Dataset): void };
  };
const workerFiles: Record<string, string> = {
  'category-reclassification-native-worker':
    '../integration/helpers/category-reclassification-native-worker.mjs',
  'owner-post-visibility-native-worker':
    '../integration/owner-post-visibility-native-worker.mjs',
  'related-sync-native-child':
    '../../../wechat/scripts/related-sync-native-child.mjs',
};
const flatten = (nodes: (Node | string)[]): Node[] =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [] : [node, ...flatten(node.children)],
  );
const readWorker = (name: string) =>
  ts.createSourceFile(
    name,
    readFileSync(
      path.resolve(workerRoot, workerFiles[name] ?? `${name}.mjs`),
      'utf8',
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
const helperNames = new Set([
  'openComposer',
  'openComposePanel',
  'openQrPanel',
  'openManagementMenu',
  'openMediaPanel',
  'openIdentityPanel',
  'openPostMenu',
  'openConversationPanel',
  'openRecoveryActions',
  'openMessageMenu',
  'openRemovalMenu',
  'openCampusPicker',
]);
function helper(name: string, helperName: string) {
  const source = readWorker(name);
  const value = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === helperName,
  );
  assert.ok(value, `${name} has its explicit disclosure journey`);
  assert.doesNotMatch(
    value.getText(source),
    /setData|\.page\.on|capture|disabled\s*=/,
    'The worker opens controls with visible taps, not page handlers or injected state',
  );
  return (h: unknown, args: string[]) =>
    runInNewContext(`(${value.getText(source)})(h, ...args)`, {
      assert,
      h,
      args,
    });
}
function mount(name: string, initial: Record<string, unknown>) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    Page: globals.Page,
    getApp: globals.getApp,
    wx: globals.wx,
  };
  let page: Owner | undefined;
  globals.Page = (value: Owner) => {
    page = value;
  };
  globals.getApp = () => ({});
  globals.wx = {};
  const pageFile = path.join(root, `pages/${name}/${name}`);
  delete require.cache[require.resolve(`${pageFile}.${extension}`)];
  require(`${pageFile}.${extension}`);
  assert.ok(page, 'Production source entrypoint registers the Page');
  const owner = page;
  owner.data = { ...structuredClone(owner.data), ...structuredClone(initial) };
  owner.setData = (patch) => {
    Object.assign(owner.data, patch);
  };
  const templates: Record<string, Node> = {};
  const visited = new Set<string>();
  function tree(file: string): Node {
    assert.ok(file.startsWith(`${root}${path.sep}`));
    visited.add(file);
    const result = parse(readFileSync(file, 'utf8'));
    for (const node of flatten(result.children)) {
      if (node.tag === 'import') {
        const dependency = path.resolve(path.dirname(file), node.attrs.src!);
        if (!visited.has(dependency)) tree(dependency);
      }
      if (node.tag === 'template' && node.attrs.name)
        templates[node.attrs.name] = node;
    }
    return result;
  }
  const wxml = tree(`${pageFile}.wxml`);
  const renderNodes = () =>
    render(
      wxml.children.filter(
        (node) =>
          typeof node === 'string' ||
          node.tag !== 'template' ||
          !node.attrs.name,
      ),
      owner.data,
      templates,
    );
  const controls = createNativePgControls({
    page: owner,
    pageFile,
    dist: root,
    extension,
    renderNodes,
  });
  const bridge = controls.press;
  const taps: { handler: string; dataset: Dataset }[] = [];
  let visible = true;
  return {
    page: owner,
    bridge,
    taps,
    tap(handler: string, dataset: Dataset = {}) {
      controls.dispatch(handler, dataset);
      taps.push({ handler, dataset: structuredClone(dataset) });
    },
    event(binding: string, handler: string, detail: object, dataset: Dataset) {
      assert.equal(visible, true);
      assert.equal(binding, 'bindlongpress');
      assert.equal(handler, 'onMessageMenu');
      const node = flatten(renderNodes()).find(
        (node) =>
          node.tag === 'view' &&
          node.attrs.bindlongpress === handler &&
          node.attrs['data-id'] === dataset.id,
      );
      assert.ok(node, 'Actual native message view exposes its long-press menu');
      (owner[handler] as (event: object) => void).call(owner, {
        detail,
        currentTarget: { dataset },
      });
      taps.push({ handler, dataset: structuredClone(dataset) });
    },
    hide() {
      visible = false;
      (owner.onHide as () => void).call(owner);
    },
    find(handler: string, dataset: Dataset = {}) {
      return flatten(
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
      ).find(
        (node) =>
          Object.entries(node.attrs).some(
            ([key, value]) => /^(bind|catch)/.test(key) && value === handler,
          ) &&
          Object.entries(dataset).every(
            ([key, value]) => node.attrs[`data-${key}`] === value,
          ),
      );
    },
    close() {
      bridge.lifecycle('detach');
      Object.assign(globals, previous);
    },
  };
}
interface Journey {
  worker: string;
  page: string;
  helper: string;
  args?: string[];
  rawDisclosure?: boolean;
  initial: Record<string, unknown>;
  disclosure: string;
  dataset: Dataset;
  target: string;
  targetDataset?: Dataset;
}
const journeys: Journey[] = [];
for (const kind of ['window', 'major']) {
  for (const suffix of ['', '-images']) {
    for (const thread of ['', '-thread'])
      journeys.push({
        worker: `${kind}-discussion${suffix}-native-worker`,
        page: `${kind}-discussion${thread}`,
        helper: 'openComposer',
        initial: { loaded: true, hasSession: true, imageEnabled: true },
        disclosure: kind === 'window' ? 'onOpenComposer' : 'onTogglePanel',
        dataset: kind === 'window' ? {} : { panel: 'compose' },
        target: suffix ? 'onPickImage' : 'onBody',
        targetDataset: suffix ? { source: 'album' } : {},
      });
  }
}
for (const worker of [
  'errand-group-native-worker',
  'errand-media-native-worker',
]) {
  for (const field of ['private', 'images'])
    journeys.push({
      worker,
      page: 'errand-compose',
      helper: 'openComposePanel',
      args: [field],
      initial: { loaded: true },
      disclosure: 'onTogglePanel',
      dataset: { field },
      target: field === 'private' ? 'onForm' : 'onChooseOrderImage',
      targetDataset:
        field === 'private' ? { field: 'privateText' } : { value: 'public0' },
    });
}
journeys.push(
  {
    worker: 'errand-target-services-native-worker',
    page: 'school-configuration',
    helper: 'openQrPanel',
    initial: { loaded: true, management: 'campus', form: { kind: 'group' } },
    disclosure: 'onToggleUiPanel',
    dataset: { panel: 'qr' },
    target: 'onPickQr',
  },
  {
    worker: 'post-pins-native-worker',
    page: 'community-detail',
    helper: 'openManagementMenu',
    initial: {
      loaded: true,
      postPin: {
        loaded: true,
        busy: false,
        frozen: false,
        detail: { canPin: true, canUnpin: true },
      },
    },
    disclosure: 'onToggleMenu',
    dataset: { menu: 'management' },
    target: 'onPinCreate',
  },
);

journeys.push(
  {
    worker: 'private-message-images-native-worker',
    page: 'private-message-recovery',
    helper: 'openRecoveryActions',
    initial: { loaded: true, pending: true, canRetry: true },
    disclosure: 'onToggleActions',
    dataset: {},
    target: 'onRetry',
  },
  {
    worker: 'private-message-images-native-worker',
    page: 'private-message-detail',
    helper: 'openMediaPanel',
    rawDisclosure: true,
    initial: {
      loaded: true,
      canSend: true,
      conversation: {
        id: 'conversation',
        peer: { displayName: 'Peer' },
        self: { mode: 'named' },
      },
    },
    disclosure: 'onTogglePanel',
    dataset: { panel: 'media' },
    target: 'onImageAlbum',
  },
  {
    worker: 'category-reclassification-native-worker',
    page: 'community-detail',
    helper: 'openManagementMenu',
    initial: {
      loaded: true,
      categoryManagement: {
        busy: false,
        frozen: false,
        management: {
          postId: 'post',
          canChange: true,
          currentCategory: 'pets',
          targets: ['scenery'],
        },
      },
    },
    disclosure: 'onToggleMenu',
    dataset: { menu: 'management' },
    target: 'onCategoryChoose',
    targetDataset: { id: 'post', category: 'scenery' },
  },
  {
    worker: 'owner-post-visibility-native-worker',
    page: 'community-detail',
    helper: 'openManagementMenu',
    initial: {
      loaded: true,
      ownerVisibility: {
        busy: false,
        frozen: false,
        management: { postId: 'post', canChange: true, ownerHidden: true },
      },
    },
    disclosure: 'onToggleMenu',
    dataset: { menu: 'management' },
    target: 'onOwnerVisibilityUnhide',
    targetDataset: { id: 'post' },
  },
  {
    worker: 'related-sync-native-child',
    page: 'community-compose',
    helper: 'openIdentityPanel',
    initial: {
      loaded: true,
      hasSession: true,
      canChooseRelatedCampusSync: true,
    },
    disclosure: 'onToggleComposePanel',
    dataset: { panel: 'identity' },
    target: 'onRelatedCampusSync',
  },
  {
    worker: 'admin-post-removal-native-child',
    page: 'community-detail',
    helper: 'openPostMenu',
    initial: {
      loaded: true,
      post: {
        id: 'post',
        author: { kind: 'anonymous', displayName: 'Author' },
        viewer: { isSelf: false },
        text: 'post',
        images: [],
        likeCount: 0,
        space: { id: 'space' },
        component: { kind: 'none' },
      },
    },
    disclosure: 'onToggleMenu',
    dataset: { menu: 'post' },
    target: 'onAdminPostRemoval',
  },
);

const conversationFixture = {
  id: 'conversation',
  peer: { displayName: 'Peer' },
  self: { mode: 'named' },
};
const postFixture = {
  id: 'post',
  author: { kind: 'anonymous', displayName: 'Author' },
  viewer: { isSelf: false },
  text: 'post',
  images: [],
  likeCount: 0,
  space: { id: 'space' },
  component: { kind: 'none' },
};
const replyFixture = {
  id: 'reply',
  target: { status: 'unavailable' },
  text: 'reply',
  images: [],
  author: { kind: 'anonymous', displayName: 'Peer' },
  viewer: { isSelf: false },
};
const commentFixture = {
  ...replyFixture,
  id: 'comment',
  replyPreview: { items: [replyFixture], total: 1 },
  replyCount: 1,
};
journeys.push(
  {
    worker: 'private-message-images-native-worker',
    page: 'private-message-detail',
    helper: 'openConversationPanel',
    rawDisclosure: true,
    initial: { loaded: true, canSend: true, conversation: conversationFixture },
    disclosure: 'onTogglePanel',
    dataset: { panel: 'conversation' },
    target: 'onAction',
    targetDataset: { kind: 'hide' },
  },
  {
    worker: 'related-sync-native-child',
    page: 'community-detail',
    helper: 'openManagementMenu',
    initial: {
      loaded: true,
      postPin: {
        loaded: true,
        busy: false,
        frozen: false,
        detail: { canPin: true },
      },
    },
    disclosure: 'onToggleMenu',
    dataset: { menu: 'management' },
    target: 'onPinCreate',
  },
);
for (const kind of ['post', 'comment', 'reply'])
  journeys.push({
    worker: 'related-sync-native-child',
    page: 'community-detail',
    helper: 'openRemovalMenu',
    args: [kind, kind],
    initial: { loaded: true, post: postFixture, comments: [commentFixture] },
    disclosure: 'onToggleMenu',
    dataset: { menu: kind === 'post' ? 'post' : `${kind}:${kind}` },
    target: kind === 'post' ? 'onAdminPostRemoval' : 'onAdminDiscussionRemoval',
    targetDataset: kind === 'post' ? {} : { kind, id: kind },
  });
test('private image recall uses the actual message long-press, without admitting hidden or stale menus', () => {
  const message = {
    id: 'message',
    state: 'image',
    canRecall: true,
    sender: 'self',
  };
  const h = mount('private-message-detail', {
    loaded: true,
    conversation: conversationFixture,
    messages: [message],
    uiMessages: [message],
  });
  try {
    assert.equal(
      h.find('onAction', { kind: 'recall', id: 'message' }),
      undefined,
    );
    const open = helper(
      'private-message-images-native-worker',
      'openMessageMenu',
    );
    open(h, ['message']);
    assert.equal(h.page.data.uiMessageMenu, 'message');
    assert.ok(h.find('onAction', { kind: 'recall', id: 'message' }));
    open(h, ['message']);
    assert.deepEqual(h.taps, [
      { handler: 'onMessageMenu', dataset: { id: 'message' } },
    ]);
    h.hide();
    assert.throws(() => open(h, ['message']));
  } finally {
    h.close();
  }
});
test('related-sync browsing opens Home menu then campus picker without changing the frozen Home implementation', () => {
  const h = mount('community-feed', {
    loaded: true,
    campusId: 'before',
    homeTab: 'campus',
    campuses: [{ id: 'after', fullName: 'After', isActive: true }],
  });
  try {
    assert.equal(h.find('onCampus', { id: 'after' }), undefined);
    const open = helper('related-sync-native-child', 'openCampusPicker');
    open(h, []);
    assert.ok(h.find('onCampus', { id: 'after' }));
    open(h, []);
    assert.deepEqual(h.taps, [
      { handler: 'onToggleHomeMenu', dataset: {} },
      { handler: 'onToggleCampusPicker', dataset: {} },
    ]);
  } finally {
    h.close();
  }
});
test('owner visibility My Publications preserves direct row actions without inventing a detail menu', () => {
  const h = mount('community-mine', {
    loaded: true,
    publications: [
      {
        id: 'post',
        status: 'published',
        ownerVisibility: { canChange: true, ownerHidden: false },
      },
    ],
  });
  try {
    assert.ok(h.find('onOwnerVisibilityHide', { id: 'post' }));
    helper('owner-post-visibility-native-worker', 'openManagementMenu')(h, []);
    assert.equal(h.taps.length, 0);
    assert.ok(h.find('onOwnerVisibilityHide', { id: 'post' }));
  } finally {
    h.close();
  }
});
for (const journey of journeys)
  test(`${journey.worker} ${journey.page} ${journey.target}: real disclosure before control, idempotent and hide-fenced`, () => {
    const h = mount(journey.page, journey.initial);
    const open = helper(journey.worker, journey.helper);
    try {
      assert.equal(
        h.find(journey.target, journey.targetDataset),
        undefined,
        'Old journey targets an actually unrendered control',
      );
      open(h, journey.args ?? []);
      assert.equal(
        h.bridge.emissions.length,
        journey.rawDisclosure ? 0 : 1,
        'Custom disclosures use their actual F7 Component; native buttons retain their raw path',
      );
      assert.deepEqual(h.taps, [
        { handler: journey.disclosure, dataset: journey.dataset },
      ]);
      if (!journey.rawDisclosure)
        assert.deepEqual(
          h.bridge.emissions[0]!.currentTarget.dataset,
          journey.dataset,
        );
      assert.ok(
        h.find(journey.target, journey.targetDataset),
        'Disclosure rendered the original target',
      );
      if (journey.helper === 'openComposer')
        assert.ok(
          h.find('onBody'),
          'Image and text composition share the real sheet',
        );
      open(h, journey.args ?? []);
      assert.equal(
        h.taps.length,
        1,
        'Reusing the visible panel must not close it',
      );
      if (journey.rawDisclosure) {
        h.hide();
        assert.throws(() => h.tap(journey.disclosure, journey.dataset));
      } else {
        const retained = h.bridge.capture(journey.disclosure, journey.dataset);
        h.bridge.lifecycle('hide');
        assert.equal(
          retained.press(),
          false,
          'Hidden native components cannot reopen a panel',
        );
        retained.detach();
      }
      assert.equal(h.taps.length, 1);
    } finally {
      h.close();
    }
  });
for (const journey of journeys.filter((value) =>
  [
    'openComposer',
    'openComposePanel',
    'openMediaPanel',
    'openRecoveryActions',
  ].includes(value.helper),
))
  test(`${journey.worker} ${journey.page} ${journey.target}: busy disclosure cannot be bypassed`, () => {
    const h = mount(journey.page, { ...journey.initial, busy: true });
    try {
      assert.throws(() =>
        helper(journey.worker, journey.helper)(h, journey.args ?? []),
      );
      assert.equal(h.bridge.emissions.length, 0);
      assert.equal(h.find(journey.target, journey.targetDataset), undefined);
    } finally {
      h.close();
    }
  });

test('private image recovery reopens the real actions sheet before each same-request retry', () => {
  const initial = {
    loaded: true,
    pending: true,
    canRetry: true,
    operation: 'send_image',
    requestId: 'original-image-request',
    conversationId: 'original-conversation',
    error: 'unknown outcome',
  };
  const h = mount('private-message-recovery', initial);
  const retries: unknown[] = [];
  // Isolate the actual Page event wiring, without initiating transport. The
  // existing recovery suite separately exercises same-key/unknown-outcome I/O.
  h.page.controller = {
    recover: (retry: unknown) => {
      retries.push(retry);
    },
  };
  const open = helper(
    'private-message-images-native-worker',
    'openRecoveryActions',
  );
  try {
    assert.throws(() => h.tap('onRetry'));
    assert.ok(h.find('onReceipt'), 'Receipt query never needs the retry sheet');
    for (let attempt = 0; attempt < 2; attempt++) {
      open(h, []);
      h.tap('onRetry');
      assert.equal(
        h.page.data.uiActions,
        false,
        'Actual retry closes its sheet',
      );
      assert.throws(
        () => h.tap('onRetry'),
        'The next retry cannot skip disclosure',
      );
      for (const [key, value] of Object.entries(initial))
        assert.equal(h.page.data[key], value);
    }
    assert.deepEqual(retries, [true, true]);
    assert.deepEqual(
      h.taps.map((tap) => tap.handler),
      ['onToggleActions', 'onRetry', 'onToggleActions', 'onRetry'],
    );
    assert.equal(h.bridge.emissions.length, 4);
  } finally {
    h.close();
  }
});
test('private image recovery disclosure does not create retry authority or a new request', () => {
  const h = mount('private-message-recovery', {
    loaded: true,
    pending: true,
    canRetry: false,
    operation: 'send_image',
    requestId: 'original-receipt-only-request',
  });
  try {
    helper('private-message-images-native-worker', 'openRecoveryActions')(
      h,
      [],
    );
    assert.equal(h.find('onRetry'), undefined);
    assert.throws(() => h.tap('onRetry'));
    assert.equal(h.page.data.canRetry, false);
    assert.equal(h.page.data.requestId, 'original-receipt-only-request');
    assert.equal(h.page.data.pending, true);
    assert.equal(h.bridge.emissions.length, 1);
    assert.ok(h.find('onReceipt'));
  } finally {
    h.close();
  }
});
test('private image recovery worker explicitly opens actions immediately before both retries', () => {
  const source = readWorker('private-message-images-native-worker');
  let guarded = 0;
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'recovery.tap' &&
      node.arguments[0]?.getText(source) === "'onRetry'"
    ) {
      let statement: ts.Node = node;
      while (statement.parent && !ts.isBlock(statement.parent))
        statement = statement.parent;
      assert.ok(statement.parent && ts.isBlock(statement.parent));
      const statements = [...statement.parent.statements];
      const index = statements.indexOf(statement as ts.Statement);
      assert.ok(index > 0);
      assert.equal(
        statements[index - 1]!.getText(source),
        'openRecoveryActions(recovery);',
      );
      guarded++;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(guarded, 2);
});

// Original assertions from ad61a16b are audited independently of the newly added
// helper assertions: payload/privacy/session/recovery checks may not disappear.
const originalAssertions: Record<string, [number, string]> = {
  'window-discussion-native-worker': [
    52,
    'f46956a705a571075e4238c05f7bd1f3c3528e8c94784d109d32cc82274c47bd',
  ],
  'window-discussion-images-native-worker': [
    55,
    '6ff542252d0d19b46d5568fd1fc17fa4cf6b50d5761cb763213f287854996473',
  ],
  'major-discussion-native-worker': [
    82,
    'a579ed593f7490b8da3c1393c8531c4289f655396b06624f16b68bce661d4ea2',
  ],
  'major-discussion-images-native-worker': [
    74,
    '568d574a28a293821a39fd117d738f38f5ac1f219aa4971e5ecda357ce90e31a',
  ],
  'errand-group-native-worker': [
    9,
    '46362fc042747371194743ca22ed129b63888a926118bfcd701df97515b53333',
  ],
  'errand-media-native-worker': [
    17,
    '8c2d247d663db8462295efd86890f84e8c74650b8e616f4b222cb9615632c752',
  ],
  'errand-target-services-native-worker': [
    29,
    'e6da585e8d899910e8c2f95c276854c94e46b3ebffd08bab63172f0e7f0d0773',
  ],
  'post-pins-native-worker': [
    48,
    '6fc4e5b4e358ee5df5a54b7a9395d904bab37fdb96393666b531a35ae0231f6e',
  ],
  'private-message-images-native-worker': [
    24,
    'ded72cde004c7790cec15f9c9bd7141f78b5fe18c11ef8c7e940bb640db0887d',
  ],
  'category-reclassification-native-worker': [
    42,
    '3dbde36f8617a19a269e5ee33223d7367a129c866a89a2516902f8954339db57',
  ],
  'owner-post-visibility-native-worker': [
    46,
    '0378c5e048594d4c6d17fcda49bbdb28f4bcd176541c0a90e2c20f480b32cdb7',
  ],
  'related-sync-native-child': [
    129,
    '9cb7dea1af4f6a3b7441a436320849a54ff7f3d627b193386946bd9f7bc7c669',
  ],
  'admin-post-removal-native-child': [
    71,
    'a2dfb6c159e6c10ddf7be515051c52ed004b8141c1f545f65566f444c836bf62',
  ],
};
const terminologySuccessors: Record<
  string,
  { before: string; after: string; source: string; text: string }
> = {
  'admin-post-removal-native-child': {
    before: 'assert.match(words, /评论、回复将不可访问/)',
    after: 'assert.match(words, /此主题及其全部回复将不可访问/)',
    source: 'pages/admin-post-removal/admin-post-removal.wxml',
    text: '此主题及其全部回复将不可访问',
  },
  'major-discussion-native-worker': {
    before: 'assert.match(text(h), /这条评论当前不可查看/)',
    after: 'assert.match(text(h), /这条回复当前不可查看/)',
    source: 'major-discussion/errors.ts',
    text: '这条回复当前不可查看',
  },
};
for (const [worker, successor] of Object.entries(terminologySuccessors))
  test(`${worker}: only the exact current reply terminology replaces its historical copy assertion`, () => {
    const source = readWorker(worker).text;
    assert.equal(source.split(successor.after).length - 1, 1);
    assert.equal(source.includes(successor.before), false);
    assert.ok(
      readFileSync(path.join(sourceRoot, successor.source), 'utf8').includes(
        successor.text,
      ),
    );
  });
// The owner count now belongs to the system source, not the aggregate timeline.
// Actual DTO/projection/read behavior is exercised by admin-removal-native-notice-journey.test.ts.
const ownerCountSuccessor = {
  before: 'assert.equal(h.page.data.unreadCount, 5)',
  after:
    "assert.equal(h.page.data.sources.find((source) => source.source === 'system')\n    .unreadCount, 5)",
};
const noticeAssertionHelpers = new Set([
  'assertAdminNoticePresentation',
  'assertSystemNoticeReads',
  'assertAdminNoticeReadState',
]);
const printer = ts.createPrinter({ removeComments: true });
for (const [worker, [count, digest]] of Object.entries(originalAssertions))
  test(`${worker}: preserves original assertion ASTs except audited terminology and owner-count successors`, () => {
    const source = readWorker(worker);
    const assertions: string[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isFunctionDeclaration(node) &&
        (helperNames.has(node.name?.text ?? '') ||
          (worker === 'admin-post-removal-native-child' &&
            noticeAssertionHelpers.has(node.name?.text ?? '')))
      )
        return;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === 'assert'
      ) {
        let printed = printer.printNode(ts.EmitHint.Unspecified, node, source);
        const successor = terminologySuccessors[worker];
        if (successor && printed === successor.after)
          printed = successor.before;
        if (
          worker === 'admin-post-removal-native-child' &&
          printed === ownerCountSuccessor.after
        )
          printed = ownerCountSuccessor.before;
        assertions.push(printed);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    assert.equal(assertions.length, count);
    assert.equal(
      createHash('sha256').update(JSON.stringify(assertions)).digest('hex'),
      digest,
    );
  });
for (const kind of ['window', 'major'])
  for (const suffix of ['', '-images'])
    test(`${kind}${suffix}: every body interaction follows explicit composer admission`, () => {
      const source = readWorker(`${kind}-discussion${suffix}-native-worker`);
      let guarded = 0;
      function visit(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          node.arguments[0]?.getText(source) === "'bindinput'" &&
          node.arguments[1]?.getText(source) === "'onBody'"
        ) {
          let statement: ts.Node = node;
          while (statement.parent && !ts.isBlock(statement.parent))
            statement = statement.parent;
          assert.ok(statement.parent && ts.isBlock(statement.parent));
          const statements = [...statement.parent.statements];
          const index = statements.indexOf(statement as ts.Statement);
          assert.ok(index > 0);
          assert.equal(
            statements[index - 1]!.getText(source),
            'openComposer(h);',
          );
          guarded++;
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      assert.equal(guarded, suffix ? 2 : 5);
    });
