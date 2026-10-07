import type {
  SystemNotice,
  SystemNoticesList,
} from '../src/community/system-notices-contract';
import type { SystemNoticesGateway } from '../src/community/system-notices-gateway';
import { createdAt, requestId, setup } from './community-helpers';

export const systemNotice = (
  overrides: Partial<SystemNotice> = {},
): SystemNotice => ({
  noticeId: requestId,
  kind: 'post_jury_removed',
  createdAt,
  readAt: null,
  keepVotes: 5,
  removeVotes: 6,
  ...overrides,
});
export const systemNotices = (
  items: readonly SystemNotice[] = [systemNotice()],
  nextCursor: string | null = null,
  unreadCount = items.filter((item) => item.readAt === null).length,
): SystemNoticesList => ({ items, nextCursor, unreadCount });

export class FakeSystemNoticesGateway implements SystemNoticesGateway {
  calls: { method: string; args: unknown[] }[] = [];
  listImpl: SystemNoticesGateway['list'] = async () => systemNotices();
  unreadImpl: SystemNoticesGateway['unread'] = async () => ({ unreadCount: 1 });
  readImpl: SystemNoticesGateway['read'] = async (noticeId) => ({
    noticeId,
    readAt: createdAt,
    unreadCount: 0,
  });
  list(...args: Parameters<SystemNoticesGateway['list']>) {
    this.calls.push({ method: 'list', args });
    return this.listImpl(...args);
  }
  unread(...args: Parameters<SystemNoticesGateway['unread']>) {
    this.calls.push({ method: 'unread', args });
    return this.unreadImpl(...args);
  }
  read(...args: Parameters<SystemNoticesGateway['read']>) {
    this.calls.push({ method: 'read', args });
    return this.readImpl(...args);
  }
}
export function systemNoticesSetup(loggedIn = true) {
  const s = setup(loggedIn);
  const notices = new FakeSystemNoticesGateway();
  return { ...s, notices, runtime: { ...s.runtime, systemNotices: notices } };
}
