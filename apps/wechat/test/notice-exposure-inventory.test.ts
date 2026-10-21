import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import type { PresentationNode } from './framework7-action-parity';
const root = path.resolve(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const manifestText = read('../../docs/NOTICE_EXPOSURE_READ_INVENTORY.json');
const manifest = JSON.parse(manifestText) as {
  changed: Record<string, { before: string; after: string; evidence: string }>;
  added: Record<string, string>;
};
const correctionText = read(
  '../../docs/NOTICE_EXPOSURE_UNCERTAIN_READ_CORRECTION.json',
);
const correction = JSON.parse(correctionText) as {
  changed: Record<string, { before: string; after: string; evidence: string }>;
  predecessorInventory: { path: string; sha256: string };
  delta: { path: string; sha256: string };
};
function initialExposureSource(file: string): string {
  const fixed = correction.changed[file];
  if (!fixed) return read(file);
  assert.equal(
    sha(correctionText),
    'ffe95b91f8214a71b8a4ff1315a28be4f055ac0102cafe2415ce7f1b09291f26',
  );
  assert.equal(sha(manifestText), correction.predecessorInventory.sha256);
  assert.equal(
    sha(read(`../../${correction.delta.path}`)),
    correction.delta.sha256,
  );
  assert.equal(fixed.before, manifest.changed[file]!.after);
  const intermediate = read(fixed.evidence);
  assert.equal(
    sha(intermediate),
    fixed.before,
    `${file}: immutable initial exposure`,
  );
  assert.equal(
    sha(read(file)),
    fixed.after,
    `${file}: explicit reviewed uncertain-outcome correction`,
  );
  return intermediate;
}
const { parsePreviewWxml: parse } = createRequire(__filename)(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(text: string): PresentationNode };
interface SyntaxEvidence {
  kind: ts.SyntaxKind;
  text?: string;
  children: SyntaxEvidence[];
}
function syntax(node: ts.Node): SyntaxEvidence {
  const children: SyntaxEvidence[] = [];
  ts.forEachChild(node, (child) => {
    children.push(syntax(child));
  });
  return {
    kind: node.kind,
    ...(ts.isIdentifier(node) ||
    ts.isPrivateIdentifier(node) ||
    ts.isLiteralExpression(node) ||
    ts.isTemplateLiteralToken(node)
      ? { text: node.text }
      : {}),
    children,
  };
}
function ownerSyntax(source: string, removeGuard = false): SyntaxEvidence {
  const file = ts.createSourceFile(
    'owner.ts',
    source,
    ts.ScriptTarget.ES2020,
    true,
  );
  if (!removeGuard) return syntax(file);
  const transformed = ts.transform(file, [
    (context) => {
      const visit: ts.Visitor = (node) => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text.endsWith('/notice-read-guard')
        ) {
          assert.equal(node.importClause?.name, undefined);
          const bindings = node.importClause?.namedBindings;
          assert.ok(bindings && ts.isNamedImports(bindings));
          assert.ok(
            bindings.elements.length >= 1 && bindings.elements.length <= 2,
          );
          assert.ok(
            bindings.elements.every(
              (item) =>
                !item.propertyName &&
                ['guardNoticeRead', 'NoticeReadGuard'].includes(item.name.text),
            ),
          );
          return undefined;
        }
        if (
          ts.isParameter(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'guard'
        ) {
          assert.equal(node.initializer, undefined);
          assert.equal(node.dotDotDotToken, undefined);
          assert.equal(node.modifiers, undefined);
          const owner = node.parent;
          if (ts.isMethodDeclaration(owner) || ts.isMethodSignature(owner)) {
            assert.ok(
              ['acknowledge', 'read'].includes(owner.name.getText(file)),
            );
            assert.equal(owner.parameters[owner.parameters.length - 1], node);
            assert.ok(
              node.questionToken &&
                node.type &&
                ts.isTypeReferenceNode(node.type),
            );
            assert.equal(node.type.typeName.getText(file), 'NoticeReadGuard');
            assert.equal(node.type.typeArguments, undefined);
          } else {
            assert.ok(
              ts.isArrowFunction(owner) && owner.parameters.length === 2,
            );
            assert.equal(owner.parameters[0]!.name.getText(file), 'id');
            assert.equal(node.type, undefined);
            assert.equal(node.questionToken, undefined);
            assert.ok(ts.isPropertyAssignment(owner.parent));
            assert.equal(owner.parent.name.getText(file), 'acknowledge');
          }
          return undefined;
        }
        if (ts.isCallExpression(node)) {
          if (
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'guardNoticeRead'
          ) {
            assert.equal(node.arguments.length, 2);
            assert.ok(
              ['cancel', 'c'].includes(node.arguments[0]!.getText(file)),
            );
            assert.equal(node.arguments[1]!.getText(file), 'guard');
            assert.equal(node.typeArguments, undefined);
            return node.arguments[0]!;
          }
          if (
            node.arguments[node.arguments.length - 1]?.getText(file) === 'guard'
          ) {
            assert.equal(node.arguments.length, 2);
            assert.ok(
              [
                'reader.acknowledge',
                'reader.read',
                'this.readers.get(row.source)?.acknowledge',
                'this.system.acknowledge',
                'this.errand.read',
                'this.verification.acknowledge',
                'this.feedback.acknowledge',
              ].includes(node.expression.getText(file)),
            );
            return context.factory.updateCallExpression(
              node,
              node.expression,
              node.typeArguments,
              node.arguments.slice(0, -1),
            );
          }
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (root) => ts.visitNode(root, visit) as ts.SourceFile;
    },
  ]);
  try {
    return syntax(transformed.transformed[0]!);
  } finally {
    transformed.dispose();
  }
}
function actions(
  node: PresentationNode,
  parents: Record<string, string>[] = [],
): unknown[] {
  const guards = Object.fromEntries(
    Object.entries(node.attrs).filter(([key]) =>
      [
        'wx:if',
        'wx:elif',
        'wx:else',
        'wx:for',
        'wx:key',
        'wx:for-item',
        'wx:for-index',
      ].includes(key),
    ),
  );
  const scope = Object.keys(guards).length ? [...parents, guards] : parents;
  return [
    ...(node.tag === 'navigator' ||
    Object.keys(node.attrs).some((key) => /^(bind|catch)/.test(key))
      ? [{ tag: node.tag, attrs: node.attrs, scope }]
      : []),
    ...node.children.flatMap((child) =>
      typeof child === 'string' ? [] : actions(child, scope),
    ),
  ];
}

test('exposure before/after inventory authenticates every changed source without rewriting protected predecessors', () => {
  assert.equal(
    sha(manifestText),
    '2af3ead32dddeef4569d621f6007f6367eff778332fe9b38887189f77712bcd8',
  );
  assert.equal(Object.keys(manifest.changed).length, 15);
  for (const [file, evidence] of Object.entries(manifest.changed)) {
    assert.equal(
      sha(read(evidence.evidence)),
      evidence.before,
      `${file}: immutable predecessor`,
    );
    assert.equal(
      sha(initialExposureSource(file)),
      evidence.after,
      `${file}: reviewed successor`,
    );
  }
  for (const [file, hash] of Object.entries(manifest.added))
    assert.equal(sha(read(file)), hash, file);
});

test('initial exposure delta in all eleven owner adapters is optional guard threading only; every original authority/receipt/action token survives', () => {
  const controllers = Object.entries(manifest.changed).filter(
    ([file]) =>
      file.endsWith('.ts') &&
      !/\/(social-notices|system-notices)\.ts$/.test(file),
  );
  assert.equal(controllers.length, 11);
  for (const [file, evidence] of controllers) {
    const current = initialExposureSource(file);
    assert.match(current, /guard\?: NoticeReadGuard/);
    assert.deepEqual(
      ownerSyntax(current, true),
      ownerSyntax(read(evidence.evidence)),
      `${file}: no unrelated policy, decoder, endpoint or behavior change`,
    );
  }
});

test('both actual WXML pages preserve every manual action, source dataset, navigation and ancestor permission gate', () => {
  for (const name of ['social-notices', 'system-notices']) {
    const file = `src/pages/${name}/${name}.wxml`;
    const before = read(manifest.changed[file]!.evidence),
      after = read(file);
    assert.deepEqual(actions(parse(after)), actions(parse(before)), name);
    assert.match(
      after,
      /<view wx:for="\{\{(?:rows|items)\}\}" wx:key="(?:id|key)" id="\{\{item.observationId\}\}" class="notice-event">/,
    );
    assert.doesNotMatch(after, /<(?:wu-f7-)?(?:popup|sheet|dialog|modal)\b/);
    assert.doesNotMatch(
      read(`src/pages/${name}/${name}.ts`),
      /onPageScroll|markAll|mark-all/,
    );
  }
});

test('guard-only AST proof rejects changed authority checks, receipt identity and unconditional guard replacements', () => {
  const file = 'src/notifications/social-updates/controller.ts';
  const current = read(file);
  const before = ownerSyntax(read(manifest.changed[file]!.evidence));
  assert.notDeepEqual(
    ownerSyntax(
      current.replace(
        '!this.view.loaded || this.view.busy',
        '!this.view.loaded',
      ),
      true,
    ),
    before,
  );
  assert.notDeepEqual(
    ownerSyntax(
      current.replace(
        'result.noticeId !== noticeId',
        'result.noticeId === noticeId',
      ),
      true,
    ),
    before,
  );
  assert.throws(() =>
    ownerSyntax(
      current.replace(
        'guardNoticeRead(cancel, guard)',
        'guardNoticeRead(cancel, () => true)',
      ),
      true,
    ),
  );
});

function acknowledgeMethod(source: string): ts.MethodDeclaration {
  const file = ts.createSourceFile(
    'owner.ts',
    source,
    ts.ScriptTarget.ES2020,
    true,
  );
  let result: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isMethodDeclaration(node) &&
      node.name.getText(file) === 'acknowledge'
    )
      result = node;
    else ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(result);
  return result;
}
function runCall(method: ts.MethodDeclaration): ts.CallExpression {
  let result: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'this.run')
      result = node;
    else ts.forEachChild(node, visit);
  };
  visit(method);
  assert.ok(result);
  return result;
}
test('two explicitly authorized uncertain-outcome corrections preserve every other method, request, receipt and denial tail', () => {
  assert.deepEqual(Object.keys(correction.changed).sort(), [
    'src/notifications/student-notices.ts',
    'src/ratings/updates-controller.ts',
  ]);
  for (const file of Object.keys(correction.changed)) {
    const before = initialExposureSource(file),
      after = read(file);
    const previous = acknowledgeMethod(before),
      current = acknowledgeMethod(after);
    assert.deepEqual(
      ownerSyntax(after.replace(current.getText(), previous.getText())),
      ownerSyntax(before),
      'nothing outside acknowledge changes',
    );
    assert.deepEqual(
      syntax(current.body!.statements[0]!),
      syntax(previous.body!.statements[0]!),
      'entry authority/eligibility unchanged',
    );
    const oldRun = runCall(previous),
      newRun = runCall(current);
    assert.deepEqual(
      syntax(newRun.arguments[0]!),
      syntax(oldRun.arguments[0]!),
      'exact original transport and guard',
    );
    assert.deepEqual(
      syntax(newRun.arguments[1]!),
      syntax(oldRun.arguments[1]!),
      'exact original decoder and receipt application',
    );
    const oldError = oldRun.arguments[2]!,
      newError = newRun.arguments[2]!;
    assert.ok(
      ts.isArrowFunction(oldError) &&
        ts.isArrowFunction(newError) &&
        ts.isBlock(newError.body),
    );
    assert.ok(ts.isIfStatement(newError.body.statements[0]!));
    const denial = newError.body.statements.slice(1);
    if (ts.isBlock(oldError.body))
      assert.deepEqual(
        denial.map(syntax),
        oldError.body.statements.map(syntax),
      );
    else {
      assert.equal(denial.length, 1);
      assert.ok(ts.isExpressionStatement(denial[0]!));
      assert.deepEqual(syntax(denial[0]!.expression), syntax(oldError.body));
    }
  }
});
