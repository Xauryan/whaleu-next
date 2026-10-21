import type { ErrandForm, ErrandView } from '../../errands/controller';
import type { ErrandNotice } from '../../errands/admin-notice-contract';

/** Display the supplied instant in the device's local time; no invented recency. */
export function errandDisplayTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

/** Matches canonicalErrandText: normalize CRLF/outer whitespace, then code points. */
export function errandFormCounts(
  form: Pick<ErrandForm, 'title' | 'publicText'>,
) {
  const count = (value: string) =>
    Array.from(value.replace(/\r\n/g, '\n').trim()).length;
  return { title: count(form.title), publicText: count(form.publicText) };
}

export function errandPresentation(view: ErrandView) {
  const detail = view.loaded ? view.detail : null;
  return {
    formCounts: errandFormCounts(view.form),
    detailTimes: {
      createdAt: errandDisplayTime(detail?.createdAt),
      acceptedAt: errandDisplayTime(detail?.acceptedAt),
      completedAt: errandDisplayTime(detail?.completedAt),
      cancelledAt: errandDisplayTime(detail?.cancelledAt),
    },
  };
}

export function errandNoticeTimeLabels(items: readonly ErrandNotice[]) {
  return Object.fromEntries(
    items.map((item) => [
      item.noticeId,
      {
        createdAt: errandDisplayTime(item.createdAt),
        startsAt:
          item.kind === 'feature_restricted'
            ? errandDisplayTime(item.startsAt)
            : '',
        endsAt:
          item.kind === 'feature_restricted'
            ? errandDisplayTime(item.endsAt)
            : '',
        releasedAt:
          item.kind === 'feature_released'
            ? errandDisplayTime(item.releasedAt)
            : '',
      },
    ]),
  );
}
