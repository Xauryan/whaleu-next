/**
 * Package an already-built native dist without changing it or source routes.
 * Sizes are local file-byte budgets, NOT Tencent compiled/upload package sizes.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { losslessIconPng } from './lossless-icon-png.mjs';
import {
  iconAssetRoot,
  iconComponentFiles,
  planPackageIcons,
  verifyStatelessIconComponent,
} from './package-local-icons.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const builder = 'whaleu-native-release-v1';
const shellNames = [
  'community-feed',
  'campus-hub',
  'inbox',
  'me',
  'compose-entry',
];
const pageExtensions = ['.js', '.json', '.wxml', '.wxss'];
const packageRoots = ['packages/ratings', 'packages/features'];
const defaultBudget = 2 * 1024 * 1024;
const nativeAssetPrefix =
  /^\/(?:assets|packages\/(?:ratings|features)\/assets)\//;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readTree(root, prefix = '') {
  const result = new Map();
  for (const entry of (await readdir(root, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const relative = path.posix.join(prefix, entry.name);
    assert(!entry.isSymbolicLink(), `Unsupported symlink: ${relative}`);
    if (entry.isDirectory()) {
      for (const [name, bytes] of await readTree(
        path.join(root, entry.name),
        relative,
      ))
        result.set(name, bytes);
    } else if (entry.isFile())
      result.set(relative, await readFile(path.join(root, entry.name)));
  }
  return result;
}

function fingerprint(files) {
  const hash = createHash('sha256');
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    hash.update(name).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
}

function parseJavascript(text, file) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.JS,
  );
  assert(!source.parseDiagnostics.length, `Cannot parse JavaScript: ${file}`);
  return source;
}

function buildGraph(files) {
  const graph = new Map();
  const references = new Map();
  function resolve(from, specifier, extension = '') {
    assert(
      typeof specifier === 'string' &&
        specifier.length > 0 &&
        !/^[a-z]+:/i.test(specifier),
      `Unsupported reference in ${from}: ${specifier}`,
    );
    const candidate = path.posix.normalize(
      specifier.startsWith('/')
        ? specifier.slice(1)
        : path.posix.join(path.posix.dirname(from), specifier),
    );
    assert(
      candidate !== '..' && !candidate.startsWith('../'),
      `Dependency escapes package: ${from} -> ${specifier}`,
    );
    const choices = [
      candidate,
      candidate + extension,
      ...(extension === '.js' ? [candidate + '/index.js'] : []),
    ];
    const found = choices.find((file) => files.has(file));
    assert(found, `Missing dependency: ${from} -> ${specifier}`);
    return found;
  }
  for (const [file, bytes] of files) {
    const refs = [];
    const extension = path.posix.extname(file);
    const text = bytes.toString('utf8');
    const add = (specifier, start, end, ext = '', kind = 'quoted') => {
      const target = resolve(file, specifier, ext);
      refs.push({ target, start, end, kind });
    };
    if (extension === '.js') {
      const source = parseJavascript(text, file);
      const visit = (node) => {
        if (
          ts.isImportDeclaration(node) ||
          (ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              node.expression.getText(source).startsWith('require.')))
        )
          throw new Error(`Unsupported import syntax in ${file}`);
        if (
          ts.isCallExpression(node) &&
          (node.expression.getText(source) === 'require' ||
            node.expression.getText(source) === 'module.require')
        ) {
          const argument = node.arguments[0];
          assert(
            node.expression.getText(source) === 'require' &&
              node.arguments.length === 1 &&
              argument &&
              ts.isStringLiteral(argument) &&
              (argument.text.startsWith('.') || argument.text.startsWith('/')),
            `Unsupported dynamic/module require in ${file}`,
          );
          add(
            argument.text,
            argument.getStart(source),
            argument.getEnd(),
            '.js',
            'javascript',
          );
        }
        if (
          ts.isTemplateExpression(node) &&
          nativeAssetPrefix.test(node.head.text)
        )
          throw new Error(`Unsupported dynamic native asset in ${file}`);
        if (
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node)) &&
          nativeAssetPrefix.test(node.text) &&
          !(
            ts.isCallExpression(node.parent) &&
            node.parent.expression.getText(source) === 'require'
          )
        ) {
          // Native APIs resolve these URLs from the package root, not from the
          // JavaScript module. Keep that distinction when relocating assets.
          assert(
            /^\/[a-z0-9_./-]+\.[a-z0-9]+$/i.test(node.text) &&
              path.posix.normalize(node.text) === node.text &&
              !(
                ts.isBinaryExpression(node.parent) &&
                node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
              ),
            `Unsupported dynamic/invalid native asset in ${file}: ${node.text}`,
          );
          add(
            node.text,
            node.getStart(source),
            node.getEnd(),
            '',
            'native-asset',
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    } else if (extension === '.wxml') {
      assert(!/<wxs\b/i.test(text), `Unsupported WXS dependency in ${file}`);
      for (const match of text.matchAll(
        /<(import|include|image)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g,
      )) {
        const attribute = /\bsrc=(["'])(.*?)\1/.exec(match[0]);
        if (!attribute) continue;
        const specifier = attribute[2];
        if (specifier.includes('{{')) {
          assert(
            match[1] === 'image',
            `Unsupported dynamic template dependency in ${file}`,
          );
          assert(
            !/^(\/|\.\.?\/)/.test(specifier) ||
              (iconAssetRoot(file, packageRoots) &&
                specifier.startsWith(iconAssetRoot(file, packageRoots)) &&
                specifier.endsWith('/{{name}}.png')),
            `Unsupported dynamic local asset in ${file}: ${specifier}`,
          );
          continue; // Runtime remote images; icon assets are handled separately.
        }
        if (/^(https?:|data:)/.test(specifier)) continue;
        const start = match.index + attribute.index + 'src='.length;
        add(specifier, start, start + specifier.length + 2);
      }
    } else if (extension === '.wxss') {
      for (const match of text.matchAll(/@import\s+(["'])(.*?)\1/g)) {
        const start = match.index + match[0].indexOf(match[1]);
        add(match[2], start, start + match[2].length + 2);
      }
      for (const match of text.matchAll(
        /url\(\s*(?:(["'])(.*?)\1|([^)'"\s]+))\s*\)/g,
      )) {
        const specifier = match[2] ?? match[3];
        if (/^(https?:|data:|#)/.test(specifier)) continue;
        const start = match.index + match[0].indexOf(specifier);
        add(specifier, start, start + specifier.length, '', 'bare');
      }
    } else if (extension === '.json') {
      const json = JSON.parse(text);
      assert(!json.plugins, `Unsupported plugins declaration in ${file}`);
      for (const specifier of Object.values(json.usingComponents ?? {}))
        for (const ext of pageExtensions)
          refs.push({
            target: resolve(file, specifier, ext),
            kind: 'component',
            specifier,
          });
      if (file === 'app.json') {
        for (const key of ['sitemapLocation', 'themeLocation'])
          if (json[key])
            refs.push({
              target: resolve(file, './' + json[key]),
              kind: 'root-config',
            });
        for (const item of json.tabBar?.list ?? [])
          for (const key of ['iconPath', 'selectedIconPath'])
            if (item[key])
              refs.push({
                target: resolve(file, './' + item[key]),
                kind: 'root-config',
              });
      }
    }
    graph.set(
      file,
      refs.map((ref) => ref.target),
    );
    references.set(file, refs);
  }
  return { graph, references };
}

function closure(graph, roots) {
  const result = new Set();
  const visit = (file) => {
    assert(graph.has(file), `Missing entrypoint: ${file}`);
    if (result.has(file)) return;
    result.add(file);
    for (const dependency of graph.get(file)) visit(dependency);
  };
  roots.forEach(visit);
  return result;
}

function expressionValues(value, fallback, onFallback) {
  if (!value.includes('{{')) return [value];
  assert(
    value.startsWith('{{') && value.endsWith('}}'),
    `Unsupported interpolated icon attribute: ${value}`,
  );
  const expression = value
    .slice(2, -2)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
  const source = parseJavascript(`const value = (${expression});`, 'icon.js');
  const initializer =
    source.statements[0].declarationList.declarations[0].initializer;
  function values(node) {
    if (ts.isParenthesizedExpression(node)) return values(node.expression);
    if (ts.isStringLiteral(node)) return [node.text];
    if (ts.isConditionalExpression(node))
      return [...values(node.whenTrue), ...values(node.whenFalse)];
    onFallback?.();
    return fallback;
  }
  return [...new Set(values(initializer))];
}

function iconAssets(files, reachable, tags = new Set(['wu-icon'])) {
  for (const tag of tags)
    assert(/^[a-z][a-z0-9-]*$/i.test(tag), `Unsupported icon tag: ${tag}`);
  const tagPattern = new RegExp(
    `<(?:${[...tags].join('|')})\\b(?:[^"'<>]|"[^"]*"|'[^']*')*>`,
    'g',
  );
  const manifestFile = files.get('assets/icons/manifest.json');
  if (!manifestFile) {
    assert(
      ![...reachable].some(
        (file) =>
          file.endsWith('.wxml') &&
          new RegExp(tagPattern.source).test(files.get(file).toString()),
      ),
      'Missing icon manifest',
    );
    return { assets: new Set(), fallbacks: [] };
  }
  const manifest = JSON.parse(manifestFile.toString());
  const result = new Set();
  const fallbacks = [];
  const add = (name, tone) => {
    assert(
      /^[a-z0-9-]+$/i.test(name) && /^[a-z0-9-]+$/i.test(tone),
      `Unsupported native icon candidate: ${tone}/${name}`,
    );
    const file = `assets/icons/${tone}/${name}.png`;
    assert(files.has(file), `Missing referenced native icon: ${file}`);
    result.add(file);
  };
  for (const file of reachable) {
    if (!file.endsWith('.wxml')) continue;
    for (const tag of files.get(file).toString().matchAll(tagPattern)) {
      const attribute = (key, defaultValue) => {
        const match = new RegExp(`\\b${key}=(["'])(.*?)\\1`).exec(tag[0]);
        return match?.[2] ?? defaultValue;
      };
      const candidates = (key, defaultValue, fallback) => {
        const expression = attribute(key, defaultValue);
        let expanded = false;
        const values = expressionValues(expression, fallback, () => {
          expanded = true;
        });
        if (expanded)
          fallbacks.push({
            file,
            attribute: key,
            expression,
            candidateCount: values.length,
          });
        return values;
      };
      const names = candidates('name', 'home', manifest.names);
      const tones = candidates('tone', 'default', [
        'default',
        'inverse',
        ...Object.keys(manifest.tones),
      ]);
      for (const name of names)
        for (const tone of tones)
          for (const palette of ['default', 'inverse'].includes(tone)
            ? ['light', 'dark']
            : [tone])
            add(name, palette);
    }
  }
  return { assets: result, fallbacks };
}

function isRatingsPage(route) {
  // Social notifications consume Ratings updates. Keep both page consumers in
  // one package so their stateful controller need not be promoted into main.
  // Major discussions share rating/discussion utilities; keep the whole family
  // together (including recovery), while legacy URLs retain redirect aliases.
  return (
    /^pages\/(rating-|course-|window-|canteen-|target-|major-)/.test(route) ||
    route === 'pages/social-notices/social-notices'
  );
}

function relativeReference(from, to) {
  const relative = path.posix.relative(path.posix.dirname(from), to);
  return relative.startsWith('.') ? relative : './' + relative;
}

// redirectTo replaces the alias stack entry instead of leaving a Back loop.
// Only navigation is performed: original query values are not logged or saved.
const aliasHelper = `
exports.createAlias = function (target) {
  return {
    data: { error: '', opening: false },
    onLoad: function (query) {
      this.aliasAlive = true;
      this.aliasUrl = target;
      var pairs = Object.keys(query || {}).map(function (key) {
        if (typeof query[key] !== 'string') throw new Error('Invalid query');
        return encodeURIComponent(key) + '=' + encodeURIComponent(query[key]);
      });
      if (pairs.length) this.aliasUrl += '?' + pairs.join('&');
      this.onRetry();
    },
    onRetry: function () {
      if (!this.aliasAlive || this.aliasPending) return;
      this.aliasPending = true;
      this.setData({ error: '', opening: true });
      var page = this;
      function fail() {
        if (!page.aliasAlive) return;
        page.aliasPending = false;
        page.setData({ error: '暂时无法打开，请重试。', opening: false });
      }
      try {
        wx.redirectTo({ url: this.aliasUrl, fail: fail });
      } catch (_) { fail(); }
    },
    onUnload: function () {
      this.aliasAlive = false;
      this.aliasPending = false;
      this.aliasUrl = '';
    }
  };
};`;
const aliasMarkup =
  '<view style="padding:48rpx"><text wx:if="{{opening}}">正在打开…</text><block wx:if="{{error}}"><text>{{error}}</text><button bindtap="onRetry">重试</button></block></view>';

export async function packageRelease({
  input = path.join(appRoot, 'dist'),
  output = path.join(appRoot, 'release'),
  project = path.join(appRoot, 'project.config.json'),
  budget = defaultBudget,
} = {}) {
  input = path.resolve(input);
  output = path.resolve(output);
  assert(
    input !== output &&
      !input.startsWith(output + path.sep) &&
      !output.startsWith(input + path.sep),
    'Release output must be separate from the input tree',
  );
  assert(Number.isSafeInteger(budget) && budget > 0, 'Invalid package budget');
  try {
    await stat(output);
    const previous = JSON.parse(
      await readFile(path.join(output, 'package-report.json'), 'utf8'),
    );
    assert(previous.builder === builder, 'Refusing to replace foreign output');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A missing report inside an existing directory is not permission to erase it.
    try {
      await stat(output);
      throw new Error('Refusing to replace output without a package report', {
        cause: error,
      });
    } catch (missing) {
      if (missing.code !== 'ENOENT') throw missing;
    }
  }
  const files = await readTree(input);
  const sourceFingerprint = fingerprint(files);
  const config = JSON.parse(files.get('app.json')?.toString() ?? '{}');
  assert(
    Array.isArray(config.pages) &&
      config.pages.length &&
      !config.subPackages &&
      !config.subpackages,
    'Expected a flat, already-built app.json',
  );
  assert(
    !config.preloadRule,
    'Existing preloadRule requires explicit migration',
  );
  assert(
    new Set(config.pages).size === config.pages.length,
    'Duplicate source page route',
  );
  for (const route of config.pages) {
    assert(
      /^pages\/[a-z0-9-]+\/[a-z0-9-]+$/.test(route),
      `Unsupported source page route: ${route}`,
    );
    for (const ext of pageExtensions)
      assert(files.has(route + ext), `Missing page asset: ${route + ext}`);
  }
  const { graph, references } = buildGraph(files);
  const nativeTabs = (config.tabBar?.list ?? []).map((item) => item.pagePath);
  const mainRoutes = [
    ...new Set([
      config.pages[0],
      ...shellNames
        .map((name) => `pages/${name}/${name}`)
        .filter((route) => config.pages.includes(route)),
      ...nativeTabs,
    ]),
  ];
  assert(
    mainRoutes.every((route) => config.pages.includes(route)),
    'Native tab page is not declared in pages',
  );
  const rootsForPages = (routes) =>
    routes.flatMap((route) => pageExtensions.map((ext) => route + ext));
  const routeGroups = [
    config.pages.filter(
      (route) => !mainRoutes.includes(route) && isRatingsPage(route),
    ),
    config.pages.filter(
      (route) => !mainRoutes.includes(route) && !isRatingsPage(route),
    ),
  ];
  let main = closure(graph, [
    'app.js',
    'app.json',
    'app.wxss',
    ...rootsForPages(mainRoutes),
    ...(files.has('vendor/js-sha256-LICENSE.txt')
      ? ['vendor/js-sha256-LICENSE.txt']
      : []),
  ]);
  const groups = routeGroups.map((routes) =>
    closure(graph, rootsForPages(routes)),
  );
  const shared = [...groups[0]].filter(
    (file) => groups[1].has(file) && !main.has(file),
  );
  main = closure(graph, [...main, ...shared]);
  const allReachable = new Set([...main, ...groups[0], ...groups[1]]);
  const { assets: icons, fallbacks: iconFallbacks } = iconAssets(
    files,
    allReachable,
  );
  for (const routes of routeGroups)
    for (const route of routes)
      for (const ext of pageExtensions)
        assert(
          !main.has(route + ext),
          `Deep page entry is imported by main/shared code: ${route + ext}`,
        );
  const owner = new Map([...main].map((file) => [file, -1]));
  groups.forEach((group, index) => {
    for (const file of group) if (!main.has(file)) owner.set(file, index);
  });
  const localIcons = planPackageIcons({
    files,
    graph,
    references,
    owner,
    discoverIcons: iconAssets,
  });
  if ([...owner.keys()].some((file) => iconComponentFiles.has(file)))
    verifyStatelessIconComponent(files, graph, references);
  // A known icon tag without a resolvable registration must not silently lose
  // its assets. Aliased registrations are discovered contextually above.
  for (const file of icons)
    assert(
      localIcons.icons.has(file),
      `Icon usage has no reachable icon component registration: ${file}`,
    );
  for (const file of localIcons.icons) icons.add(file);
  const fallbackMap = new Map(
    [...iconFallbacks, ...localIcons.fallbacks].map((item) => [
      JSON.stringify(item),
      item,
    ]),
  );
  iconFallbacks.splice(0, iconFallbacks.length, ...fallbackMap.values());
  const packageDestination = (file, group) =>
    group === -1 ? file : `${packageRoots[group]}/${file}`;
  const destination = (file) => {
    assert(owner.has(file), `Unassigned dependency: ${file}`);
    const group = owner.get(file);
    return packageDestination(file, group);
  };
  const emitted = new Map();
  const minify = (text) =>
    transformSync(text, {
      loader: 'js',
      target: 'es2020',
      minify: true,
      legalComments: 'inline',
    }).code;
  // Whitespace only: keep WXSS selectors, rpx, custom properties and values intact.
  const compactStyles = (text) =>
    transformSync(text, {
      loader: 'css',
      minifyWhitespace: true,
      minifySyntax: false,
      minifyIdentifiers: false,
      legalComments: 'inline',
    }).code;
  for (const [file, group] of owner) {
    if (iconComponentFiles.has(file)) continue;
    const dest = destination(file);
    let content = files.get(file);
    for (const dependency of graph.get(file) ?? [])
      assert(
        owner.get(dependency) === -1 || owner.get(dependency) === group,
        `Illegal package dependency: ${file} -> ${dependency}`,
      );
    const extension = path.posix.extname(file);
    if (/^assets\/icons\/[^/]+\/[^/]+\.png$/.test(file))
      content = await losslessIconPng(content);
    if (extension === '.json') {
      const json = JSON.parse(content.toString());
      if (json.usingComponents) {
        for (const [name, specifier] of Object.entries(json.usingComponents)) {
          const ref = references
            .get(file)
            .find(
              (item) =>
                item.kind === 'component' &&
                item.specifier === specifier &&
                item.target.endsWith('.js'),
            );
          json.usingComponents[name] = relativeReference(
            dest,
            (iconComponentFiles.has(ref.target)
              ? packageDestination(ref.target, group)
              : destination(ref.target)
            ).slice(0, -3),
          );
        }
      }
      content = Buffer.from(JSON.stringify(json));
    } else if (['.js', '.wxml', '.wxss'].includes(extension)) {
      let text = content.toString();
      for (const ref of [...references.get(file)].sort(
        (a, b) => b.start - a.start,
      )) {
        const target = destination(ref.target);
        const relative =
          ref.kind === 'native-asset'
            ? '/' + target
            : relativeReference(
                dest,
                ref.kind === 'javascript'
                  ? target.replace(/\.js$/, '')
                  : target,
              );
        const replacement =
          ref.kind === 'bare' ? relative : JSON.stringify(relative);
        text = text.slice(0, ref.start) + replacement + text.slice(ref.end);
      }
      content = Buffer.from(
        extension === '.js'
          ? minify(text)
          : extension === '.wxss'
            ? compactStyles(text)
            : text,
      );
    }
    emitted.set(dest, content);
  }
  // Only this verified stateless quartet may have multiple destinations.
  // All other JavaScript retains the original single-owner closure above.
  for (const group of localIcons.componentGroups)
    for (const file of iconComponentFiles) {
      let text = files.get(file).toString();
      if (file.endsWith('.wxml'))
        text = text.replaceAll(
          '/assets/icons/',
          '/' + packageDestination('assets/icons/', group),
        );
      else if (file.endsWith('.js')) text = minify(text);
      else if (file.endsWith('.wxss')) text = compactStyles(text);
      else text = JSON.stringify(JSON.parse(text));
      emitted.set(packageDestination(file, group), Buffer.from(text));
    }
  const iconPlacements = new Map();
  for (const [file, group] of owner)
    if (/^assets\/icons\/[^/]+\/[^/]+\.png$/.test(file)) {
      icons.add(file);
      iconPlacements.set(packageDestination(file, group), file);
    }
  const optimizedIcons = new Map();
  for (const [group, assets] of localIcons.assetsByGroup)
    for (const file of assets) {
      if (!optimizedIcons.has(file))
        optimizedIcons.set(file, await losslessIconPng(files.get(file)));
      const dest = packageDestination(file, group);
      emitted.set(dest, optimizedIcons.get(file));
      iconPlacements.set(dest, file);
    }
  const aliases = {};
  emitted.set('shell/route-alias.js', Buffer.from(minify(aliasHelper)));
  emitted.set('shell/route-alias.wxml', Buffer.from(aliasMarkup));
  routeGroups.forEach((routes, index) => {
    for (const route of routes) {
      const target = `/${packageRoots[index]}/${route}`;
      aliases[route] = target;
      emitted.set(
        route + '.js',
        Buffer.from(
          minify(
            `Page(require("../../shell/route-alias").createAlias(${JSON.stringify(target)}));`,
          ),
        ),
      );
      emitted.set(
        route + '.wxml',
        Buffer.from('<include src="../../shell/route-alias.wxml"/>'),
      );
      emitted.set(route + '.wxss', Buffer.from(''));
      emitted.set(route + '.json', Buffer.from('{}'));
    }
  });
  config.subPackages = routeGroups
    .map((pages, index) => ({ root: packageRoots[index], pages }))
    .filter((group) => group.pages.length);
  emitted.set('app.json', Buffer.from(JSON.stringify(config)));
  // Adapted component licenses must accompany compiled distribution, not only source.
  const thirdPartyNotices = [];
  if ([...owner.keys()].some((file) => file.startsWith('components/f7-'))) {
    const notice = files.get('third-party-notices.json');
    assert(notice, 'Framework7 native ports require third-party-notices.json');
    const parsed = JSON.parse(notice.toString());
    const framework = parsed.notices?.find(
      (item) => item.name === 'Framework7',
    );
    assert(
      framework?.version === '9.2.0' &&
        framework?.license === 'MIT' &&
        framework?.commit === '7668f883c29f69dd2ad7bd8ac3b35b9124082b0b' &&
        typeof framework.licenseText === 'string' &&
        createHash('sha256').update(framework.licenseText).digest('hex') ===
          '1c115994b4470862e1fa6d694a326f5d745dd8e77027a5ab18e7c285b05fa59e',
      'Framework7 native port requires the complete pinned MIT license',
    );
    emitted.set('third-party-notices.json', notice);
    thirdPartyNotices.push('third-party-notices.json');
  }

  const finalGraph = buildGraph(emitted).graph;
  const packageOf = (file) =>
    packageRoots.find((root) => file.startsWith(root + '/')) ?? 'main';
  for (const [file, dependencies] of finalGraph)
    for (const dependency of dependencies)
      assert(
        packageOf(dependency) === 'main' ||
          packageOf(file) === packageOf(dependency),
        `Invalid emitted package boundary: ${file} -> ${dependency}`,
      );
  // Dynamic icon paths are outside the ordinary static graph. Validate them
  // separately against their exact consuming registration and candidate set.
  for (const [group, assets] of localIcons.assetsByGroup) {
    const template = packageDestination('components/icon/icon.wxml', group);
    const prefix = iconAssetRoot(template, packageRoots);
    const text = emitted.get(template)?.toString();
    assert(
      text && text.includes(prefix),
      `Missing local icon template: ${template}`,
    );
    for (const file of assets)
      assert(
        emitted.has(packageDestination(file, group)),
        `Missing emitted local icon: ${template} -> ${file}`,
      );
  }
  const sizes = Object.fromEntries(
    ['main', ...packageRoots].map((name) => [name, 0]),
  );
  for (const [file, bytes] of emitted) sizes[packageOf(file)] += bytes.length;
  const iconBytes = [...iconPlacements.keys()].reduce(
    (total, file) => total + emitted.get(file).length,
    0,
  );
  const iconDiagnostic =
    `; retained ${icons.size} icons (${iconBytes} bytes)` +
    (iconFallbacks.length
      ? '; conservative dynamic icon bindings: ' +
        [
          ...new Set(
            iconFallbacks.map(
              (item) =>
                `${item.file} ${item.attribute}=${item.expression} (${item.candidateCount} candidates)`,
            ),
          ),
        ].join('; ')
      : '');
  for (const [name, size] of Object.entries(sizes))
    assert(
      size <= budget,
      `${name} local file-byte budget exceeded: ${size} > ${budget}${iconDiagnostic}`,
    );
  const report = {
    builder,
    sourceFingerprint,
    measurement: 'Sum of emitted file bytes; not Tencent compiled package size',
    nativeVerification:
      'Not performed. Validate compile, package size, redirects, rendering, and physical-device behavior in WeChat DevTools.',
    javascriptMinifier: createRequire(import.meta.url)('esbuild').version,
    stylesheetOptimization:
      'whitespace-only; no syntax or identifier minification',
    budgetPerPackage: budget,
    sizes,
    sourceBytes: [...files.values()].reduce(
      (sum, value) => sum + value.length,
      0,
    ),
    totalBytes: [...emitted.values()].reduce(
      (sum, value) => sum + value.length,
      0,
    ),
    mainRoutes,
    thirdPartyNotices,
    subPackages: config.subPackages,
    aliases,
    javascriptAssetFiles: [
      ...new Set(
        [...owner.keys()].flatMap((file) =>
          references
            .get(file)
            .filter((ref) => ref.kind === 'native-asset')
            .map((ref) => destination(ref.target)),
        ),
      ),
    ].sort(),
    sharedFiles: shared.filter((file) => !iconComponentFiles.has(file)).sort(),
    icons: [...icons].sort(),
    iconPlacements: Object.fromEntries([...iconPlacements].sort()),
    iconComponents: [...localIcons.componentGroups]
      .map((group) => packageDestination('components/icon/icon', group))
      .sort(),
    iconBytesByPackage: Object.fromEntries(
      ['main', ...packageRoots].map((name) => [
        name,
        [...iconPlacements.keys()]
          .filter((file) => packageOf(file) === name)
          .reduce((sum, file) => sum + emitted.get(file).length, 0),
      ]),
    ),
    iconBytes,
    iconFallbacks,
    droppedFiles: [...files.keys()]
      .filter(
        (file) =>
          !owner.has(file) &&
          !icons.has(file) &&
          !thirdPartyNotices.includes(file),
      )
      .sort(),
  };
  assert(
    fingerprint(await readTree(input)) === sourceFingerprint,
    'Input changed while packaging; wait for build completion and retry',
  );
  await mkdir(path.dirname(output), { recursive: true });
  const staging = await mkdtemp(
    path.join(path.dirname(output), '.release-stage-'),
  );
  try {
    for (const [file, bytes] of emitted) {
      const target = path.join(staging, 'miniprogram', file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    const projectConfig = JSON.parse(await readFile(project, 'utf8'));
    projectConfig.miniprogramRoot = 'miniprogram/';
    projectConfig.setting = { ...projectConfig.setting, minified: false };
    projectConfig.description =
      'Development-only dependency-aware artifact; native acceptance not verified';
    await writeFile(
      path.join(staging, 'project.config.json'),
      JSON.stringify(projectConfig, null, 2) + '\n',
    );
    await writeFile(
      path.join(staging, 'package-report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    assert(
      ['--input', '--output', '--project', '--budget'].includes(key) && value,
      `Usage: node package-release.mjs [--input dist] [--output release] [--project project.config.json] [--budget bytes]`,
    );
    options[key.slice(2)] = key === '--budget' ? Number(value) : value;
  }
  const report = await packageRelease(options);
  console.log(
    JSON.stringify(
      {
        output: options.output ?? path.join(appRoot, 'release'),
        sizes: report.sizes,
        totalBytes: report.totalBytes,
        aliases: Object.keys(report.aliases).length,
        icons: report.icons.length,
        measurement: report.measurement,
        nativeVerification: report.nativeVerification,
      },
      null,
      2,
    ),
  );
}
