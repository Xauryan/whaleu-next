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
import vm from 'node:vm';
import test from 'node:test';

const script = path.join(__dirname, '../scripts/package-release.mjs');
interface Report {
  builder: string;
  sourceFingerprint: string;
  sizes: Record<string, number>;
  aliases: Record<string, string>;
  icons: string[];
  iconBytes: number;
  iconFallbacks: {
    file: string;
    attribute: string;
    expression: string;
    candidateCount: number;
  }[];
  sharedFiles: string[];
  javascriptAssetFiles: string[];
  mainRoutes: string[];
  nativeVerification: string;
  droppedFiles: string[];
  thirdPartyNotices: string[];
}
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'whaleu-release-test-'));
  const input = path.join(root, 'dist');
  const output = path.join(root, 'release');
  const project = path.join(root, 'project.config.json');
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(input, file)), { recursive: true });
    writeFileSync(path.join(input, file), text);
  };
  const page = (name: string, js: string, wxml = '<view />') => {
    const route = `pages/${name}/${name}`;
    write(route + '.js', js);
    write(route + '.wxml', wxml);
    write(route + '.wxss', '@import "../../shared/common.wxss";\n');
    write(
      route + '.json',
      JSON.stringify({
        navigationBarTitleText: name,
        usingComponents: { 'wu-icon': '../../components/icon/icon' },
      }),
    );
    return route;
  };
  const routes = [
    page(
      'community-feed',
      'Page({data:{}});',
      '<wu-icon name="menu" /><wu-icon name="heart" tone="{{liked ? \'pink\' : \'muted\'}}" />',
    ),
    page(
      'rating-detail',
      'const shared=require("../../shared/state");const detail=require("../../rating/detail");Page({data:{value:detail.value,shared:shared.value}});',
      '<import src="../../rating/card.wxml"/><wu-icon name="heart" tone="white" />',
    ),
    page(
      'profile',
      'const shared=require("../../shared/state");const profile=require("../../profile/detail");Page({data:{value:profile.value,shared:shared.value}});',
      '<include src="../../profile/card.wxml"/><wu-icon name="{{item.icon}}" tone="accent" />',
    ),
  ];
  write(
    'app.json',
    JSON.stringify({
      pages: routes,
      sitemapLocation: 'sitemap.json',
      themeLocation: 'theme.json',
    }),
  );
  write('app.js', 'App({});');
  write('app.wxss', 'page { color: #123456; }\n');
  write('sitemap.json', '{}');
  write('theme.json', '{}');
  write('shared/common.wxss', '.common { margin: 12rpx 4rpx; }\n');
  write('shared/state.js', 'exports.value = {counter: 0};');
  write('rating/detail.js', 'exports.value = "rating";');
  write('rating/card.wxml', '<view>Rating</view>');
  write('profile/detail.js', 'exports.value = "profile";');
  write('profile/card.wxml', '<view>Profile</view>');
  write('unused/debug.js', 'throw new Error("not a runtime dependency");');
  write(
    'components/icon/icon.js',
    `Component({
      properties: {
        name: { type: String, value: 'home' },
        tone: { type: String, value: 'default' },
        size: { type: Number, value: 24 }
      },
      data: {},
      methods: {}
    });`,
  );
  write('components/icon/icon.json', '{"component":true}');
  write('components/icon/icon.wxss', '.icon { width: 72rpx; }\n');
  write(
    'components/icon/icon.wxml',
    '<image src="/assets/icons/{{tone}}/{{name}}.png"/>',
  );
  const names = ['menu', 'heart'];
  const tones = ['light', 'dark', 'accent', 'muted', 'pink', 'white', 'green'];
  write(
    'assets/icons/manifest.json',
    JSON.stringify({
      names,
      tones: Object.fromEntries(tones.map((tone) => [tone, '#123456'])),
    }),
  );
  for (const name of names)
    for (const tone of tones)
      write(`assets/icons/${tone}/${name}.png`, `png:${tone}:${name}`);
  writeFileSync(
    project,
    JSON.stringify({
      miniprogramRoot: 'dist/',
      appid: 'touristappid',
      setting: { minified: false },
    }),
  );
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
    write,
    args,
    run: () => {
      execFileSync(process.execPath, args, { stdio: 'pipe' });
      return JSON.parse(
        readFileSync(path.join(output, 'package-report.json'), 'utf8'),
      ) as Report;
    },
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
function digest(root: string): string {
  const hash = createHash('sha256');
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else hash.update(path.relative(root, file)).update(readFileSync(file));
    }
  };
  visit(root);
  return hash.digest('hex');
}
test('release packaging isolates two packages, promotes shared state and preserves source', () => {
  const f = fixture();
  try {
    const before = digest(f.input);
    const report = f.run();
    const runtime = path.join(f.output, 'miniprogram');
    assert.equal(digest(f.input), before);
    assert.ok(report.sharedFiles.includes('shared/state.js'));
    assert.ok(existsSync(path.join(runtime, 'shared/state.js')));
    assert.ok(
      existsSync(path.join(runtime, 'packages/ratings/rating/detail.js')),
    );
    assert.ok(
      existsSync(path.join(runtime, 'packages/features/profile/detail.js')),
    );
    assert.ok(!existsSync(path.join(runtime, 'unused/debug.js')));
    assert.match(
      readFileSync(
        path.join(
          runtime,
          'packages/ratings/pages/rating-detail/rating-detail.js',
        ),
        'utf8',
      ),
      /\.\.\/\.\.\/\.\.\/\.\.\/shared\/state/,
    );
    assert.match(
      readFileSync(
        path.join(runtime, 'packages/features/pages/profile/profile.json'),
        'utf8',
      ),
      /\.\.\/\.\.\/components\/icon\/icon/,
    );
    assert.match(
      readFileSync(
        path.join(
          runtime,
          'packages/ratings/pages/rating-detail/rating-detail.wxml',
        ),
        'utf8',
      ),
      /\.\.\/\.\.\/rating\/card\.wxml/,
    );
    assert.equal(
      readFileSync(path.join(runtime, 'shared/common.wxss'), 'utf8'),
      '.common{margin:12rpx 4rpx}\n',
    );
    assert.deepEqual(Object.keys(report.aliases).sort(), [
      'pages/profile/profile',
      'pages/rating-detail/rating-detail',
    ]);
    assert.equal(
      readFileSync(path.join(runtime, 'pages/profile/profile.wxml'), 'utf8'),
      '<include src="../../shell/route-alias.wxml"/>',
    );
    assert.match(
      readFileSync(path.join(runtime, 'shell/route-alias.wxml'), 'utf8'),
      /bindtap="onRetry"/,
    );
    assert.ok(Object.values(report.sizes).every((bytes) => bytes <= 2097152));
    assert.match(report.nativeVerification, /Not performed/);
    const first = digest(f.output);
    f.run();
    assert.equal(digest(f.output), first, 'Repeatable artifact bytes');
  } finally {
    f.clean();
  }
});

test('icon retention covers new names, conditional tones and unknown dynamic names without unused palettes', () => {
  const f = fixture();
  try {
    const report = f.run();
    assert.deepEqual(report.icons, [
      'assets/icons/accent/heart.png',
      'assets/icons/accent/menu.png',
      'assets/icons/dark/menu.png',
      'assets/icons/light/menu.png',
      'assets/icons/muted/heart.png',
      'assets/icons/pink/heart.png',
      'assets/icons/white/heart.png',
    ]);
    assert.ok(!report.icons.some((file) => file.includes('/green/')));
    assert.deepEqual(report.iconFallbacks, [
      {
        file: 'pages/profile/profile.wxml',
        attribute: 'name',
        expression: '{{item.icon}}',
        candidateCount: 2,
      },
    ]);
  } finally {
    f.clean();
  }
});

test('unbounded icon properties retain every candidate and expose the expansion instead of guessing runtime values', () => {
  const f = fixture();
  try {
    f.write(
      'pages/profile/profile.wxml',
      '<wu-icon name="{{icon}}" tone="{{tone}}" />',
    );
    const report = f.run();
    assert.equal(report.icons.length, 14);
    assert.ok(report.iconBytes > 0);
    assert.deepEqual(report.iconFallbacks, [
      {
        file: 'pages/profile/profile.wxml',
        attribute: 'name',
        expression: '{{icon}}',
        candidateCount: 2,
      },
      {
        file: 'pages/profile/profile.wxml',
        attribute: 'tone',
        expression: '{{tone}}',
        candidateCount: 9,
      },
    ]);
    const failed = spawnSync(process.execPath, [...f.args, '--budget', '1'], {
      encoding: 'utf8',
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /retained 14 icons/);
    assert.match(failed.stderr, /profile\.wxml tone=\{\{tone\}\}/);
  } finally {
    f.clean();
  }
});

test('social and rating notification pages share a controller inside the ratings package, not main', () => {
  const f = fixture();
  try {
    const route = 'pages/social-notices/social-notices';
    const config = JSON.parse(
      readFileSync(path.join(f.input, 'app.json'), 'utf8'),
    );
    config.pages.push(route);
    f.write('app.json', JSON.stringify(config));
    f.write(
      'ratings/updates-controller.js',
      'exports.reader={kind:"ratings"};',
    );
    f.write(
      'rating/detail.js',
      'exports.value=require("../ratings/updates-controller").reader;',
    );
    f.write(
      route + '.js',
      'Page({data:{reader:require("../../ratings/updates-controller").reader}});',
    );
    f.write(route + '.json', '{}');
    f.write(route + '.wxml', '<view />');
    f.write(route + '.wxss', '');
    const report = f.run();
    const runtime = path.join(f.output, 'miniprogram');
    assert.equal(
      report.aliases[route],
      '/packages/ratings/pages/social-notices/social-notices',
    );
    assert.ok(
      existsSync(
        path.join(runtime, 'packages/ratings/ratings/updates-controller.js'),
      ),
    );
    assert.ok(!existsSync(path.join(runtime, 'ratings/updates-controller.js')));
    assert.ok(!report.sharedFiles.includes('ratings/updates-controller.js'));
  } finally {
    f.clean();
  }
});

test('static JavaScript share assets are retained and relocated with root-absolute URLs', () => {
  const f = fixture();
  try {
    f.write('assets/share/profile.png', 'public neutral profile cover');
    f.write('assets/share/rating.webp', 'public neutral rating cover');
    f.write('shared/share.js', 'exports.imageUrl="/assets/share/profile.png";');
    f.write(
      'pages/community-feed/community-feed.js',
      'Page({data:{imageUrl:require("../../shared/share").imageUrl}});',
    );
    f.write(
      'pages/profile/profile.js',
      'Page({data:{imageUrl:require("../../shared/share").imageUrl}});',
    );
    f.write(
      'rating/detail.js',
      'exports.value="rating";exports.imageUrl=`/assets/share/rating.webp`;',
    );
    const sourceBefore = digest(f.input);
    const report = f.run();
    const runtime = path.join(f.output, 'miniprogram');
    assert.equal(digest(f.input), sourceBefore);
    assert.deepEqual(report.javascriptAssetFiles, [
      'assets/share/profile.png',
      'packages/ratings/assets/share/rating.webp',
    ]);
    assert.equal(
      readFileSync(path.join(runtime, 'assets/share/profile.png'), 'utf8'),
      'public neutral profile cover',
    );
    assert.equal(
      readFileSync(
        path.join(runtime, 'packages/ratings/assets/share/rating.webp'),
        'utf8',
      ),
      'public neutral rating cover',
    );
    const shared: Record<string, unknown> = {};
    vm.runInNewContext(
      readFileSync(path.join(runtime, 'shared/share.js'), 'utf8'),
      { exports: shared },
    );
    assert.equal(shared['imageUrl'], '/assets/share/profile.png');
    const rating: Record<string, unknown> = {};
    vm.runInNewContext(
      readFileSync(
        path.join(runtime, 'packages/ratings/rating/detail.js'),
        'utf8',
      ),
      { exports: rating },
    );
    assert.equal(
      rating['imageUrl'],
      '/packages/ratings/assets/share/rating.webp',
    );
    assert.ok(!existsSync(path.join(runtime, 'assets/share/rating.webp')));
  } finally {
    f.clean();
  }
});

test('transformed page modules execute with the same main-package singleton', () => {
  const f = fixture();
  try {
    f.run();
    const runtime = path.join(f.output, 'miniprogram');
    const registered: { data: { value: string; shared: object } }[] = [];
    const cache = new Map<string, { exports: Record<string, unknown> }>();
    const load = (file: string): Record<string, unknown> => {
      file = path.resolve(file);
      assert.ok(file.startsWith(runtime + path.sep));
      const previous = cache.get(file);
      if (previous) return previous.exports;
      const module = { exports: {} };
      cache.set(file, module);
      const execute = vm.runInNewContext(
        `(function (exports, require, module) { ${readFileSync(file, 'utf8')}\n})`,
        {
          Page: (value: { data: { value: string; shared: object } }) =>
            registered.push(value),
        },
      ) as (
        exports: object,
        require: (specifier: string) => Record<string, unknown>,
        module: { exports: object },
      ) => void;
      execute(
        module.exports,
        (specifier) =>
          load(path.resolve(path.dirname(file), specifier + '.js')),
        module,
      );
      return module.exports;
    };
    load(
      path.join(
        runtime,
        'packages/ratings/pages/rating-detail/rating-detail.js',
      ),
    );
    load(path.join(runtime, 'packages/features/pages/profile/profile.js'));
    assert.equal(registered[0]?.data.value, 'rating');
    assert.equal(registered[1]?.data.value, 'profile');
    assert.equal(registered[0]?.data.shared, registered[1]?.data.shared);
  } finally {
    f.clean();
  }
});

test('redirect aliases replace rather than push history, preserve query and fence repeated/stale callbacks', () => {
  const f = fixture();
  try {
    f.run();
    const runtime = path.join(f.output, 'miniprogram');
    const exports: Record<string, unknown> = {};
    const requests: { url: string; fail: () => void }[] = [];
    const stack = [
      '/pages/community-feed/community-feed',
      '/pages/profile/profile',
    ];
    let definition: Record<string, unknown> = {};
    const context = vm.createContext({
      exports,
      wx: {
        redirectTo: (request: { url: string; fail: () => void }) =>
          requests.push(request),
      },
      Page: (value: Record<string, unknown>) => {
        definition = value;
      },
      require: (name: string) => {
        assert.equal(name, '../../shell/route-alias');
        return exports;
      },
    });
    vm.runInContext(
      readFileSync(path.join(runtime, 'shell/route-alias.js'), 'utf8'),
      context,
    );
    vm.runInContext(
      readFileSync(path.join(runtime, 'pages/profile/profile.js'), 'utf8'),
      context,
    );
    const updates: Record<string, unknown>[] = [];
    const page = {
      ...definition,
      setData: (value: Record<string, unknown>) => updates.push(value),
    } as unknown as Record<string, unknown> & {
      onLoad: (query: Record<string, string>) => void;
      onRetry: () => void;
      onUnload: () => void;
    };
    page.onLoad({ id: 'A&B?=#中文', empty: '', space: 'a b', '%': '%' });
    assert.equal(requests.length, 1);
    page.onRetry();
    assert.equal(requests.length, 1, 'One navigation per pending alias');
    const url = new URL(requests[0]!.url, 'https://native.invalid');
    assert.equal(url.pathname, '/packages/features/pages/profile/profile');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      id: 'A&B?=#中文',
      empty: '',
      space: 'a b',
      '%': '%',
    });
    requests[0]!.fail();
    assert.equal(updates[updates.length - 1]?.['opening'], false);
    page.onRetry();
    assert.equal(requests.length, 2);
    stack.splice(-1, 1, requests[1]!.url);
    page.onUnload();
    const before = updates.length;
    requests[1]!.fail();
    page.onRetry();
    assert.equal(
      updates.length,
      before,
      'Unload fences late failures and retry',
    );
    stack.pop();
    assert.deepEqual(stack, ['/pages/community-feed/community-feed']);
  } finally {
    f.clean();
  }
});

test('native tab pages stay main even when their names normally match a deep package', () => {
  const f = fixture();
  try {
    const config = JSON.parse(
      readFileSync(path.join(f.input, 'app.json'), 'utf8'),
    );
    config.tabBar = {
      list: [
        { pagePath: 'pages/community-feed/community-feed' },
        { pagePath: 'pages/rating-detail/rating-detail' },
      ],
    };
    f.write('app.json', JSON.stringify(config));
    const report = f.run();
    assert.ok(report.mainRoutes.includes('pages/rating-detail/rating-detail'));
    assert.equal(
      report.aliases['pages/rating-detail/rating-detail'],
      undefined,
    );
  } finally {
    f.clean();
  }
});

for (const [label, mutate, expected] of [
  [
    'missing stylesheet',
    (f: ReturnType<typeof fixture>) =>
      f.write('pages/profile/profile.wxss', '@import "../../missing.wxss";'),
    /Missing dependency/,
  ],
  [
    'dynamic require',
    (f: ReturnType<typeof fixture>) =>
      f.write('profile/detail.js', 'exports.value=require(name);'),
    /Unsupported dynamic/,
  ],
  [
    'unresolved icon',
    (f: ReturnType<typeof fixture>) =>
      f.write(
        'pages/profile/profile.wxml',
        '<wu-icon name="not-a-real-icon" />',
      ),
    /Missing referenced native icon/,
  ],
  [
    'unknown dynamic local image',
    (f: ReturnType<typeof fixture>) =>
      f.write(
        'pages/profile/profile.wxml',
        '<image src="/private/{{item.id}}.png" />',
      ),
    /Unsupported dynamic local asset/,
  ],
  [
    'missing JavaScript native share asset',
    (f: ReturnType<typeof fixture>) =>
      f.write(
        'profile/detail.js',
        'exports.imageUrl="/assets/share/missing.png";',
      ),
    /Missing dependency/,
  ],
  [
    'dynamically concatenated native asset',
    (f: ReturnType<typeof fixture>) =>
      f.write(
        'profile/detail.js',
        'exports.imageUrl="/assets/share/"+name+".png";',
      ),
    /Unsupported dynamic\/invalid native asset/,
  ],
  [
    'dynamic native asset template',
    (f: ReturnType<typeof fixture>) =>
      f.write(
        'profile/detail.js',
        'exports.imageUrl=`/assets/share/${name}.png`;',
      ),
    /Unsupported dynamic native asset/,
  ],
  [
    'traversing native asset path',
    (f: ReturnType<typeof fixture>) =>
      f.write(
        'profile/detail.js',
        'exports.imageUrl="/assets/../profile/detail.js";',
      ),
    /Unsupported dynamic\/invalid native asset/,
  ],
  [
    'existing subpackages',
    (f: ReturnType<typeof fixture>) =>
      f.write(
        'app.json',
        '{"pages":["pages/community-feed/community-feed"],"subPackages":[]}',
      ),
    /Expected a flat/,
  ],
] as const) {
  test(`release fails closed on ${label} and retains the preceding successful artifact`, () => {
    const f = fixture();
    try {
      f.run();
      const before = digest(f.output);
      mutate(f);
      const result = spawnSync(process.execPath, f.args, { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(digest(f.output), before);
    } finally {
      f.clean();
    }
  });
}

test('budget failures and unsafe output paths do not alter built source or successful release', () => {
  const f = fixture();
  try {
    f.run();
    const before = digest(f.output);
    const source = digest(f.input);
    const result = spawnSync(process.execPath, [...f.args, '--budget', '1'], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /budget exceeded/);
    assert.equal(digest(f.output), before);
    const unsafe = spawnSync(
      process.execPath,
      [...f.args, '--output', f.input],
      { encoding: 'utf8' },
    );
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /separate from the input/);
    assert.equal(digest(f.input), source);
  } finally {
    f.clean();
  }
});

test('release refuses to erase an existing directory without its own report', () => {
  const f = fixture();
  try {
    mkdirSync(f.output);
    writeFileSync(path.join(f.output, 'important.txt'), 'keep');
    const result = spawnSync(process.execPath, f.args, { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to replace output/);
    assert.equal(
      readFileSync(path.join(f.output, 'important.txt'), 'utf8'),
      'keep',
    );
  } finally {
    f.clean();
  }
});

test('WXSS packaging compacts whitespace without rewriting units, calculation semantics or quoted text', () => {
  const f = fixture();
  try {
    f.write(
      'shared/common.wxss',
      `/* authoring note */
.common::after { content: "a  b > c"; width: calc(100% - 12rpx); padding-bottom: env(safe-area-inset-bottom); color: var(--wu-text, #1d1d1f); }
@media (prefers-color-scheme: dark) { .common { --wu-text: #ffffff; } }
`,
    );
    f.run();
    const css = readFileSync(
      path.join(f.output, 'miniprogram/shared/common.wxss'),
      'utf8',
    );
    assert.match(css, /content:"a {2}b > c"/);
    assert.match(css, /calc\(100% - 12rpx\)/);
    assert.match(css, /env\(safe-area-inset-bottom\)/);
    assert.match(css, /var\(--wu-text,\s*#1d1d1f\)/);
    assert.match(css, /@media\(prefers-color-scheme:dark\)/);
    assert.match(css, /--wu-text:\s*#ffffff/);
    assert.doesNotMatch(css, /authoring note/);
  } finally {
    f.clean();
  }
});

test('major family including recovery shares rating state once and keeps all legacy aliases', () => {
  const f = fixture();
  try {
    const names = [
      'major-directory',
      'major-detail',
      'major-discussion',
      'major-discussion-thread',
      'major-discussion-notices',
      'major-discussion-recovery',
    ];
    const config = JSON.parse(
      readFileSync(path.join(f.input, 'app.json'), 'utf8'),
    );
    f.write('shared/discussion-state.js', 'exports.state={generation:1};');
    f.write(
      'rating/detail.js',
      'exports.value=require("../shared/discussion-state").state;',
    );
    for (const name of names) {
      const route = `pages/${name}/${name}`;
      config.pages.push(route);
      f.write(
        route + '.js',
        'Page({data:{state:require("../../shared/discussion-state").state}});',
      );
      f.write(route + '.json', '{}');
      f.write(route + '.wxml', '<view />');
      f.write(route + '.wxss', '');
    }
    f.write('app.json', JSON.stringify(config));
    const report = f.run();
    const runtime = path.join(f.output, 'miniprogram');
    for (const name of names) {
      const route = `pages/${name}/${name}`;
      assert.equal(report.aliases[route], '/packages/ratings/' + route);
      assert.ok(
        existsSync(path.join(runtime, route + '.js')),
        'legacy route remains valid',
      );
      assert.ok(
        existsSync(path.join(runtime, 'packages/ratings/' + route + '.js')),
      );
    }
    assert.ok(
      existsSync(
        path.join(runtime, 'packages/ratings/shared/discussion-state.js'),
      ),
    );
    assert.ok(!existsSync(path.join(runtime, 'shared/discussion-state.js')));
    assert.ok(
      !existsSync(
        path.join(runtime, 'packages/features/shared/discussion-state.js'),
      ),
    );
    assert.ok(!report.sharedFiles.includes('shared/discussion-state.js'));
  } finally {
    f.clean();
  }
});

test('native Framework7 ports retain full pinned MIT notice and fail closed if absent or changed', () => {
  const f = fixture();
  try {
    f.write(
      'components/f7-button/f7-button.js',
      'Component({properties:{},data:{},methods:{}});',
    );
    f.write('components/f7-button/f7-button.json', '{"component":true}');
    f.write('components/f7-button/f7-button.wxml', '<button>Continue</button>');
    f.write('components/f7-button/f7-button.wxss', '.button{min-height:44px}');
    f.write(
      'pages/profile/profile.json',
      JSON.stringify({
        usingComponents: {
          'wu-f7-button': '../../components/f7-button/f7-button',
        },
      }),
    );
    f.write('pages/profile/profile.wxml', '<wu-f7-button />');
    assert.throws(() => f.run(), /third-party-notices/);
    const notice = readFileSync(
      path.join(__dirname, '../src/third-party-notices.json'),
      'utf8',
    );
    f.write('third-party-notices.json', notice);
    const report = f.run();
    assert.deepEqual(report.thirdPartyNotices, ['third-party-notices.json']);
    assert.ok(!report.droppedFiles.includes('third-party-notices.json'));
    assert.equal(
      readFileSync(
        path.join(f.output, 'miniprogram/third-party-notices.json'),
        'utf8',
      ),
      notice,
    );
    f.write(
      'third-party-notices.json',
      notice.replace('Permission is hereby granted', 'Permission removed'),
    );
    assert.throws(() => f.run(), /complete pinned MIT license/);
  } finally {
    f.clean();
  }
});
