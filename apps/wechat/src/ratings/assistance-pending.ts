import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import {
  assistanceDigest,
  assistanceId,
  assistancePurpose,
  decodeAssistanceMetadata,
  matchAssistanceMetadata,
  type AssistanceMetadata,
  type AssistancePurpose,
} from './assistance-contract';
/** New metadata-only journal. Neither original input, context tokens nor result text may be persisted here. */
export interface PendingAssistance {
  readonly kind: 'rating_assistance_v1';
  readonly version: 1;
  readonly accountId: string;
  readonly requestId: string;
  readonly purpose: AssistancePurpose;
  readonly intentHash: string;
  readonly draftId: string;
  readonly inputRevision: number;
  readonly scopeDigest: string;
  readonly state: 'unresolved' | 'cancel_requested' | 'terminal';
  readonly metadata: AssistanceMetadata | null;
}
export function decodePendingAssistance(
  v: unknown,
  accountId: string,
): PendingAssistance {
  exact(v, [
    'kind',
    'version',
    'accountId',
    'requestId',
    'purpose',
    'intentHash',
    'draftId',
    'inputRevision',
    'scopeDigest',
    'state',
    'metadata',
  ]);
  if (
    v.kind !== 'rating_assistance_v1' ||
    v.version !== 1 ||
    !ratingId(accountId) ||
    v.accountId !== accountId ||
    !assistanceId(v.requestId) ||
    !assistanceId(v.draftId) ||
    !assistancePurpose(v.purpose) ||
    !assistanceDigest(v.intentHash) ||
    !assistanceDigest(v.scopeDigest) ||
    !Number.isSafeInteger(v.inputRevision) ||
    (v.inputRevision as number) < 0 ||
    (v.inputRevision as number) > 2_147_483_647 ||
    !['unresolved', 'cancel_requested', 'terminal'].includes(v.state as string)
  )
    invalidRating();
  const metadata =
    v.metadata === null ? null : decodeAssistanceMetadata(v.metadata);
  if (metadata)
    matchAssistanceMetadata(v as unknown as PendingAssistance, metadata);
  if ((v.state === 'terminal') !== (!!metadata && assistanceTerminal(metadata)))
    invalidRating();
  return Object.freeze({ ...v, metadata }) as unknown as PendingAssistance;
}
export const assistanceTerminal = (m: AssistanceMetadata): boolean =>
  ['generated', 'unavailable', 'rejected', 'cancelled', 'expired'].includes(
    m.outcome,
  );
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const storageError = (): ClientError =>
  new ClientError('storage', 'Assistance recovery storage is unavailable');
export class PendingAssistanceStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string): string {
    if (!ratingId(accountId)) throw storageError();
    return `whaleu.ratings.assistance.v1:${this.namespace}:${accountId}`;
  }
  load(accountId: string): PendingAssistance | null {
    try {
      const raw = this.storage.get(this.key(accountId));
      return raw === null || raw === undefined || raw === ''
        ? null
        : decodePendingAssistance(raw, accountId);
    } catch {
      throw storageError();
    }
  }
  freeze(raw: PendingAssistance): PendingAssistance {
    try {
      const value = decodePendingAssistance(raw, raw.accountId),
        old = this.load(value.accountId);
      if (old && !equal(old, value)) throw storageError();
      if (!old) this.storage.set(this.key(value.accountId), value);
      const saved = this.load(value.accountId);
      if (!saved || !equal(saved, value)) throw storageError();
      return saved;
    } catch {
      throw storageError();
    }
  }
  private replace(
    old: PendingAssistance,
    next: PendingAssistance,
  ): PendingAssistance {
    try {
      if (!equal(this.load(old.accountId), old)) throw storageError();
      const value = decodePendingAssistance(next, old.accountId);
      this.storage.set(this.key(old.accountId), value);
      if (!equal(this.load(old.accountId), value)) throw storageError();
      return value;
    } catch {
      throw storageError();
    }
  }
  record(old: PendingAssistance, raw: AssistanceMetadata): PendingAssistance {
    const metadata = decodeAssistanceMetadata(raw);
    matchAssistanceMetadata(old, metadata);
    if (old.state === 'terminal') {
      if (!equal(old.metadata, metadata)) throw storageError();
      return old;
    }
    return this.replace(old, {
      ...old,
      metadata,
      state: assistanceTerminal(metadata) ? 'terminal' : old.state,
    });
  }
  requestCancel(old: PendingAssistance): PendingAssistance {
    return old.state === 'terminal'
      ? old
      : this.replace(old, { ...old, state: 'cancel_requested' });
  }
  dismiss(old: PendingAssistance): void {
    try {
      if (old.state !== 'terminal' || !equal(this.load(old.accountId), old))
        throw storageError();
      this.storage.remove(this.key(old.accountId));
      if (this.load(old.accountId)) throw storageError();
    } catch {
      throw storageError();
    }
  }
}
