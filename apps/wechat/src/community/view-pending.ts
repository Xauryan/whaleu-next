import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import type { Storage } from '../platform/contracts';
import { exact, invalid } from './contract';
import { isUuid } from '../profile/contract';
import {
  decodeViewEpoch,
  decodeViewIntent,
  matchViewReceipt,
  viewKind,
  VIEW_RETRY_MS,
  type ViewEpoch,
  type ViewIntent,
  type ViewKind,
} from './view-contract';

export const VIEW_QUEUE_KEY = 'whaleu.view-reporting.v1';
export const VIEW_MAX_OWNERS = 3;
export const VIEW_MAX_EVENTS = 500;
export const VIEW_MAX_BATCHES = 128;
export const VIEW_MAX_BYTES = 512 * 1024;
interface EpochClock {
  descriptor: ViewEpoch;
  collectionDeadline: number;
  expiresDeadline: number;
}
interface Observation {
  epochId: string;
  kind: ViewKind;
  postId: string;
  at: number;
}
export interface FrozenViewBatch {
  readonly intent: ViewIntent;
  readonly createdAt: number;
  readonly retryAt: number;
}
interface OwnerQueue {
  origin: string;
  accountId: string;
  touchedAt: number;
  epochs: EpochClock[];
  observations: Observation[];
  batches: FrozenViewBatch[];
}
interface Document {
  version: 1;
  revision: number;
  lastSeenClock: number;
  owners: OwnerQueue[];
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
function size(value: Document): number {
  return JSON.stringify(value).length * 2;
}
function count(owner: OwnerQueue): number {
  return (
    owner.observations.length +
    owner.batches.reduce((total, item) => total + item.intent.postIds.length, 0)
  );
}
function decodeDocument(value: unknown): Document {
  exact(value, ['version', 'revision', 'lastSeenClock', 'owners']);
  if (
    value.version !== 1 ||
    !finite(value.revision) ||
    value.revision < 0 ||
    !finite(value.lastSeenClock) ||
    !Array.isArray(value.owners) ||
    value.owners.length > VIEW_MAX_OWNERS
  )
    invalid();
  const seen = new Set<string>();
  for (const owner of value.owners) {
    exact(owner, [
      'origin',
      'accountId',
      'touchedAt',
      'epochs',
      'observations',
      'batches',
    ]);
    if (
      typeof owner.origin !== 'string' ||
      normalizeOrigin(owner.origin) !== owner.origin ||
      typeof owner.accountId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(owner.accountId) ||
      !finite(owner.touchedAt) ||
      !Array.isArray(owner.epochs) ||
      owner.epochs.length > VIEW_MAX_EVENTS + 1 ||
      !Array.isArray(owner.observations) ||
      !Array.isArray(owner.batches) ||
      owner.batches.length > VIEW_MAX_BATCHES
    )
      invalid();
    const ownerKey = JSON.stringify([owner.origin, owner.accountId]);
    if (seen.has(ownerKey)) invalid();
    seen.add(ownerKey);
    const epochs = new Set<string>();
    for (const epoch of owner.epochs) {
      exact(epoch, ['descriptor', 'collectionDeadline', 'expiresDeadline']);
      const descriptor = decodeViewEpoch(epoch.descriptor);
      if (
        !finite(epoch.collectionDeadline) ||
        !finite(epoch.expiresDeadline) ||
        epoch.collectionDeadline >= epoch.expiresDeadline ||
        epochs.has(descriptor.epochId)
      )
        invalid();
      epochs.add(descriptor.epochId);
    }
    for (const item of owner.observations) {
      exact(item, ['epochId', 'kind', 'postId', 'at']);
      if (
        typeof item.epochId !== 'string' ||
        !epochs.has(item.epochId) ||
        !viewKind(item.kind) ||
        !isUuid(item.postId) ||
        item.postId !== item.postId.toLowerCase() ||
        !finite(item.at)
      )
        invalid();
    }
    const batches = new Set<string>();
    for (const item of owner.batches) {
      exact(item, ['intent', 'createdAt', 'retryAt']);
      const intent = decodeViewIntent(item.intent);
      if (
        !epochs.has(intent.epochId) ||
        !finite(item.createdAt) ||
        !finite(item.retryAt) ||
        JSON.stringify(intent) !== JSON.stringify(item.intent) ||
        batches.has(intent.batchId)
      )
        invalid();
      batches.add(intent.batchId);
    }
    if (count(owner as unknown as OwnerQueue) > VIEW_MAX_EVENTS) invalid();
  }
  const document = value as unknown as Document;
  if (size(document) > VIEW_MAX_BYTES) invalid();
  return clone(document);
}

/** One bounded document; synchronous copy-on-write preserves exact frozen identities. */
export class PendingViewStore {
  private document: Document;
  private blocked = false;
  private rollback = false;
  readonly origin: string;
  readonly diagnostics = {
    capacityDropped: 0,
    storageBlocked: 0,
    expiredDropped: 0,
    terminalDropped: 0,
    corruptDropped: 0,
  };
  constructor(
    private readonly storage: Storage,
    origin: string,
    now: number,
  ) {
    this.origin = normalizeOrigin(origin);
    this.document = { version: 1, revision: 0, lastSeenClock: now, owners: [] };
    let raw: unknown;
    try {
      raw = storage.get(VIEW_QUEUE_KEY);
    } catch {
      this.block();
      return;
    }
    if (raw !== undefined && raw !== null && raw !== '') {
      try {
        this.document = decodeDocument(raw);
      } catch {
        // Known-invalid data cannot be recovered into new report identities.
        this.diagnostics.corruptDropped += 1;
        this.commit(this.document);
      }
    }
    this.rollback = now < this.document.lastSeenClock;
    if (!this.rollback) this.purge(now);
  }
  private block(): void {
    this.blocked = true;
    this.diagnostics.storageBlocked += 1;
  }
  get usable(): boolean {
    return !this.blocked && !this.rollback;
  }
  private owner(document: Document, accountId: string): OwnerQueue | undefined {
    return document.owners.find(
      (owner) => owner.origin === this.origin && owner.accountId === accountId,
    );
  }
  private commit(document: Document): boolean {
    if (this.blocked) return false;
    const next = clone(document);
    next.revision = this.document.revision + 1;
    if (!Number.isSafeInteger(next.revision) || size(next) > VIEW_MAX_BYTES)
      return false;
    try {
      this.storage.set(VIEW_QUEUE_KEY, next);
      const stored = decodeDocument(this.storage.get(VIEW_QUEUE_KEY));
      if (JSON.stringify(stored) !== JSON.stringify(next))
        throw new Error('Storage mismatch');
      this.document = stored;
      return true;
    } catch {
      this.block();
      return false;
    }
  }
  checkClock(now: number): boolean {
    if (now < this.document.lastSeenClock) this.rollback = true;
    return this.usable;
  }
  private prune(document: Document, now: number): void {
    for (const owner of document.owners) {
      const live = new Set(
        owner.epochs
          .filter((item) => item.expiresDeadline > now)
          .map((item) => item.descriptor.epochId),
      );
      const before = count(owner);
      owner.observations = owner.observations.filter((item) =>
        live.has(item.epochId),
      );
      owner.batches = owner.batches.filter((item) =>
        live.has(item.intent.epochId),
      );
      this.diagnostics.expiredDropped += before - count(owner);
      const referenced = new Set([
        ...owner.observations.map((item) => item.epochId),
        ...owner.batches.map((item) => item.intent.epochId),
      ]);
      owner.epochs = owner.epochs.filter(
        (item) =>
          live.has(item.descriptor.epochId) &&
          (referenced.has(item.descriptor.epochId) ||
            item.collectionDeadline > now),
      );
    }
    document.owners = document.owners.filter(
      (owner) => owner.epochs.length > 0 || count(owner) > 0,
    );
    document.lastSeenClock = now;
  }
  purge(now: number): boolean {
    if (!this.checkClock(now)) return false;
    // Merely constructing a configured community runtime is a read-only action.
    // With no retained epochs/events there is no recovery clock to persist; an
    // unrelated profile/Updates/detail read must not create an empty queue cache.
    if (this.document.owners.length === 0) {
      this.document.lastSeenClock = now;
      return true;
    }
    const next = clone(this.document);
    this.prune(next, now);
    if (JSON.stringify(next) === JSON.stringify(this.document)) return true;
    return this.commit(next);
  }
  /** Re-establish time using a current authenticated response; no old events change epochs. */
  synchronize(
    accountId: string,
    raw: unknown,
    requestStart: number,
    now: number,
  ): boolean {
    if (this.blocked || now < requestStart) return false;
    const descriptor = decodeViewEpoch(raw),
      serverNow = Date.parse(descriptor.serverNow);
    const next = clone(this.document);
    const rolledBack = this.rollback || requestStart < next.lastSeenClock;
    for (const owner of next.owners) {
      for (const epoch of owner.epochs) {
        const collection =
          requestStart +
          Date.parse(epoch.descriptor.collectionUntil) -
          serverNow;
        const expires =
          requestStart + Date.parse(epoch.descriptor.expiresAt) - serverNow;
        epoch.collectionDeadline = rolledBack
          ? collection
          : Math.min(epoch.collectionDeadline, collection);
        epoch.expiresDeadline = rolledBack
          ? expires
          : Math.min(epoch.expiresDeadline, expires);
      }
      if (rolledBack) {
        for (const item of owner.observations)
          item.at = Math.min(item.at, now - VIEW_RETRY_MS);
        owner.batches = owner.batches.map((item) => ({
          ...item,
          retryAt: Math.min(item.retryAt, now + VIEW_RETRY_MS),
        }));
      }
    }
    this.prune(next, now);
    let owner = this.owner(next, accountId);
    if (!owner) {
      if (next.owners.length >= VIEW_MAX_OWNERS) {
        next.owners.sort((a, b) => a.touchedAt - b.touchedAt);
        const removed = next.owners.shift();
        this.diagnostics.capacityDropped += removed ? count(removed) : 0;
      }
      owner = {
        origin: this.origin,
        accountId,
        touchedAt: now,
        epochs: [],
        observations: [],
        batches: [],
      };
      next.owners.push(owner);
    }
    const existing = owner.epochs.find(
      (item) => item.descriptor.epochId === descriptor.epochId,
    );
    if (
      existing &&
      (existing.descriptor.issuedAt !== descriptor.issuedAt ||
        existing.descriptor.collectionUntil !== descriptor.collectionUntil ||
        existing.descriptor.expiresAt !== descriptor.expiresAt)
    )
      invalid();
    const epoch = {
      descriptor,
      collectionDeadline:
        requestStart + Date.parse(descriptor.collectionUntil) - serverNow,
      expiresDeadline:
        requestStart + Date.parse(descriptor.expiresAt) - serverNow,
    };
    if (existing) {
      epoch.collectionDeadline = Math.min(
        existing.collectionDeadline,
        epoch.collectionDeadline,
      );
      epoch.expiresDeadline = Math.min(
        existing.expiresDeadline,
        epoch.expiresDeadline,
      );
      owner.epochs.splice(owner.epochs.indexOf(existing), 1, epoch);
    } else owner.epochs.push(epoch);
    owner.touchedAt = now;
    const success = this.commit(next);
    if (success) this.rollback = false;
    return success;
  }
  collecting(accountId: string, now: number): string | undefined {
    if (!this.checkClock(now)) return;
    return this.owner(this.document, accountId)?.epochs.find(
      (epoch) => epoch.collectionDeadline > now,
    )?.descriptor.epochId;
  }
  observe(
    accountId: string,
    kind: ViewKind,
    postId: string,
    now: number,
  ): boolean {
    if (!viewKind(kind) || !isUuid(postId) || !this.checkClock(now))
      return false;
    const epochId = this.collecting(accountId, now);
    if (!epochId) return false;
    const next = clone(this.document);
    this.prune(next, now);
    const owner = this.owner(next, accountId);
    if (
      !owner ||
      count(owner) >= VIEW_MAX_EVENTS ||
      owner.batches.length >= VIEW_MAX_BATCHES
    ) {
      this.diagnostics.capacityDropped += 1;
      return false;
    }
    owner.observations.push({
      epochId,
      kind,
      postId: postId.toLowerCase(),
      at: now,
    });
    owner.touchedAt = now;
    if (size(next) > VIEW_MAX_BYTES) {
      this.diagnostics.capacityDropped += 1;
      return false;
    }
    return this.commit(next);
  }
  dueObservation(
    accountId: string,
    now: number,
  ): { readonly epochId: string; readonly kind: ViewKind } | undefined {
    if (!this.checkClock(now)) return;
    const owner = this.owner(this.document, accountId);
    if (!owner || owner.batches.length >= VIEW_MAX_BATCHES) return;
    for (const first of owner.observations) {
      const group = owner.observations.filter(
        (item) => item.epochId === first.epochId && item.kind === first.kind,
      );
      if (
        first.kind === 'detail_visit' ||
        group.length >= 50 ||
        now - first.at >= VIEW_RETRY_MS
      )
        return { epochId: first.epochId, kind: first.kind };
    }
  }
  freeze(
    accountId: string,
    due: { epochId: string; kind: ViewKind },
    batchId: string,
    now: number,
  ): FrozenViewBatch | undefined {
    if (!this.checkClock(now)) return;
    const next = clone(this.document);
    this.prune(next, now);
    const owner = this.owner(next, accountId);
    if (
      !owner ||
      owner.batches.length >= VIEW_MAX_BATCHES ||
      owner.batches.some((item) => item.intent.batchId === batchId)
    )
      return;
    const items = owner.observations
      .filter((item) => item.epochId === due.epochId && item.kind === due.kind)
      .slice(0, due.kind === 'detail_visit' ? 1 : 50);
    if (!items.length) return;
    const batch = {
      intent: decodeViewIntent({
        version: 1,
        epochId: due.epochId,
        batchId,
        kind: due.kind,
        postIds: items.map((item) => item.postId),
      }),
      createdAt: now,
      retryAt: now,
    };
    owner.observations = owner.observations.filter(
      (item) => !items.includes(item),
    );
    owner.batches.push(batch);
    if (!this.commit(next)) return;
    return clone(batch);
  }
  dueBatch(accountId: string, now: number): FrozenViewBatch | undefined {
    if (!this.checkClock(now)) return;
    const owner = this.owner(this.document, accountId);
    const batch = owner?.batches.find(
      (item) =>
        item.retryAt <= now &&
        owner.epochs.some(
          (epoch) =>
            epoch.descriptor.epochId === item.intent.epochId &&
            epoch.expiresDeadline > now,
        ),
    );
    return batch && clone(batch);
  }
  assertOriginal(accountId: string, batch: FrozenViewBatch): void {
    if (this.blocked || this.rollback)
      throw new ClientError('storage', 'View queue unavailable');
    let stored: Document;
    try {
      stored = decodeDocument(this.storage.get(VIEW_QUEUE_KEY));
    } catch {
      this.block();
      throw new ClientError('storage', 'View queue unavailable');
    }
    if (
      JSON.stringify(stored) !== JSON.stringify(this.document) ||
      !this.owner(stored, accountId)?.batches.some(
        (item) => JSON.stringify(item) === JSON.stringify(batch),
      )
    ) {
      this.block();
      throw new ClientError('storage', 'View queue changed');
    }
  }
  private changeBatch(
    accountId: string,
    batch: FrozenViewBatch,
    retryAt?: number,
  ): boolean {
    // A running cleanup may expire captured work while its response is in flight.
    if (
      !this.owner(this.document, accountId)?.batches.some(
        (item) => item.intent.batchId === batch.intent.batchId,
      )
    )
      return false;
    this.assertOriginal(accountId, batch);
    const next = clone(this.document),
      owner = this.owner(next, accountId)!;
    owner.batches = owner.batches.flatMap((item) =>
      item.intent.batchId !== batch.intent.batchId
        ? [item]
        : retryAt === undefined
          ? []
          : [{ ...item, retryAt }],
    );
    return this.commit(next);
  }
  settle(accountId: string, batch: FrozenViewBatch, receipt: unknown): boolean {
    matchViewReceipt(batch.intent, receipt);
    return this.changeBatch(accountId, batch);
  }
  terminal(accountId: string, batch: FrozenViewBatch): boolean {
    const success = this.changeBatch(accountId, batch);
    if (success)
      this.diagnostics.terminalDropped += batch.intent.postIds.length;
    return success;
  }
  retry(accountId: string, batch: FrozenViewBatch, now: number): boolean {
    return this.changeBatch(accountId, batch, now + VIEW_RETRY_MS);
  }
  nextDelay(accountId: string, now: number): number {
    const owner = this.owner(this.document, accountId);
    if (!owner) return 60_000;
    const times = owner.epochs.flatMap((epoch) => [
      epoch.collectionDeadline,
      epoch.expiresDeadline,
    ]);
    times.push(...owner.batches.map((item) => item.retryAt));
    if (owner.batches.length < VIEW_MAX_BATCHES)
      times.push(
        ...owner.observations.map((item) =>
          item.kind === 'detail_visit' ? now : item.at + VIEW_RETRY_MS,
        ),
      );
    const future = times.filter((time) => time > now);
    return Math.max(1, Math.min(60_000, ...future.map((time) => time - now)));
  }
  /** Exposes quantities only; no event identity enters diagnostics. */
  quantities(accountId: string): {
    events: number;
    batches: number;
    owners: number;
  } {
    const owner = this.owner(this.document, accountId);
    return {
      events: owner ? count(owner) : 0,
      batches: owner?.batches.length ?? 0,
      owners: this.document.owners.length,
    };
  }
}
