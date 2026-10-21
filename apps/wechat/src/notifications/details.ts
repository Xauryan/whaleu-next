/** Display only. Keep receipt IDs, raw timestamps, order and source owners intact. */
export function noticeTime(value: string, now = Date.now()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const prefix = year === new Date(now).getFullYear() ? '' : `${year}年`;
  return `${prefix}${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function noticeRows<T extends { readonly createdAt: string }>(
  items: readonly T[],
  now = Date.now(),
): (T & { readonly timeLabel: string })[] {
  return items.map((item) => ({
    ...item,
    timeLabel: noticeTime(item.createdAt, now),
  }));
}

const routineStatuses = new Set([
  '已读取本账号的社区站内更新',
  '已读取本站内未读数',
  '当前通知已核验',
  '已读取本账号当前本地订阅更新',
  '已读取本账号当前本地赞通知',
  '已读取本账号当前本地评分回复更新',
  '已读取更多本地订阅更新',
  '已读取更多本地赞通知',
  '已读取更多本地评分回复更新',
]);
/** Hide only known routine load confirmations, never errors or uncertain outcomes. */
export function noticeStatus(value: string): string {
  return routineStatuses.has(value) ? '' : value;
}

/** Account restriction boundaries retain seconds and server fractional precision. */
export function noticeScheduleTime(value: unknown): string {
  if (typeof value !== 'string') return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
  const decimal = fraction && /[1-9]/.test(fraction) ? `.${fraction}` : '';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}${decimal}`;
}

export function systemNoticeRows<T extends { readonly createdAt: string }>(
  items: readonly T[],
  now = Date.now(),
) {
  return noticeRows(items, now).map((item) => {
    const times = item as {
      startsAt?: unknown;
      endsAt?: unknown;
      releasedAt?: unknown;
      punishment?: { startsAt?: unknown; endsAt?: unknown };
    };
    return {
      ...item,
      startTimeLabel: noticeScheduleTime(times.startsAt),
      endTimeLabel: noticeScheduleTime(times.endsAt),
      releaseTimeLabel: noticeScheduleTime(times.releasedAt),
      punishmentStartTimeLabel: noticeScheduleTime(times.punishment?.startsAt),
      punishmentEndTimeLabel: noticeScheduleTime(times.punishment?.endsAt),
    };
  });
}
