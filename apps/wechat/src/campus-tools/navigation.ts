import { DirectoryNavigator } from '../directory/navigation';
import { toolUuid, type ToolEntry } from './contract';
export { DirectoryNavigator as ToolNavigator };
export interface ToolRoute {
  campusId: string;
  catalogId: string;
  entryId: string;
}
export function toolRoute(raw: Record<string, unknown>): ToolRoute {
  if (
    Object.keys(raw).length !== 3 ||
    Object.keys(raw).some(
      (key) => !['campusId', 'catalogId', 'entryId'].includes(key),
    )
  )
    throw new Error('Invalid tool route');
  return {
    campusId: toolUuid(raw.campusId),
    catalogId: toolUuid(raw.catalogId),
    entryId: toolUuid(raw.entryId),
  };
}
export function toolEntryPath(
  route: ToolRoute,
  entry: ToolEntry,
): string | null {
  if (entry.state !== 'enabled' || route.entryId !== entry.id) return null;
  const page = entry.kind === 'web-link' ? 'webview' : entry.kind;
  const checked = toolRoute({ ...route });
  return `/pages/campus-tools-${page}/campus-tools-${page}?campusId=${checked.campusId}&catalogId=${checked.catalogId}&entryId=${checked.entryId}`;
}
export const toolHubPath = '/pages/campus-tools/campus-tools';
