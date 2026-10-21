import {
  decodeSourcePresentation,
  type SourcePresentation,
} from '../src/community/text-source-read-contract';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {
  renderTextSource,
  SOURCE_TEXT_PREVIEW_LIMITS,
  type SourceTextRender,
  type SourceTextRenderInput,
} from '../src/community/text-source-renderer';
import {
  sourceEligible,
  textSourceHash,
  type TextSourceDescriptor,
} from '../src/community/text-source-contract';

const markdown = { version: 1, format: 'markdown' } as const;
const auto = {
  version: 1,
  format: 'plain',
  readingFormatting: 'auto',
} as const;
const off = { version: 1, format: 'plain', readingFormatting: 'off' } as const;
const id = '12345678-1234-4234-8234-123456789012';
const contents = (view: SourceTextRender) =>
  view.blocks.map((block) => block.runs.map((run) => run.text).join(''));
const editor = (source: string, descriptor: unknown = markdown) =>
  renderTextSource({ source, descriptor });
function reviewed(
  text: string,
  syntax: TextSourceDescriptor = auto,
): SourcePresentation {
  const eligible = sourceEligible(text, syntax, 'post');
  return decodeSourcePresentation({
    version: 2,
    source: {
      version: 1,
      classification: 'reviewedSource',
      kind: 'post',
      id,
      postId: id,
      rootCommentId: null,
      text,
      sourceRevision: 1,
      textSource: { ...syntax, sourceHash: textSourceHash(text, syntax) },
      readingFormattingEligible: eligible,
      presentationStatus: eligible ? 'not_configured' : 'ineligible',
    },
    presentation: { status: 'source' },
  });
}
function formatted(text: string, endpoints: number[]): SourcePresentation {
  const source = reviewed(text).source;
  let cursor = 0;
  return decodeSourcePresentation({
    version: 2,
    source,
    presentation: {
      status: 'formatted',
      plan: {
        version: 1,
        formatter: 'plain-cjk-slices-v2',
        offsetEncoding: 'utf16',
        mode: 'grouped',
        reason: 'grouped',
        spans: endpoints.map((end) => {
          const start = cursor;
          cursor = end;
          return { start, end };
        }),
      },
    },
  });
}
const unsafeRead = (raw: unknown) =>
  renderTextSource({
    presentation: raw as SourcePresentation,
    source: 'UNRELATED PRIVATE EDITOR TEXT',
    descriptor: markdown,
  });

test('plain auto is the default; off and legacy never guess Markdown or make a plan', () => {
  const source = '# Not a heading\r\n- not a list\r\n**not bold** 😀';
  for (const descriptor of [undefined, null, auto, off]) {
    const view = renderTextSource({ source, descriptor });
    assert.equal(view.mode, 'plain');
    assert.equal(view.rawSource, source);
    assert.deepEqual(contents(view), [source]);
    assert.equal(view.canToggleSource, false);
    assert.equal('plan' in view, false);
  }
  const legacy = decodeSourcePresentation({
    version: 2,
    source: {
      version: 1,
      classification: 'legacyPlain',
      kind: 'post',
      id,
      postId: id,
      rootCommentId: null,
      text: '# Legacy **text**',
    },
    presentation: { status: 'source' },
  });
  const view = renderTextSource({
    presentation: legacy,
    descriptor: markdown,
    source: '**unrelated**',
  });
  assert.equal(view.mode, 'plain');
  assert.deepEqual(contents(view), ['# Legacy **text**']);
});

test('explicit Markdown renders bounded headings, lists, quote, fenced code and inline styles', () => {
  const source =
    '# Heading\n## Smaller\n- item **strong**\n2. item *em*\n> quote _em_\n\n```ts\n<script>literal &amp;</script>\n![no](https://example.test/a)\n```\nlast `code`';
  const view = editor(source);
  assert.equal(view.mode, 'markdown');
  assert.equal(view.rawSource, source);
  assert.equal(view.canToggleSource, true);
  assert.deepEqual(
    view.blocks.map((block) => block.kind),
    [
      'heading',
      'heading',
      'list',
      'list',
      'quote',
      'blank',
      'code',
      'paragraph',
    ],
  );
  assert.deepEqual(
    view.blocks.slice(0, 2).map((block) => block.level),
    [1, 2],
  );
  assert.equal(view.blocks[2]!.marker, '-');
  assert.equal(view.blocks[3]!.marker, '2.');
  assert.equal(view.blocks[2]!.runs[1]!.style, 'strong');
  assert.equal(view.blocks[3]!.runs[1]!.style, 'emphasis');
  assert.equal(view.blocks[4]!.runs[1]!.style, 'emphasis');
  assert.equal(
    view.blocks[6]!.runs[0]!.text,
    '<script>literal &amp;</script>\n![no](https://example.test/a)\n',
  );
  assert.equal(view.blocks[7]!.runs[1]!.style, 'code');
  assert.deepEqual(contents(view).slice(0, 5), [
    'Heading',
    'Smaller',
    'item strong',
    'item em',
    'quote em',
  ]);
});

test('HTML, scripts, entities, URL schemes, images and links are literal text, never executable output', () => {
  for (const source of [
    '<script>alert("x")</script>',
    '<image src="https://example.test/x" onerror="alert(1)" />',
    '<a href="javascript:alert(1)">**not interpreted**</a>',
    '[**label**](javascript:alert(1))',
    '![*image*](https://example.test/x)',
    '[reference]: https://example.test/a',
    'https://example.test/*secret*?a=1&b=2',
    'javascript:alert(1)',
    'data:text/html,<script>test</script>',
    'www.example.test/*raw*',
    '&lt;script&gt;&amp;&#x1F600;',
    '{{constructor.constructor("return globalThis")()}}',
    '<https://example.test/x>',
  ]) {
    const view = editor(source);
    assert.equal(view.rawSource, source);
    assert.deepEqual(contents(view), [source]);
    assert.deepEqual(view.blocks[0]!.runs, [
      { key: 0, text: source, style: 'plain' },
    ]);
    for (const block of view.blocks) {
      assert.deepEqual(Object.keys(block).sort(), [
        'key',
        'kind',
        'level',
        'marker',
        'runs',
      ]);
      for (const run of block.runs)
        assert.deepEqual(Object.keys(run).sort(), ['key', 'style', 'text']);
    }
  }
});

test('unsupported, nested, escaped and incomplete syntax remains literal without dropping markers', () => {
  for (const source of [
    '~~strike~~',
    '***nested***',
    '**a *b* c**',
    'snake_case_value',
    '\\*escaped*',
    '>> nested quote',
    '    # indented heading',
    '#missing-space',
    '- [x] task',
    '| a | b |',
    '```\nunfinished **code**',
    '*unclosed',
    '`unclosed',
    '**broken***',
  ]) {
    const view = editor(source);
    assert.equal(view.rawSource, source);
    // Recognized list prefixes are represented by a native literal marker.
    const shown = view.blocks
      .map(
        (block) =>
          `${block.marker ? block.marker + ' ' : ''}${block.runs.map((run) => run.text).join('')}`,
      )
      .join('\n');
    assert.equal(shown, source);
  }
});

test('raw original is exact for CRLF, lone CR, whitespace, trailing blank lines and surrogate emoji', () => {
  const source =
    '  # 😀 Heading\r\n\r\n```\r\n a\t😀 \r\nb\r\n```\r\nlast **😀**\r\n\r';
  const view = editor(source);
  assert.equal(view.rawSource, source);
  assert.equal(
    view.blocks.find((block) => block.kind === 'code')!.runs[0]!.text,
    ' a\t😀 \r\nb\r\n',
  );
  assert.equal(
    view.blocks.find((block) =>
      block.runs.some((run) => run.style === 'strong'),
    )!.runs[1]!.text,
    '😀',
  );
  assert.equal(view.rawSource.length, source.length);
  assert.equal(view.rawSource.charCodeAt(view.rawSource.length - 1), 13);
});

test('reviewed Markdown requires explicit source syntax and does not use unrelated editor props', () => {
  const source = reviewed('# Heading\n**strong**', markdown);
  const snapshot = JSON.stringify(source);
  const view = renderTextSource({
    presentation: source,
    descriptor: off,
    source: 'unrelated',
  });
  assert.equal(view.mode, 'markdown');
  assert.deepEqual(contents(view), ['Heading', 'strong']);
  assert.equal(view.rawSource, source.source.text);
  assert.equal(JSON.stringify(source), snapshot);
});

test('formatted plain uses only complete, supplied UTF16 slices; emoji and every unit survive', () => {
  const text = '前'.repeat(160) + '😀' + '后'.repeat(160);
  const source = formatted(text, [162, text.length]);
  assert.equal(source.presentation.status, 'formatted');
  const snapshot = JSON.stringify(source);
  const view = renderTextSource({ presentation: source });
  assert.equal(view.mode, 'formatted');
  assert.deepEqual(contents(view), [text.slice(0, 162), text.slice(162)]);
  assert.equal(contents(view).join(''), text);
  assert.equal(view.rawSource, text);
  assert.equal(JSON.stringify(source), snapshot);
  assert.equal('plan' in view, false);
});

test('malformed, incomplete, overlapping, unsafe-integer and surrogate-splitting plans fall back to exact source', () => {
  const text = '前'.repeat(160) + '😀' + '后'.repeat(160);
  const good = formatted(text, [162, text.length]);
  assert.equal(good.presentation.status, 'formatted');
  if (good.presentation.status !== 'formatted') return;
  for (const spans of [
    [],
    [
      { start: 0, end: 161 },
      { start: 161, end: text.length },
    ],
    [
      { start: 0, end: 160 },
      { start: 162, end: text.length },
    ],
    [
      { start: 0, end: 162 },
      { start: 160, end: text.length },
    ],
    [
      { start: 1, end: 162 },
      { start: 162, end: text.length },
    ],
    [
      { start: 0, end: 162 },
      { start: 162, end: text.length - 1 },
    ],
    [
      { start: 0, end: 162 },
      { start: 162, end: Number.MAX_VALUE },
    ],
    [
      { start: 0, end: 162.5 },
      { start: 162.5, end: text.length },
    ],
    [
      { start: 0, end: 162, url: 'https://example.test' },
      { start: 162, end: text.length },
    ],
    [
      { start: '0', end: 162 },
      { start: 162, end: text.length },
    ],
  ]) {
    const view = unsafeRead({
      ...good,
      presentation: {
        status: 'formatted',
        plan: { ...good.presentation.plan, spans },
      },
    });
    assert.equal(view.mode, 'plain');
    assert.equal(view.fallback, 'invalid-plan');
    assert.deepEqual(contents(view), [text]);
    assert.equal(view.rawSource, text);
  }
  for (const change of [
    { offsetEncoding: 'codepoint' },
    { formatter: '<script>' },
    { mode: 'html' },
    { reason: 'unknown' },
    { mode: 'unchanged' },
    { extra: 'bad' },
  ]) {
    const view = unsafeRead({
      ...good,
      presentation: {
        status: 'formatted',
        plan: { ...good.presentation.plan, ...change },
      },
    });
    assert.equal(view.fallback, 'invalid-plan');
    assert.equal(view.rawSource, text);
  }
});

test('plain off and ineligible sources cannot acquire formatted presentation from a forged optional plan', () => {
  const text = '字'.repeat(320);
  const good = formatted(text, [160, 320]);
  for (const source of [
    reviewed(text, off).source,
    reviewed('short', auto).source,
  ]) {
    const view = unsafeRead({ ...good, source });
    assert.equal(view.mode, 'plain');
    assert.equal(view.fallback, 'invalid-plan');
    assert.equal(view.rawSource, source.text);
  }
});

test('unknown source/descriptor values fail closed and do not leak unrelated editor source', () => {
  for (const descriptor of [
    false,
    [],
    'markdown',
    {},
    { version: 2, format: 'markdown' },
    { version: 1, format: 'html' },
    { version: 1, format: 'plain' },
    { ...markdown, html: true },
    { ...auto, readingFormatting: 'always' },
  ]) {
    const view = editor('private raw', descriptor);
    assert.equal(view.mode, 'unavailable');
    assert.equal(view.rawSource, '');
    assert.deepEqual(view.blocks, []);
  }
  for (const source of [null, undefined, {}, ['raw'], 42]) {
    assert.equal(
      renderTextSource({ source, descriptor: markdown }).mode,
      'unavailable',
    );
  }
  for (const presentation of [
    false,
    [],
    {},
    { version: 1 },
    {
      version: 2,
      source: { text: 'leak' },
      presentation: { status: 'source' },
    },
    { ...reviewed('safe'), presentation: { status: 'html', html: 'evil' } },
    {
      ...reviewed('safe'),
      source: { ...reviewed('safe').source, classification: 'unknown' },
    },
  ]) {
    const view = unsafeRead(presentation);
    assert.equal(view.mode, 'unavailable');
    assert.equal(view.rawSource, '');
    assert.deepEqual(view.blocks, []);
  }
  assert.equal(
    renderTextSource(null as unknown as SourceTextRenderInput).mode,
    'unavailable',
  );
  assert.equal(
    editor(
      'raw',
      Object.defineProperty({}, 'version', {
        get() {
          throw new Error('private');
        },
      }),
    ).mode,
    'unavailable',
  );
});

test('parser budgets fail to full literal source, never truncation or unbounded block/run output', () => {
  for (const source of [
    '# ' + '😀'.repeat(SOURCE_TEXT_PREVIEW_LIMITS.utf16Units),
    Array.from(
      { length: SOURCE_TEXT_PREVIEW_LIMITS.blocks + 1 },
      () => '*line*',
    ).join('\r\n'),
    Array.from({ length: 128 }, () => '*a* **b** `c`').join('\n'),
  ]) {
    const view = editor(source);
    assert.equal(view.mode, 'plain');
    assert.equal(view.fallback, 'limit');
    assert.equal(view.rawSource, source);
    assert.deepEqual(contents(view), [source]);
  }
});

type Method = (this: Instance, event?: unknown) => void;
interface Definition {
  options: { styleIsolation: string };
  properties: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, Method>;
  observers: Record<string, Method>;
  lifetimes: Record<string, Method>;
  pageLifetimes: Record<string, Method>;
}
interface Instance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(update: Record<string, unknown>): void;
  triggerEvent(...args: unknown[]): void;
}
function component() {
  const require = createRequire(__filename);
  const target = require.resolve('../src/components/source-text/source-text');
  const globals = globalThis as unknown as {
    Component?: (value: Definition) => void;
  };
  const old = globals.Component;
  let definition: Definition | undefined;
  globals.Component = (value) => {
    definition = value;
  };
  try {
    delete require.cache[target];
    require(target);
  } finally {
    if (old) globals.Component = old;
    else delete globals.Component;
  }
  assert.ok(definition);
  const config = definition;
  const writes: Record<string, unknown>[] = [];
  const events: unknown[][] = [];
  const instance: Instance = {
    properties: Object.fromEntries(
      Object.entries(config.properties).map(([key, value]) => [
        key,
        value.value,
      ]),
    ),
    data: structuredClone(config.data),
    setData(update) {
      writes.push(structuredClone(update));
      Object.assign(this.data, update);
    },
    triggerEvent(...args) {
      events.push(args);
    },
  };
  for (const [key, method] of Object.entries(config.methods))
    instance[key] = method.bind(instance);
  const update = (props: Record<string, unknown>) => {
    Object.assign(instance.properties, props);
    for (const observer of Object.values(config.observers))
      observer.call(instance);
  };
  return {
    config,
    instance,
    writes,
    events,
    update,
    attach: () => config.lifetimes.attached!.call(instance),
    detach: () => config.lifetimes.detached!.call(instance),
    hide: () => config.pageLifetimes.hide!.call(instance),
    show: () => config.pageLifetimes.show!.call(instance),
    toggle: (revision = instance.data.revision) =>
      config.methods.onToggleSource!.call(instance, {
        currentTarget: { dataset: { revision } },
      }),
  };
}

test('native raw toggle is view-only, disabled/stale guarded, and cannot serialize preview into editor', () => {
  const h = component();
  const source = '# Raw\r\n**😀**\r\n';
  h.update({ source, descriptor: markdown, preview: true });
  assert.equal(h.writes.length, 0);
  h.attach();
  assert.equal(h.instance.data.mode, 'markdown');
  h.toggle();
  assert.equal(h.instance.data.showingRaw, true);
  assert.equal(h.instance.data.rawSource, source);
  assert.equal(h.instance.properties.source, source);
  assert.deepEqual(h.events, []);
  h.toggle();
  assert.equal(h.instance.data.showingRaw, false);
  h.toggle(-1);
  assert.equal(h.instance.data.showingRaw, false);
  h.update({ disabled: true });
  h.toggle();
  assert.equal(h.instance.data.showingRaw, false);
  h.update({ disabled: false, source: 'new raw' });
  assert.equal(h.instance.data.rawSource, 'new raw');
  assert.deepEqual(h.events, []);
});

test('native hide/detach clears derived private text; hidden updates cannot repopulate it; show reads only current props', () => {
  const h = component();
  h.update({ source: '# Private old', descriptor: markdown });
  h.attach();
  h.toggle();
  const oldRevision = h.instance.data.revision;
  h.hide();
  assert.equal(h.instance.data.rawSource, '');
  assert.deepEqual(h.instance.data.blocks, []);
  assert.equal(h.instance.data.showingRaw, false);
  const afterHide = h.writes.length;
  h.update({ source: '# Current only' });
  h.toggle(oldRevision);
  assert.equal(h.writes.length, afterHide);
  assert.equal(h.instance.data.rawSource, '');
  h.show();
  assert.equal(h.instance.data.rawSource, '# Current only');
  assert.equal(h.instance.data.showingRaw, false);
  assert.equal(JSON.stringify(h.instance.data).includes('Private old'), false);
  h.toggle(oldRevision);
  assert.equal(h.instance.data.showingRaw, false);
  const beforeDetach = h.writes.length;
  h.detach();
  assert.equal(h.writes.length, beforeDetach);
  assert.equal(h.instance.data.rawSource, '');
  assert.deepEqual(h.instance.data.blocks, []);
  h.update({ source: '# After detach' });
  h.show();
  assert.equal(h.writes.length, beforeDetach);
  assert.equal(h.instance.data.rawSource, '');
});

test('native read props override editor props and invalidated presentation replaces stale data', () => {
  const h = component();
  h.update({
    presentation: reviewed('# Reviewed', markdown),
    source: 'unrelated',
    descriptor: auto,
  });
  h.attach();
  assert.equal(h.instance.data.rawSource, '# Reviewed');
  h.update({
    presentation: {
      version: 2,
      source: null,
      presentation: { status: 'source' },
    },
  });
  assert.equal(h.instance.data.mode, 'unavailable');
  assert.equal(h.instance.data.rawSource, '');
  assert.deepEqual(h.instance.data.blocks, []);
});

test('native template is isolated text only, has exact raw representation, and has no content-driven action channel', () => {
  const base = path.join(
    __dirname,
    '../src/components/source-text/source-text',
  );
  const template = readFileSync(base + '.wxml', 'utf8');
  const source = readFileSync(base + '.ts', 'utf8');
  const style = readFileSync(base + '.wxss', 'utf8');
  assert.equal(component().config.options.styleIsolation, 'isolated');
  assert.match(template, /\{\{rawSource\}\}/);
  assert.match(template, /\{\{run\.text\}\}/);
  assert.doesNotMatch(
    template,
    /<(rich-text|image|navigator|web-view|video|audio|input|textarea)\b/,
  );
  assert.doesNotMatch(template, /\b(?:src|href|url|nodes)=/);
  assert.equal((template.match(/catchtap=/g) ?? []).length, 1);
  assert.doesNotMatch(
    source,
    /triggerEvent\(|wx\.|request\(|setStorage|navigateTo|setTimeout/,
  );
  assert.doesNotMatch(style, /url\(|@import/);
  assert.equal(
    JSON.parse(readFileSync(base + '.json', 'utf8')).component,
    true,
  );
});
