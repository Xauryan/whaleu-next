import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { initialMajorDiscussionView } from '../src/major-discussion/controller';
import { item, own, rootId } from './major-discussion-helpers';
type Node =
  string | { tag: string; attrs: Record<string, string>; children: Node[] };
const nativeRequire = createRequire(__filename),
  model = nativeRequire('../scripts/smoke-ratings.mjs') as {
    parse(s: string): Exclude<Node, string>;
    render(
      n: Node[],
      s: unknown,
      t: Record<string, Exclude<Node, string>>,
    ): Node[];
  },
  root = path.resolve(__dirname, '../src');
const flatten = (n: Node[]): Node[] =>
  n.flatMap((i) => (typeof i === 'string' ? [i] : [i, ...flatten(i.children)]));
const common = model.parse(
    readFileSync(path.join(root, 'major-discussion/common.wxml'), 'utf8'),
  ),
  templates: Record<string, Exclude<Node, string>> = {};
for (const n of common.children)
  if (typeof n !== 'string' && n.attrs['name']) templates[n.attrs['name']] = n;
function render(name: string, patch: Record<string, unknown>) {
  const tree = model.parse(
    readFileSync(path.join(root, `pages/${name}/${name}.wxml`), 'utf8'),
  );
  return flatten(
    model.render(
      tree.children,
      { ...initialMajorDiscussionView(), ...patch },
      templates,
    ),
  );
}
const buttons = (n: Node[], handler: string) =>
    n.filter(
      (i) =>
        typeof i !== 'string' &&
        i.tag === 'button' &&
        i.attrs['bindtap'] === handler,
    ),
  text = (n: Node[]) => n.filter((i) => typeof i === 'string').join(' ');
test('real WXML renders named root/reply and reversible likes without score or media controls', () => {
  const nodes = render('major-discussion', {
    loaded: true,
    items: [item()],
    hasSession: true,
  });
  assert.match(text(nodes), /合成用户/);
  assert.equal(buttons(nodes, 'onLike').length, 1);
  assert.equal(buttons(nodes, 'onThread').length, 1);
  assert.equal(buttons(nodes, 'onConfirmPublish').length, 1);
  assert.equal(
    nodes.some((n) => typeof n !== 'string' && n.tag === 'image'),
    false,
  );
  const input = nodes.find(
    (n) => typeof n !== 'string' && n.tag === 'textarea',
  );
  assert.ok(input && typeof input !== 'string');
  assert.equal(input.attrs['maxlength'], '-1');
});
test('standalone recovery always renders same-account own lookup and verified unlike, even without any public source', () => {
  const n = render('major-discussion-recovery', {
    loaded: false,
    own: own(),
    canUnlike: true,
  });
  assert.equal(buttons(n, 'onLookupOwn').length, 1);
  assert.equal(buttons(n, 'onUnlike').length, 1);
  const frozen = render('major-discussion-recovery', {
    frozen: true,
    recoveryPhase: 'cancel',
    recoveryCommentId: rootId,
  });
  assert.equal(buttons(frozen, 'onRetry').length, 1);
  assert.equal(buttons(frozen, 'onRequestCancellation').length, 0);
  assert.match(text(frozen), /等待服务端结果/);
  const cold = render('major-discussion-recovery', {});
  assert.equal(buttons(cold, 'onLookupOwn').length, 1);
  assert.equal(buttons(cold, 'onUnlike').length, 0);
  assert.doesNotMatch(text(cold), /已确认没有点赞记录/);
  assert.doesNotMatch(text(cold), /当前：/);
});
test('unavailable notice hides stale target and keeps explicit mark-read; unavailable own history does not show absent', () => {
  const n = render('major-discussion-notices', {
    loaded: true,
    items: [
      {
        noticeId: rootId,
        createdAt: 'now',
        readAt: null,
        status: 'unavailable',
      },
    ],
    unreadCount: 1,
  });
  assert.equal(buttons(n, 'onOpen').length, 0);
  assert.equal(buttons(n, 'onRead').length, 1);
  assert.match(
    text(render('major-discussion-recovery', { own: { kind: 'unavailable' } })),
    /不能当作未点赞/,
  );
});
test('all Major discussion routes and directory/global recovery/notifications entrypoints remain reachable', () => {
  const app = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')) as {
    pages: string[];
  };
  for (const name of [
    'major-discussion',
    'major-discussion-thread',
    'major-discussion-recovery',
    'major-discussion-notices',
  ])
    assert.ok(app.pages.includes(`pages/${name}/${name}`));
  assert.match(
    readFileSync(
      path.join(root, 'pages/major-detail/major-detail.wxml'),
      'utf8',
    ),
    /onOpenDiscussion/,
  );
  for (const name of ['major-directory', 'rating-recovery'])
    assert.match(
      readFileSync(path.join(root, `pages/${name}/${name}.wxml`), 'utf8'),
      /major-discussion-recovery/,
    );
  assert.match(
    readFileSync(
      path.join(root, 'pages/community-updates/community-updates.wxml'),
      'utf8',
    ),
    /major-discussion-notices/,
  );
});
test('independent Major native contracts, keys and pages contain no Window creator mapping or numeric score dependency', () => {
  for (const name of [
    'contract.ts',
    'controller.ts',
    'gateway.ts',
    'pending.ts',
    'notices-controller.ts',
    'page.ts',
  ]) {
    const source = readFileSync(
      path.join(root, 'major-discussion', name),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /window-ratings|window-discussion|course-ratings|course-comments|creatorNotice|creatorUnavailable|expectedWindowRevision/,
    );
  }
  assert.match(
    readFileSync(path.join(root, 'major-discussion/pending.ts'), 'utf8'),
    /whaleu\.major-discussion\.pending\.v1/,
  );
  const page = readFileSync(
    path.join(root, 'pages/major-discussion/major-discussion.wxml'),
    'utf8',
  );
  assert.doesNotMatch(page, /创建者身份未确认/);
  assert.match(page, /专业没有创建者通知/);
});
test('Major directory and detail WXML display source metadata, named summaries and explicit related/read routes', () => {
  const source = model.parse(
    readFileSync(path.join(root, 'majors/common.wxml'), 'utf8'),
  );
  const directoryTemplates: Record<string, Exclude<Node, string>> = {};
  for (const n of source.children)
    if (typeof n !== 'string' && n.attrs['name'])
      directoryTemplates[n.attrs['name']] = n;
  const directory = model.parse(
    readFileSync(
      path.join(root, 'pages/major-directory/major-directory.wxml'),
      'utf8',
    ),
  );
  const major = {
    id: rootId,
    majorName: '合成专业',
    collegeName: '合成学院',
    departmentId: 110,
    summary: { kind: 'unavailable' },
  };
  const view = {
    loaded: true,
    busy: false,
    hasSession: true,
    status: '',
    error: '',
    searchDraft: '',
    departmentNames: ['全部院系'],
    departmentIndex: 0,
    departments: { items: [] },
    appliedFilter: '全部院系',
    items: [major],
    totalCount: 1,
    pageNumber: 1,
    canNext: false,
  };
  const nodes = flatten(
    model.render(directory.children, view, directoryTemplates),
  );
  assert.match(text(nodes), /合成专业/);
  assert.match(text(nodes), /合成学院/);
  assert.match(text(nodes), /110系/);
  assert.match(text(nodes), /暂无可靠讨论摘要/);
  assert.doesNotMatch(text(nodes), /0 条主评论/);
  assert.equal(buttons(nodes, 'onDetail').length, 1);
  assert.equal(buttons(nodes, 'onSearch').length, 1);
  const known = flatten(
    model.render(
      directory.children,
      {
        ...view,
        items: [
          {
            ...major,
            summary: {
              kind: 'known',
              rootCount: 2,
              hotComment: { id: rootId, body: '已核验热评', likes: 3 },
            },
          },
        ],
      },
      directoryTemplates,
    ),
  );
  assert.match(text(known), /2 条主评论/);
  assert.match(text(known), /已核验热评/);
  assert.match(text(known), /3 个赞/);
  const app = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')) as {
    pages: string[];
  };
  for (const name of ['major-directory', 'major-detail'])
    assert.ok(app.pages.includes(`pages/${name}/${name}`));
  for (const name of ['rating-catalog', 'directory-hub'])
    assert.match(
      readFileSync(path.join(root, `pages/${name}/${name}.wxml`), 'utf8'),
      /major-directory/,
    );
});
