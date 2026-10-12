import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { initialFloorRatingView } from '../src/canteen-floor-scores/controller';
import {
  detail,
  floorId,
  recordedAt,
  scoreRevision,
} from './canteen-floor-scores-helpers';
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
    path.join(
      root,
      'pages/canteen-floor-score-detail/canteen-floor-score-detail.wxml',
    ),
    'utf8',
  ),
);
const common = model.parse(
  readFileSync(path.join(root, 'canteen-floor-scores/common.wxml'), 'utf8'),
);
const templates = Object.fromEntries(
  common.children
    .filter(
      (node): node is Exclude<Node, string> =>
        typeof node !== 'string' && node.tag === 'template',
    )
    .map((node) => [node.attrs['name']!, node]),
);
const flatten = (nodes: Node[]): Node[] =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [node] : [node, ...flatten(node.children)],
  );
const render = (patch: Record<string, unknown>) =>
  flatten(
    model.render(
      tree.children,
      {
        ...initialFloorRatingView(),
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
      node.tag === 'button' &&
      node.attrs['bindtap'] === handler,
  );
test('actual floor WXML exposes decimal input and explicit immutable first-active confirmation, no edit/delete or media', () => {
  const nodes = render({
    hasSession: true,
    loaded: true,
    detail: detail(),
    canScore: true,
    selectedScore: 4.75,
    confirming: 'score',
  });
  assert.equal(
    nodes.filter(
      (n) =>
        typeof n !== 'string' &&
        n.tag === 'input' &&
        n.attrs['bindinput'] === 'onScore',
    ).length,
    1,
  );
  assert.match(text(nodes), /4.75/);
  assert.match(text(nodes), /当前没有编辑或删除入口/);
  assert.equal(buttons(nodes, 'onSubmit').length, 1);
  assert.equal(buttons(nodes, 'onCloseConfirmation').length, 1);
  assert.equal(buttons(nodes, 'onDeleteScore').length, 0);
});
test('recorded own scalar, unavailable history and record counts retain honest UI distinctions', () => {
  const nodes = render({
    loaded: true,
    detail: detail({
      floor: { ...detail().floor, summary: { kind: 'unavailable' } },
      myScore: {
        kind: 'recorded',
        score: 1.25,
        revision: scoreRevision,
        recordedAt,
      },
    }),
  });
  assert.match(text(nodes), /1.25/);
  assert.match(text(nodes), /历史评分暂不能确认/);
  assert.doesNotMatch(text(nodes), /已确认尚未评分|当前已确认没有评分|人参与/);
  assert.equal(buttons(nodes, 'onSubmit').length, 0);
});
test('frozen decimal cancellation recovery is visible without catalog and never offers resubmission after cancel intent', () => {
  const nodes = render({
    frozen: true,
    recoveryFloorId: floorId,
    recoveryScore: 4.75,
    recoveryPhase: 'cancel',
  });
  assert.match(text(nodes), /原请求分数：4.75/);
  assert.match(text(nodes), /只查询回执或重试取消/);
  assert.equal(buttons(nodes, 'onRecover').length, 1);
  assert.equal(buttons(nodes, 'onRetry').length, 1);
  assert.equal(buttons(nodes, 'onRequestCancellation').length, 0);
});
test('new reachable Next routes are registered; selector uses accepted floor identities without window dependency', () => {
  const app = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')) as {
    pages: string[];
  };
  for (const name of ['canteen-floor-scores', 'canteen-floor-score-detail'])
    assert.ok(app.pages.includes(`pages/${name}/${name}`));
  assert.ok(
    readFileSync(
      path.join(root, 'pages/rating-catalog/rating-catalog.wxml'),
      'utf8',
    ).includes('/pages/canteen-floor-scores/canteen-floor-scores'),
  );
  const selector = readFileSync(
    path.join(root, 'pages/canteen-floor-scores/canteen-floor-scores.wxml'),
    'utf8',
  );
  assert.match(selector, /bindchange="onFloor"/);
  assert.match(selector, /data-id="{{floorDraft}}"/);
  assert.doesNotMatch(selector, /windowId|\/windows\//);
});
