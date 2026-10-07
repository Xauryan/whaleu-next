import { ClientError } from '../api/errors';
import type { Storage } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { exact, invalid } from './contract';
import {
  decodeBlockIntent,
  decodeBlockResult,
  matchBlockResult,
  type BlockIntent,
  type BlockResult,
} from './block-contract';
export interface PendingBlock {
  readonly version: 1;
  readonly accountId: string;
  readonly intent: BlockIntent;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = () =>
  new ClientError('storage', 'Block recovery storage unavailable');
function decode(value: unknown, accountId: string): PendingBlock {
  exact(value, ['version', 'accountId', 'intent']);
  if (
    value.version !== 1 ||
    !isUuid(accountId) ||
    value.accountId !== accountId
  )
    invalid();
  return Object.freeze({
    version: 1,
    accountId,
    intent: decodeBlockIntent(value.intent),
  });
}
/** One unknown desired intent per account; separate from every prior feature journal. */
export class PendingBlockStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string): string {
    if (!isUuid(accountId)) throw unavailable();
    return `whaleu.safety.blocks.pending.v1:${this.namespace}:${accountId}`;
  }
  load(accountId: string): PendingBlock | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(attempt: PendingBlock): PendingBlock {
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
  settle(attempt: PendingBlock, raw: BlockResult): BlockResult {
    const result = decodeBlockResult(raw);
    matchBlockResult(attempt.intent, result);
    try {
      const current = this.load(attempt.accountId);
      if (!current || !equal(current, attempt)) throw unavailable();
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw unavailable();
    } catch {
      throw unavailable();
    }
    return result;
  }
}
