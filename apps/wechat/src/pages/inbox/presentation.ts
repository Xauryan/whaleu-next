import type { ListView } from '../../messaging/list-controller';
import type { NoticeSenderSnapshot } from '../../notifications/senders';

export interface InboxRow {
  readonly key: string;
  readonly kind: 'person' | 'sender';
  readonly name: string;
  readonly initial: string;
  readonly icon: string;
  readonly tone: string;
  readonly summary: string;
  readonly timestamp: string;
  readonly timeLabel: string;
  readonly unread: number | null;
  readonly unreadLabel: string;
  readonly hasUnread: boolean;
  readonly anonymous: boolean;
  readonly url: string;
}

/** Human and service senders share the exact same row, with no synthetic messages. */
export function conversationRows(
  list: ListView,
  senders: readonly NoticeSenderSnapshot[],
  now: number,
): InboxRow[] {
  const visibleSenders = senders.filter(
    (sender) => sender.kind === 'system' || sender.kind === 'activity',
  );
  const rows: InboxRow[] = visibleSenders.map((sender) => ({
    key: `sender:${sender.kind}`,
    kind: 'sender',
    name: sender.name,
    initial: '',
    icon: senderIcon(sender.kind),
    tone: sender.kind === 'activity' ? 'activity' : 'system',
    summary: sender.latest?.summary ?? '',
    timestamp: sender.latest?.createdAt ?? '',
    timeLabel: conversationTime(sender.latest?.createdAt ?? '', now),
    unread: sender.unreadCount,
    unreadLabel: unreadLabel(sender.unreadCount),
    hasUnread: sender.hasUnread,
    anonymous: false,
    url: sender.url,
  }));
  if (list.loaded) {
    for (const item of list.items) {
      const peer = item.conversation.peer;
      rows.push({
        key: `dm:${item.conversation.id}`,
        kind: 'person',
        name: peer.displayName,
        initial: [...peer.displayName.trim()][0] ?? '',
        icon: 'person',
        tone: 'person',
        summary: !item.latest
          ? '消息暂不可查看'
          : item.latest.state === 'text'
            ? (item.latest.text?.replace(/\s+/g, ' ') ?? '消息暂不可查看')
            : item.latest.state === 'image'
              ? '[图片]'
              : item.latest.state === 'recalled'
                ? '消息已撤回'
                : '消息暂不可查看',
        timestamp: item.updatedAt,
        timeLabel: conversationTime(item.updatedAt, now),
        unread: item.conversation.unreadCount,
        unreadLabel: unreadLabel(item.conversation.unreadCount),
        hasUnread: item.conversation.unreadCount > 0,
        anonymous: peer.mode === 'anonymous',
        url: `/pages/private-message-detail/private-message-detail?conversationId=${encodeURIComponent(item.conversation.id)}`,
      });
    }
  }
  // Known server timestamps determine ordering. Unknown sender dates stay blank,
  // after dated conversations, rather than pretending a notice arrived today.
  return rows.sort((left, right) => {
    const leftTime = Date.parse(left.timestamp);
    const rightTime = Date.parse(right.timestamp);
    return (
      (Number.isFinite(rightTime) ? rightTime : 0) -
      (Number.isFinite(leftTime) ? leftTime : 0)
    );
  });
}

function senderIcon(kind: string): string {
  return kind === 'activity' ? 'message-filled' : 'bell';
}

function unreadLabel(count: number | null): string {
  return count !== null && count > 0
    ? count > 99
      ? '99+'
      : String(count)
    : '';
}

export function conversationTime(value: string, now: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const today = new Date(now);
  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  )
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}/`}${date.getMonth() + 1}/${date.getDate()}`;
}

/** Local view filtering only. This cannot search unloaded pages or message history. */
export function filterConversationRows(
  rows: readonly InboxRow[],
  query: string,
): InboxRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle
    ? rows.filter((row) =>
        `${row.name} ${row.summary}`.toLocaleLowerCase().includes(needle),
      )
    : [...rows];
}
