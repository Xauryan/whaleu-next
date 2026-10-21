/** Plain, bounded action projection. No HTML, callbacks, URLs or route names. */
import { validActionId } from '../f7-sheet/overlay';
export interface OverlayAction {
  id: string;
  label: string;
  disabled: boolean;
  destructive: boolean;
  strong: boolean;
}
export function actionItems(value: unknown): OverlayAction[] {
  if (!Array.isArray(value) || value.length > 100) return [];
  const ids = new Set<string>();
  const result: OverlayAction[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return [];
    const item = candidate as Record<string, unknown>;
    if (
      !validActionId(item.id) ||
      ids.has(item.id) ||
      typeof item.label !== 'string' ||
      !item.label.trim() ||
      item.label.length > 1000
    )
      return [];
    for (const flag of ['disabled', 'destructive', 'strong'])
      if (item[flag] !== undefined && typeof item[flag] !== 'boolean')
        return [];
    ids.add(item.id);
    result.push({
      id: item.id,
      label: item.label,
      disabled: item.disabled === true,
      destructive: item.destructive === true,
      strong: item.strong === true,
    });
  }
  return result;
}
