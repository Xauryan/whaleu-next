import assert from 'node:assert/strict';
import test from 'node:test';
import type { WhaleuApp } from '../src/app';
import type { FeedThumbnail } from '../src/media/feed-thumbnails';
import {
  MediaGalleryController,
  type GalleryView,
} from '../src/media/gallery-controller';
import type { MediaReadTransfer } from '../src/media/authenticated-download';
import type { MeContentCard, MeContentView } from '../src/pages/me/controller';
import type { WxApi, WxIntersectionObserver } from '../src/platform/wechat';
import { otherId } from './community-helpers';
import {
  discoverySetup,
  namedPost,
  profileList,
  publicProfile,
} from './discovery-helpers';
import { flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { attachment } from './support/media-read-fixtures';

interface MePage {
  data: {
    content: MeContentView;
    contentQuery: string;
    contentSearchOpen: boolean;
    visibleContentItems: readonly MeContentCard[];
    contentImages: Readonly<Record<string, FeedThumbnail>>;
  };
  searchSessionUnsubscribe: (() => void) | undefined;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
  onShow(): void;
  onHide(): void;
  onUnload(): void;
  onContentSearchToggle(): void;
  onContentSearchInput(event: { detail: { value: string } }): void;
}

let definition: MePage | undefined;
async function pageDefinition(): Promise<MePage> {
  if (!definition) {
    const previous = globalThis.Page;
    globalThis.Page = ((value: object) => {
      definition = value as MePage;
    }) as typeof Page;
    try {
      await import('../src/pages/me/me.js');
    } finally {
      globalThis.Page = previous;
    }
  }
  assert.ok(definition);
  return definition;
}

for (const boundary of ['logout', 'replacement', 'relogin'] as const) {
  test(`native Me ${boundary} clears private search text, filtered cards and thumbnails before stale callbacks`, async () => {
    const native = globalThis as typeof globalThis & { wx: WxApi };
    const previous = { getApp: globalThis.getApp, wx: native.wx };
    const s = discoverySetup();
    s.behavior.profile = async () => publicProfile({ isOwn: true });
    s.behavior.list = async () =>
      profileList({
        items: [
          {
            ...namedPost(),
            text: 'synthetic private owner query',
            images: [attachment],
          },
        ],
      });
    const observers: ((result: { intersectionRatio: number }) => void)[] = [];
    const commits: (() => void)[] = [];
    const released: string[] = [];
    let downloads = 0;
    const transfer: MediaReadTransfer = {
      async download(_descriptor, variant, _owner, session) {
        session.current();
        assert.equal(variant, 'thumb-v1');
        downloads++;
        return { localId: 'private-thumbnail' };
      },
      async resolve(file, _owner, ticket) {
        s.sessions.assertCurrent(ticket);
        return `wxfile://${file.localId}`;
      },
      async release(file) {
        released.push(file.localId);
      },
    };
    globalThis.getApp = (() =>
      ({
        identity: { sessions: s.sessions },
        community: s.runtime,
        mediaRead: {
          createGallery: (render: (view: GalleryView) => void) =>
            new MediaGalleryController(
              s.sessions,
              transfer,
              render,
              s.runtime.privateViews,
            ),
        },
      }) as unknown as WhaleuApp) as typeof getApp;
    native.wx = {
      createIntersectionObserver: (): WxIntersectionObserver => ({
        relativeToViewport() {
          return this;
        },
        observe(_selector, callback) {
          observers.push(callback);
        },
        disconnect() {},
      }),
    } as unknown as WxApi;
    const captured = await pageDefinition();
    const page: MePage = {
      ...captured,
      data: { ...captured.data },
      setData(patch, callback) {
        this.data = { ...this.data, ...patch };
        if (callback) commits.push(callback);
      },
    };
    try {
      page.onShow();
      for (let n = 0; n < 4; n++) await flush();
      page.onContentSearchToggle();
      page.onContentSearchInput({ detail: { value: 'private owner' } });
      assert.equal(page.data.visibleContentItems.length, 1);
      for (const commit of commits.splice(0)) commit();
      assert.equal(observers.length, 1);
      observers[0]!({ intersectionRatio: 1 });
      await flush();
      assert.equal(downloads, 1);
      assert.ok(
        Object.values(page.data.contentImages).some(
          (image) => image.status === 'ready',
        ),
      );
      // Leave an old render commit queued across the login-owner boundary.
      page.onContentSearchInput({ detail: { value: 'private owner' } });
      if (boundary === 'logout') s.sessions.logout();
      else
        s.sessions.completeLogin(s.sessions.beginLogin(), {
          ...wireCredentials('next'),
          ...(boundary === 'replacement' ? { accountId: otherId } : {}),
        });
      assert.equal(page.data.contentQuery, '');
      assert.equal(page.data.contentSearchOpen, false);
      assert.deepEqual(page.data.visibleContentItems, []);
      assert.deepEqual(page.data.contentImages, {});
      assert.deepEqual(page.data.content.items, []);
      for (const commit of commits.splice(0)) commit();
      observers[0]!({ intersectionRatio: 1 });
      await flush();
      assert.equal(downloads, 1);
      assert.deepEqual(released, ['private-thumbnail']);
      assert.deepEqual(page.data.contentImages, {});
      page.onHide();
      assert.equal(page.searchSessionUnsubscribe, undefined);
    } finally {
      page.onUnload();
      native.wx = previous.wx;
      globalThis.getApp = previous.getApp;
    }
  });
}
