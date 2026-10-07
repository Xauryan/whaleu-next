import { ClientError } from '../api/errors';
import type { Storage } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { exact, invalid } from './contract';
import {
  decodeFormationJoinIntent,
  decodeFormationReceipt,
  type FormationJoinIntent,
  type FormationReceipt,
} from './formation-contract';
export interface PendingFormationJoin {
  readonly version: 1;
  readonly accountId: string;
  readonly postId: string;
  readonly payload: FormationJoinIntent;
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const storageError = (): ClientError =>
  new ClientError('storage', 'FormationJoin recovery storage is unavailable');
function decode(value: unknown, accountId: string): PendingFormationJoin {
  exact(value, ['version', 'accountId', 'postId', 'payload']);
  if (
    value.version !== 1 ||
    !isUuid(accountId) ||
    value.accountId !== accountId ||
    !isUuid(value.postId)
  )
    invalid();
  return Object.freeze({
    version: 1,
    accountId,
    postId: value.postId,
    payload: decodeFormationJoinIntent(value.payload),
  });
}
/** Dedicated account/origin namespace: an unknown formationJoin never expires or releases a new key. */
export class PendingFormationJoinStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string): string {
    if (!isUuid(accountId)) throw storageError();
    return `whaleu.community.formation.pending.v1:${this.namespace}:${accountId}`;
  }
  load(accountId: string): PendingFormationJoin | null {
    try {
      const raw = this.storage.get(this.key(accountId));
      return raw === undefined || raw === null || raw === ''
        ? null
        : decode(raw, accountId);
    } catch {
      throw storageError();
    }
  }
  freeze(attempt: PendingFormationJoin): PendingFormationJoin {
    try {
      const checked = decode(attempt, attempt.accountId),
        old = this.load(attempt.accountId);
      if (old && !equal(old, checked)) throw storageError();
      if (!old) this.storage.set(this.key(checked.accountId), checked);
      const saved = this.load(checked.accountId);
      if (!saved || !equal(saved, checked)) throw storageError();
      return saved;
    } catch {
      throw storageError();
    }
  }
  settle(
    attempt: PendingFormationJoin,
    raw: FormationReceipt,
  ): FormationReceipt {
    const receipt = decodeFormationReceipt(raw);
    if (receipt.requestId !== attempt.payload.clientRequestId) invalid();
    try {
      const current = this.load(attempt.accountId);
      if (!current || !equal(current, attempt)) throw storageError();
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw storageError();
    } catch {
      throw storageError();
    }
    return receipt;
  }
}
