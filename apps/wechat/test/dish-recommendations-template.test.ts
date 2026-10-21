import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { initialDishRecommendationView } from '../src/dish-recommendations/controller';
import { id, own } from './dish-recommendations-helpers';
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
    path.join(root, 'pages/window-dishes/window-dishes.wxml'),
    'utf8',
  ),
);
const templates = {};
const flatten = (nodes: Node[]): Node[] =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [node] : [node, ...flatten(node.children)],
  );
const render = (patch: Record<string, unknown>) =>
  flatten(
    model.render(
      tree.children,
      {
        ...initialDishRecommendationView(),
        uiPanel: 'dish',
        ...patch,
      },
      templates,
    ),
  );
const text = (nodes: Node[]) =>
  nodes.filter((node) => typeof node === 'string').join(' ');
const buttons = (nodes: Node[], handler: string) =>
  nodes.filter(
    (node): node is Exclude<Node, string> =>
      typeof node !== 'string' &&
      node.tag === 'wu-f7-button' &&
      node.attrs['bind:press'] === handler,
  );
test('real WXML leaves independent own lookup and retract reachable without public list', () => {
  const nodes = render({
    hasSession: true,
    loaded: false,
    own: own(),
    ownName: '菜',
    nameDraft: '菜',
    canRetract: true,
  });
  assert.equal(buttons(nodes, 'onLookup').length, 1);
  assert.equal(buttons(nodes, 'onRetract').length, 1);
  assert.equal(buttons(nodes, 'onRecommend').length, 0);
  assert.ok(
    nodes.some(
      (node) =>
        typeof node !== 'string' &&
        node.tag === 'wu-f7-input' &&
        node.attrs['maxlength'] === '-1',
    ),
  );
  assert.match(text(nodes), /1 至 10 个字符/);
});
test('recovery, cancellation and unavailable own history never require public source visibility', () => {
  const nodes = render({
    frozen: true,
    recoveryWindowId: id,
    recoveryName: '菜',
    recoveryOperation: 'window.dish.retract.v1',
    recoveryPhase: 'cancel',
  });
  assert.equal(buttons(nodes, 'onRecover').length, 1);
  assert.equal(buttons(nodes, 'onRetry').length, 1);
  assert.equal(buttons(nodes, 'onRequestCancellation').length, 0);
  assert.match(text(nodes), /撤回推荐/);
  const unknown = render({ hasSession: true, own: { kind: 'unavailable' } });
  assert.match(text(unknown), /不能当作尚未推荐/);
  assert.doesNotMatch(text(unknown), /已确认尚未推荐/);
});
test('W2 native entry is registered and linked from W1 without broader feature controls', () => {
  const app = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')) as {
    pages: string[];
  };
  assert.ok(app.pages.includes('pages/window-dishes/window-dishes'));
  const detail = readFileSync(
    path.join(root, 'pages/window-rating-detail/window-rating-detail.wxml'),
    'utf8',
  );
  assert.match(detail, /onOpenRecommendations/);
  const source = readFileSync(
    path.join(root, 'pages/window-dishes/window-dishes.wxml'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /<image|onComment|onReward|onNotice|onAdmin|onProfile/,
  );
});
test('cold actor-owned recovery links are outside all catalog visibility conditions', () => {
  for (const entry of ['window-ratings', 'rating-recovery']) {
    const source = readFileSync(
      path.join(root, `pages/${entry}/${entry}.wxml`),
      'utf8',
    );
    const matches: Array<{ node: Exclude<Node, string>; gates: string[] }> = [];
    const visit = (nodes: Node[], gates: string[]) => {
      for (const node of nodes) {
        if (typeof node === 'string') continue;
        const next = [
          ...gates,
          ...Object.entries(node.attrs)
            .filter(([key]) =>
              ['wx:if', 'wx:elif', 'wx:for', 'hidden'].includes(key),
            )
            .map(([, value]) => value),
        ];
        if (
          node.tag === 'navigator' &&
          node.attrs['url'] === '/pages/window-dishes/window-dishes'
        )
          matches.push({ node, gates: next });
        visit(node.children, next);
      }
    };
    visit(model.parse(source).children, []);
    assert.equal(matches.length, 1);
    assert.match(matches[0]!.node.attrs['class'] ?? '', /(?:^|\s)link(?:\s|$)/);
    assert.match(
      flatten(matches[0]!.node.children)
        .filter((node) => typeof node === 'string')
        .join(''),
      /菜品推荐原请求/,
    );
    assert.deepEqual(
      matches[0]!.gates,
      entry === 'window-ratings' ? ["{{uiPanel === 'menu'}}"] : [],
    );
    assert.equal(matches[0]!.node.attrs['disabled'], undefined);
  }
});
