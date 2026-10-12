import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { initialWindowDiscussionView } from '../src/window-discussion/controller';
import { item, own, rootId } from './window-discussion-helpers';
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
    readFileSync(path.join(root, 'window-discussion/common.wxml'), 'utf8'),
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
      { ...initialWindowDiscussionView(), ...patch },
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
  const nodes = render('window-discussion', {
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
  const n = render('window-discussion-recovery', {
    loaded: false,
    own: own(),
    canUnlike: true,
  });
  assert.equal(buttons(n, 'onLookupOwn').length, 1);
  assert.equal(buttons(n, 'onUnlike').length, 1);
  const frozen = render('window-discussion-recovery', {
    frozen: true,
    recoveryPhase: 'cancel',
    recoveryCommentId: rootId,
  });
  assert.equal(buttons(frozen, 'onRetry').length, 1);
  assert.equal(buttons(frozen, 'onRequestCancellation').length, 0);
  assert.match(text(frozen), /等待服务端结果/);
  const cold = render('window-discussion-recovery', {});
  assert.equal(buttons(cold, 'onLookupOwn').length, 1);
  assert.equal(buttons(cold, 'onUnlike').length, 0);
  assert.doesNotMatch(text(cold), /已确认没有点赞记录/);
  assert.doesNotMatch(text(cold), /当前：/);
});
test('unavailable notice hides stale target and keeps explicit mark-read; unavailable own history does not show absent', () => {
  const n = render('window-discussion-notices', {
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
    text(
      render('window-discussion-recovery', { own: { kind: 'unavailable' } }),
    ),
    /不能当作未点赞/,
  );
});
test('all four routes registered and W1 and global recovery/notifications entrypoints remain reachable', () => {
  const app = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')) as {
    pages: string[];
  };
  for (const name of [
    'window-discussion',
    'window-discussion-thread',
    'window-discussion-recovery',
    'window-discussion-notices',
  ])
    assert.ok(app.pages.includes(`pages/${name}/${name}`));
  assert.match(
    readFileSync(
      path.join(root, 'pages/window-rating-detail/window-rating-detail.wxml'),
      'utf8',
    ),
    /onOpenDiscussion/,
  );
  for (const name of ['window-ratings', 'rating-recovery'])
    assert.match(
      readFileSync(path.join(root, `pages/${name}/${name}.wxml`), 'utf8'),
      /window-discussion-recovery/,
    );
  assert.match(
    readFileSync(
      path.join(root, 'pages/community-updates/community-updates.wxml'),
      'utf8',
    ),
    /window-discussion-notices/,
  );
});
