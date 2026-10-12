import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation, Json } from '../platform/contracts';
import {
  decodeFloorCatalog,
  decodeFloorDetail,
  decodeFloorReceipt,
  decodeFloorSetScore,
  invalidFloor,
  matchFloorReceipt,
  floorId,
  type FloorCatalog,
  type FloorDetail,
  type FloorReceipt,
  type FloorSetScore,
} from './contract';
export interface FloorRatingsGateway {
  catalog(cancel: Cancellation): Promise<FloorCatalog>;
  detail(floorId: string, cancel: Cancellation): Promise<FloorDetail>;
  submit(
    floorId: string,
    command: FloorSetScore,
    cancel: Cancellation,
  ): Promise<FloorReceipt>;
  cancel(
    floorId: string,
    command: FloorSetScore,
    cancel: Cancellation,
  ): Promise<FloorReceipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<FloorReceipt>;
}
export class HttpFloorRatingsGateway implements FloorRatingsGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
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
  catalog(cancel: Cancellation): Promise<FloorCatalog> {
    return this.read(
      '/v1/ratings/canteen-floors/catalog',
      decodeFloorCatalog,
      cancel,
    );
  }
  async detail(id: string, cancel: Cancellation): Promise<FloorDetail> {
    if (!floorId(id)) invalidFloor();
    const detail = await this.read(
      `/v1/ratings/canteen-floors/${id}`,
      decodeFloorDetail,
      cancel,
    );
    if (detail.floor.id !== id) invalidFloor();
    return detail;
  }
  private async write(
    id: string,
    raw: FloorSetScore,
    cancellation: Cancellation,
    cancelling: boolean,
  ): Promise<FloorReceipt> {
    if (!floorId(id)) invalidFloor();
    const command = decodeFloorSetScore(raw);
    const receipt = await this.api.request(
      {
        path: cancelling
          ? `/v1/ratings/canteen-floors/requests/${command.clientRequestId}/cancel`
          : `/v1/ratings/canteen-floors/${id}/first-score`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeFloorReceipt,
      },
      {
        cancellation,
        body: JSON.parse(
          JSON.stringify(cancelling ? { floorId: id, command } : command),
        ) as Json,
      },
    );
    matchFloorReceipt(id, command, receipt);
    return receipt;
  }
  submit(
    id: string,
    command: FloorSetScore,
    cancel: Cancellation,
  ): Promise<FloorReceipt> {
    return this.write(id, command, cancel, false);
  }
  cancel(
    id: string,
    command: FloorSetScore,
    cancel: Cancellation,
  ): Promise<FloorReceipt> {
    return this.write(id, command, cancel, true);
  }
  async receipt(id: string, cancel: Cancellation): Promise<FloorReceipt> {
    if (!floorId(id)) invalidFloor();
    const receipt = await this.read(
      `/v1/ratings/canteen-floors/requests/${id}`,
      decodeFloorReceipt,
      cancel,
    );
    if (receipt.requestId !== id) invalidFloor();
    return receipt;
  }
}
