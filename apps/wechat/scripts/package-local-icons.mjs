import ts from 'typescript';

export const iconComponentFiles = new Set(
  ['.js', '.json', '.wxml', '.wxss'].map(
    (extension) => 'components/icon/icon' + extension,
  ),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function iconAssetRoot(file, packageRoots) {
  for (const root of ['', ...packageRoots]) {
    const prefix = root ? root + '/' : '';
    if (file === prefix + 'components/icon/icon.wxml')
      return '/' + prefix + 'assets/icons/';
  }
  return undefined;
}

/**
 * This is deliberately not a general-purpose "pure JavaScript" classifier.
 * Only the existing raster icon component's declarative contract is eligible.
 * Any future behavior, state, dependency or compiler prelude needs review.
 */
export function verifyStatelessIconComponent(files, graph, references) {
  const fail = (detail) =>
    `Package-local icon component is not verified stateless: ${detail}`;
  for (const file of iconComponentFiles) {
    assert(files.has(file), fail(`missing ${file}`));
    assert(!graph.get(file)?.length, fail(`dependency in ${file}`));
  }
  for (const [file, refs] of references)
    for (const ref of refs)
      assert(
        !iconComponentFiles.has(ref.target) || ref.kind === 'component',
        fail(`non-component reference ${file} -> ${ref.target}`),
      );
  const json = JSON.parse(files.get('components/icon/icon.json').toString());
  assert(
    json.component === true && Object.keys(json).length === 1,
    fail('component JSON must only declare component: true'),
  );
  const text = files.get('components/icon/icon.js').toString();
  const source = ts.createSourceFile(
    'icon.js',
    text,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.JS,
  );
  assert(!source.parseDiagnostics.length, fail('invalid JavaScript'));
  const printer = ts.createPrinter({ removeComments: true });
  const print = (node) =>
    printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());
  const prelude = ts.createSourceFile(
    'prelude.js',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.JS,
  );
  const expectedPrelude = print(prelude.statements[0]);
  const statements = source.statements.filter(
    (node) =>
      !(
        ts.isExpressionStatement(node) &&
        ts.isStringLiteral(node.expression) &&
        node.expression.text === 'use strict'
      ) && print(node) !== expectedPrelude,
  );
  const statement = statements[0];
  assert(
    statements.length === 1 &&
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      statement.expression.expression.text === 'Component' &&
      statement.expression.arguments.length === 1,
    fail('expected only a declarative Component call'),
  );
  const fields = (node, allowed, label) => {
    assert(ts.isObjectLiteralExpression(node), fail(`${label} is not literal`));
    const result = new Map();
    for (const member of node.properties) {
      assert(
        ts.isPropertyAssignment(member) &&
          (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
          allowed.includes(member.name.text) &&
          !result.has(member.name.text),
        fail(`unsupported ${label} member`),
      );
      result.set(member.name.text, member.initializer);
    }
    return result;
  };
  const definition = fields(
    statement.expression.arguments[0],
    ['properties', 'data', 'methods'],
    'Component',
  );
  for (const key of ['data', 'methods'])
    if (definition.has(key)) fields(definition.get(key), [], key);
  assert(definition.has('properties'), fail('missing properties contract'));
  {
    const expected = {
      name: ['String', 'home'],
      tone: ['String', 'default'],
      size: ['Number', 24],
    };
    const properties = fields(
      definition.get('properties'),
      Object.keys(expected),
      'properties',
    );
    assert(
      properties.size === Object.keys(expected).length,
      fail('properties must declare name, tone and size'),
    );
    for (const [key, node] of properties) {
      const property = fields(node, ['type', 'value'], key);
      const type = property.get('type');
      const value = property.get('value');
      assert(
        property.size === 2 &&
          type &&
          ts.isIdentifier(type) &&
          type.text === expected[key][0] &&
          value &&
          (key === 'size'
            ? ts.isNumericLiteral(value) &&
              Number(value.text) === expected[key][1]
            : ts.isStringLiteral(value) && value.text === expected[key][1]),
        fail(`changed ${key} property contract`),
      );
    }
  }
  const markup = files.get('components/icon/icon.wxml').toString();
  const allowedSources = new Set([
    '/assets/icons/{{tone}}/{{name}}.png',
    "/assets/icons/{{tone === 'inverse' ? 'dark' : 'light'}}/{{name}}.png",
    "/assets/icons/{{tone === 'inverse' ? 'light' : 'dark'}}/{{name}}.png",
  ]);
  const allowedAttributes = {
    view: {
      class: new Set(['wu-icon']),
      style: new Set(['width:{{size}}px;height:{{size}}px;']),
      'aria-hidden': new Set(['true']),
    },
    block: {
      'wx:if': new Set(["{{tone === 'default' || tone === 'inverse'}}"]),
    },
    image: {
      class: new Set([
        'wu-icon-image',
        'wu-icon-image wu-icon-light',
        'wu-icon-image wu-icon-dark',
      ]),
      src: allowedSources,
      mode: new Set(['aspectFit']),
      'wx:else': new Set([undefined, '']),
    },
  };
  const stack = [];
  let imageCount = 0;
  let offset = 0;
  // Inspect every token, not just image sources. Native tags and open-type,
  // event handlers, slots or additional bindings can add behavior without JS.
  for (const token of markup.matchAll(
    /<\/?[a-z][a-z0-9-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/g,
  )) {
    assert(
      !markup.slice(offset, token.index).trim(),
      fail('unsupported raster markup content'),
    );
    offset = token.index + token[0].length;
    const [, closing, tag, attributes, selfClosing] =
      /^<(\/?)([a-z][a-z0-9-]*)([\s\S]*?)(\/?)>$/.exec(token[0]);
    assert(
      Object.hasOwn(allowedAttributes, tag),
      fail(`unsupported raster tag: ${tag}`),
    );
    if (closing) {
      assert(
        !attributes.trim() && !selfClosing && stack.pop() === tag,
        fail('unbalanced raster markup'),
      );
      continue;
    }
    const seen = new Set();
    let attributeOffset = 0;
    for (const attribute of attributes.matchAll(
      /\s+([a-z][a-z0-9:-]*)(?:\s*=\s*(["'])([\s\S]*?)\2)?/g,
    )) {
      const [, name, , value] = attribute;
      assert(
        !attributes.slice(attributeOffset, attribute.index).trim() &&
          !seen.has(name) &&
          Object.hasOwn(allowedAttributes[tag], name) &&
          allowedAttributes[tag][name].has(value),
        fail(`unsupported raster attribute: ${tag}.${name}`),
      );
      seen.add(name);
      attributeOffset = attribute.index + attribute[0].length;
    }
    assert(
      !attributes.slice(attributeOffset).trim(),
      fail('invalid raster attributes'),
    );
    if (tag === 'image') {
      assert(seen.has('src'), fail('missing raster image source'));
      imageCount++;
    }
    if (!selfClosing) stack.push(tag);
  }
  assert(
    !markup.slice(offset).trim() && stack.length === 0,
    fail('unbalanced or unsupported raster markup'),
  );
  assert(imageCount > 0, fail('missing raster images'));
}

/**
 * A WXML include/import is evaluated in the consuming page/component context.
 * A nested custom component instead owns its own JSON registration. In
 * particular, a shared main-package component must keep the main icon clone.
 */
export function planPackageIcons({
  files,
  graph,
  references,
  owner,
  discoverIcons,
}) {
  const componentGroups = new Set();
  const assetsByGroup = new Map();
  const icons = new Set();
  const fallbackMap = new Map();
  const iconBindings = (file) => {
    const json = JSON.parse(files.get(file).toString());
    return new Map(
      Object.entries(json.usingComponents ?? {}).map(([name, specifier]) => [
        name,
        references
          .get(file)
          .some(
            (ref) =>
              ref.kind === 'component' &&
              ref.specifier === specifier &&
              ref.target === 'components/icon/icon.js',
          ),
      ]),
    );
  };
  const globals = iconBindings('app.json');
  const templateClosure = (root) => {
    const result = new Set();
    const visit = (file) => {
      if (!file.endsWith('.wxml') || result.has(file)) return;
      result.add(file);
      for (const dependency of graph.get(file) ?? []) visit(dependency);
    };
    visit(root);
    return result;
  };
  for (const [file, group] of owner) {
    if (!file.endsWith('.json') || iconComponentFiles.has(file)) continue;
    const local = iconBindings(file);
    for (const isIcon of local.values()) if (isIcon) componentGroups.add(group);
    const root = file.replace(/\.json$/, '.wxml');
    if (!files.has(root)) continue;
    const effective = new Map(
      [...globals].map(([name, isIcon]) => [name, isIcon ? -1 : null]),
    );
    for (const [name, isIcon] of local)
      effective.set(name, isIcon ? group : null);
    const templates = templateClosure(root);
    for (const template of templates)
      assert(
        !/<wu-icon\b/.test(files.get(template).toString()) ||
          (effective.has('wu-icon') && effective.get('wu-icon') !== null),
        `Unknown icon component registration: ${file} consumes ${template}`,
      );
    const tagsByGroup = new Map();
    for (const [tag, targetGroup] of effective) {
      if (targetGroup === null) continue;
      const tags = tagsByGroup.get(targetGroup) ?? new Set();
      tags.add(tag);
      tagsByGroup.set(targetGroup, tags);
      componentGroups.add(targetGroup);
    }
    for (const [targetGroup, tags] of tagsByGroup) {
      const discovered = discoverIcons(files, templates, tags);
      const assets = assetsByGroup.get(targetGroup) ?? new Set();
      for (const asset of discovered.assets) {
        assets.add(asset);
        icons.add(asset);
      }
      assetsByGroup.set(targetGroup, assets);
      for (const fallback of discovered.fallbacks)
        fallbackMap.set(JSON.stringify(fallback), fallback);
    }
  }
  return {
    componentGroups,
    assetsByGroup,
    icons,
    fallbacks: [...fallbackMap.values()],
  };
}
