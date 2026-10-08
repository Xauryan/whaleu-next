import { SafetyChanges } from '../src/community/safety-changes';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import {
  DirectoryReadController,
  initialDirectoryView,
  type DirectoryMode,
} from '../src/directory/controller';
import type { DirectoryGateway } from '../src/directory/gateway';
import type {
  DirectoryCategory,
  DirectoryDetail,
  DirectoryEntry,
  DirectoryPlatform,
} from '../src/directory/contract';
import { setup } from './community-helpers';
export const directoryRegion = '11111111-1111-4111-8111-111111111111';
export const directoryCategoryId = '22222222-2222-4222-8222-222222222222';
export const directoryEntryId = '33333333-3333-4333-8333-333333333333';
export const directoryOtherRegion = '44444444-4444-4444-8444-444444444444';
export const directoryToken = (n = 1): string =>
  Buffer.alloc(32, n).toString('base64url');
export const directoryCategory = (
  patch: Partial<DirectoryCategory> = {},
): DirectoryCategory => ({
  id: directoryCategoryId,
  kind: 'org',
  name: '合成社团',
  description: '完整介绍',
  accent: 'cyan',
  ...patch,
});
export const directoryEntry = (
  patch: Partial<DirectoryEntry> = {},
): DirectoryEntry => ({
  id: directoryEntryId,
  categoryId: directoryCategoryId,
  kind: 'org',
  platform: 'qq',
  name: '合成群聊',
  introPreview: '合成公开介绍',
  badge: { status: 'known', value: 'official' },
  avatar: { status: 'unavailable', value: null },
  ...patch,
});
export const directoryDetail = (
  platform: DirectoryPlatform = 'qq',
): DirectoryDetail => ({
  ...directoryEntry({ platform }),
  introText: '完整介绍\n不截断历史数据',
  introImages: { status: 'unavailable', items: null },
  mainQr: { status: 'unavailable', value: null },
  managerWechatImage: {
    status: platform === 'wechat' ? 'unavailable' : 'not_applicable',
    value: null,
  },
  linkedOfficialAccountQr: {
    status: platform === 'official' ? 'not_applicable' : 'absent',
    value: null,
  },
  qqGroupNumber:
    platform === 'qq'
      ? { status: 'known', value: '0012345678901234' }
      : { status: 'not_applicable', value: null },
  createdAt: null,
  updatedAt: null,
  visits: { status: 'unavailable', value: null },
  managers: { status: 'unavailable', items: null },
  management: { status: 'unavailable' },
});
export const directoryListRoute = {
  regionId: directoryRegion,
  kind: 'org',
  categoryId: directoryCategoryId,
} as const;
export const directoryDetailRoute = {
  ...directoryListRoute,
  entryId: directoryEntryId,
};
export function directoryHarness(
  mode: DirectoryMode = 'list',
  signedIn = true,
) {
  const s = setup(signedIn);
  const calls: { method: keyof DirectoryGateway; args: unknown[] }[] = [];
  const behavior: DirectoryGateway = {
    context: async () => ({ regionId: directoryRegion }),
    categories: async (_region, kind) => ({
      items: [directoryCategory({ kind })],
      continuation: 'end',
      nextCursor: null,
    }),
    entries: async () => ({
      items: [directoryEntry()],
      continuation: 'end',
      nextCursor: null,
    }),
    detail: async () => directoryDetail(),
  };
  const directory: DirectoryGateway = {
    context: (...args) => {
      calls.push({ method: 'context', args });
      return behavior.context(...args);
    },
    categories: (...args) => {
      calls.push({ method: 'categories', args });
      return behavior.categories(...args);
    },
    entries: (...args) => {
      calls.push({ method: 'entries', args });
      return behavior.entries(...args);
    },
    detail: (...args) => {
      calls.push({ method: 'detail', args });
      return behavior.detail(...args);
    },
  };
  const runtime = {
    ...s.runtime,
    directory,
    directoryScopeChanges: new PrivateViewLifecycle(),
    safetyChanges: new SafetyChanges(s.runtime.privateViews),
  };
  let view = initialDirectoryView();
  const controller = new DirectoryReadController(runtime, mode, (next) => {
    view = next;
  });
  return { ...s, runtime, calls, behavior, controller, view: () => view };
}
