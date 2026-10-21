import assert from 'node:assert/strict';
import test from 'node:test';
import { registerMajorDirectoryPage } from '../src/majors/page';
import { registerMajorDiscussionPage } from '../src/major-discussion/page';
import { SafetyChanges } from '../src/community/safety-changes';
import type { CommunityRuntime } from '../src/community/runtime';
import {
  discussionHarness,
  id,
  rootId,
  catalogRevision,
  revision,
} from './major-discussion-helpers';
import { flush } from './helpers';

type Page = {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  onLoad(query: Record<string, string>): void;
  onShow(): void;
  onHide(): void;
  onUnload(): void;
  onTogglePanel(event: { currentTarget: { dataset: { panel: string } } }): void;
  onClosePanel(): void;
  onBody?(event: { detail: { value: string } }): void;
};
const event = (panel: string) => ({ currentTarget: { dataset: { panel } } });
for (const family of ['directory', 'discussion'] as const) {
  test(`${family} product panel is transient across hide, invalidation and account changes without publishing`, async () => {
    const h = discussionHarness();
    const safetyChanges = new SafetyChanges(h.runtime.privateViews);
    const major = {
      id,
      majorRevision: revision,
      catalogRevision,
      campusId: rootId,
      departmentId: 12,
      collegeName: '合成学院',
      majorName: '合成专业',
      summary: { kind: 'unavailable' as const },
    };
    const runtime: CommunityRuntime = {
      ...h.runtime,
      safetyChanges,
      majors: {
        departments: async () => ({ catalogRevision, items: [] }),
        list: async () => ({
          catalogRevision,
          items: [major],
          totalCount: 1,
          nextCursor: null,
          continuation: 'end',
        }),
        detail: async () => ({ catalogRevision, item: major }),
        related: async () => ({
          catalogRevision,
          items: [],
          totalCount: 0,
          nextCursor: null,
          continuation: 'end',
        }),
      },
    };
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = {
      Page: globals.Page,
      getApp: globals.getApp,
      wx: globals.wx,
    };
    let page: Page | undefined;
    globals.Page = (value: Page) => {
      page = value;
    };
    globals.getApp = () => ({ community: runtime });
    globals.wx = {};
    try {
      if (family === 'directory') registerMajorDirectoryPage('directory');
      else registerMajorDiscussionPage('roots');
      assert.ok(page);
      page.setData = function (patch) {
        this.data = { ...this.data, ...patch };
      };
      page.onLoad(family === 'directory' ? {} : { majorId: id });
      page.onShow();
      await flush();
      assert.equal(page.data.loaded, true);
      page.onTogglePanel(event('options'));
      assert.equal(page.data.uiPanel, 'options');
      page.onTogglePanel(event('options'));
      assert.equal(page.data.uiPanel, '');
      page.onTogglePanel(event('unexpected'));
      assert.equal(page.data.uiPanel, '');
      if (family === 'discussion') {
        page.onBody?.({ detail: { value: '保留这段未发表的原文' } });
        page.onTogglePanel(event('compose'));
        assert.equal(page.data.uiPanel, 'compose');
        page.onClosePanel();
        assert.equal(page.data.body, '保留这段未发表的原文');
        assert.equal(h.calls.includes('submit'), false);
        for (const guard of ['busy', 'frozen', 'imageBusy', 'imageFrozen']) {
          page.setData({ [guard]: true });
          page.onTogglePanel(event('compose'));
          assert.equal(page.data.uiPanel, '');
          page.setData({ [guard]: false });
        }
      }
      page.onTogglePanel(event('options'));
      safetyChanges.invalidate(
        runtime.sessions.snapshot().credentials!.accountId,
      );
      assert.equal(page.data.uiPanel, '');
      page.onTogglePanel(event('options'));
      page.onHide();
      assert.equal(page.data.uiPanel, '');
      page.onShow();
      await flush();
      assert.equal(page.data.uiPanel, '');
      page.onTogglePanel(event('options'));
      runtime.sessions.logout();
      assert.equal(page.data.uiPanel, '');
      assert.equal(page.data.loaded, false);
      assert.equal(h.calls.includes('submit'), false);
      page.onUnload();
    } finally {
      page?.onUnload();
      h.controller.dispose();
      Object.assign(globals, previous);
    }
  });
}
