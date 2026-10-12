import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import { exact } from '../community/contract';
import { uploadDigest } from '../media/upload-contracts';
import type { Storage } from '../platform/contracts';
import { windowId } from '../window-ratings/contract';
import {
  decodeDiscussionV2CancelTarget,
  decodeDiscussionV2Receipt,
  matchDiscussionV2Receipt,
  type DiscussionV2CancelTarget,
  type DiscussionV2Receipt,
} from './v2-contract';

export interface DiscussionV2UploadRecoveryKey {
  readonly requestId: string;
  readonly requestHash: string;
}
/** This journal intentionally cannot reconstruct or resend a publication.
 * The original account can only recover its receipt or cancel the same key. */
export interface PendingWindowDiscussionV2 {
  readonly version: 2;
  readonly accountId: string;
  readonly origin: string;
  readonly target: DiscussionV2CancelTarget;
  readonly phase: 'draft' | 'submit' | 'cancel';
  readonly intentHash: string | null;
  readonly uploadRecoveryKeys: readonly DiscussionV2UploadRecoveryKey[];
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): ClientError =>
  new ClientError('storage', 'Window discussion recovery storage unavailable');

export class PendingWindowDiscussionV2Store {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(accountId: string): string {
    if (
      !windowId(accountId) ||
      typeof this.origin !== 'string' ||
      !this.origin.length
    )
      throw unavailable();
    normalizeOrigin(this.origin);
    return `whaleu.window-discussion.pending.v2:${this.origin}:${accountId}`;
  }
  private decode(raw: unknown, accountId: string): PendingWindowDiscussionV2 {
    exact(raw, [
      'version',
      'accountId',
      'origin',
      'target',
      'phase',
      'intentHash',
      'uploadRecoveryKeys',
    ]);
    if (
      raw.version !== 2 ||
      !windowId(accountId) ||
      raw.accountId !== accountId ||
      raw.origin !== this.origin ||
      (raw.phase !== 'draft' &&
        raw.phase !== 'submit' &&
        raw.phase !== 'cancel') ||
      !(raw.intentHash === null || uploadDigest(raw.intentHash)) ||
      (raw.phase === 'draft' && raw.intentHash !== null) ||
      (raw.phase === 'submit' && raw.intentHash === null) ||
      !Array.isArray(raw.uploadRecoveryKeys) ||
      raw.uploadRecoveryKeys.length > 3
    )
      throw unavailable();
    const target = decodeDiscussionV2CancelTarget(raw.target);
    const uploadRecoveryKeys = Array.from(raw.uploadRecoveryKeys).map(
      (value) => {
        exact(value, ['requestId', 'requestHash']);
        if (
          !windowId(value.requestId) ||
          !uploadDigest(value.requestHash) ||
          value.requestId === target.clientRequestId
        )
          throw unavailable();
        return Object.freeze({
          requestId: value.requestId,
          requestHash: value.requestHash,
        });
      },
    );
    if (
      new Set(uploadRecoveryKeys.map((key) => key.requestId)).size !==
      uploadRecoveryKeys.length
    )
      throw unavailable();
    return Object.freeze({
      version: 2,
      accountId,
      origin: this.origin,
      target,
      phase: raw.phase,
      intentHash: raw.intentHash,
      uploadRecoveryKeys: Object.freeze(uploadRecoveryKeys),
    });
  }
  load(accountId: string): PendingWindowDiscussionV2 | null {
    try {
      const raw = this.storage.get(this.key(accountId));
      return raw === undefined || raw === null || raw === ''
        ? null
        : this.decode(raw, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingWindowDiscussionV2): PendingWindowDiscussionV2 {
    try {
      const value = this.decode(raw, raw.accountId),
        old = this.load(value.accountId);
      if (old && !equal(old, value)) throw unavailable();
      if (!old) this.storage.set(this.key(value.accountId), value);
      this.assertOriginal(value);
      return value;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(value: PendingWindowDiscussionV2): void {
    if (!equal(this.load(value.accountId), this.decode(value, value.accountId)))
      throw unavailable();
  }
  private replace(
    value: PendingWindowDiscussionV2,
    raw: unknown,
  ): PendingWindowDiscussionV2 {
    this.assertOriginal(value);
    try {
      const next = this.decode(raw, value.accountId);
      this.storage.set(this.key(value.accountId), next);
      this.assertOriginal(next);
      return next;
    } catch {
      throw unavailable();
    }
  }
  appendUpload(
    value: PendingWindowDiscussionV2,
    key: DiscussionV2UploadRecoveryKey,
  ): PendingWindowDiscussionV2 {
    if (value.phase !== 'draft') throw unavailable();
    return this.replace(value, {
      ...value,
      uploadRecoveryKeys: [...value.uploadRecoveryKeys, key],
    });
  }
  beginSubmission(
    value: PendingWindowDiscussionV2,
    intentHash: string,
  ): PendingWindowDiscussionV2 {
    if (value.phase !== 'draft' || !uploadDigest(intentHash))
      throw unavailable();
    return this.replace(value, { ...value, phase: 'submit', intentHash });
  }
  beginCancellation(
    value: PendingWindowDiscussionV2,
  ): PendingWindowDiscussionV2 {
    return this.replace(value, { ...value, phase: 'cancel' });
  }
  settle(
    value: PendingWindowDiscussionV2,
    raw: DiscussionV2Receipt,
  ): DiscussionV2Receipt {
    const receipt = decodeDiscussionV2Receipt(raw);
    matchDiscussionV2Receipt(value.target, receipt);
    this.assertOriginal(value);
    try {
      this.storage.remove(this.key(value.accountId));
      if (this.load(value.accountId)) throw unavailable();
    } catch {
      try {
        this.storage.set(this.key(value.accountId), value);
      } catch {
        /* Keep recovery blocked. */
      }
      throw unavailable();
    }
    return receipt;
  }
}
