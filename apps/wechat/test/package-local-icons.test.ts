import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.join(__dirname, '../scripts/package-release.mjs');
const component = 'components/icon/icon';
const roots = ['', 'packages/ratings/', 'packages/features/'];
const names = ['home', 'rating', 'feature', 'shared', 'template', 'unused'];
const tones = ['light', 'dark', 'accent', 'white'];
const iconJavascript = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
Component({
  properties: {
    name: { type: String, value: 'home' },
    tone: { type: String, value: 'default' },
    size: { type: Number, value: 24 }
  },
  data: {},
  methods: {}
});`;
interface Report {
  sizes: Record<string, number>;
  aliases: Record<string, string>;
  iconPlacements: Record<string, string>;
  iconComponents: string[];
  iconBytes: number;
  iconBytesByPackage: Record<string, number>;
  iconFallbacks: { file: string; attribute: string; candidateCount: number }[];
}
function tree(root: string, prefix = ''): string[] {
  return readdirSync(path.join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.posix.join(prefix, entry.name);
      return entry.isDirectory() ? tree(root, file) : [file];
    })
    .sort();
}
function fingerprint(root: string) {
  const hash = createHash('sha256');
  for (const file of tree(root))
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(path.join(root, file)));
  return hash.digest('hex');
}
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'whaleu-local-icon-test-'));
  const input = path.join(root, 'dist');
  const output = path.join(root, 'release');
  const runtime = path.join(output, 'miniprogram');
  const project = path.join(root, 'project.config.json');
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(input, file)), { recursive: true });
    writeFileSync(path.join(input, file), content);
  };
  const read = (file: string) => readFileSync(path.join(runtime, file), 'utf8');
  const page = (name: string, markup: string, nested = false) => {
    const route = `pages/${name}/${name}`;
    write(
      route + '.js',
      'Page({data:{shared:require("../../shared/state").value}});',
    );
    write(route + '.wxml', markup);
    write(route + '.wxss', '');
    write(
      route + '.json',
      JSON.stringify({
        usingComponents: {
          'wu-icon': '../../' + component,
          ...(nested ? { 'shared-card': '../../components/shared/card' } : {}),
          ...(name === 'rating-detail'
            ? { 'local-card': '../../components/rating/card' }
            : {}),
        },
      }),
    );
    return route;
  };
  const pages = [
    page('community-feed', '<wu-icon name="home" tone="accent"/>'),
    page(
      'rating-detail',
      '<wu-icon name="rating" tone="accent"/><shared-card/><local-card/><include src="../../shared/template.wxml"/>',
      true,
    ),
    page(
      'profile',
      '<wu-icon name="feature" tone="white"/><shared-card/><import src="../../shared/template.wxml"/><template is="row"/>',
      true,
    ),
  ];
  write('app.json', JSON.stringify({ pages }));
  write('app.js', 'App({});');
  write('app.wxss', '');
  write('shared/state.js', 'exports.value={count:0};');
  write(
    'shared/template.wxml',
    '<template name="row"><wu-icon name="template" tone="dark"/></template>',
  );
  for (const [name, icon, tone] of [
    ['shared', 'shared', 'white'],
    ['rating', 'rating', 'light'],
  ]) {
    write(
      `components/${name}/card.js`,
      'Component({data:{shared:require("../../shared/state").value}});',
    );
    write(
      `components/${name}/card.json`,
      '{"component":true,"usingComponents":{"wu-icon":"../icon/icon"}}',
    );
    write(
      `components/${name}/card.wxml`,
      `<wu-icon name="${icon}" tone="${tone}"/>`,
    );
    write(`components/${name}/card.wxss`, '.card { color: red; }');
  }
  write(component + '.js', iconJavascript);
  write(component + '.json', '{"component":true}');
  write(component + '.wxss', '.icon { width: 100%; }');
  write(
    component + '.wxml',
    "<image src=\"/assets/icons/{{tone === 'inverse' ? 'dark' : 'light'}}/{{name}}.png\"/><image src=\"/assets/icons/{{tone === 'inverse' ? 'light' : 'dark'}}/{{name}}.png\"/><image src=\"/assets/icons/{{tone}}/{{name}}.png\"/>",
  );
  write(
    'assets/icons/manifest.json',
    JSON.stringify({
      names,
      tones: Object.fromEntries(tones.map((tone) => [tone, '#123456'])),
    }),
  );
  for (const name of names)
    for (const tone of tones)
      write(`assets/icons/${tone}/${name}.png`, `fixture-png:${tone}:${name}`);
  writeFileSync(project, '{}');
  const args = [
    script,
    '--input',
    input,
    '--output',
    output,
    '--project',
    project,
  ];
  return {
    input,
    output,
    runtime,
    write,
    read,
    run: () => {
      execFileSync(process.execPath, args, { stdio: 'pipe' });
      return JSON.parse(
        readFileSync(path.join(output, 'package-report.json'), 'utf8'),
      ) as Report;
    },
    fail: () => spawnSync(process.execPath, args, { encoding: 'utf8' }),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('only verified icon code duplicates, with exact package-local PNGs and singleton nested components', () => {
  const f = fixture();
  try {
    const inputBefore = fingerprint(f.input);
    const report = f.run();
    assert.equal(fingerprint(f.input), inputBefore);
    assert.deepEqual(
      report.iconComponents,
      roots.map((root) => root + component).sort(),
    );
    assert.deepEqual(Object.keys(report.iconPlacements).sort(), [
      'assets/icons/accent/home.png',
      'assets/icons/white/shared.png',
      'packages/features/assets/icons/dark/template.png',
      'packages/features/assets/icons/white/feature.png',
      'packages/ratings/assets/icons/accent/rating.png',
      'packages/ratings/assets/icons/dark/template.png',
      'packages/ratings/assets/icons/light/rating.png',
    ]);
    assert.ok(existsSync(path.join(f.runtime, 'shared/template.wxml')));
    assert.ok(
      !existsSync(path.join(f.runtime, 'assets/icons/dark/template.png')),
    );
    assert.ok(
      !existsSync(
        path.join(f.runtime, 'packages/ratings/assets/icons/white/shared.png'),
      ),
    );
    assert.ok(
      !existsSync(
        path.join(f.runtime, 'packages/features/assets/icons/white/shared.png'),
      ),
    );
    assert.ok(existsSync(path.join(f.runtime, 'components/shared/card.js')));
    assert.ok(
      !existsSync(
        path.join(f.runtime, 'packages/ratings/components/shared/card.js'),
      ),
    );
    assert.ok(
      !existsSync(
        path.join(f.runtime, 'packages/features/components/shared/card.js'),
      ),
    );
    assert.ok(
      existsSync(
        path.join(f.runtime, 'packages/ratings/components/rating/card.js'),
      ),
    );
    const registration = (file: string) =>
      (JSON.parse(f.read(file)) as { usingComponents: Record<string, string> })
        .usingComponents['wu-icon'];
    assert.equal(registration('components/shared/card.json'), '../icon/icon');
    assert.equal(
      registration('packages/ratings/components/rating/card.json'),
      '../icon/icon',
    );
    assert.equal(
      registration('packages/ratings/pages/rating-detail/rating-detail.json'),
      '../../components/icon/icon',
    );
    assert.equal(
      registration('packages/features/pages/profile/profile.json'),
      '../../components/icon/icon',
    );
    for (const root of roots) {
      for (const extension of ['.js', '.json', '.wxss'])
        assert.equal(
          f.read(root + component + extension),
          f.read(component + extension),
        );
      assert.equal(
        f
          .read(root + component + '.wxml')
          .split('/' + root + 'assets/icons/')
          .join('/assets/icons/'),
        f.read(component + '.wxml'),
      );
      assert.ok(
        f
          .read(root + component + '.wxml')
          .includes('/' + root + 'assets/icons/'),
      );
    }
    assert.deepEqual(
      tree(f.runtime).filter((file) => file.endsWith('shared/state.js')),
      ['shared/state.js'],
    );
    for (const [file, source] of Object.entries(report.iconPlacements))
      assert.equal(
        f.read(file),
        readFileSync(path.join(f.input, source), 'utf8'),
      );
    for (const file of tree(f.runtime)) {
      const root = roots.find((item) => item && file.startsWith(item));
      if (root && /\.(js|json|wxml|wxss)$/.test(file)) {
        const sibling = root.includes('ratings') ? 'features' : 'ratings';
        assert.ok(!f.read(file).includes('packages/' + sibling), file);
        assert.ok(!f.read(file).includes('../../../' + sibling), file);
      }
    }
    const measured = Object.fromEntries(
      ['main', ...roots.slice(1).map((root) => root.slice(0, -1))].map(
        (key) => [key, 0],
      ),
    );
    for (const file of tree(f.runtime)) {
      const key =
        roots.find((root) => root && file.startsWith(root))?.slice(0, -1) ??
        'main';
      measured[key]! += readFileSync(path.join(f.runtime, file)).length;
    }
    assert.deepEqual(report.sizes, measured);
    assert.equal(
      report.iconBytes,
      Object.values(report.iconBytesByPackage).reduce(
        (sum, bytes) => sum + bytes,
        0,
      ),
    );
    const before = fingerprint(f.output);
    f.run();
    assert.equal(fingerprint(f.output), before);
  } finally {
    f.clean();
  }
});

test('app-level registrations remain main and apply through nested and imported templates', () => {
  const f = fixture();
  try {
    const config = JSON.parse(
      readFileSync(path.join(f.input, 'app.json'), 'utf8'),
    );
    config.usingComponents = { 'wu-icon': './' + component };
    f.write('app.json', JSON.stringify(config));
    for (const file of tree(f.input).filter(
      (file) => file.endsWith('.json') && file !== 'app.json',
    )) {
      const json = JSON.parse(readFileSync(path.join(f.input, file), 'utf8'));
      if (json.usingComponents) {
        delete json.usingComponents['wu-icon'];
        f.write(file, JSON.stringify(json));
      }
    }
    const report = f.run();
    assert.deepEqual(report.iconComponents, [component]);
    assert.ok(
      Object.keys(report.iconPlacements).every((file) =>
        file.startsWith('assets/icons/'),
      ),
    );
    assert.ok(report.iconPlacements['assets/icons/dark/template.png']);
    assert.ok(report.iconPlacements['assets/icons/white/shared.png']);
    assert.equal(
      JSON.parse(f.read('app.json')).usingComponents['wu-icon'],
      './' + component,
    );
  } finally {
    f.clean();
  }
});

test('aliased component registrations retain the same local raster contract', () => {
  const f = fixture();
  try {
    f.write(
      'pages/profile/profile.json',
      '{"usingComponents":{"symbol":"../../components/icon/icon"}}',
    );
    f.write(
      'pages/profile/profile.wxml',
      '<symbol name="feature" tone="inverse"/>',
    );
    const report = f.run();
    assert.ok(
      report.iconPlacements['packages/features/assets/icons/light/feature.png'],
    );
    assert.ok(
      report.iconPlacements['packages/features/assets/icons/dark/feature.png'],
    );
    assert.ok(!report.iconPlacements['assets/icons/light/feature.png']);
  } finally {
    f.clean();
  }
});

test('local registrations override app-global icons without promoting their assets', () => {
  const f = fixture();
  try {
    const config = JSON.parse(
      readFileSync(path.join(f.input, 'app.json'), 'utf8'),
    );
    config.usingComponents = { 'wu-icon': './' + component };
    f.write('app.json', JSON.stringify(config));
    const report = f.run();
    assert.ok(
      report.iconPlacements['packages/ratings/assets/icons/accent/rating.png'],
    );
    assert.ok(!report.iconPlacements['assets/icons/accent/rating.png']);
    assert.ok(
      report.iconPlacements['packages/features/assets/icons/white/feature.png'],
    );
    assert.ok(!report.iconPlacements['assets/icons/white/feature.png']);
  } finally {
    f.clean();
  }
});

test('subpackage-only registrations do not emit an unused main icon component', () => {
  const f = fixture();
  try {
    f.write('pages/community-feed/community-feed.json', '{}');
    f.write('pages/community-feed/community-feed.wxml', '<view/>');
    for (const page of ['rating-detail', 'profile'])
      f.write(
        `pages/${page}/${page}.json`,
        '{"usingComponents":{"wu-icon":"../../components/icon/icon"}}',
      );
    const report = f.run();
    assert.deepEqual(report.iconComponents, [
      'packages/features/' + component,
      'packages/ratings/' + component,
    ]);
    assert.ok(!existsSync(path.join(f.runtime, component + '.js')));
    assert.ok(
      Object.keys(report.iconPlacements).every((file) =>
        file.startsWith('packages/'),
      ),
    );
  } finally {
    f.clean();
  }
});

test('static JavaScript icon assets retain their normal owner alongside contextual copies', () => {
  const f = fixture();
  try {
    f.write(
      'pages/profile/profile.js',
      'Page({data:{imageUrl:"/assets/icons/accent/home.png"}});',
    );
    const report = f.run();
    assert.ok(report.iconPlacements['assets/icons/accent/home.png']);
    assert.ok(
      report.iconPlacements['packages/features/assets/icons/accent/home.png'],
    );
    assert.match(
      f.read('packages/features/pages/profile/profile.js'),
      /\/packages\/features\/assets\/icons\/accent\/home\.png/,
    );
  } finally {
    f.clean();
  }
});

test('unbounded properties conservatively expand only the consuming package', () => {
  const f = fixture();
  try {
    f.write(
      'pages/profile/profile.wxml',
      '<wu-icon name="{{item.icon}}" tone="{{item.tone}}"/>',
    );
    const report = f.run();
    assert.equal(
      Object.keys(report.iconPlacements).filter((file) =>
        file.startsWith('packages/features/'),
      ).length,
      names.length * tones.length,
    );
    assert.deepEqual(
      report.iconFallbacks.map((item) => [
        item.file,
        item.attribute,
        item.candidateCount,
      ]),
      [
        ['pages/profile/profile.wxml', 'name', names.length],
        ['pages/profile/profile.wxml', 'tone', tones.length + 2],
      ],
    );
    assert.ok(!report.iconPlacements['assets/icons/accent/unused.png']);
    assert.ok(
      report.iconPlacements['packages/features/assets/icons/accent/unused.png'],
    );
  } finally {
    f.clean();
  }
});

test('the current native raster template passes the complete tag and attribute whitelist unchanged', () => {
  const f = fixture();
  try {
    const markup = readFileSync(
      path.join(__dirname, '../src/components/icon/icon.wxml'),
      'utf8',
    );
    f.write(component + '.wxml', markup);
    f.run();
    for (const root of roots)
      assert.equal(
        f
          .read(root + component + '.wxml')
          .split('/' + root + 'assets/icons/')
          .join('/assets/icons/'),
        markup,
      );
  } finally {
    f.clean();
  }
});

for (const [label, file, content, expected] of [
  [
    'state',
    component + '.js',
    iconJavascript.replace('data: {}', 'data: { counter: 1 }'),
    /not verified stateless/,
  ],
  [
    'methods',
    component + '.js',
    iconJavascript.replace('methods: {}', 'methods: { tap() {} }'),
    /not verified stateless/,
  ],
  [
    'lifecycle',
    component + '.js',
    'Component({ attached() {} });',
    /not verified stateless/,
  ],
  [
    'observer',
    component + '.js',
    iconJavascript.replace("value: 'home'", "value: 'home', observer() {}"),
    /not verified stateless/,
  ],
  [
    'changed default',
    component + '.js',
    iconJavascript.replace("value: 'home'", "value: 'feature'"),
    /not verified stateless/,
  ],
  [
    'missing properties',
    component + '.js',
    'Component({data:{},methods:{}});',
    /missing properties contract/,
  ],
  [
    'missing name property',
    component + '.js',
    iconJavascript.replace("name: { type: String, value: 'home' },", ''),
    /properties must declare name, tone and size/,
  ],
  [
    'missing tone property',
    component + '.js',
    iconJavascript.replace("tone: { type: String, value: 'default' },", ''),
    /properties must declare name, tone and size/,
  ],
  [
    'missing size property',
    component + '.js',
    iconJavascript.replace('size: { type: Number, value: 24 }', ''),
    /properties must declare name, tone and size/,
  ],
  [
    'module dependency',
    component + '.js',
    'const state=require("../../shared/state");' + iconJavascript,
    /not verified stateless/,
  ],
  [
    'import',
    component + '.js',
    'import "../../shared/state";' + iconJavascript,
    /Unsupported import syntax/,
  ],
  [
    'new top-level behavior',
    component + '.js',
    iconJavascript + '\nglobalThis.counter++;',
    /not verified stateless/,
  ],
  [
    'JSON dependency',
    component + '.json',
    '{"component":true,"usingComponents":{"card":"../shared/card"}}',
    /not verified stateless/,
  ],
  [
    'stylesheet dependency',
    component + '.wxss',
    '@import "../shared/card.wxss";',
    /not verified stateless/,
  ],
  [
    'changed raster expression',
    component + '.wxml',
    '<image src="/assets/icons/{{unknown}}/{{name}}.png"/>',
    /not verified stateless/,
  ],
  [
    'native interactive markup',
    component + '.wxml',
    '<image src="/assets/icons/{{tone}}/{{name}}.png"/><button open-type="contact">Contact</button>',
    /unsupported raster tag/,
  ],
  [
    'native event handler',
    component + '.wxml',
    '<image bindtap="onTap" src="/assets/icons/{{tone}}/{{name}}.png"/>',
    /unsupported raster attribute/,
  ],
  [
    'native event capture',
    component + '.wxml',
    '<view capture-catch:touchstart="onTouch"><image src="/assets/icons/{{tone}}/{{name}}.png"/></view>',
    /unsupported raster attribute/,
  ],
  [
    'custom component markup',
    component + '.wxml',
    '<image src="/assets/icons/{{tone}}/{{name}}.png"/><shared-card/>',
    /unsupported raster tag/,
  ],
  [
    'undeclared property binding',
    component + '.wxml',
    '<view style="width:{{other}}px;"><image src="/assets/icons/{{tone}}/{{name}}.png"/></view>',
    /unsupported raster attribute/,
  ],
  [
    'unbalanced raster markup',
    component + '.wxml',
    '<view><image src="/assets/icons/{{tone}}/{{name}}.png"/></block>',
    /unbalanced raster markup/,
  ],
  [
    'direct module consumer',
    'pages/profile/profile.js',
    'Page({data:{icon:require("../../components/icon/icon")}});',
    /not verified stateless/,
  ],
  [
    'unknown registration',
    'pages/profile/profile.json',
    '{}',
    /Unknown icon component registration/,
  ],
  [
    'unsupported interpolation',
    'pages/profile/profile.wxml',
    '<wu-icon name="prefix-{{item.icon}}" />',
    /Unsupported interpolated icon attribute/,
  ],
] as const) {
  test(`local icon packaging rejects ${label} before replacing an existing artifact`, () => {
    const f = fixture();
    try {
      f.run();
      const before = fingerprint(f.output);
      f.write(file, content);
      const result = f.fail();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(fingerprint(f.output), before);
    } finally {
      f.clean();
    }
  });
}
