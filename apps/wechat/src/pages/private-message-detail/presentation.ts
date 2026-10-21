import type { Message } from '../../messaging/contract';

export function privateMessageTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const today = new Date(now);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === today.toDateString()) return time;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}年`}${day} ${time}`;
}

export function privateMessageRows(
  messages: readonly Message[],
  now = Date.now(),
) {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const timestamp = Date.parse(message.createdAt);
    const previousTimestamp = previous ? Date.parse(previous.createdAt) : NaN;
    return {
      ...message,
      timeLabel: privateMessageTime(message.createdAt, now),
      showTime:
        !previous ||
        !Number.isFinite(previousTimestamp) ||
        timestamp - previousTimestamp >= 5 * 60 * 1000 ||
        new Date(timestamp).toDateString() !==
          new Date(previousTimestamp).toDateString(),
    };
  });
}
