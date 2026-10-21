import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
const root = path.join(__dirname, '../src');
const icons = path.join(root, 'assets/icons');
const manifest = JSON.parse(
  readFileSync(path.join(icons, 'manifest.json'), 'utf8'),
) as { names: string[]; tones: Record<string, string> };
test('every original icon has native 3x PNGs in every tone and a vector source', () => {
  assert.ok(manifest.names.length >= 40);
  for (const name of manifest.names) {
    assert.match(name, /^[a-z-]+$/);
    assert.ok(existsSync(path.join(icons, 'source', `${name}.svg`)));
    assert.match(
      readFileSync(path.join(icons, 'source', `${name}.svg`), 'utf8'),
      /color="#1d1d1f"/,
      `${name} must expose the native palette token`,
    );
    for (const tone of Object.keys(manifest.tones)) {
      const bytes = readFileSync(path.join(icons, tone, `${name}.png`));
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      assert.equal(bytes.readUInt32BE(16), 72);
      assert.equal(bytes.readUInt32BE(20), 72);
    }
  }
});
test('icon component uses native PNGs with default and inverse light/dark variants, no font or SVG dependency', () => {
  const markup = readFileSync(
    path.join(root, 'components/icon/icon.wxml'),
    'utf8',
  );
  assert.match(markup, /\.png/);
  assert.match(markup, /tone === 'inverse'/);
  assert.doesNotMatch(markup, /\.svg|font-family|SF Symbols/);
  const component = JSON.parse(
    readFileSync(path.join(root, 'components/tab-bar/tab-bar.json'), 'utf8'),
  );
  assert.equal(component.usingComponents['wu-icon'], '../icon/icon');
  const bar = readFileSync(
    path.join(root, 'components/tab-bar/tab-bar.wxml'),
    'utf8',
  );
  for (const label of ['首页', '校园', '消息', '我的'])
    assert.ok(bar.includes(label));
  assert.doesNotMatch(bar, /name="{{selected/);
  assert.match(bar, /name="plus" tone="white"/);
});

test('all native page and template literal icon names and tones resolve to real raster assets', () => {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(directory, entry.name))
        : entry.name.endsWith('.wxml')
          ? [path.join(directory, entry.name)]
          : [],
    );
  let checked = 0;
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(
      /<wu-icon\b((?:"[^"]*"|'[^']*'|[^'">])*)\/?>/g,
    )) {
      const name = /\bname="([^"]*)"/.exec(match[1]!)?.[1] ?? 'home';
      const tone = /\btone="([^"]*)"/.exec(match[1]!)?.[1] ?? 'default';
      if (!tone.includes('{{'))
        assert.ok(
          ['default', 'inverse', ...Object.keys(manifest.tones)].includes(tone),
          `${file}: unsupported tone ${tone}`,
        );
      if (!name.includes('{{'))
        assert.ok(
          manifest.names.includes(name),
          `${file}: missing icon ${name}`,
        );
      checked++;
    }
  }
  assert.ok(checked > 200);
});
