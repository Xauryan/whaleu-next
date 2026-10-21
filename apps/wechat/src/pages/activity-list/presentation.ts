import type { ActivityType } from '../../activities/publication/contract';
import type { ActivityPublicationView } from '../../activities/publication/controller';

export const activityTypeLabels: Record<ActivityType, string> = {
  online: '线上',
  offline: '线下',
  reward: '有奖',
};

export const initialActivityPanels = () => ({
  preferences: false,
  information: false,
  gallery: false,
  options: false,
});

export function toggledActivityPanels(
  current: ReturnType<typeof initialActivityPanels>,
  field: string,
) {
  if (!Object.prototype.hasOwnProperty.call(current, field)) return current;
  const key = field as keyof typeof current;
  return { ...current, [key]: !current[key] };
}

/** Preserve the supplied timezone; never infer an event date from its publication. */
export function activityDisplayTimestamp(value: string | null): string {
  if (!value) return '未指定';
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) return value;
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日 ${match[4]}:${match[5]}（UTC${match[6] === 'Z' ? '+00:00' : match[6]}）`;
}

export function activityPublicationPresentation(view: ActivityPublicationView) {
  return {
    typeSelected: {
      online: view.form.types.includes('online'),
      offline: view.form.types.includes('offline'),
      reward: view.form.types.includes('reward'),
    },
    titleCount: Array.from(view.form.title).length,
    descriptionCount: Array.from(view.form.description).length,
  };
}
