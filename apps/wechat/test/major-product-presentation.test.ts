import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';
import { initialMajorDiscussionView } from '../src/major-discussion/controller';
import {
  initialMajorDiscussionImageView,
  initialMajorDiscussionGalleryView,
} from '../src/major-discussion/image-runtime';
import { item, rootId } from './major-discussion-helpers';

type Element = { tag: string; attrs: Record<string, string>; children: Node[] };
type Node = string | Element;
type Action = {
  tag: string;
  template: string;
  attrs: Record<string, string>;
  ancestors: Record<string, string>[];
};
const requireNative = createRequire(__filename);
const { parsePreviewWxml: parse } = requireNative(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): Element };
const { render } = requireNative('../scripts/smoke-ratings.mjs') as {
  render(
    nodes: Node[],
    scope: unknown,
    templates: Record<string, Element>,
  ): Node[];
};
const root = path.join(__dirname, '../src');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const inventory = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/major-product-action-inventory.json'),
    'utf8',
  ),
) as Record<string, Action[]>;
function actions(
  nodes: Node[],
  ancestors: Record<string, string>[] = [],
  template = '',
): Action[] {
  const result: Action[] = [];
  let branches: string[] = [];
  for (const node of nodes) {
    if (typeof node === 'string') continue;
    const { tag, attrs, children } = normalizeFramework7ActionNode(node);
    const currentTemplate =
      tag === 'template' && attrs.name ? attrs.name : template;
    if ('wx:if' in attrs) branches = [attrs['wx:if']!];
    else if ('wx:elif' in attrs) branches.push(attrs['wx:elif']!);
    else if (!('wx:else' in attrs)) branches = [];
    const guards: Record<string, string> = Object.fromEntries(
      Object.entries(attrs).filter(([key]) =>
        [
          'wx:if',
          'wx:elif',
          'wx:else',
          'wx:for',
          'wx:for-item',
          'wx:key',
        ].includes(key),
      ),
    );
    if ('wx:elif' in attrs || 'wx:else' in attrs)
      guards.precedingBranches = JSON.stringify(
        branches.slice(0, 'wx:elif' in attrs ? -1 : undefined),
      );
    if (
      tag === 'navigator' ||
      Object.keys(attrs).some((key) => /^(bind|catch)/.test(key))
    )
      result.push({
        tag,
        template: currentTemplate,
        attrs: Object.fromEntries(
          Object.entries(attrs).filter(
            ([key]) =>
              ![
                'class',
                'style',
                'placeholder',
                'aria-label',
                'aria-role',
              ].includes(key),
          ),
        ),
        ancestors,
      });
    result.push(
      ...actions(
        children,
        Object.keys(guards).length ? [...ancestors, guards] : ancestors,
        currentTemplate,
      ),
    );
  }
  return result;
}
const contains = (
  actual: Record<string, string>,
  expected: Record<string, string>,
) => Object.entries(expected).every(([key, value]) => actual[key] === value);
for (const [file, original] of Object.entries(inventory)) {
  test(`${file} retains original handlers, bindings and complete ancestor guards`, () => {
    const current = actions(
      parse(read(file.replace('/common.wxml', '/framework7-product.wxml')))
        .children,
    );
    for (const action of original) {
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === action.tag &&
          candidate.template === action.template &&
          contains(candidate.attrs, action.attrs) &&
          action.ancestors.every((guard) =>
            candidate.ancestors.some((ancestor) => contains(ancestor, guard)),
          ),
      );
      assert.notEqual(
        index,
        -1,
        `Missing or weakened action: ${JSON.stringify(action)}`,
      );
      current.splice(index, 1);
    }
  });
}
const templates = Object.fromEntries(
  parse(read('major-discussion/framework7-product.wxml'))
    .children.filter(
      (node): node is Element => typeof node !== 'string' && !!node.attrs.name,
    )
    .map((node) => [node.attrs.name!, node]),
);
const flatten = (nodes: Node[]): Node[] =>
  nodes.flatMap((node) =>
    typeof node === 'string'
      ? [node]
      : [normalizeFramework7ActionNode(node), ...flatten(node.children)],
  );
function rendered(patch: Record<string, unknown>, page = 'major-discussion') {
  return flatten(
    render(
      parse(read(`pages/${page}/${page}.wxml`)).children,
      {
        ...initialMajorDiscussionView(),
        ...initialMajorDiscussionImageView(),
        ...initialMajorDiscussionGalleryView(),
        uiPanel: '',
        timeLabels: {},
        ...patch,
      },
      templates,
    ),
  );
}
const buttons = (nodes: Node[], handler: string) =>
  nodes.filter(
    (node): node is Element =>
      typeof node !== 'string' &&
      node.tag === 'button' &&
      node.attrs.bindtap === handler,
  );
const text = (nodes: Node[]) =>
  nodes.filter((node) => typeof node === 'string').join(' ');

test('public surfaces import only isolated product styles and registered real icons', () => {
  for (const page of [
    'major-directory',
    'major-detail',
    'major-discussion',
    'major-discussion-thread',
  ]) {
    const source = read(`pages/${page}/${page}.wxml`);
    assert.match(source, /class="screen major-product/);
    assert.doesNotMatch(source, /WHALEU ·|实名|主回复|历史迁移|→|✓/);
    assert.equal(
      read(`pages/${page}/${page}.wxss`).trim(),
      '@import "../../majors/product.wxss";\n@import "../../majors/framework7-product.wxss";',
    );
    const json = JSON.parse(read(`pages/${page}/${page}.json`)) as {
      usingComponents: Record<string, string>;
    };
    assert.equal(json.usingComponents['wu-icon'], '../../components/icon/icon');
  }
  const styles = read('majors/product.wxss');
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /background: var\(--wu-elevated\)/);
  for (const selector of styles
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((rule) => rule.split('{')[0]?.trim())
    .filter(Boolean))
    for (const part of selector!.split(','))
      assert.ok(part.trim().startsWith('.major-product'), part);
});

test('flat reading view has one primary compose entry and keeps drafts out of the initial reading surface', () => {
  const initial = rendered({
    loaded: true,
    hasSession: true,
    items: [item()],
    totalCount: 1,
  });
  assert.match(text(initial), /合成用户/);
  assert.equal(
    initial.some((node) => typeof node !== 'string' && node.tag === 'textarea'),
    false,
  );
  assert.equal(buttons(initial, 'onConfirmPublish').length, 0);
  assert.equal(buttons(initial, 'onLike').length, 1);
  assert.equal(buttons(initial, 'onThread').length, 1);
  assert.equal(
    buttons(initial, 'onTogglePanel').filter(
      (node) => node.attrs['data-panel'] === 'compose',
    ).length,
    1,
  );
  assert.doesNotMatch(text(initial), /UTF-8|历史迁移|创建者通知|原请求编号/);
  const compose = rendered({
    loaded: true,
    hasSession: true,
    uiPanel: 'compose',
    body: '保留原文',
    bodyBytes: 12,
    canPublish: true,
  });
  assert.equal(buttons(compose, 'onConfirmPublish').length, 1);
  assert.equal(buttons(compose, 'onSubmit').length, 0);
  const input = compose.find(
    (node) => typeof node !== 'string' && node.tag === 'textarea',
  );
  assert.ok(input && typeof input !== 'string');
  assert.equal(input.attrs.maxlength, '-1');
  const confirming = rendered({
    loaded: true,
    uiPanel: 'compose',
    confirming: 'publish',
    body: '保留原文',
    imageCount: 2,
  });
  assert.equal(buttons(confirming, 'onConfirmPublish').length, 0);
  assert.equal(buttons(confirming, 'onSubmit').length, 1);
  assert.match(text(confirming), /保留原文/);
  assert.match(text(confirming), /2 张有序图片/);
});

test('deletion remains capability-gated and confirmation stays separate from menu lookup', () => {
  const second = item({ id: '77777777-7777-4777-8777-777777777777' });
  const initial = rendered({ loaded: true, items: [item(), second] });
  assert.equal(buttons(initial, 'onDeleteMenu').length, 2);
  assert.equal(buttons(initial, 'onDelete').length, 0);
  const allowed = rendered({
    loaded: true,
    items: [item(), second],
    deleteTarget: { majorId: item().majorId, commentId: rootId, rootId: null },
  });
  assert.equal(buttons(allowed, 'onDelete').length, 1);
  assert.equal(buttons(allowed, 'onDelete')[0]!.attrs['data-id'], rootId);
  assert.equal(buttons(allowed, 'onSubmit').length, 0);
  const confirming = rendered({
    loaded: true,
    confirming: 'delete',
    deleteTarget: { majorId: item().majorId, commentId: rootId, rootId: null },
  });
  assert.equal(buttons(confirming, 'onSubmit').length, 1);
  assert.match(text(confirming), /删除主题后其回复也将不可查看/);
  assert.match(text(confirming), /此操作不提供恢复入口/);
});

test('nullable image lists and gallery access retain native action and busy boundaries', () => {
  for (const images of [undefined, null, []]) {
    const nodes = rendered({ loaded: true, items: [{ ...item(), images }] });
    assert.equal(buttons(nodes, 'onImage').length, 0);
  }
  const nodes = rendered({
    loaded: true,
    imageBusy: true,
    items: [
      { ...item(), images: [{ bindingId: 'synthetic-binding', ordinal: 0 }] },
    ],
  });
  assert.equal(buttons(nodes, 'onImage').length, 1);
  assert.equal(buttons(nodes, 'onImage')[0]!.attrs.disabled, 'true');
  assert.equal(buttons(nodes, 'onImage')[0]!.attrs['data-index'], '0');
  const gallery = rendered({
    galleryOpen: true,
    gallerySrc: '/synthetic-local-image.png',
    galleryIndex: 0,
    galleryCount: 1,
  });
  assert.equal(buttons(gallery, 'onCloseGallery').length, 1);
  assert.equal(buttons(gallery, 'onImagePrevious')[0]!.attrs.disabled, 'true');
  assert.equal(buttons(gallery, 'onImageNext')[0]!.attrs.disabled, 'true');
  assert.equal(
    gallery.filter((node) => typeof node !== 'string' && node.tag === 'image')
      .length,
    1,
  );
  assert.equal(
    rendered({
      galleryOpen: false,
      gallerySrc: '/synthetic-local-image.png',
    }).filter((node) => typeof node !== 'string' && node.tag === 'image')
      .length,
    0,
  );
});

test('pending request and image recovery remain accessible when public content cannot load', () => {
  const pending = rendered({
    loaded: false,
    frozen: true,
    recoveryPhase: 'submit',
    recoveryMajorId: item().majorId,
  });
  assert.equal(buttons(pending, 'onRecover').length, 1);
  assert.equal(buttons(pending, 'onRetry').length, 1);
  assert.equal(buttons(pending, 'onRequestCancellation').length, 1);
  assert.equal(buttons(pending, 'onConfirmPublish').length, 0);
  const cancelled = rendered({
    loaded: false,
    frozen: true,
    recoveryPhase: 'cancel',
  });
  assert.equal(buttons(cancelled, 'onRequestCancellation').length, 0);
  assert.match(text(cancelled), /等待服务端结果/);
  const images = rendered({
    loaded: false,
    imageEnabled: true,
    imagePending: true,
    imageRecoverable: true,
    imageCancelConfirm: true,
  });
  for (const handler of [
    'onRecoverImages',
    'onRequestImageCancel',
    'onConfirmImageCancel',
    'onCloseImageCancel',
  ])
    assert.equal(buttons(images, handler).length, 1);
  assert.match(text(images), /已发表的请求以原回执为准/);
});

test('thread keeps original root, reply addressing and notification anchor without exposing raw timestamps', () => {
  const reply = item({
    id: '77777777-7777-4777-8777-777777777777',
    rootId,
    addressedAuthor: {
      mode: 'named',
      profileId: rootId,
      displayName: '被回复的同学',
    },
  });
  const nodes = rendered(
    {
      loaded: true,
      mode: 'thread',
      root: item(),
      items: [reply],
      totalCount: 1,
      timeLabels: { [rootId]: '10月20日' },
      focusCommentId: reply.id,
    },
    'major-discussion-thread',
  );
  assert.match(text(nodes), /被回复的同学/);
  assert.match(text(nodes), /10月20日/);
  assert.match(text(nodes), /已标记通知中的回复/);
  assert.equal(buttons(nodes, 'onReply').length, 1);
  assert.equal(buttons(nodes, 'onThread').length, 0);
  assert.doesNotMatch(text(nodes), /2026-.*T.*Z/);
});

test('image recovery is inside the open composer sheet exactly once and survives closing it', () => {
  const patch = {
    loaded: true,
    hasSession: true,
    uiPanel: 'compose',
    imageEnabled: true,
    imagePending: true,
    imageRecoverable: true,
    imageStatus: '等待原请求结果',
    imageCancelConfirm: true,
  };
  const nodes = rendered(patch);
  const sheet = nodes.find(
    (node) => typeof node !== 'string' && node.attrs.class === 'major-sheet',
  );
  assert.ok(sheet && typeof sheet !== 'string');
  assert.equal(buttons(flatten(sheet.children), 'onRecoverImages').length, 1);
  assert.equal(buttons(nodes, 'onRecoverImages').length, 1);
  assert.equal(buttons(nodes, 'onConfirmImageCancel').length, 1);
  assert.match(text(nodes), /结果待确认时不能创建替代请求/);
  assert.equal(
    buttons(rendered({ ...patch, uiPanel: '' }), 'onRecoverImages').length,
    1,
  );
});

test('every active confirmation sheet owns pending image recovery above its backdrop', () => {
  for (const confirming of ['publish', 'like', 'delete']) {
    const nodes = rendered({
      loaded: true,
      uiPanel: 'compose',
      confirming,
      selectedComment: item(),
      deleteTarget: {
        majorId: item().majorId,
        commentId: rootId,
        rootId: null,
      },
      imageEnabled: true,
      imagePending: true,
      imageRecoverable: true,
      imageStatus: '等待原请求结果',
      imageCancelConfirm: true,
    });
    const sheet = nodes.find(
      (node) =>
        typeof node !== 'string' &&
        node.attrs.class === 'major-sheet major-confirmation',
    );
    assert.ok(sheet && typeof sheet !== 'string', confirming);
    for (const handler of [
      'onRecoverImages',
      'onRequestImageCancel',
      'onConfirmImageCancel',
      'onCloseImageCancel',
    ]) {
      assert.equal(
        buttons(flatten(sheet.children), handler).length,
        1,
        `${confirming}: ${handler} must be inside the sheet`,
      );
      assert.equal(
        buttons(nodes, handler).length,
        1,
        `${confirming}: ${handler} must not be duplicated behind the backdrop`,
      );
    }
  }
});
