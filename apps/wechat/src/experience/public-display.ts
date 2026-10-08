import { ClientError, isRecord } from '../api/errors';
import { experienceColorStyle } from './colors';

export interface PublicExperienceTitle {
  readonly key: string;
  readonly name: string;
}
export type PublicNullable<T> =
  | { readonly status: 'known'; readonly value: T | null }
  | { readonly status: 'unavailable'; readonly value: null };
export interface PublicExperienceDisplay {
  readonly title: PublicNullable<PublicExperienceTitle>;
  readonly color: PublicNullable<number>;
  readonly level:
    | { readonly status: 'known'; readonly value: number }
    | { readonly status: 'unavailable'; readonly value: null };
}

// Local, immutable presentation data only. Public wire values are numeric IDs,
// never CSS. This palette is shared without adding view fields to Author DTOs.
export const PUBLIC_EXPERIENCE_COLOR_STYLES = Object.freeze(
  Array.from({ length: 26 }, (_, id) => experienceColorStyle(id)),
);

const titleNames: Readonly<Record<string, string>> = Object.freeze({
  default_jingxiaoyu: '鲸小语',
  level_1: '萌新小白',
  level_3: '初来乍到',
  level_5: '崭露头角',
  level_7: '小有名气',
  level_9: '活跃分子',
  level_11: '社区新星',
  level_13: '人气达人',
  level_15: '校园红人',
  level_17: '意见领袖',
  level_19: '社区元老',
  level_21: '校园名人',
  level_23: '风云人物',
  level_25: '传奇人物',
  level_27: '校园之光',
  level_29: '一代宗师',
});
function invalid(): never {
  throw new ClientError('protocol', 'Invalid public experience display');
}
function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid();
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    invalid();
  return value;
}
function title(value: unknown): PublicExperienceTitle {
  exact(value, ['key', 'name']);
  if (
    typeof value.key !== 'string' ||
    !Object.prototype.hasOwnProperty.call(titleNames, value.key) ||
    value.name !== titleNames[value.key]
  )
    invalid();
  return Object.freeze({ key: value.key, name: value.name as string });
}
function nullable<T>(
  value: unknown,
  decode: (raw: unknown) => T,
): PublicNullable<T> {
  exact(value, ['status', 'value']);
  if (value.status === 'unavailable') {
    if (value.value !== null) invalid();
    return Object.freeze({ status: 'unavailable', value: null });
  }
  if (value.status !== 'known') invalid();
  return Object.freeze({
    status: 'known',
    value: value.value === null ? null : decode(value.value),
  });
}
/** Independent evidence dimensions: title/color never imply a current level. */
export function decodePublicExperienceDisplay(
  value: unknown,
): PublicExperienceDisplay {
  exact(value, ['title', 'color', 'level']);
  const selectedTitle = nullable(value.title, title);
  const color = nullable(value.color, (raw) => integer(raw, 0, 25));
  exact(value.level, ['status', 'value']);
  let level: PublicExperienceDisplay['level'];
  if (value.level.status === 'known')
    level = Object.freeze({
      status: 'known',
      value: integer(value.level.value, 1, 30),
    });
  else if (value.level.status === 'unavailable' && value.level.value === null)
    level = Object.freeze({ status: 'unavailable', value: null });
  else invalid();
  return Object.freeze({ title: selectedTitle, color, level });
}
