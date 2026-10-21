import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { FeedView } from '../src/pages/community-feed/controller';
import { campus as campusFixture } from './profile-helpers';
import type { WxApi } from '../src/platform/wechat';

interface EntryPage {
  data: FeedView & { opening: boolean };
  controller?: { chooseCampus(id: string): Promise<void> };
  setData(data: Record<string, unknown>): void;
  onCampus(event: { currentTarget: { dataset: { id: string } } }): void;
  onContinue(): void;
}
test('compose destination uses real campus labels and prevents unknown campus selection and repeat opens', async () => {
  const priorPage = globalThis.Page;
  const globals = globalThis as typeof globalThis & { wx: WxApi };
  const priorWx = globals.wx;
  let page: EntryPage | undefined;
  globalThis.Page = ((value: object) => {
    page = value as EntryPage;
  }) as typeof Page;
  try {
    await import('../src/pages/compose-entry/compose-entry.js');
    assert.ok(page);
    page.setData = (patch) => {
      page!.data = { ...page!.data, ...patch };
    };
    const campus = campusFixture();
    page.data = { ...page.data, campuses: [campus] };
    const choices: string[] = [];
    page.controller = {
      chooseCampus: async (id) => {
        choices.push(id);
      },
    };
    page.onCampus({ currentTarget: { dataset: { id: 'unknown' } } });
    assert.equal(choices.length, 0);
    page.onCampus({ currentTarget: { dataset: { id: campus.id } } });
    assert.deepEqual(choices, [campus.id]);
    const template = readFileSync(
      path.join(__dirname, '../src/pages/compose-entry/compose-entry.wxml'),
      'utf8',
    );
    assert.match(template, /{{item.fullName}}/);
    assert.ok(campus.fullName);
    const calls: Parameters<NonNullable<WxApi['navigateTo']>>[0][] = [];
    globals.wx = {
      navigateTo: (options) => {
        calls.push(options);
      },
    } as typeof wx;
    page.onContinue();
    assert.equal(calls.length, 0);
    page.data = {
      ...page.data,
      busy: false,
      hasSession: true,
      space: {
        id: '20000000-0000-4000-8000-000000000002',
        name: '校园',
        kind: 'regional',
      } as FeedView['space'],
    };
    page.onContinue();
    page.onContinue();
    assert.equal(calls.length, 1);
    calls[0]!.fail({});
    assert.equal(page.data.opening, false);
    assert.ok(page.data.error);
  } finally {
    globalThis.Page = priorPage;
    globals.wx = priorWx;
  }
});
