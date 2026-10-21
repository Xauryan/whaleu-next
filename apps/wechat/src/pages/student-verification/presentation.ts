import type { StudentView } from '../../verification/student-controller';

/** Display-only dates; original authority and expiry timestamps stay untouched. */
export function localDateLabel(value: string | null | undefined): string {
  if (!value) return '时间暂不可用';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间暂不可用';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function presentStudentDates(view: StudentView) {
  return {
    evidenceExpiresLabel: localDateLabel(view.application?.evidenceExpiresAt),
    noticeDates: Object.fromEntries(
      view.notices.map((notice) => [
        notice.id,
        localDateLabel(notice.createdAt),
      ]),
    ),
  };
}
