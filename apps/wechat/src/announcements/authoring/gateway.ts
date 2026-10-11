import type { ApiClient } from '../../api/client';
import type { Cancellation } from '../../platform/contracts';
import {
  id,
  key,
  digest,
  decodeCommand,
  decodeReceipt,
  decodeRecovery,
  decodeManaged,
  decodePage,
  decodeCapabilities,
  decodeRegions,
} from './contract';
import type { Command } from './contract';
import { exact } from '../../community/contract';
import { revision } from './contract';
import { ClientError } from '../../api/errors';
export class AnnouncementManagementGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
    path: string,
    decode: (v: unknown) => T,
    cancel: Cancellation,
    query: Record<string, string | number> = {},
  ) {
    return this.api.request(
      {
        path: '/v1/announcement-management' + path,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode,
      },
      { query, cancellation: cancel },
    );
  }
  closure(target: string, c: Cancellation) {
    return this.read(
      '/draft-closure/' + id(target),
      (v) => {
        exact(v, ['id', 'revision', 'state']);
        if (v.id !== target || v.state !== 'draft')
          throw new ClientError('protocol', '上传草稿不匹配');
        return {
          id: id(v.id),
          revision: revision(v.revision),
          state: 'draft' as const,
        };
      },
      c,
    );
  }
  capabilities(c: Cancellation) {
    return this.read('/capabilities', decodeCapabilities, c);
  }
  regions(search: string, c: Cancellation) {
    return this.read('/regions', decodeRegions, c, { search });
  }
  list(c: Cancellation, cursor?: string) {
    return this.read('', decodePage, c, cursor ? { cursor } : {});
  }
  async detail(target: string, c: Cancellation) {
    const r = await this.read('/' + id(target), decodeManaged, c);
    if (r.id !== target) throw new ClientError('protocol', '公告不匹配');
    return r;
  }
  async command(target: string, raw: Command, c: Cancellation) {
    const command = decodeCommand(raw),
      r = await this.api.request(
        {
          path: '/v1/announcement-management/' + id(target) + '/commands',
          method: 'POST',
          authentication: 'required',
          authReplay: 'never',
          successStatus: 200,
          decode: decodeReceipt,
        },
        { body: JSON.parse(JSON.stringify(command)), cancellation: c },
      );
    if (r.announcementId !== target || r.requestId !== command.clientRequestId)
      throw new ClientError('protocol', '公告回执不匹配');
    return r;
  }
  async recover(request: string, c: Cancellation) {
    const r = await this.read('/requests/' + key(request), decodeRecovery, c);
    if (r.requestId !== request)
      throw new ClientError('protocol', '公告回执不匹配');
    return r;
  }
  async cancel(request: string, hash: string, c: Cancellation) {
    const r = await this.api.request(
      {
        path:
          '/v1/announcement-management/requests/' + key(request) + '/cancel',
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeRecovery,
      },
      { body: { requestHash: digest(hash) }, cancellation: c },
    );
    if (r.requestId !== request)
      throw new ClientError('protocol', '公告回执不匹配');
    return r;
  }
}
