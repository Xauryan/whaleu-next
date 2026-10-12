import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation } from '../platform/contracts';
import {
  decodeMajorDepartments,
  decodeMajorDetail,
  decodeMajorPage,
  decodeMajorQuery,
  invalidMajor,
  majorCursor,
  majorId,
  type MajorDepartments,
  type MajorDetail,
  type MajorPage,
  type MajorQuery,
} from './contract';
export interface MajorDirectoryGateway {
  departments(cancel: Cancellation): Promise<MajorDepartments>;
  list(
    query: MajorQuery,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<MajorPage>;
  detail(id: string, cancel: Cancellation): Promise<MajorDetail>;
  related(id: string, cancel: Cancellation, limit?: number): Promise<MajorPage>;
}
export class HttpMajorDirectoryGateway implements MajorDirectoryGateway {
  constructor(private readonly api: ApiClient) {}
  private get<T>(
    path: string,
    decode: Decoder<T>,
    cancellation: Cancellation,
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
      { cancellation, ...(query ? { query } : {}) },
    );
  }
  departments(cancel: Cancellation): Promise<MajorDepartments> {
    return this.get('/v1/majors/departments', decodeMajorDepartments, cancel);
  }
  private pagination(
    cursor: string | null,
    limit: number,
  ): Record<string, string | number> {
    if (
      (cursor !== null && !majorCursor(cursor)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      invalidMajor();
    return { limit, ...(cursor ? { cursor } : {}) };
  }
  async list(
    raw: MajorQuery,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<MajorPage> {
    const query = decodeMajorQuery(raw);
    const page = await this.get('/v1/majors', decodeMajorPage, cancel, {
      ...query,
      ...this.pagination(cursor, limit),
    });
    if (
      page.items.length > limit ||
      (page.nextCursor !== null && page.nextCursor === cursor) ||
      page.items.some(
        (item) =>
          query.departmentId !== undefined &&
          item.departmentId !== query.departmentId,
      )
    )
      invalidMajor();
    for (let n = 1; n < page.items.length; n++) {
      const a = page.items[n - 1]!,
        b = page.items[n]!;
      if (
        a.departmentId > b.departmentId ||
        (a.departmentId === b.departmentId && a.id >= b.id)
      )
        invalidMajor();
    }
    return page;
  }
  async detail(id: string, cancel: Cancellation): Promise<MajorDetail> {
    if (!majorId(id)) invalidMajor();
    const detail = await this.get(
      `/v1/majors/${id}`,
      decodeMajorDetail,
      cancel,
    );
    if (detail.item.id !== id) invalidMajor();
    return detail;
  }
  async related(
    id: string,
    cancel: Cancellation,
    limit = 5,
  ): Promise<MajorPage> {
    if (!majorId(id)) invalidMajor();
    const page = await this.get(
      `/v1/majors/${id}/related`,
      decodeMajorPage,
      cancel,
      this.pagination(null, limit),
    );
    if (
      page.items.length > limit ||
      page.items.some((item) => item.id === id) ||
      page.nextCursor !== null ||
      page.continuation !== 'end'
    )
      invalidMajor();
    return page;
  }
}
