import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { initialWindowRatingView } from '../src/window-ratings/controller';
import { windowScoreChoices } from '../src/window-ratings/contract';
import {
  detail,
  id,
  recordedAt,
  scoreRevision,
} from './window-ratings-helpers';
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
    path.join(root, 'pages/window-rating-detail/window-rating-detail.wxml'),
    'utf8',
  ),
);
const common = model.parse(
  readFileSync(
    path.join(root, 'window-ratings/framework7-product.wxml'),
    'utf8',
  ),
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
        uiPanel: '',
        ...initialWindowRatingView(),
        scores: windowScoreChoices.map((value) => ({
          value,
          label: value > 0 ? `+${value}` : String(value),
        })),
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
test('actual WXML has all 21 signed choices, explicit zero preview and edit confirmation', () => {
  const nodes = render({
    hasSession: true,
    loaded: true,
    detail: detail({
      myScore: {
        kind: 'recorded',
        score: -10,
        revision: scoreRevision,
        recordedAt,
      },
    }),
    canScore: true,
    selectedScore: 0,
    confirming: 'score',
  });
  const selection = render({
    hasSession: true,
    loaded: true,
    detail: detail(),
    canScore: true,
    selectedScore: 0,
    uiPanel: 'score',
  });
  assert.equal(
    buttons(nodes, 'onScore').length,
    0,
    'confirmation replaces editable score sheet',
  );
  assert.deepEqual(
    buttons(selection, 'onScore').map((node) =>
      Number(node.attrs['data-score']),
    ),
    windowScoreChoices,
  );
  assert.match(text(nodes), /当前 -10 分 → 本次 0 分/);
  assert.equal(buttons(nodes, 'onSubmit').length, 1);
  assert.equal(buttons(nodes, 'onCloseConfirmation').length, 1);
  assert.match(text(nodes), /可修改/);
  assert.doesNotMatch(text(nodes), /唯一一次|首次评分不能/);
});
test('recovery and durable cancellation remain reachable without catalog visibility', () => {
  const nodes = render({
    frozen: true,
    recoveryWindowId: id,
    recoveryScore: 0,
    recoveryPhase: 'cancel',
  });
  assert.match(text(nodes), /原请求分数：0/);
  assert.match(text(nodes), /只查询回执或重试取消/);
  assert.equal(buttons(nodes, 'onRecover').length, 1);
  assert.equal(buttons(nodes, 'onRetry').length, 1);
  assert.equal(buttons(nodes, 'onRequestCancellation').length, 0);
  assert.equal(buttons(nodes, 'onScore').length, 0);
  const confirmation = render({
    frozen: true,
    recoveryWindowId: id,
    recoveryScore: -10,
    recoveryPhase: 'submit',
    receiptMissing: true,
    confirming: 'cancel',
  });
  assert.equal(buttons(confirmation, 'onConfirmCancellation').length, 1);
  assert.match(text(confirmation), /不会删除已经写入的评分/);
});
test('unknown history is neither an empty aggregate nor absence of own score', () => {
  const nodes = render({
    loaded: true,
    detail: detail({
      window: { ...detail().window, summary: { kind: 'unavailable' } },
      myScore: { kind: 'unavailable' },
    }),
  });
  assert.match(text(nodes), /历史评分暂不能确认/);
  assert.doesNotMatch(text(nodes), /当前已确认尚未评分|当前已确认没有评分/);
  assert.equal(buttons(nodes, 'onScore').length, 0);
});
test('registered native specialist entries are reachable and have no wider specialist feature controls', () => {
  const app = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')) as {
    pages: string[];
  };
  for (const name of ['window-ratings', 'window-rating-detail'])
    assert.ok(app.pages.includes(`pages/${name}/${name}`));
  for (const name of ['rating-catalog', 'rating-scoped', 'rating-recovery'])
    assert.ok(
      readFileSync(
        path.join(root, `pages/${name}/${name}.wxml`),
        'utf8',
      ).includes('/pages/window-ratings/window-ratings'),
    );
  const source = readFileSync(
    path.join(root, 'pages/window-rating-detail/window-rating-detail.wxml'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /<image|onComment|onDish|onReward|onNotice|onFloorScore|onDeleteScore/,
  );
});
