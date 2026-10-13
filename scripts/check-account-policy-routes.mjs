import { format } from 'prettier';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'apps/api/src');
const manifest = path.join(sourceRoot, 'safety/account-policy/routes.ts');
const methods = [
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Head',
  'Options',
  'All',
];
const actions = new Set([
  'browse',
  'interaction',
  'private_self_service',
  'protective_cleanup',
  'passive_bookkeeping',
  'privileged_read',
  'noncontent_management',
  'content_management',
  'restricted_self_service',
  'guest',
]);
const phases = new Set(['entry', 'owner_after_recovery', 'restricted']);
const decorated = new Map();
const classes = new Map();
const policyDetails = new Map();
const classified = new Map();
function decorators(node, name) {
  return (ts.getDecorators(node) ?? [])
    .map((d) => d.expression)
    .filter((d) => ts.isCallExpression(d) && d.expression.getText() === name);
}
function literal(node) {
  if (!node) return '';
  if (!ts.isStringLiteral(node))
    throw new Error(`Route must be explicitly inventoried: ${node.getText()}`);
  return node.text;
}
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    if (!file.endsWith('.ts')) continue;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const node of source.statements) {
      if (!ts.isClassDeclaration(node)) continue;
      if (node.name) classes.set(node.name.text, { node, source, file });
      const controller = decorators(node, 'Controller');
      if (!controller.length) continue;
      if (controller.length !== 1 || !node.name)
        throw new Error(`Ambiguous controller in ${file}`);
      const prefix = literal(controller[0].arguments[0]);
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        // Supplementary source inventory for the existing route factories.
        // Actual Nest reflection below is the completeness authority, not this list.
        for (const factory of ['scoped', 'route'])
          for (const decorator of decorators(member, factory)) {
            const method = literal(decorator.arguments[0]);
            if (!['GET', 'POST', 'PUT'].includes(method))
              throw new Error('Unknown factory method');
            const id = `${node.name.text}.${member.name.getText(source)}`;
            if (decorated.has(id)) throw new Error(`Duplicate handler ${id}`);
            decorated.set(id, [
              method,
              '/' +
                [prefix, literal(decorator.arguments[1])]
                  .filter(Boolean)
                  .join('/'),
              path.relative(root, file),
            ]);
          }
        for (const method of methods)
          for (const decorator of decorators(member, method)) {
            const id = `${node.name.text}.${member.name.getText(source)}`;
            if (decorated.has(id)) throw new Error(`Duplicate handler ${id}`);
            decorated.set(id, [
              method.toUpperCase(),
              '/' +
                [prefix, literal(decorator.arguments[0])]
                  .filter(Boolean)
                  .join('/'),
              path.relative(root, file),
            ]);
          }
      }
    }
  }
}
walk(sourceRoot);
const source = ts.createSourceFile(
  manifest,
  fs.readFileSync(manifest, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function inspect(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === 'accountRoutePolicies'
  ) {
    let value = node.initializer;
    while (
      value &&
      (ts.isAsExpression(value) || ts.isSatisfiesExpression(value))
    )
      value = value.expression;
    if (!value || !ts.isArrayLiteralExpression(value))
      throw new Error('Manifest must be a literal array');
    for (const row of value.elements) {
      if (!ts.isArrayLiteralExpression(row) || row.elements.length !== 6)
        throw new Error('Invalid manifest row');
      const [id, method, route, action, phase, file] =
        row.elements.map(literal);
      if (classified.has(id)) throw new Error(`Duplicate policy ${id}`);
      if (!actions.has(action) || !phases.has(phase))
        throw new Error(`Invalid class ${id}`);
      if (
        (action === 'restricted_self_service' || action === 'guest') !==
        (phase === 'restricted')
      )
        throw new Error(`Invalid restricted phase ${id}`);
      classified.set(id, [method, route, file]);
      policyDetails.set(id, {
        method,
        path: route,
        action,
        phase,
        controllerFile: file,
      });
    }
  }
  ts.forEachChild(node, inspect);
}
inspect(source);
const errors = [];
for (const [id, route] of decorated) {
  if (JSON.stringify(classified.get(id)) !== JSON.stringify(route))
    errors.push(`Missing/stale policy: ${id} ${route.join(' ')}`);
}
for (const id of classified.keys())
  if (!decorated.has(id)) errors.push(`Removed/unregistered handler: ${id}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Account policy: ${classified.size} source-inventoried controller routes; runtime metadata equality is tested separately.`,
  );

// Mechanical reachability is evidence of wiring, not evidence that an owner has
// correct final authorization. Keep mixed dispatch expressions visible to review.
const bindings = [...policyDetails]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([handler, policy]) => {
    const [controller, method] = handler.split('.');
    const type = classes.get(controller);
    const member = type.node.members.find(
      (n) => n.name?.getText(type.source) === method,
    );
    const ctor = type.node.members.find(ts.isConstructorDeclaration);
    const dependencies = new Map(
      (ctor?.parameters ?? []).map((n) => [
        n.name.getText(type.source),
        n.type?.getText(type.source),
      ]),
    );
    const ownerCalls = [];
    function visit(n) {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isPropertyAccessExpression(n.expression.expression) &&
        n.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const owner = dependencies.get(n.expression.expression.name.text);
        if (owner) {
          const target = classes.get(owner),
            targetMethod = n.expression.name.text;
          const implementation = target?.node.members.find(
            (m) => m.name?.getText(target.source) === targetMethod,
          );
          const annotations = implementation
            ? [
                ...decorators(implementation, 'AccountPolicy'),
                ...decorators(implementation, 'AccountPolicyFor'),
              ].map((d) => d.getText(target.source))
            : [];
          ownerCalls.push({
            owner,
            method: targetMethod,
            file: target ? path.relative(root, target.file) : null,
            policy: annotations,
            resolution: implementation
              ? 'concrete'
              : 'interface_or_external_owner',
          });
        }
      }
      ts.forEachChild(n, visit);
    }
    if (member?.body) visit(member.body);
    return { handler, ...policy, ownerCalls };
  });
const inventoryFile = path.join(
  root,
  'docs/account-moderation/route-owners.json',
);
const serialized = await format(JSON.stringify(bindings, null, 2), {
  parser: 'json',
});
if (process.argv.includes('--write-inventory'))
  fs.writeFileSync(inventoryFile, serialized);
else if (
  !fs.existsSync(inventoryFile) ||
  fs.readFileSync(inventoryFile, 'utf8') !== serialized
) {
  console.error(
    'Stale route owner inventory; review changes then run --write-inventory.',
  );
  process.exitCode = 1;
}
