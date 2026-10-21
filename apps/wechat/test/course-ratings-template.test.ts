import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { initialCourseRatingView } from '../src/course-ratings/controller';
import { courseScoreChoices } from '../src/course-ratings/contract';
import { detail, id } from './course-ratings-helpers';
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
function text(nodes: Node[]): string {
  return nodes
    .map((node) => (typeof node === 'string' ? node : text(node.children)))
    .join(' ');
}
test('actual course WXML replaces not-submitted with pending uncertainty and labels source provenance', () => {
  const root = path.resolve(__dirname, '../src');
  const tree = model.parse(
    readFileSync(
      path.join(root, 'pages/course-rating-detail/course-rating-detail.wxml'),
      'utf8',
    ),
  );
  const common = model.parse(
    readFileSync(
      path.join(root, 'course-ratings/framework7-product.wxml'),
      'utf8',
    ),
  );
  const templates: Record<string, Exclude<Node, string>> = {};
  for (const node of common.children)
    if (typeof node !== 'string' && node.tag === 'template')
      templates[node.attrs.name!] = node;
  const view = {
    ...initialCourseRatingView(),
    loaded: true,
    detail: detail(),
    frozen: true,
    recoveryCourseId: id,
    recoveryScores: { gradeScore: 0.5, abilityScore: 4.5, overallScore: 1.5 },
    scores: courseScoreChoices,
  };
  const pending = text(model.render(tree.children, view, templates));
  assert.match(pending, /上次评分结果待确认，请先查询/);
  assert.doesNotMatch(pending, /还没有为这门课评分/);
  assert.doesNotMatch(pending, /来源校区：synthetic-campus/);
  const provenance = text(
    model.render(tree.children, { ...view, uiPanel: 'info' }, templates),
  );
  assert.match(provenance, /来源校区：synthetic-campus/);
  assert.ok(provenance.includes(`目录版本：${detail().catalogRevision}`));
  const corrupt = text(
    model.render(
      tree.children,
      { ...view, recoveryCourseId: '', recoveryScores: null },
      templates,
    ),
  );
  assert.doesNotMatch(corrupt, /还没有为这门课评分/);
  assert.match(corrupt, /上次评分结果待确认/);
  const fresh = text(
    model.render(tree.children, { ...view, frozen: false }, templates),
  );
  assert.match(fresh, /还没有为这门课评分/);
});
