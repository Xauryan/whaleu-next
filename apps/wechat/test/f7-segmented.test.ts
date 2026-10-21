import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  segmentOptions,
  segmentPresentation,
  selectedSegment,
} from '../src/components/f7-segmented/model';
const options = [
  { value: 'public', label: '公开' },
  { value: 'private', label: '分身' },
  { value: 'disabled', label: '不可用', disabled: true },
];
test('segmented option projection fails closed for duplicate, malformed and excessive options', () => {
  assert.deepEqual(segmentOptions(null), []);
  assert.deepEqual(segmentOptions([...options, options[0]]), []);
  assert.deepEqual(segmentOptions([{ value: 'a', label: {} }]), []);
  assert.deepEqual(
    segmentOptions([{ value: 'a', label: 'A', disabled: 'false' }]),
    [],
  );
  assert.deepEqual(
    segmentOptions(
      Array.from({ length: 11 }, (_, i) => ({
        value: String(i),
        label: String(i),
      })),
    ),
    [],
  );
  assert.equal(segmentOptions(options).length, 3);
});
test('segmented controlled selection ignores disabled, same, stale and unknown values', () => {
  assert.equal(selectedSegment(options, 'public', 'private', false), 'private');
  for (const candidate of ['public', 'disabled', 'unknown', null, 0])
    assert.equal(selectedSegment(options, 'public', candidate, false), null);
  assert.equal(selectedSegment(options, 'public', 'private', true), null);
  assert.equal(selectedSegment([], 'public', 'private', false), null);
});
test('native segmented emits one isolated change without mutating controlled selection', () => {
  const require = createRequire(__filename);
  type Instance = {
    properties: { options: typeof options; value: string; disabled: boolean };
    data: { items: unknown[] };
    setData(update: object): void;
    triggerEvent(...args: unknown[]): void;
  };
  type Definition = {
    lifetimes: { attached(this: Instance): void };
    methods: {
      onSelect(
        this: Instance,
        event: { currentTarget: { dataset: { value: string } } },
      ): void;
    };
  };
  let definition: Definition | undefined;
  const global = globalThis as unknown as {
    Component: ((value: unknown) => void) | undefined;
  };
  const previous = global.Component;
  global.Component = (value) => {
    definition = value as Definition;
  };
  const file = require.resolve('../src/components/f7-segmented/f7-segmented');
  try {
    delete require.cache[file];
    require(file);
  } finally {
    global.Component = previous;
  }
  const emitted: unknown[] = [];
  const instance = {
    properties: { options, value: 'public', disabled: false },
    data: { items: [] },
    setData(update: object) {
      Object.assign(this.data, update);
    },
    triggerEvent(...args: unknown[]) {
      emitted.push(args);
    },
  };
  assert.ok(definition);
  const component = definition;
  component.lifetimes.attached.call(instance);
  const tap = (value: string) =>
    component.methods.onSelect.call(instance, {
      currentTarget: { dataset: { value } },
    });
  tap('disabled');
  tap('public');
  tap('unknown');
  assert.equal(emitted.length, 0);
  tap('private');
  assert.deepEqual(emitted, [
    ['change', { value: 'private' }, { bubbles: false, composed: false }],
  ]);
  assert.equal(instance.properties.value, 'public');
  instance.properties.options = [];
  tap('private');
  assert.equal(emitted.length, 1);
});

test('segmented highlight uses pinned 2px padding and 4px gap without DOM measurement', () => {
  assert.deepEqual(segmentPresentation([], 'missing'), {
    items: [],
    activeIndex: -1,
    highlightStyle: '',
  });
  const view = segmentPresentation(options, 'private');
  assert.equal(view.activeIndex, 1);
  assert.equal(
    view.highlightStyle,
    `width:calc(${100 / 3}% - 4px);left:calc(${100 / 3}% + 2px)`,
  );
  assert.equal(segmentPresentation(options, 'unknown').highlightStyle, '');
});
