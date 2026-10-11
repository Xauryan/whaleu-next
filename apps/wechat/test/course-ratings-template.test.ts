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
    readFileSync(path.join(root, 'course-ratings/common.wxml'), 'utf8'),
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
  assert.match(pending, /原请求结果待确认，当前快照不能解除原请求/);
  assert.doesNotMatch(pending, /当前已确认尚未评分/);
  assert.match(pending, /来源校区标识：synthetic-campus/);
  assert.ok(pending.includes(`已核验目录版本：${detail().catalogRevision}`));
  const corrupt = text(
    model.render(
      tree.children,
      { ...view, recoveryCourseId: '', recoveryScores: null },
      templates,
    ),
  );
  assert.doesNotMatch(corrupt, /当前已确认尚未评分/);
  assert.match(corrupt, /原请求结果待确认/);
  const fresh = text(
    model.render(tree.children, { ...view, frozen: false }, templates),
  );
  assert.match(fresh, /当前已确认尚未评分/);
});
