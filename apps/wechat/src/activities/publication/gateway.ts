import type { ApiClient } from '../../api/client';
import type { Cancellation } from '../../platform/contracts';
import {
  activityId,
  activityKey,
  activityDigest,
  decodeActivityCommand,
  decodeActivityResult,
  decodeActivityRecovery,
  decodeActivityDraft,
  decodeActivityOrganizers,
  decodeNativeActivity,
  decodeNativeActivityPage,
  invalidActivityPublication,
} from './contract';
import type { ActivityCommand } from './contract';
export class HttpActivityPublicationGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
    path: string,
    decode: (v: unknown) => T,
    cancel: Cancellation,
    query: Record<string, string | number> = {},
  ) {
    return this.api.request(
      {
        path: '/v1/activity-publication' + path,
        decode,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
      },
      { query, cancellation: cancel },
    );
  }
  organizers(cancel: Cancellation, cursor?: string) {
    return this.read(
      '/organizers',
      decodeActivityOrganizers,
      cancel,
      cursor ? { cursor } : {},
    );
  }
  async draft(id: string, cancel: Cancellation) {
    const value = await this.read(
      `/drafts/${activityId(id)}`,
      decodeActivityDraft,
      cancel,
    );
    if (value.id !== id) invalidActivityPublication();
    return value;
  }
  async detail(id: string, cancel: Cancellation) {
    const value = await this.read(
      `/activities/${activityId(id)}`,
      decodeNativeActivity,
      cancel,
    );
    if (value.id !== id) invalidActivityPublication();
    return value;
  }
  list(mine: boolean, cancel: Cancellation, cursor?: string) {
    return this.read(
      mine ? '/mine' : '/catalog',
      decodeNativeActivityPage,
      cancel,
      cursor ? { cursor } : {},
    );
  }
  async command(id: string, input: ActivityCommand, cancel: Cancellation) {
    const command = decodeActivityCommand(input),
      result = await this.api.request(
        {
          path: `/v1/activity-publication/drafts/${activityId(id)}/commands`,
          decode: decodeActivityResult,
          method: 'POST',
          authentication: 'required',
          authReplay: 'never',
          successStatus: 200,
        },
        { body: JSON.parse(JSON.stringify(command)), cancellation: cancel },
      );
    if (
      result.requestId !== command.clientRequestId ||
      (!('state' in result) && result.activityId !== id)
    )
      invalidActivityPublication();
    return result;
  }
  async recover(key: string, cancel: Cancellation) {
    const result = await this.read(
      `/requests/${activityKey(key)}`,
      decodeActivityRecovery,
      cancel,
    );
    if (result.requestId !== key) invalidActivityPublication();
    return result;
  }
  async cancel(key: string, hash: string, cancel: Cancellation) {
    const result = await this.api.request(
      {
        path: `/v1/activity-publication/requests/${activityKey(key)}/cancel`,
        decode: decodeActivityRecovery,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
      },
      { body: { requestHash: activityDigest(hash) }, cancellation: cancel },
    );
    if (result.requestId !== key) invalidActivityPublication();
    return result;
  }
}
