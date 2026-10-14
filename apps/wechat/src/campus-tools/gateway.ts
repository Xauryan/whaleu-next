import type { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import {
  decodeToolHub,
  decodeToolDetail,
  decodeToolLink,
  invalidTool,
  toolUuid,
  type ToolHub,
  type ToolDetail,
  type ToolLink,
} from './contract';
import type { ToolRoute } from './navigation';
export interface ToolGateway {
  hub(campusId: string, cancel: Cancellation): Promise<ToolHub>;
  detail(route: ToolRoute, cancel: Cancellation): Promise<ToolDetail>;
  link(
    route: ToolRoute,
    action: 'copy' | 'webview',
    cancel: Cancellation,
  ): Promise<ToolLink>;
}
export class HttpToolGateway implements ToolGateway {
  constructor(
    private readonly api: ApiClient,
    private readonly guard: () => void = () => undefined,
  ) {}
  private async read<T>(
    path: string,
    decode: (raw: unknown) => T,
    cancellation: Cancellation,
    query: Record<string, string> = {},
  ) {
    this.guard();
    const result = await this.api.request(
      {
        path,
        decode,
        method: 'GET',
        authentication: 'optional',
        authReplay: 'once',
        successStatus: 200,
      },
      { query, cancellation },
    );
    this.guard();
    return result;
  }
  async hub(campusId: string, cancel: Cancellation) {
    const result = await this.read(
      `/v1/campuses/${toolUuid(campusId)}/tools`,
      decodeToolHub,
      cancel,
    );
    if (result.campusId !== campusId) invalidTool();
    return result;
  }
  async detail(route: ToolRoute, cancel: Cancellation) {
    const result = await this.read(
      `/v1/campuses/${toolUuid(route.campusId)}/tools/${toolUuid(route.entryId)}`,
      decodeToolDetail,
      cancel,
      { catalogId: toolUuid(route.catalogId) },
    );
    if (
      result.campusId !== route.campusId ||
      (result.state === 'ready' &&
        (result.catalogId !== route.catalogId ||
          result.entry.id !== route.entryId))
    )
      invalidTool();
    return result;
  }
  async link(
    route: ToolRoute,
    action: 'copy' | 'webview',
    cancel: Cancellation,
  ) {
    const result = await this.read(
      `/v1/campuses/${toolUuid(route.campusId)}/tools/${toolUuid(route.entryId)}/link`,
      decodeToolLink,
      cancel,
      { catalogId: toolUuid(route.catalogId), action },
    );
    if (
      result.campusId !== route.campusId ||
      (result.state === 'ready' &&
        (result.catalogId !== route.catalogId ||
          result.entryId !== route.entryId ||
          result.action !== action))
    )
      invalidTool();
    return result;
  }
}
