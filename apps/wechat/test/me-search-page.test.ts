import assert from 'node:assert/strict';
import test from 'node:test';

test('native Me active-tab taps preserve local query and do not leave filtered cards behind a blank input', async () => {
  interface Harness {
    data: { content: { tab: string }; contentQuery: string };
    contentController?: { setTab(key: string): Promise<void> };
    onTab(event: { currentTarget: { dataset: { key: string } } }): void;
    setData(patch: Partial<Harness['data']>): void;
  }
  const original = globalThis.Page;
  let definition: Harness | undefined;
  globalThis.Page = ((value: object) => {
    definition = value as Harness;
  }) as typeof Page;
  try {
    await import('../src/pages/me/me.js');
    assert.ok(definition);
    const tabs: string[] = [];
    const page: Harness = {
      ...definition,
      data: { content: { tab: 'posts' }, contentQuery: 'library' },
      contentController: {
        async setTab(key) {
          tabs.push(key);
        },
      },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    page.onTab({ currentTarget: { dataset: { key: 'posts' } } });
    assert.equal(page.data.contentQuery, 'library');
    assert.deepEqual(tabs, []);
    page.onTab({ currentTarget: { dataset: { key: 'invalid' } } });
    assert.equal(page.data.contentQuery, 'library');
    page.onTab({ currentTarget: { dataset: { key: 'saved' } } });
    assert.equal(page.data.contentQuery, '');
    assert.deepEqual(tabs, ['saved']);
  } finally {
    globalThis.Page = original;
  }
});
