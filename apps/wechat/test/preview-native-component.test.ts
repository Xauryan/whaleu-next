import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(__filename);
const { nativeComponentPreviewState } =
  require('../scripts/preview-native-component.mjs') as {
    nativeComponentPreviewState(
      definition: object,
      attributes: Record<string, string>,
      evaluate: (value: string) => unknown,
    ): Record<string, unknown>;
  };
test('source preview resolves typed controlled props and native initialization without acting', () => {
  const options = [{ value: 'a', label: '<script>not markup</script>' }];
  const state = nativeComponentPreviewState(
    {
      properties: {
        disabled: { type: Boolean, value: false },
        ariaLabel: { type: String, value: 'default' },
        options: { type: Array, value: [] },
      },
      data: { ready: false },
      lifetimes: {
        attached(this: { setData(data: object): void }) {
          this.setData({ ready: true });
        },
      },
    },
    { disabled: '{{false}}', 'aria-label': 'Label', options: '{{options}}' },
    (value) =>
      value === '{{false}}' ? false : value === '{{options}}' ? options : value,
  );
  assert.equal(state['disabled'], false);
  assert.equal(state['ariaLabel'], 'Label');
  assert.equal(state['ready'], true);
  assert.deepEqual(state['options'], options);
});
test('component source preview rejects initialization that attempts a business event', () => {
  assert.throws(
    () =>
      nativeComponentPreviewState(
        {
          properties: {},
          data: {},
          lifetimes: {
            attached(this: { triggerEvent(): void }) {
              this.triggerEvent();
            },
          },
        },
        {},
        (v) => v,
      ),
    /must not dispatch actions/,
  );
});
