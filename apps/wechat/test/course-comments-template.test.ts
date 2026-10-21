import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { initialCourseCommentsView } from '../src/course-comments/controller';
import { body, comment, commentId, id } from './course-comments-helpers';
type Node =
  string | { tag: string; attrs: Record<string, string>; children: Node[] };
const nativeRequire = createRequire(__filename);
const model = nativeRequire('../scripts/smoke-ratings.mjs') as {
  parse(source: string): Exclude<Node, string>;
  render(
    nodes: Node[],
    scope: unknown,
    templates: Record<string, Exclude<Node, string>>,
  ): Node[];
};
const root = path.resolve(__dirname, '../src');
const tree = model.parse(
  readFileSync(
    path.join(root, 'pages/course-comments/course-comments.wxml'),
    'utf8',
  ),
);
const flatten = (nodes: Node[]): Node[] =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [node] : [node, ...flatten(node.children)],
  );
const render = (patch: Record<string, unknown>) =>
  flatten(
    model.render(
      tree.children,
      { ...initialCourseCommentsView(), timeLabels: {}, ...patch },
      {},
    ),
  );
const text = (nodes: Node[]) =>
  nodes.filter((node) => typeof node === 'string').join(' ');
const button = (nodes: Node[], handler: string) =>
  nodes.find(
    (node) =>
      typeof node !== 'string' &&
      node.tag === 'wu-f7-button' &&
      node.attrs['bind:press'] === handler,
  ) as Exclude<Node, string> | undefined;
test('actual comments WXML displays only exact body, likes and time, with no author/persona/avatar controls', () => {
  const nodes = render({
    hasSession: true,
    loaded: true,
    courseId: id,
    items: [comment()],
    pageNumber: 1,
  });
  assert.ok(text(nodes).includes(body));
  assert.match(text(nodes), /赞 0/);
  assert.equal(button(nodes, 'onConfirmLike')?.attrs['data-id'], commentId);
  assert.equal(
    nodes.some((node) => typeof node !== 'string' && node.tag === 'image'),
    false,
  );
  const source = readFileSync(
    path.join(root, 'pages/course-comments/course-comments.wxml'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /item\.(author|avatar|persona|isMine|viewer|isLiked)/,
  );
  assert.doesNotMatch(source, /onUnlike|onDelete|onReply|authorMode/);
});
test('actual WXML separates exact publish preview and irreversible like confirmations', () => {
  const publishing = render({
    hasSession: true,
    loaded: true,
    body,
    confirming: 'publish',
  });
  assert.ok(text(publishing).includes(body));
  assert.ok(button(publishing, 'onSubmit'));
  assert.match(text(publishing), /确认发表/);
  const liking = render({
    hasSession: true,
    loaded: true,
    confirming: 'like',
    selectedComment: comment(),
  });
  assert.match(text(liking), /点赞后不能取消/);
  assert.ok(button(liking, 'onSubmit'));
  assert.ok(button(liking, 'onCloseConfirmation'));
});
test('pending recovery stays visible without source authority and cancellation is separately confirmed', () => {
  const patch = {
    hasSession: true,
    frozen: true,
    recoveryCourseId: id,
    recoveryOperation: 'course.comment.publish.v1',
    recoveryBody: body,
  };
  const pending = render(patch);
  assert.ok(button(pending, 'onRecover'));
  assert.ok(button(pending, 'onRetry'));
  assert.ok(button(pending, 'onRequestCancellation'));
  assert.equal(button(pending, 'onConfirmPublish'), undefined);
  assert.equal(button(pending, 'onConfirmCancellation'), undefined);
  const confirmation = render({
    ...patch,
    receiptMissing: true,
    confirming: 'cancel',
  });
  assert.ok(button(confirmation, 'onConfirmCancellation'));
  assert.match(text(confirmation), /暂未查到结果，不代表已取消/);
  const hidden = render({});
  assert.equal(text(hidden).includes(body), false);
});
test('native app registers dedicated comments page and fresh detail links its exact course', () => {
  const app = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')) as {
    pages: string[];
  };
  assert.ok(app.pages.includes('pages/course-comments/course-comments'));
  const detail = readFileSync(
    path.join(root, 'pages/course-rating-detail/course-rating-detail.wxml'),
    'utf8',
  );
  assert.ok(
    detail.includes(
      '/pages/course-comments/course-comments?courseId={{detail.course.id}}',
    ),
  );
  assert.ok(
    readFileSync(
      path.join(root, 'pages/course-ratings/course-ratings.wxml'),
      'utf8',
    ).includes('/pages/course-comments/course-comments'),
  );
});
