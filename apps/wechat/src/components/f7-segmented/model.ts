/** Controlled native selection; never changes a domain value optimistically. */
export interface SegmentOption {
  value: string;
  label: string;
  disabled?: boolean;
}
export function segmentOptions(value: unknown): SegmentOption[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return [];
  const seen = new Set<string>();
  const result: SegmentOption[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.value !== 'string' ||
      !item.value ||
      item.value.length > 100 ||
      typeof item.label !== 'string' ||
      !item.label ||
      item.label.length > 100 ||
      (item.disabled !== undefined && typeof item.disabled !== 'boolean') ||
      seen.has(item.value)
    )
      return [];
    seen.add(item.value);
    result.push({
      value: item.value,
      label: item.label,
      disabled: item.disabled === true,
    });
  }
  return result;
}
export function selectedSegment(
  options: unknown,
  selected: string,
  candidate: unknown,
  disabled: boolean,
): string | null {
  if (disabled || typeof candidate !== 'string' || candidate === selected)
    return null;
  const option = segmentOptions(options).find(
    (item) => item.value === candidate,
  );
  return option && !option.disabled ? option.value : null;
}
/** Equivalent upstream highlight geometry, without DOM measurements or selectors. */
export function segmentPresentation(options: unknown, value: string) {
  const items = segmentOptions(options);
  const activeIndex = items.findIndex((item) => item.value === value);
  return {
    items,
    activeIndex,
    highlightStyle:
      activeIndex < 0
        ? ''
        : `width:calc(${100 / items.length}% - 4px);left:calc(${(activeIndex * 100) / items.length}% + 2px)`,
  };
}
