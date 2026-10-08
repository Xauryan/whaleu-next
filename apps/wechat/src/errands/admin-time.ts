/** Inputs have already passed activityTimestamp. Preserve the database's microsecond precision. */
export function errandAdminInstantBefore(left: string, right: string): boolean {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds !== 0) return milliseconds < 0;
  const remainder = (value: string): string =>
    ((/\.(\d+)/.exec(value)?.[1] ?? '') + '000000').slice(3, 6);
  return remainder(left) < remainder(right);
}
