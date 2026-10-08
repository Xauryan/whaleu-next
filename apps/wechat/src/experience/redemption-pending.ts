import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import type { Storage } from '../platform/contracts';
import {
  exactExperience,
  experienceRequestId,
  experienceUuid,
} from './contract';
import {
  decodeRedemptionReceipt,
  type RedemptionReceipt,
} from './redemption-contract';
export interface RedemptionHandle {
  readonly version: 1;
  readonly origin: string;
  readonly accountId: string;
  readonly operation: 'redeem_title';
  readonly requestId: string;
}
const unavailable = () =>
  new ClientError('storage', 'Redemption recovery storage unavailable');
export class PendingRedemptionStore {
  constructor(
    private readonly storage: Storage,
    private readonly origin: string,
  ) {}
  private key(accountId: string): string {
    if (!experienceUuid(accountId)) throw unavailable();
    return `whaleu.redemption.pending.v1:${normalizeOrigin(this.origin)}:${accountId}`;
  }
  load(accountId: string): RedemptionHandle | null {
    try {
      const raw = this.storage.get(this.key(accountId));
      if (raw === undefined || raw === null || raw === '') return null;
      exactExperience(raw, [
        'version',
        'origin',
        'accountId',
        'operation',
        'requestId',
      ]);
      if (
        raw.version !== 1 ||
        raw.origin !== normalizeOrigin(this.origin) ||
        raw.accountId !== accountId ||
        raw.operation !== 'redeem_title' ||
        !experienceRequestId(raw.requestId)
      )
        throw unavailable();
      return Object.freeze({
        version: 1,
        origin: raw.origin,
        accountId,
        operation: 'redeem_title',
        requestId: raw.requestId,
      });
    } catch {
      throw unavailable();
    }
  }
  freeze(accountId: string, requestId: string): RedemptionHandle {
    if (!experienceRequestId(requestId)) throw unavailable();
    const old = this.load(accountId);
    if (old && old.requestId !== requestId) throw unavailable();
    try {
      if (!old)
        this.storage.set(this.key(accountId), {
          version: 1,
          origin: normalizeOrigin(this.origin),
          accountId,
          operation: 'redeem_title',
          requestId,
        });
      const saved = this.load(accountId);
      if (!saved || saved.requestId !== requestId) throw unavailable();
      return saved;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(handle: RedemptionHandle): void {
    if (this.load(handle.accountId)?.requestId !== handle.requestId)
      throw unavailable();
  }
  settle(handle: RedemptionHandle, raw: unknown): RedemptionReceipt {
    const receipt = decodeRedemptionReceipt(raw);
    if (receipt.requestId !== handle.requestId)
      throw new ClientError('protocol', 'Redemption receipt mismatch');
    this.assertOriginal(handle);
    try {
      this.storage.remove(this.key(handle.accountId));
      if (this.load(handle.accountId)) throw unavailable();
    } catch {
      throw unavailable();
    }
    return receipt;
  }
}
