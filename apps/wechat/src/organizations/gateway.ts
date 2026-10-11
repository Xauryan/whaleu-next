import type { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import type { SchoolCapabilities } from '../school-configuration/contract';
import { exact } from '../community/contract';
import {
  decodeOrganizationCapabilities,
  decodeOrganizationCommand,
  decodeOrganizationDetail,
  decodeOrganizationPublicDetail,
  decodeOrganizationPage,
  decodeOrganizationPerson,
  decodeOrganizationReceipt,
  decodeOrganizationRecovery,
  organizationUuid,
  organizationRequestId,
  organizationDigest,
  invalidOrganization,
} from './contract';
import type {
  OrganizationCommand,
  OrganizationDetail,
  OrganizationPublicDetail,
  OrganizationPage,
  OrganizationPerson,
  OrganizationQuery,
  OrganizationReceipt,
  OrganizationRecovery,
} from './contract';
export interface OrganizationGateway {
  context(cancel: Cancellation): Promise<{ regionId: string }>;
  capabilities(cancel: Cancellation): Promise<SchoolCapabilities>;
  list(
    mode: 'mine' | 'review' | 'public',
    regionId: string | null,
    query: OrganizationQuery,
    cancel: Cancellation,
  ): Promise<OrganizationPage>;
  detail(id: string, cancel: Cancellation): Promise<OrganizationDetail>;
  publicDetail(
    regionId: string,
    id: string,
    cancel: Cancellation,
  ): Promise<OrganizationPublicDetail>;
  lookup(
    id: string,
    profileId: string,
    cancel: Cancellation,
  ): Promise<OrganizationPerson>;
  command(
    id: string,
    regionId: string,
    command: OrganizationCommand,
    cancel: Cancellation,
  ): Promise<OrganizationReceipt>;
  recover(id: string, cancel: Cancellation): Promise<OrganizationRecovery>;
  cancel(
    id: string,
    hash: string,
    cancel: Cancellation,
  ): Promise<OrganizationRecovery>;
}
export class HttpOrganizationGateway implements OrganizationGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
    path: string,
    decode: (v: unknown) => T,
    cancel: Cancellation,
    query: Record<string, string | number> = {},
  ) {
    return this.api.request(
      {
        path,
        decode,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
      },
      { query, cancellation: cancel },
    );
  }
  context(cancel: Cancellation) {
    return this.read(
      '/v1/organizations/context',
      (v) => {
        exact(v, ['regionId']);
        return { regionId: organizationUuid(v.regionId) };
      },
      cancel,
    );
  }
  capabilities(cancel: Cancellation) {
    return this.read(
      '/v1/organizations/capabilities',
      decodeOrganizationCapabilities,
      cancel,
    );
  }
  async list(
    mode: 'mine' | 'review' | 'public',
    regionId: string | null,
    query: OrganizationQuery,
    cancel: Cancellation,
  ) {
    if (regionId !== null) organizationUuid(regionId);
    const path =
      mode === 'mine'
        ? '/v1/organizations/mine'
        : mode === 'review'
          ? '/v1/organizations/reviews'
          : `/v1/organizations/regions/${organizationUuid(regionId)}/entries`;
    const result = await this.read(path, decodeOrganizationPage, cancel, {
      ...query,
      ...(mode === 'review' && regionId ? { regionId } : {}),
    });
    if (
      result.items.some(
        (i) =>
          (regionId !== null && i.regionId !== regionId) ||
          (query.kind !== undefined && i.data.kind !== query.kind) ||
          (query.categoryId !== undefined &&
            i.data.categoryId !== query.categoryId),
      )
    )
      invalidOrganization();
    return result;
  }
  async detail(id: string, cancel: Cancellation) {
    const result = await this.read(
      `/v1/organizations/${organizationUuid(id)}`,
      decodeOrganizationDetail,
      cancel,
    );
    if (result.id !== id) invalidOrganization();
    return result;
  }
  async publicDetail(regionId: string, id: string, cancel: Cancellation) {
    const result = await this.read(
      `/v1/organizations/regions/${organizationUuid(regionId)}/entries/${organizationUuid(id)}`,
      decodeOrganizationPublicDetail,
      cancel,
    );
    if (result.id !== id || result.regionId !== regionId) invalidOrganization();
    return result;
  }
  async lookup(id: string, profileId: string, cancel: Cancellation) {
    const result = await this.read(
      `/v1/organizations/${organizationUuid(id)}/members/lookup`,
      decodeOrganizationPerson,
      cancel,
      { profileId: organizationUuid(profileId) },
    );
    if (result.profileId !== profileId) invalidOrganization();
    return result;
  }
  async command(
    id: string,
    regionId: string,
    input: OrganizationCommand,
    cancel: Cancellation,
  ) {
    organizationUuid(id);
    organizationUuid(regionId);
    const command = decodeOrganizationCommand(input),
      action = command.action,
      path =
        action === 'create'
          ? '/v1/organizations'
          : `/v1/organizations/${id}/${action === 'save' || action === 'submit' ? 'content' : action === 'approve' || action === 'reject' ? 'review' : 'members'}`;
    if (
      action === 'create' &&
      (command.organizationId !== id || command.regionId !== regionId)
    )
      invalidOrganization();
    const result = await this.api.request(
      {
        path,
        decode: decodeOrganizationReceipt,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
      },
      {
        body: JSON.parse(JSON.stringify(command)),
        query: action === 'approve' || action === 'reject' ? { regionId } : {},
        cancellation: cancel,
      },
    );
    if (
      result.organizationId !== id ||
      result.requestId !== command.clientRequestId
    )
      invalidOrganization();
    return result;
  }
  async recover(id: string, cancel: Cancellation) {
    const result = await this.read(
      `/v1/organizations/requests/${organizationRequestId(id)}`,
      decodeOrganizationRecovery,
      cancel,
    );
    if (result.requestId !== id) invalidOrganization();
    return result;
  }
  async cancel(id: string, hash: string, cancel: Cancellation) {
    const result = await this.api.request(
      {
        path: `/v1/organizations/requests/${organizationRequestId(id)}/cancel`,
        decode: decodeOrganizationRecovery,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
      },
      { body: { requestHash: organizationDigest(hash) }, cancellation: cancel },
    );
    if (result.requestId !== id) invalidOrganization();
    return result;
  }
}
