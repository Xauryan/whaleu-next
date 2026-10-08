import { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import {
  announcementCampus,
  announcementCursor,
  announcementTimestamp,
  announcementUuid,
  decodeAnnouncementChanges,
  decodeAnnouncementDetail,
  decodeAnnouncementOwnerPopup,
  decodeAnnouncementPage,
  decodeAnnouncementPublicPopup,
  decodeAnnouncementReceipt,
  invalidAnnouncement,
  type AnnouncementChanges,
  type AnnouncementDetail,
  type AnnouncementOwnerPopup,
  type AnnouncementPage,
  type AnnouncementPublicPopup,
  type AnnouncementReceipt,
} from './contract';
export interface AnnouncementsGateway {
  list(
    campusId: string | null,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<AnnouncementPage>;
  detail(
    campusId: string | null,
    id: string,
    cancel: Cancellation,
  ): Promise<AnnouncementDetail>;
  popup(
    campusId: string | null,
    cancel: Cancellation,
  ): Promise<AnnouncementPublicPopup>;
  changes(
    campusId: string | null,
    since: string | null,
    cancel: Cancellation,
  ): Promise<AnnouncementChanges>;
  ownerPopup(
    campusId: string | null,
    cancel: Cancellation,
  ): Promise<AnnouncementOwnerPopup>;
  acknowledge(
    campusId: string | null,
    id: string,
    revision: string,
    cancel: Cancellation,
  ): Promise<AnnouncementReceipt>;
}
function query(campusId: string | null): Record<string, string | number> {
  announcementCampus(campusId);
  return campusId === null ? {} : { campusId };
}
export class HttpAnnouncementsGateway implements AnnouncementsGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
    path: string,
    decode: (value: unknown) => T,
    cancel: Cancellation,
    query: Record<string, string | number>,
    owner = false,
  ): Promise<T> {
    return this.api.request(
      {
        path,
        method: 'GET',
        authentication: owner ? 'required' : 'optional',
        authReplay: 'once',
        successStatus: 200,
        decode,
      },
      { query, cancellation: cancel },
    );
  }
  async list(
    campusId: string | null,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<AnnouncementPage> {
    const scope = query(campusId);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (cursor !== null && !announcementCursor(cursor))
    )
      invalidAnnouncement();
    const result = await this.read(
      '/v1/announcements',
      decodeAnnouncementPage,
      cancel,
      { ...scope, limit, ...(cursor === null ? {} : { cursor }) },
    );
    if (
      result.context.campusId !== campusId ||
      result.items.length > limit ||
      (result.continuation === 'more' && result.items.length !== limit) ||
      (cursor !== null &&
        (result.nextCursor === cursor ||
          result.items.some((item) => item.isLatest))) ||
      (cursor === null && result.items.length > 0 && !result.items[0]!.isLatest)
    )
      invalidAnnouncement();
    return result;
  }
  async detail(
    campusId: string | null,
    id: string,
    cancel: Cancellation,
  ): Promise<AnnouncementDetail> {
    if (!announcementUuid(id)) invalidAnnouncement();
    const result = await this.read(
      `/v1/announcements/${id}`,
      decodeAnnouncementDetail,
      cancel,
      query(campusId),
    );
    if (result.id !== id) invalidAnnouncement();
    return result;
  }
  async popup(
    campusId: string | null,
    cancel: Cancellation,
  ): Promise<AnnouncementPublicPopup> {
    const result = await this.read(
      '/v1/announcements/popup',
      decodeAnnouncementPublicPopup,
      cancel,
      query(campusId),
    );
    if (result.context.campusId !== campusId) invalidAnnouncement();
    return result;
  }
  async changes(
    campusId: string | null,
    since: string | null,
    cancel: Cancellation,
  ): Promise<AnnouncementChanges> {
    if (since !== null && !announcementTimestamp(since)) invalidAnnouncement();
    const result = await this.read(
      '/v1/announcements/changes',
      decodeAnnouncementChanges,
      cancel,
      { ...query(campusId), ...(since === null ? {} : { since }) },
    );
    if (result.context.campusId !== campusId) invalidAnnouncement();
    return result;
  }
  async ownerPopup(
    campusId: string | null,
    cancel: Cancellation,
  ): Promise<AnnouncementOwnerPopup> {
    const result = await this.read(
      '/v1/me/announcements/popup',
      decodeAnnouncementOwnerPopup,
      cancel,
      query(campusId),
      true,
    );
    if (result.context.campusId !== campusId) invalidAnnouncement();
    return result;
  }
  async acknowledge(
    campusId: string | null,
    id: string,
    revision: string,
    cancel: Cancellation,
  ): Promise<AnnouncementReceipt> {
    announcementCampus(campusId);
    if (!announcementUuid(id) || !announcementUuid(revision))
      invalidAnnouncement();
    const result = await this.api.request(
      {
        path: `/v1/me/announcements/${id}/popup-acknowledgement`,
        method: 'PUT',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeAnnouncementReceipt,
      },
      { body: { campusId, expectedRevision: revision }, cancellation: cancel },
    );
    if (result.announcementId !== id) invalidAnnouncement();
    return result;
  }
}
