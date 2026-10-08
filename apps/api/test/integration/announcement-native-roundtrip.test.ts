import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import {
  syntheticAnnouncement,
  seedAnnouncementCatalog,
  announcementMarkerCount,
} from '../support/announcement-fixtures.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';

const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { ClientError } = require('../../../wechat/src/api/errors.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  HttpAnnouncementsGateway,
} = require('../../../wechat/src/announcements/gateway.ts');
const {
  AnnouncementReadController,
  initialAnnouncementReadView,
} = require('../../../wechat/src/announcements/controller.ts');
const {
  AnnouncementPopupController,
  initialAnnouncementPopupView,
} = require('../../../wechat/src/announcements/popup-controller.ts');
interface ReadView {
  loaded: boolean;
  items: readonly { id: string }[];
  detail: { id: string; bodyText: string } | null;
  canNext: boolean;
  canPrevious: boolean;
  changesNotice: string;
  error: string;
  restartRequired: boolean;
  pageNumber: number;
}
interface PopupView {
  popup: { id: string; bodyText: string } | null;
  acknowledgement: string;
  error: string;
}
function platform() {
  const values = new Map<string, unknown>();
  return {
    values,
    getStorageSync: (key: string) => structuredClone(values.get(key)),
    setStorageSync: (key: string, value: unknown) =>
      values.set(key, structuredClone(value)),
    removeStorageSync: (key: string) => values.delete(key),
    getRandomValues: (input: {
      length: number;
      success(value: { randomValues: ArrayBuffer }): void;
    }) =>
      input.success({
        randomValues: Uint8Array.from(randomBytes(input.length)).buffer,
      }),
  };
}
const protocol = (error: unknown) => {
  assert.ok(error instanceof ClientError);
  assert.equal((error as { kind: string }).kind, 'protocol');
  return true;
};

test(
  'actual native optional gateway and transient announcement controllers cross normal HTTP and PostgreSQL',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture(),
      transport = new DirectoryHttpTransport(f.port);
    const actor = await createRuntimeActor(f.app),
      other = await createRuntimeActor(f.app);
    const rows = Array.from({ length: 24 }, (_, i) =>
      syntheticAnnouncement({
        ordinal: String(i + 1),
        bodyText: `Native announcement ${i}\n\n  preserved whitespace`,
        versionLabel: 'Shared version',
      }),
    );
    const latest = rows.at(-1)!;
    await seedAnnouncementCatalog(f.pool, rows);
    const client = (credentials?: SessionCredentials) => {
      const native = platform(),
        sessions = new SessionStore();
      if (credentials)
        sessions.completeLogin(sessions.beginLogin(), credentials);
      const auth = new AuthService(
        sessions,
        new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
        {
          login: async () => {
            throw new Error('No provider calls in announcement acceptance');
          },
        },
        systemClock,
      );
      const api = new ApiClient(
        directoryNativeOrigin,
        transport,
        sessions,
        auth,
      );
      const runtime = createCommunityRuntime(
        { sessions, auth, api },
        native,
        directoryNativeOrigin,
      );
      return {
        native,
        sessions,
        runtime,
        gateway: new HttpAnnouncementsGateway(api),
      };
    };
    const guest = client(),
      member = client(actor),
      cancel = new Cancellation();
    try {
      await t.test(
        'optional authentication keeps public list/detail/popup/changes guest-capable, exact microseconds reach real SQL',
        async () => {
          const start = transport.exchanges.length;
          const page = await guest.gateway.list(null, null, cancel);
          assert.equal(page.items.length, 20);
          assert.equal(page.items[0].id, latest.id);
          const detail = await guest.gateway.detail(null, latest.id, cancel);
          assert.equal(detail.bodyText, latest.bodyText);
          assert.equal(
            (await guest.gateway.popup(null, cancel)).popup.id,
            latest.id,
          );
          assert.equal(
            (
              await guest.gateway.changes(
                null,
                '2026-10-08T00:00:00.000001Z',
                cancel,
              )
            ).newness.newCount,
            '0',
          );
          assert.ok(
            transport.exchanges
              .slice(start)
              .every((exchange) => !exchange.authorized),
          );
          assert.equal(
            (await member.gateway.list(null, null, cancel)).items[0].id,
            latest.id,
          );
          assert.equal(transport.exchanges.at(-1)!.authorized, true);
          const before = transport.exchanges.length;
          let view: PopupView = initialAnnouncementPopupView();
          const popup = new AnnouncementPopupController(
            guest.runtime,
            (value: PopupView) => {
              view = value;
            },
          );
          await popup.load(null);
          assert.equal(view.popup, null);
          assert.equal(
            transport.exchanges.length,
            before,
            'Guest home never requests owner popup',
          );
          popup.dispose();
        },
      );
      await t.test(
        'actual decoders reject private extras, wrong target/scope, untrusted media and inconsistent newness',
        async () => {
          for (const transform of [
            (body: Record<string, unknown>) => ({ ...body, source_id: 99 }),
            (body: Record<string, unknown>) => ({ ...body, id: randomUUID() }),
            (body: Record<string, unknown>) => ({
              ...body,
              media: {
                status: 'known_empty',
                items: ['https://untrusted.invalid/media'],
              },
            }),
            (body: Record<string, unknown>) => ({
              ...body,
              bodyText: { text: 'not canonical text' },
            }),
          ]) {
            transport.corruptNext = {
              path: `/v1/announcements/${latest.id}`,
              transform: (body) => transform(body as Record<string, unknown>),
            };
            await assert.rejects(
              guest.gateway.detail(null, latest.id, cancel),
              protocol,
            );
          }
          transport.corruptNext = {
            path: '/v1/announcements',
            transform: (body) => ({
              ...(body as object),
              context: { campusId: f.scope.home.campusId },
            }),
          };
          await assert.rejects(
            guest.gateway.list(null, null, cancel),
            protocol,
          );
          transport.corruptNext = {
            path: '/v1/announcements/changes',
            transform: (body) => ({
              ...(body as object),
              newness: {
                status: 'available',
                hasNew: false,
                newCount: '9007199254740993',
              },
            }),
          };
          await assert.rejects(
            guest.gateway.changes(null, null, cancel),
            protocol,
          );
          transport.corruptNext = {
            path: '/v1/announcements/changes',
            transform: (body) => ({
              ...(body as object),
              newness: {
                status: 'available',
                hasNew: true,
                newCount: '9007199254740993',
              },
            }),
          };
          assert.equal(
            (await guest.gateway.changes(null, null, cancel)).newness.newCount,
            '9007199254740993',
            'Decoder retains exact string counts',
          );
        },
      );
      await t.test(
        'guest list Next/Previous replace current page, detail is pure, hide and failed reload discard all bodies/cursors',
        async () => {
          let view: ReadView = initialAnnouncementReadView();
          const list = new AnnouncementReadController(
            guest.runtime,
            'list',
            (value: ReadView) => {
              view = value;
            },
          );
          await list.load({});
          assert.equal(view.loaded, true);
          assert.equal(view.items.length, 20);
          assert.equal(view.canNext, true);
          assert.ok(!view.changesNotice.includes('未读'));
          const path = list.detailPath(latest.id);
          assert.ok(path.includes(latest.id));
          await list.next();
          assert.equal(view.items.length, 4);
          assert.equal(view.canPrevious, true);
          assert.equal(view.pageNumber, 2);
          await list.previous();
          assert.equal(view.items[0]!.id, latest.id);
          assert.equal(view.pageNumber, 1);
          const before = await announcementMarkerCount(f.pool, actor.accountId);
          let detail: ReadView = initialAnnouncementReadView();
          const page = new AnnouncementReadController(
            member.runtime,
            'detail',
            (value: ReadView) => {
              detail = value;
            },
          );
          await page.load({ announcementId: latest.id });
          assert.equal(detail.detail?.bodyText, latest.bodyText);
          assert.equal(
            await announcementMarkerCount(f.pool, actor.accountId),
            before,
          );
          page.dispose();
          assert.equal(detail.detail, null);
          list.cancel();
          assert.deepEqual(view.items, []);
          assert.equal(view.canNext, false);
          assert.equal(view.canPrevious, false);
          assert.equal(list.detailPath(latest.id), null);
          await list.load({});
          transport.failNext = '/v1/announcements';
          await list.refresh();
          assert.deepEqual(view.items, []);
          assert.equal(view.loaded, false);
          assert.equal(view.canNext, false);
          list.dispose();
        },
      );
      await t.test(
        'late responses cannot survive hide, newer browse context, same-account relogin or account replacement',
        async () => {
          let view: ReadView = initialAnnouncementReadView();
          const controller = new AnnouncementReadController(
            member.runtime,
            'list',
            (value: ReadView) => {
              view = value;
            },
          );
          for (const mode of [
            'hide',
            'scope',
            'same-account',
            'other-account',
          ] as const) {
            member.sessions.completeLogin(member.sessions.beginLogin(), actor);
            const held = transport.holdNext('/v1/announcements');
            const pending = controller.load({});
            await held.arrived;
            if (mode === 'hide') controller.cancel();
            if (mode === 'scope')
              member.runtime.browsingScopeChanges.clear(actor.accountId);
            if (mode === 'same-account')
              member.sessions.completeLogin(
                member.sessions.beginLogin(),
                actor,
              );
            if (mode === 'other-account')
              member.sessions.completeLogin(
                member.sessions.beginLogin(),
                other,
              );
            assert.deepEqual(view.items, []);
            held.release();
            await pending;
            assert.deepEqual(view.items, []);
          }
          controller.dispose();
        },
      );
      await t.test(
        'explicit popup close alone acknowledges; repeated close sends once; lost response stays unconfirmed until fresh authoritative read',
        async () => {
          member.sessions.completeLogin(member.sessions.beginLogin(), actor);
          let view: PopupView = initialAnnouncementPopupView();
          const popup = new AnnouncementPopupController(
            member.runtime,
            (value: PopupView) => {
              view = value;
            },
          );
          await popup.load(null);
          assert.equal(view.popup?.id, latest.id);
          const ackPath = `/v1/me/announcements/${latest.id}/popup-acknowledgement`;
          transport.dropSuccess = { path: ackPath, method: 'PUT' };
          const before = transport.exchanges.filter(
            (exchange) => exchange.method === 'PUT',
          ).length;
          await Promise.all([popup.close(), popup.close()]);
          assert.equal(view.popup, null);
          assert.equal(view.acknowledgement, 'unconfirmed');
          assert.equal(
            transport.exchanges.filter((exchange) => exchange.method === 'PUT')
              .length,
            before + 1,
          );
          assert.equal(
            await announcementMarkerCount(f.pool, actor.accountId, latest.id),
            1,
          );
          await popup.load(null);
          assert.equal(view.popup, null);
          assert.equal(
            view.acknowledgement,
            'unconfirmed',
            'Same visible generation cannot reopen from old data',
          );
          popup.dispose();
          const fresh = new AnnouncementPopupController(
            member.runtime,
            (value: PopupView) => {
              view = value;
            },
          );
          await fresh.load(null);
          assert.equal(
            view.popup,
            null,
            'Latest acknowledged suppresses older unseen',
          );
          fresh.dispose();
          const second = client(other);
          let secondView: PopupView = initialAnnouncementPopupView();
          const secondPopup = new AnnouncementPopupController(
            second.runtime,
            (value: PopupView) => {
              secondView = value;
            },
          );
          await secondPopup.load(null);
          assert.equal(secondView.popup?.id, latest.id);
          secondPopup.cancel();
          assert.equal(secondView.popup, null);
          assert.equal(
            await announcementMarkerCount(f.pool, other.accountId, latest.id),
            0,
            'Hide must not acknowledge',
          );
          secondPopup.dispose();
        },
      );
      await t.test(
        'late popup bodies and committed close receipts cannot cross hide, browsing replacement or login epoch',
        async () => {
          const who = await createRuntimeActor(f.app),
            context = client(who);
          let view: PopupView = initialAnnouncementPopupView();
          const popup = new AnnouncementPopupController(
            context.runtime,
            (value: PopupView) => {
              view = value;
            },
          );
          for (const mode of ['hide', 'scope', 'login'] as const) {
            const held = transport.holdNext('/v1/me/announcements/popup');
            const loading = popup.load(null);
            await held.arrived;
            if (mode === 'hide') popup.cancel();
            if (mode === 'scope')
              context.runtime.browsingScopeChanges.clear(who.accountId);
            if (mode === 'login')
              context.sessions.completeLogin(
                context.sessions.beginLogin(),
                who,
              );
            assert.equal(view.popup, null);
            held.release();
            await loading;
            assert.equal(view.popup, null);
            assert.equal(
              await announcementMarkerCount(f.pool, who.accountId),
              0,
            );
          }
          await popup.load(null);
          assert.equal(view.popup?.id, latest.id);
          const held = transport.holdNext(
            `/v1/me/announcements/${latest.id}/popup-acknowledgement`,
            'PUT',
          );
          const closing = popup.close();
          await held.arrived;
          context.sessions.completeLogin(context.sessions.beginLogin(), other);
          assert.equal(view.popup, null);
          assert.equal(view.acknowledgement, 'idle');
          held.release();
          await closing;
          assert.equal(
            view.acknowledgement,
            'idle',
            'Late old-account receipt never claims confirmation in replacement account',
          );
          assert.equal(
            await announcementMarkerCount(f.pool, who.accountId, latest.id),
            1,
          );
          assert.equal(
            await announcementMarkerCount(f.pool, other.accountId, latest.id),
            0,
          );
          popup.dispose();
        },
      );
      await t.test(
        'withdrawal after current popup load denies stale close and next foreground exposes no cached body',
        async () => {
          const who = await createRuntimeActor(f.app),
            context = client(who);
          let view: PopupView = initialAnnouncementPopupView();
          const popup = new AnnouncementPopupController(
            context.runtime,
            (value: PopupView) => {
              view = value;
            },
          );
          await popup.load(null);
          assert.equal(view.popup?.id, latest.id);
          await seedAnnouncementCatalog(
            f.pool,
            rows.map((row) => ({ ...row, state: 'withdrawn' })),
          );
          await popup.close();
          assert.equal(view.popup, null);
          assert.equal(view.acknowledgement, 'unconfirmed');
          assert.equal(
            await announcementMarkerCount(f.pool, who.accountId, latest.id),
            0,
          );
          popup.dispose();
          const fresh = new AnnouncementPopupController(
            context.runtime,
            (value: PopupView) => {
              view = value;
            },
          );
          await fresh.load(null);
          assert.equal(view.popup, null);
          fresh.dispose();
        },
      );
      await t.test(
        'announcement reading and receipt status are never persisted to native storage',
        async () => {
          for (const context of [guest, member]) {
            assert.equal(
              context.native.values.size,
              0,
              'The real runtime may not persist announcement body/status/cursor snapshots',
            );
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
