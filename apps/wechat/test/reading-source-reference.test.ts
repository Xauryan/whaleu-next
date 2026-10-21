import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {
  decodeReadingComment,
  decodeReadingPost,
} from '../src/community/reading-contract';
import {
  DEFAULT_TEXT_SOURCE,
  sourceEligible,
  textSourceHash,
  type SourceKind,
  type TextSourceDescriptor,
} from '../src/community/text-source-contract';
import {
  ContentReferenceController,
  initialReferenceView,
  type ReferencePress,
} from '../src/content-references/controller';
import { detailReferenceRows } from '../src/content-references/detail-rows';
import type { ReferenceDestination } from '../src/content-references/contract';
import type { ContentReferencesGateway } from '../src/content-references/gateway';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { SafetyChanges } from '../src/community/safety-changes';
import {
  initialDetailView,
  type DetailView,
} from '../src/pages/community-detail/controller';
import {
  comment,
  post,
  reply,
  postId,
  commentId,
  replyId,
  otherId,
  spaceId,
} from './community-helpers';
import { credentials, deferred, flush, signedIn } from './helpers';
import type { PresentationNode } from './framework7-action-parity';

const requireNative = createRequire(__filename);
const preview: {
  parsePreviewWxml(source: string): PresentationNode;
  evaluatePreviewExpression(
    source: string,
    scope: Record<string, unknown>,
  ): unknown;
} = requireNative('../scripts/preview-wxml.mjs');
const template = preview.parsePreviewWxml(
  readFileSync(
    path.join(__dirname, '../src/pages/community-detail/community-detail.wxml'),
    'utf8',
  ),
);
const nodes = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : nodes(child),
  ),
];
const all = nodes(template);
function evaluate(
  expression: string | undefined,
  scope: Record<string, unknown>,
): unknown {
  assert.ok(typeof expression === 'string');
  assert.ok(expression.startsWith('{{') && expression.endsWith('}}'));
  return preview.evaluatePreviewExpression(expression.slice(2, -2), scope);
}
function registration<T>(kind: 'Page' | 'Component', file: string): T {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals[kind],
    resolved = requireNative.resolve(file);
  let definition: T | undefined;
  try {
    globals[kind] = (value: T) => {
      definition = value;
    };
    delete requireNative.cache[resolved];
    requireNative(resolved);
  } finally {
    if (previous === undefined) delete globals[kind];
    else globals[kind] = previous;
    delete requireNative.cache[resolved];
  }
  assert.ok(definition);
  return definition;
}
interface PageInstance {
  data: Record<string, unknown>;
  referenceController: ContentReferenceController;
  referenceInteractionBlocked(): boolean;
}
interface PageDefinition {
  data: Record<string, unknown>;
  referenceInteractionBlocked(this: PageInstance): boolean;
  onReferencePress(this: PageInstance, event: { detail: ReferencePress }): void;
  onReferenceThread(
    this: PageInstance,
    event: { detail: ReferencePress },
  ): void;
  onSourceThread(
    this: PageInstance,
    event: {
      currentTarget: { dataset: { rowKey?: string; generation?: number } };
    },
  ): void;
}
interface ComponentInstance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  triggerEvent(name: string, detail: ReferencePress): void;
}
type ComponentMethod = (this: ComponentInstance, event?: unknown) => void;
interface ComponentDefinition {
  properties: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, ComponentMethod>;
  lifetimes: Record<string, ComponentMethod>;
  pageLifetimes: Record<string, ComponentMethod>;
}
const pageDefinition = registration<PageDefinition>(
  'Page',
  '../src/pages/community-detail/community-detail.ts',
);
const componentDefinition = registration<ComponentDefinition>(
  'Component',
  '../src/components/reference-text/reference-text.ts',
);
function body(
  kind: SourceKind,
  content: {
    id: string;
    text: string;
    postId?: string;
    rootCommentId?: string;
  },
  descriptor: TextSourceDescriptor,
) {
  const eligible = sourceEligible(content.text, descriptor, kind);
  return {
    classification: 'reviewedSource',
    value: {
      version: 2,
      source: {
        version: 1,
        classification: 'reviewedSource',
        kind,
        id: content.id,
        postId: kind === 'post' ? content.id : content.postId,
        rootCommentId:
          kind === 'post'
            ? null
            : kind === 'comment'
              ? content.id
              : content.rootCommentId,
        text: content.text,
        sourceRevision: 1,
        textSource: {
          ...descriptor,
          sourceHash: textSourceHash(content.text, descriptor),
        },
        readingFormattingEligible: eligible,
        presentationStatus: eligible ? 'not_configured' : 'ineligible',
      },
      presentation: { status: 'source' },
    },
  };
}
function content(
  text: string,
  descriptor: TextSourceDescriptor = DEFAULT_TEXT_SOURCE,
): DetailView {
  const p = post({ text }),
    r = reply({ text });
  const c = comment({
    text,
    replyCount: 1,
    replyPreview: { items: [r], nextCursor: null },
  });
  const root = decodeReadingComment({
    version: 2,
    content: c,
    body: body('comment', c, descriptor),
    replyPreviewBodies: [{ id: r.id, body: body('reply', r, descriptor) }],
  });
  return {
    ...initialDetailView(),
    loaded: true,
    post: decodeReadingPost({
      version: 2,
      content: p,
      body: body('post', p, descriptor),
    }),
    comments: [root],
    locatedComment: root,
  };
}
function owner(
  view: DetailView,
  options: {
    available?: boolean;
    scope?: string;
    resolve?: ContentReferencesGateway['resolve'];
  } = {},
) {
  const sessions = signedIn(),
    privateViews = new PrivateViewLifecycle(),
    browsingScopeChanges = new PrivateViewLifecycle();
  const safetyChanges = new SafetyChanges(privateViews),
    calls: string[] = [],
    resolves: unknown[] = [];
  let references = initialReferenceView();
  const page: PageInstance = {
    data: { ...structuredClone(pageDefinition.data), ...view },
    referenceController: undefined!,
    referenceInteractionBlocked() {
      return pageDefinition.referenceInteractionBlocked.call(this);
    },
  };
  const controller = new ContentReferenceController(
    { sessions, privateViews, browsingScopeChanges, safetyChanges },
    {
      capability: async () => ({ available: options.available !== false }),
      lookup: async () => ({ items: [] }),
      resolve: async (code, cancel, scope) => {
        resolves.push({ code, scope });
        return options.resolve
          ? options.resolve(code, cancel, scope)
          : {
              kind: 'reply',
              postId,
              rootCommentId: commentId,
              replyId,
              ...(scope ? { viewSpaceId: scope } : {}),
            };
      },
    },
    {
      navigateTo: (native) => {
        calls.push(native.url);
        native.success();
      },
    },
    (next) => {
      references = next;
      page.data.references = next;
    },
    options.scope,
    () => !page.referenceInteractionBlocked(),
  );
  page.referenceController = controller;
  controller.reconcile(detailReferenceRows(view), 1);
  return {
    page,
    controller,
    sessions,
    privateViews,
    browsingScopeChanges,
    safetyChanges,
    calls,
    resolves,
    references: () => references,
  };
}
function scope(view: DetailView, references = initialReferenceView()) {
  return {
    post: view.post,
    item: view.comments[0],
    reply: view.comments[0]?.replyPreview.items[0],
    locatedComment: view.locatedComment,
    references,
  };
}
function sourceNode(surface: string) {
  const source = all.find(
    (node) =>
      node.tag === 'wu-source-text' &&
      node.attrs.presentation === `{{${surface}.readingBody.value}}`,
  );
  assert.ok(source);
  return source;
}
function referenceNode(surface: string) {
  const source = sourceNode(surface),
    parent = all.find((node) => node.children.includes(source));
  assert.ok(parent);
  const next = parent.children[parent.children.indexOf(source) + 1];
  assert.ok(next && typeof next !== 'string');
  assert.equal(next.tag, 'wu-reference-text');
  assert.equal(next.attrs['wx:else'], '');
  assert.equal(next.attrs.source, `{{${surface}.text}}`);
  return next;
}
function component(
  renderer: PresentationNode,
  binding: Record<string, unknown>,
  page: PageInstance,
) {
  const instance: ComponentInstance = {
    properties: {
      ...Object.fromEntries(
        Object.entries(componentDefinition.properties).map(([key, value]) => [
          key,
          value.value,
        ]),
      ),
      source: evaluate(renderer.attrs.source, binding),
      rowKey: evaluate(renderer.attrs['row-key'], binding),
      generation: evaluate(renderer.attrs.generation, binding),
      available: evaluate(renderer.attrs.available, binding),
      fallback: renderer.attrs.fallback
        ? evaluate(renderer.attrs.fallback, binding)
        : false,
    },
    data: structuredClone(componentDefinition.data),
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent(name, detail) {
      if (name === 'referencepress')
        pageDefinition.onReferencePress.call(page, { detail });
      else {
        assert.equal(name, 'plaintextpress');
        pageDefinition.onReferenceThread.call(page, { detail });
      }
    },
  };
  for (const [name, method] of Object.entries(componentDefinition.methods))
    instance[name] = method.bind(instance);
  componentDefinition.lifetimes.attached!.call(instance);
  return instance;
}

for (const surface of ['post', 'item', 'reply', 'locatedComment']) {
  test(`${surface}: incoming reviewed plain references use canonical original text and the existing capability-bound action`, async () => {
    const view = content('原文😀 #1234567\n保持原样'),
      original = structuredClone(view),
      s = owner(view, { scope: spaceId });
    await flush();
    const binding = scope(view, s.references()),
      renderer = referenceNode(surface);
    assert.equal(
      evaluate(sourceNode(surface).attrs['wx:if'], binding),
      false,
      'actual source conditional selects adjacent reference renderer',
    );
    assert.equal(renderer.attrs['bind:referencepress'], 'onReferencePress');
    const instance = component(renderer, binding, s.page);
    assert.equal(instance.properties.source, '原文😀 #1234567\n保持原样');
    componentDefinition.methods.onTap!.call(instance, {
      currentTarget: {
        dataset: { index: 1, revision: instance.data.revision },
      },
    });
    await flush();
    assert.deepEqual(s.resolves, [{ code: '1234567', scope: spaceId }]);
    assert.deepEqual(s.calls, [
      `/pages/community-detail/community-detail?postId=${postId}&rootCommentId=${commentId}&replyId=${replyId}&viewSpaceId=${spaceId}`,
    ]);
    assert.deepEqual(
      view,
      original,
      'no source, author, pagination or permission mutation',
    );
    assert.ok(!JSON.stringify(s.calls).includes('personaId'));
    s.controller.dispose();
  });
  test(`${surface}: unavailable reference capability retains exact source and only original thread fallback, never local resolve`, async () => {
    const view = content('原文 #1234567'),
      s = owner(view, { available: false });
    await flush();
    const renderer = referenceNode(surface),
      instance = component(renderer, scope(view, s.references()), s.page);
    assert.equal(instance.properties.source, '原文 #1234567');
    componentDefinition.methods.onTap!.call(instance, {
      currentTarget: {
        dataset: { index: 0, revision: instance.data.revision },
      },
    });
    await flush();
    assert.deepEqual(s.resolves, []);
    const fallback = surface === 'reply' || surface === 'locatedComment';
    assert.equal(s.calls.length, fallback ? 1 : 0);
    if (fallback)
      assert.equal(
        s.calls[0],
        `/pages/community-thread/community-thread?postId=${postId}&rootCommentId=${commentId}${surface === 'reply' ? `&replyId=${replyId}` : ''}`,
      );
    s.controller.dispose();
  });
  test(`${surface}: explicit Markdown selects only action-free renderer, never reference token inference`, () => {
    const view = content('# 标题\n**正文**', {
      version: 1,
      format: 'markdown',
    });
    assert.equal(
      evaluate(sourceNode(surface).attrs['wx:if'], scope(view)),
      true,
    );
    assert.equal(referenceNode(surface).attrs['wx:else'], '');
    assert.ok(
      !Object.keys(sourceNode(surface).attrs).some((key) =>
        key.startsWith('bind'),
      ),
    );
  });
}
for (const surface of ['reply', 'locatedComment']) {
  for (const descriptor of [
    DEFAULT_TEXT_SOURCE,
    { version: 1, format: 'markdown' },
  ] as const) {
    test(`${surface}/${descriptor.format}: explicit source thread control works for exact preview/off-page root without located reply`, async () => {
      const initial = content('原文😀', descriptor);
      const view =
        surface === 'locatedComment' ? { ...initial, comments: [] } : initial;
      const s = owner(view, { scope: spaceId });
      await flush();
      const binding = { ...s.page.data, ...scope(view, s.references()) };
      const button = all.find(
        (node) =>
          node.attrs.bindtap === 'onSourceThread' &&
          node.attrs['data-row-key']?.includes(`${surface}.id`),
      );
      assert.ok(button);
      assert.equal(evaluate(button.attrs['wx:if'], binding), true);
      assert.equal(evaluate(button.attrs.disabled, binding), false);
      assert.equal(view.locatedReplyId, '');
      const rowKey = evaluate(button.attrs['data-row-key'], binding),
        generation = evaluate(button.attrs['data-generation'], binding);
      assert.ok(typeof rowKey === 'string' && typeof generation === 'number');
      const event = { currentTarget: { dataset: { rowKey, generation } } };
      pageDefinition.onSourceThread.call(s.page, event);
      assert.deepEqual(s.calls, [
        `/pages/community-thread/community-thread?postId=${postId}&rootCommentId=${commentId}${surface === 'reply' ? `&replyId=${replyId}` : ''}&viewSpaceId=${spaceId}`,
      ]);
      s.calls.length = 0;
      for (const patch of [
        { busy: true },
        { needsReload: true },
        { loaded: false },
        { uiExpandedMenu: 'located' },
      ]) {
        const before = s.page.data;
        s.page.data = { ...before, ...patch };
        pageDefinition.onSourceThread.call(s.page, event);
        s.page.data = before;
      }
      pageDefinition.onSourceThread.call(s.page, {
        currentTarget: {
          dataset: { rowKey: `comment:${otherId}`, generation },
        },
      });
      s.controller.suspend();
      pageDefinition.onSourceThread.call(s.page, event);
      assert.deepEqual(s.calls, []);
      s.controller.dispose();
    });
  }
}
for (const boundary of ['hide', 'account', 'same-login', 'scope', 'safety']) {
  test(`reviewed source references: ${boundary} suppresses delayed resolution and clears all current capability state`, async () => {
    const pending = deferred<ReferenceDestination>(),
      view = content('原文 #1234567');
    const s = owner(view, { resolve: () => pending.promise });
    await flush();
    const instance = component(
      referenceNode('reply'),
      scope(view, s.references()),
      s.page,
    );
    componentDefinition.methods.onTap!.call(instance, {
      currentTarget: {
        dataset: { index: 1, revision: instance.data.revision },
      },
    });
    await flush();
    assert.equal(
      s.resolves.length,
      1,
      'the intended source-reference action actually reached the owner',
    );
    if (boundary === 'hide') {
      componentDefinition.pageLifetimes.hide!.call(instance);
      s.privateViews.clear();
    }
    if (boundary === 'account')
      s.sessions.completeLogin(s.sessions.beginLogin(), credentials('13'));
    if (boundary === 'same-login')
      s.sessions.completeLogin(s.sessions.beginLogin(), credentials());
    if (boundary === 'scope') s.browsingScopeChanges.clear('12');
    if (boundary === 'safety') s.safetyChanges.invalidate('12');
    pending.resolve({
      kind: 'reply',
      postId,
      rootCommentId: commentId,
      replyId,
    });
    await flush();
    assert.deepEqual(s.calls, []);
    assert.equal(s.references().available, false);
    assert.deepEqual(s.references().codes, {});
    s.controller.dispose();
  });
}

test('legacy detail and thread DTOs without any source descriptor never evaluate a nested source field or activate source actions', () => {
  const legacyRoot = comment({
    replyPreview: { items: [reply()], nextCursor: null },
  });
  const binding = {
    post: post(),
    item: legacyRoot,
    reply: legacyRoot.replyPreview.items[0],
    locatedComment: legacyRoot,
    root: legacyRoot,
  };
  for (const surface of ['post', 'item', 'reply', 'locatedComment']) {
    assert.match(
      sourceNode(surface).attrs['wx:if']!,
      new RegExp(`${surface}\\.readingBody &&`),
    );
    assert.equal(
      Boolean(evaluate(sourceNode(surface).attrs['wx:if'], binding)),
      false,
    );
  }
  for (const button of all.filter(
    (node) => node.attrs.bindtap === 'onSourceThread',
  ))
    assert.equal(Boolean(evaluate(button.attrs['wx:if'], binding)), false);
  const thread = preview.parsePreviewWxml(
    readFileSync(
      path.join(
        __dirname,
        '../src/pages/community-thread/community-thread.wxml',
      ),
      'utf8',
    ),
  );
  const renderers = nodes(thread).filter(
    (node) => node.tag === 'wu-source-text',
  );
  assert.equal(renderers.length, 2);
  for (const renderer of renderers)
    assert.equal(Boolean(evaluate(renderer.attrs['wx:if'], binding)), false);
});
