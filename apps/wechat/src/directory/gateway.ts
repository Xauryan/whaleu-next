import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation } from '../platform/contracts';
import {
  decodeDirectoryCategoryPage,
  decodeDirectoryContext,
  decodeDirectoryDetail,
  decodeDirectoryEntryPage,
  decodeDirectoryListIntent,
  directoryCursor,
  directoryUuid,
  invalidDirectory,
  isDirectoryKind,
  type DirectoryCategory,
  type DirectoryContext,
  type DirectoryDetail,
  type DirectoryEntry,
  type DirectoryKind,
  type DirectoryListIntent,
  type DirectoryPage,
} from './contract';
export interface DirectoryGateway {
  context(cancel: Cancellation): Promise<DirectoryContext>;
  categories(
    regionId: string,
    kind: DirectoryKind,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<DirectoryPage<DirectoryCategory>>;
  entries(
    intent: DirectoryListIntent,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<DirectoryPage<DirectoryEntry>>;
  detail(
    regionId: string,
    entryId: string,
    cancel: Cancellation,
  ): Promise<DirectoryDetail>;
}
export class HttpDirectoryGateway implements DirectoryGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
    path: string,
    decode: Decoder<T>,
    cancel: Cancellation,
    query?: Record<string, string | number>,
  ): Promise<T> {
    return this.api.request(
      {
        path,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode,
      },
      { cancellation: cancel, ...(query ? { query } : {}) },
    );
  }
  context(cancel: Cancellation): Promise<DirectoryContext> {
    return this.read('/v1/directory/context', decodeDirectoryContext, cancel);
  }
  async categories(
    regionId: string,
    kind: DirectoryKind,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<DirectoryPage<DirectoryCategory>> {
    if (!directoryUuid(regionId) || !isDirectoryKind(kind)) invalidDirectory();
    const result = await this.read(
      `/v1/directory/regions/${regionId}/categories`,
      decodeDirectoryCategoryPage,
      cancel,
      { kind, ...pagination(cursor, limit) },
    );
    checkPage(result, cursor, limit);
    if (result.items.some((item) => item.kind !== kind)) invalidDirectory();
    return result;
  }
  async entries(
    raw: DirectoryListIntent,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<DirectoryPage<DirectoryEntry>> {
    const { regionId, ...query } = decodeDirectoryListIntent(raw);
    const result = await this.read(
      `/v1/directory/regions/${regionId}/entries`,
      decodeDirectoryEntryPage,
      cancel,
      { ...query, ...pagination(cursor, limit) },
    );
    checkPage(result, cursor, limit);
    if (
      result.items.some(
        (item) =>
          item.kind !== query.kind ||
          (query.categoryId !== undefined &&
            item.categoryId !== query.categoryId),
      )
    )
      invalidDirectory();
    return result;
  }
  async detail(
    regionId: string,
    entryId: string,
    cancel: Cancellation,
  ): Promise<DirectoryDetail> {
    if (!directoryUuid(regionId) || !directoryUuid(entryId)) invalidDirectory();
    const result = await this.read(
      `/v1/directory/regions/${regionId}/entries/${entryId}`,
      decodeDirectoryDetail,
      cancel,
    );
    if (result.id !== entryId) invalidDirectory();
    return result;
  }
}
function pagination(
  cursor: string | null,
  limit: number,
): Record<string, string | number> {
  if (
    (cursor !== null && !directoryCursor(cursor)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    invalidDirectory();
  return { limit, ...(cursor !== null ? { cursor } : {}) };
}
function checkPage<T>(
  page: DirectoryPage<T>,
  cursor: string | null,
  limit: number,
): void {
  if (
    page.items.length > limit ||
    (page.continuation === 'more' && page.items.length !== limit) ||
    (cursor !== null && page.nextCursor === cursor)
  )
    invalidDirectory();
}
