import type {
  AnnouncementSummary,
  AnnouncementDetail,
  AnnouncementPopup,
  AnnouncementChanges,
} from '../src/announcements/contract';
import type { AnnouncementsGateway } from '../src/announcements/gateway';
import {
  AnnouncementReadController,
  initialAnnouncementReadView,
  type AnnouncementMode,
} from '../src/announcements/controller';
import {
  AnnouncementPopupController,
  initialAnnouncementPopupView,
} from '../src/announcements/popup-controller';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { SafetyChanges } from '../src/community/safety-changes';
import { setup } from './community-helpers';
export const announcementId = '11111111-1111-4111-8111-111111111111';
export const revision = '22222222-2222-4222-8222-222222222222';
export const campusId = '33333333-3333-4333-8333-333333333333';
export const otherId = '44444444-4444-4444-8444-444444444444';
export const timestamp = '2026-10-08T14:08:02.123456+08:00';
export const bodyText = '第一段\n\n  缩进与 <b>普通文字</b>\n\t末段 👋\n';
export const summary = (
  patch: Partial<AnnouncementSummary> = {},
): AnnouncementSummary => ({
  id: announcementId,
  revision,
  versionLabel: '同版本',
  title: '合成公告',
  announcementDate: null,
  createdAt: timestamp,
  highlight: true,
  isLatest: true,
  popupEnabled: true,
  ...patch,
});
export const detail = (): AnnouncementDetail => ({
  ...summary(),
  bodyText,
  updatedAt: null,
  media: { status: 'unavailable', items: null },
});
export const popup = (
  patch: Partial<AnnouncementPopup> = {},
): AnnouncementPopup => ({
  id: announcementId,
  revision,
  versionLabel: '同版本',
  title: '合成提醒',
  announcementDate: '2026-10-08',
  bodyText,
  media: { status: 'known_empty', items: [] },
  ...patch,
});
export const changes = (campus: string | null = null): AnnouncementChanges => ({
  context: { campusId: campus },
  since: timestamp,
  checkedAt: timestamp,
  newness: { status: 'available', hasNew: true, newCount: '9007199254740993' },
});
export const token = (n = 1): string =>
  Buffer.alloc(32, n).toString('base64url');
export function announcementHarness(
  loggedIn = true,
  mode: AnnouncementMode = 'list',
) {
  const s = setup(loggedIn),
    calls: { method: keyof AnnouncementsGateway; args: unknown[] }[] = [];
  const behavior: AnnouncementsGateway = {
    list: async (campus) => ({
      context: { campusId: campus },
      items: [summary()],
      continuation: 'end',
      nextCursor: null,
    }),
    detail: async () => detail(),
    popup: async (campus) => ({
      context: { campusId: campus },
      popup: popup(),
    }),
    changes: async (campus) => changes(campus),
    ownerPopup: async (campus) => ({
      context: { campusId: campus },
      candidate: popup(),
      acknowledgement: { status: 'unseen', acknowledgedAt: null },
    }),
    acknowledge: async (_campus, id) => ({
      announcementId: id,
      acknowledgement: { status: 'acknowledged', acknowledgedAt: timestamp },
    }),
  };
  const announcements: AnnouncementsGateway = {
    list: (...args) => {
      calls.push({ method: 'list', args });
      return behavior.list(...args);
    },
    detail: (...args) => {
      calls.push({ method: 'detail', args });
      return behavior.detail(...args);
    },
    popup: (...args) => {
      calls.push({ method: 'popup', args });
      return behavior.popup(...args);
    },
    changes: (...args) => {
      calls.push({ method: 'changes', args });
      return behavior.changes(...args);
    },
    ownerPopup: (...args) => {
      calls.push({ method: 'ownerPopup', args });
      return behavior.ownerPopup(...args);
    },
    acknowledge: (...args) => {
      calls.push({ method: 'acknowledge', args });
      return behavior.acknowledge(...args);
    },
  };
  const runtime = {
    ...s.runtime,
    announcements,
    browsingScopeChanges: new PrivateViewLifecycle(),
    safetyChanges: new SafetyChanges(s.runtime.privateViews),
  };
  let read = initialAnnouncementReadView(),
    reminder = initialAnnouncementPopupView();
  const controller = new AnnouncementReadController(runtime, mode, (next) => {
    read = next;
  });
  const popupController = new AnnouncementPopupController(runtime, (next) => {
    reminder = next;
  });
  return {
    ...s,
    runtime,
    calls,
    behavior,
    controller,
    popupController,
    view: () => read,
    popupView: () => reminder,
  };
}
