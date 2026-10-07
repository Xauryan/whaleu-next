import { ClientError } from '../api/errors';
import type { Storage } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { exact, invalid, uuid4 } from './contract';
import {
  decodeTradingReceipt,
  isTradingResolution,
  type TradingReceipt,
  type TradingResolution,
} from './trading-contract';
export interface PendingTrading {
  readonly version: 1;
  readonly accountId: string;
  readonly postId: string;
  readonly resolution: TradingResolution;
  readonly clientRequestId: string;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = () =>
  new ClientError('storage', 'Trading recovery storage unavailable');
function decode(value: unknown, accountId: string): PendingTrading {
  exact(value, [
    'version',
    'accountId',
    'postId',
    'resolution',
    'clientRequestId',
  ]);
  if (
    value.version !== 1 ||
    !isUuid(accountId) ||
    value.accountId !== accountId ||
    !isUuid(value.postId) ||
    !uuid4(value.clientRequestId) ||
    !isTradingResolution(value.resolution)
  )
    invalid();
  return Object.freeze({
    version: 1,
    accountId,
    postId: value.postId,
    resolution: value.resolution,
    clientRequestId: value.clientRequestId,
  });
}
/** Isolated, nonexpiring status journal. A missing receipt never frees an unresolved opposite intent. */
export class PendingTradingStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string): string {
    if (!isUuid(accountId)) throw unavailable();
    return `whaleu.community.trading.pending.v1:${this.namespace}:${accountId}`;
  }
  load(accountId: string): PendingTrading | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(attempt: PendingTrading): PendingTrading {
    try {
      const checked = decode(attempt, attempt.accountId),
        old = this.load(attempt.accountId);
      if (old && !equal(old, checked)) throw unavailable();
      if (!old) this.storage.set(this.key(attempt.accountId), checked);
      const saved = this.load(attempt.accountId);
      if (!saved || !equal(saved, checked)) throw unavailable();
      return saved;
    } catch {
      throw unavailable();
    }
  }
  settle(attempt: PendingTrading, raw: TradingReceipt): TradingReceipt {
    const receipt = decodeTradingReceipt(raw);
    if (
      receipt.requestId !== attempt.clientRequestId ||
      (receipt.outcome === 'applied' &&
        (receipt.resourceId !== attempt.postId ||
          receipt.resolution !== attempt.resolution))
    )
      invalid();
    try {
      const current = this.load(attempt.accountId);
      if (!current || !equal(current, attempt)) throw unavailable();
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw unavailable();
    } catch {
      throw unavailable();
    }
    return receipt;
  }
}
