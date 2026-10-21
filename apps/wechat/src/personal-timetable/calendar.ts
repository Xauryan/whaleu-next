/** Civil dates are UTC day numbers; device timezone never participates. */
const dayMs = 86_400_000;
export function dateDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error('日期格式应为 YYYY-MM-DD');
  const [year, month, day] = value.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const instant = Date.UTC(year, month - 1, day);
  if (
    year < 1900 ||
    year > 2199 ||
    new Date(instant).toISOString().slice(0, 10) !== value
  )
    throw new Error('请选择有效日期（1900–2199 年）');
  return instant / dayMs;
}
export function dayDate(day: number): string {
  return new Date(day * dayMs).toISOString().slice(0, 10);
}
export function weekday(day: number): number {
  return ((((day + 3) % 7) + 7) % 7) + 1;
}
export function monday(value: string): string {
  if (weekday(dateDay(value)) !== 1) throw new Error('第一周起始日必须是周一');
  return value;
}
export function shanghaiToday(now = Date.now()): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}
export function currentMonday(now = Date.now()): string {
  const day = dateDay(shanghaiToday(now));
  return dayDate(day - weekday(day) + 1);
}
export function weekAt(
  start: string,
  weekCount: number,
  today: string,
):
  | { state: 'before' | 'after'; week: null }
  | { state: 'within'; week: number } {
  const week = Math.floor((dateDay(today) - dateDay(monday(start))) / 7) + 1;
  return week < 1
    ? { state: 'before', week: null }
    : week > weekCount
      ? { state: 'after', week: null }
      : { state: 'within', week };
}
export function weekDates(start: string, week: number): string[] {
  return Array.from({ length: 7 }, (_, index) =>
    dayDate(dateDay(monday(start)) + (week - 1) * 7 + index),
  );
}
export function clockTime(minutes: number): string {
  return `${Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`;
}
export function timeMinutes(time: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) && time !== '24:00')
    throw new Error('请选择有效时间');
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}
export function explicitWeeks(text: string, count: number): number[] {
  const values = new Set<number>();
  if (!text.trim()) throw new Error('请至少选择一周');
  for (const raw of text.split(/[,，]/)) {
    const match = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/.exec(raw.trim());
    if (!match) throw new Error('周次示例：1-4,6,8');
    const start = Number(match[1]),
      end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > count)
      throw new Error(`周次必须在 1–${count} 周内`);
    for (let i = start; i <= end; i++) values.add(i);
  }
  return [...values].sort((a, b) => a - b);
}
export function weeksFor(
  kind: 'all' | 'odd' | 'even',
  count: number,
): number[] {
  return Array.from({ length: count }, (_, index) => index + 1).filter(
    (week) => kind === 'all' || week % 2 === (kind === 'odd' ? 1 : 0),
  );
}
export interface ConflictSlot {
  entryId?: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  weeks: number[];
}
export function conflicts(a: ConflictSlot, b: ConflictSlot): boolean {
  return (
    a.dayOfWeek === b.dayOfWeek &&
    a.startMinute < b.endMinute &&
    b.startMinute < a.endMinute &&
    a.weeks.some((week) => b.weeks.includes(week))
  );
}
