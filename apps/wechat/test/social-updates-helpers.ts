/** Source-only fictional fixtures. No provider, real user or production notification data. */
import { ApiClient } from '../src/api/client';
import { SafetyChanges } from '../src/community/safety-changes';
import { SocialUpdatesController } from '../src/notifications/social-updates/controller';
import type {
  SocialUpdate,
  SocialUpdateCategory,
  SocialUpdateRead,
  SocialUpdateResolution,
  SocialUpdatesPage,
  SocialUpdateUnread,
} from '../src/notifications/social-updates/contract';
import type { SocialUpdatesGateway } from '../src/notifications/social-updates/gateway';
import type { Cancellation } from '../src/platform/contracts';
import { setup, requestId, postId, otherId } from './community-helpers';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
export { requestId as noticeId, postId, otherId } from './community-helpers';
export const socialCreatedAt = '2026-10-20T10:00:00.000001Z';
export const socialReadAt = '2026-10-20T10:05:00.123456Z';
export const socialCursor = 'x'.repeat(43);
export function socialNotice(
  category: 'followers',
  noticeId?: string,
): Extract<SocialUpdate, { kind: 'follow' }>;
export function socialNotice(
  category?: 'likes' | 'saves',
  noticeId?: string,
): Extract<SocialUpdate, { kind: 'like' | 'save' }>;
export function socialNotice(
  category: SocialUpdateCategory,
  noticeId?: string,
): Exclude<SocialUpdate, { status: 'unavailable' }>;
export function socialNotice(
  category: SocialUpdateCategory = 'likes',
  noticeId = requestId,
): Exclude<SocialUpdate, { status: 'unavailable' }> {
  const base = {
    noticeId,
    createdAt: socialCreatedAt,
    readAt: null,
    status: 'available' as const,
  };
  return category === 'followers'
    ? {
        ...base,
        kind: 'follow',
        target: { type: 'profile', profileId: otherId },
        actor: { profileId: otherId, displayName: '虚构测试同学' },
      }
    : {
        ...base,
        kind: category === 'likes' ? 'like' : 'save',
        target: { type: 'community', postId, commentId: null, replyId: null },
      };
}
export function socialPage(
  category: SocialUpdateCategory = 'likes',
  patch: Partial<SocialUpdatesPage> = {},
): SocialUpdatesPage {
  return {
    items: [socialNotice(category)],
    nextCursor: null,
    unreadCount: 7,
    unreadCountStatus: 'available',
    ...patch,
  } as SocialUpdatesPage;
}
export function socialRead(noticeId = requestId): SocialUpdateRead {
  return {
    noticeId,
    readAt: socialReadAt,
    unreadCount: 6,
    unreadCountStatus: 'available',
  };
}
export function socialResolution(
  category: SocialUpdateCategory = 'likes',
  noticeId = requestId,
): SocialUpdateResolution {
  const notice = socialNotice(category, noticeId);
  return { noticeId, status: 'available', target: notice.target };
}
export class FakeSocialUpdatesGateway implements SocialUpdatesGateway {
  readonly calls: {
    method: string;
    id: string | null;
    cancel: Cancellation;
  }[] = [];
  listImpl: (cursor: string | null) => Promise<SocialUpdatesPage>;
  targetImpl: (id: string) => Promise<SocialUpdateResolution>;
  readImpl = async (id: string): Promise<SocialUpdateRead> => socialRead(id);
  constructor(category: SocialUpdateCategory) {
    this.listImpl = async () => socialPage(category);
    this.targetImpl = async (id) => socialResolution(category, id);
  }
  list(
    cursor: string | null,
    cancel: Cancellation,
  ): Promise<SocialUpdatesPage> {
    this.calls.push({ method: 'list', id: cursor, cancel });
    return this.listImpl(cursor);
  }
  unread(cancel: Cancellation): Promise<SocialUpdateUnread> {
    this.calls.push({ method: 'unread', id: null, cancel });
    return Promise.resolve({ unreadCount: 7, unreadCountStatus: 'available' });
  }
  target(id: string, cancel: Cancellation): Promise<SocialUpdateResolution> {
    this.calls.push({ method: 'target', id, cancel });
    return this.targetImpl(id);
  }
  markRead(id: string, cancel: Cancellation): Promise<SocialUpdateRead> {
    this.calls.push({ method: 'read', id, cancel });
    return this.readImpl(id);
  }
}
export function socialHarness(
  category: SocialUpdateCategory = 'likes',
  loggedIn = true,
) {
  const s = setup(loggedIn);
  const safetyChanges = new SafetyChanges(); // Deliberately independent from root-hide events.
  const runtime = { ...s.runtime, safetyChanges };
  const gateway = new FakeSocialUpdatesGateway(category);
  const urls: string[] = [];
  const controller = new SocialUpdatesController(
    runtime,
    gateway,
    category,
    () => undefined,
    async (url) => {
      urls.push(url);
    },
  );
  return {
    ...s,
    runtime,
    gateway,
    urls,
    controller,
    safetyChanges,
    view: () => controller.snapshot(),
  };
}
export function socialApi(loggedIn = true) {
  const s = setup(loggedIn);
  const transport = new ScriptedTransport();
  const api = new ApiClient(
    'https://fictional-social.example',
    transport,
    s.sessions,
    {
      refresh: async () =>
        s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b')),
    },
  );
  return { ...s, transport, api };
}
