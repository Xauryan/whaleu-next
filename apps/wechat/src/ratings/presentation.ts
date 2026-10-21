/** Display-only labels. Invalid or missing dates stay unknown, never "just now". */
export function ratingTime(value: string, now = Date.now()): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  const date = new Date(parsed);
  const current = new Date(now);
  const time = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  if (
    date.getFullYear() === current.getFullYear() &&
    date.getMonth() === current.getMonth() &&
    date.getDate() === current.getDate()
  )
    return time;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === current.getFullYear()
    ? day
    : `${date.getFullYear()}年${day}`;
}
export function ratingTimeLabels(
  items: readonly { readonly id: string; readonly createdAt: string }[],
  now = Date.now(),
): Record<string, string> {
  return Object.fromEntries(
    items.map((item) => [item.id, ratingTime(item.createdAt, now)]),
  );
}
