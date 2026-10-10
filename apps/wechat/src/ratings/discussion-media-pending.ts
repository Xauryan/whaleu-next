import type { SessionStore } from '../auth/session';
import {
  decodeDiscussionBatchStatus,
  decodeDiscussionBatchRecovery,
  type DiscussionBatchRecovery,
  type DiscussionBatchStatus,
} from './discussion-media-wire';
import { ClientError, isRecord } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import { canonicalRatingScopedJson } from './scoped-contract';
import { invalidRating } from './contract';
import {
  discussionMediaId as id,
  discussionMediaDigest as digest,
  decodeRatingDiscussionMediaIntent,
  decodeRatingDiscussionMediaReceipt,
  matchRatingDiscussionMediaReceipt,
  ratingDiscussionMediaIntentHash,
  type RatingDiscussionMediaIntent,
  type RatingDiscussionMediaReceipt,
} from './discussion-media-contract';
import {
  decodeRatingDiscussionBatchIdentity,
  decodeRatingDiscussionMember,
  ratingDiscussionBatchIdentityHash,
  ratingDiscussionMemberRequestHash,
  ratingDiscussionSealedPlanHash,
  type RatingDiscussionBatchIdentity,
  type RatingDiscussionMember,
} from './discussion-media-batch-contract';
export interface PendingRatingDiscussionBatch {
  readonly version: 12;
  readonly phase: 'batch';
  readonly accountId: string;
  readonly identity: RatingDiscussionBatchIdentity;
  readonly identityHash: string;
  readonly batchId: string | null;
  readonly members: readonly RatingDiscussionMember[];
  readonly orderedMemberIds: readonly string[];
  readonly sealedPlanDigest: string | null;
}
export interface PendingRatingDiscussionCommand {
  readonly version: 12;
  readonly phase: 'command';
  readonly accountId: string;
  readonly intent: RatingDiscussionMediaIntent;
  readonly receipt: RatingDiscussionMediaReceipt | null;
}
export interface OpaqueRatingDiscussionBatch {
  readonly version: 12;
  readonly phase: 'batch-opaque';
  readonly accountId: string;
  readonly batchRequestId: string;
  readonly commandRequestId: string;
  readonly identityHash: string;
  readonly batchId: string | null;
}
export interface OpaqueRatingDiscussionCommand {
  readonly version: 12;
  readonly phase: 'command-opaque';
  readonly accountId: string;
  readonly requestId: string;
  readonly operation: 'create_comment_scoped' | 'create_reply_scoped';
  readonly intentHash: string;
  readonly batchRequestId: string | null;
  readonly batchId: string | null;
  readonly identityHash: string | null;
  readonly sealedPlanDigest: string | null;
  readonly receipt: RatingDiscussionMediaReceipt | null;
}
export interface OpaqueRatingDiscussionRecovery {
  readonly batch: OpaqueRatingDiscussionBatch | null;
  readonly command: OpaqueRatingDiscussionCommand | null;
}
function opaqueBatch(raw: unknown, actor: string): OpaqueRatingDiscussionBatch {
  if (isRecord(raw) && raw.phase === 'batch') {
    const batch = decodePendingRatingDiscussionBatch(raw, actor);
    return {
      version: 12,
      phase: 'batch-opaque',
      accountId: actor,
      batchRequestId: batch.identity.batchRequestId,
      commandRequestId: batch.identity.commandRequestId,
      identityHash: batch.identityHash,
      batchId: batch.batchId,
    };
  }
  exact(raw, [
    'version',
    'phase',
    'accountId',
    'batchRequestId',
    'commandRequestId',
    'identityHash',
    'batchId',
  ]);
  if (
    raw.version !== 12 ||
    raw.phase !== 'batch-opaque' ||
    id(raw.accountId) !== actor ||
    raw.batchRequestId === raw.commandRequestId
  )
    invalidRating();
  return {
    version: 12,
    phase: 'batch-opaque',
    accountId: actor,
    batchRequestId: id(raw.batchRequestId),
    commandRequestId: id(raw.commandRequestId),
    identityHash: digest(raw.identityHash),
    batchId: raw.batchId === null ? null : id(raw.batchId),
  };
}
function opaqueCommand(
  raw: unknown,
  actor: string,
): OpaqueRatingDiscussionCommand {
  if (isRecord(raw) && raw.phase === 'command') {
    const command = decodePendingRatingDiscussionCommand(raw, actor),
      intent = command.intent,
      p = intent.payload;
    let identityHash: string | null = null;
    if (p.batchId) {
      const target = {
        targetId: p.targetId,
        expectedTargetRevision: p.expectedTargetRevision,
        expectedDefinitionRevision: p.expectedDefinitionRevision,
        expectedContentVersion: p.expectedContentVersion,
      };
      const identity = decodeRatingDiscussionBatchIdentity({
        protocol: 'ratings-discussion-media-v1',
        batchRequestId: p.batchRequestId,
        commandRequestId: p.clientRequestId,
        draftRevision: p.draftRevision,
        categoryId: p.categoryId,
        expectedCategoryRevision: p.expectedCategoryRevision,
        context: intent.context,
        target:
          intent.operation === 'create_comment_scoped'
            ? { ...target, kind: 'root' }
            : {
                ...target,
                kind: 'reply',
                rootId: intent.payload.rootId,
                expectedRootRevision: intent.payload.expectedRootRevision,
                replyTo: intent.payload.replyTo,
              },
      });
      identityHash = ratingDiscussionBatchIdentityHash(actor, identity);
    }
    return {
      version: 12,
      phase: 'command-opaque',
      accountId: actor,
      requestId: p.clientRequestId,
      operation: intent.operation,
      intentHash: ratingDiscussionMediaIntentHash(intent),
      batchRequestId: p.batchRequestId,
      batchId: p.batchId,
      identityHash,
      sealedPlanDigest: p.sealedPlanDigest,
      receipt: command.receipt,
    };
  }
  exact(raw, [
    'version',
    'phase',
    'accountId',
    'requestId',
    'operation',
    'intentHash',
    'batchRequestId',
    'batchId',
    'identityHash',
    'sealedPlanDigest',
    'receipt',
  ]);
  if (
    raw.version !== 12 ||
    raw.phase !== 'command-opaque' ||
    id(raw.accountId) !== actor ||
    (raw.operation !== 'create_comment_scoped' &&
      raw.operation !== 'create_reply_scoped')
  )
    invalidRating();
  const batchRequestId =
      raw.batchRequestId === null ? null : id(raw.batchRequestId),
    batchId = raw.batchId === null ? null : id(raw.batchId),
    identityHash = raw.identityHash === null ? null : digest(raw.identityHash),
    sealedPlanDigest =
      raw.sealedPlanDigest === null ? null : digest(raw.sealedPlanDigest);
  if (
    (batchId === null) !== (batchRequestId === null) ||
    (batchId === null) !== (identityHash === null) ||
    (batchId === null) !== (sealedPlanDigest === null)
  )
    invalidRating();
  const value: OpaqueRatingDiscussionCommand = {
    version: 12,
    phase: 'command-opaque',
    accountId: actor,
    requestId: id(raw.requestId),
    operation: raw.operation,
    intentHash: digest(raw.intentHash),
    batchRequestId,
    batchId,
    identityHash,
    sealedPlanDigest,
    receipt:
      raw.receipt === null
        ? null
        : decodeRatingDiscussionMediaReceipt(raw.receipt),
  };
  if (value.receipt) matchOpaqueReceipt(value, value.receipt);
  return value;
}
function matchOpaqueReceipt(
  command: OpaqueRatingDiscussionCommand,
  raw: RatingDiscussionMediaReceipt,
): void {
  const receipt = decodeRatingDiscussionMediaReceipt(raw);
  if (
    receipt.requestId !== command.requestId ||
    receipt.intentHash !== command.intentHash ||
    receipt.operation !== command.operation
  )
    invalidRating();
}
const same = (a: unknown, b: unknown) =>
  canonicalRatingScopedJson(a) === canonicalRatingScopedJson(b);
const unavailable = () =>
  new ClientError(
    'storage',
    'Recover the original Ratings request before starting another',
  );
export function decodePendingRatingDiscussionBatch(
  raw: unknown,
  actor: string,
): PendingRatingDiscussionBatch {
  exact(raw, [
    'version',
    'phase',
    'accountId',
    'identity',
    'identityHash',
    'batchId',
    'members',
    'orderedMemberIds',
    'sealedPlanDigest',
  ]);
  if (
    raw.version !== 12 ||
    raw.phase !== 'batch' ||
    id(raw.accountId) !== id(actor) ||
    !Array.isArray(raw.members) ||
    raw.members.length > 128 ||
    !Array.isArray(raw.orderedMemberIds)
  )
    invalidRating();
  const identity = decodeRatingDiscussionBatchIdentity(raw.identity),
    identityHash = digest(raw.identityHash);
  if (identityHash !== ratingDiscussionBatchIdentityHash(actor, identity))
    invalidRating();
  const members = raw.members.map(decodeRatingDiscussionMember),
    orderedMemberIds = raw.orderedMemberIds.map(id);
  const maximum = identity.target.kind === 'root' ? 9 : 3;
  if (
    orderedMemberIds.length > maximum ||
    new Set(orderedMemberIds).size !== orderedMemberIds.length ||
    new Set(members.map((m) => m.memberId)).size !== members.length ||
    new Set(members.map((m) => m.clientRequestId)).size !== members.length ||
    new Set(members.map((m) => m.sourceSlot)).size !== members.length ||
    members.filter(
      (m) =>
        m.state === 'pending' || m.state === 'unknown' || m.state === 'ready',
    ).length > maximum ||
    members.filter((m) => m.state === 'retiring').length > maximum ||
    orderedMemberIds.some(
      (memberId) =>
        !members.some(
          (m) =>
            m.memberId === memberId &&
            m.state !== 'retiring' &&
            m.state !== 'retired',
        ),
    )
  )
    invalidRating();
  const batchId = raw.batchId === null ? null : id(raw.batchId),
    sealedPlanDigest =
      raw.sealedPlanDigest === null ? null : digest(raw.sealedPlanDigest);
  if (
    members.length > 0 &&
    (batchId === null ||
      members.some(
        (member) =>
          member.requestHash !==
          ratingDiscussionMemberRequestHash(
            actor,
            batchId,
            identityHash,
            member,
          ),
      ))
  )
    invalidRating();
  if (
    sealedPlanDigest !== null &&
    (batchId === null ||
      orderedMemberIds.length === 0 ||
      members.some((m) => m.state !== 'ready' && m.state !== 'retired') ||
      members.filter((m) => m.state === 'ready').length !==
        orderedMemberIds.length ||
      orderedMemberIds.some(
        (memberId) =>
          members.find((m) => m.memberId === memberId)?.state !== 'ready',
      ))
  )
    invalidRating();
  if (
    sealedPlanDigest !== null &&
    batchId !== null &&
    sealedPlanDigest !==
      ratingDiscussionSealedPlanHash(
        batchId,
        identityHash,
        orderedMemberIds,
        members,
      )
  )
    invalidRating();
  return Object.freeze({
    version: 12,
    phase: 'batch',
    accountId: actor,
    identity,
    identityHash,
    batchId,
    members: Object.freeze(members),
    orderedMemberIds: Object.freeze(orderedMemberIds),
    sealedPlanDigest,
  });
}
export function decodePendingRatingDiscussionCommand(
  raw: unknown,
  actor: string,
): PendingRatingDiscussionCommand {
  exact(raw, ['version', 'phase', 'accountId', 'intent', 'receipt']);
  if (
    raw.version !== 12 ||
    raw.phase !== 'command' ||
    id(raw.accountId) !== id(actor)
  )
    invalidRating();
  const intent = decodeRatingDiscussionMediaIntent(raw.intent),
    receipt =
      raw.receipt === null
        ? null
        : decodeRatingDiscussionMediaReceipt(raw.receipt);
  if (receipt !== null) matchRatingDiscussionMediaReceipt(intent, receipt);
  return Object.freeze({
    version: 12,
    phase: 'command',
    accountId: actor,
    intent,
    receipt,
  });
}
/** Metadata only. Neither temporary paths, bytes, upload grants nor a derived
 * account's authority may be saved here. Old journals always take precedence;
 * unreadable old values block just as valid ones do. */
export class PendingRatingDiscussionMediaStore {
  private readonly scrubRequired = new Set<string>();
  private readonly hydratedActors = new Set<string>();
  constructor(
    private readonly storage: Storage,
    private readonly origin: string,
  ) {}
  watchSession(sessions: SessionStore): () => void {
    let owner = sessions.snapshot();
    return sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (
        current.epoch !== owner.epoch ||
        current.credentials?.accountId !== owner.credentials?.accountId
      ) {
        const actor = owner.credentials?.accountId;
        if (actor) {
          try {
            this.minimize(actor);
          } catch {
            /* Storage damage stays blocking; never clear an unknown publication. */
          }
        }
        owner = current;
      }
    });
  }
  private key(actor: string, kind: 'batch' | 'command'): string {
    return `whaleu.ratings.pending.v12.${kind}:${this.origin}:${id(actor)}`;
  }
  private absent(value: unknown): boolean {
    return value === undefined || value === null || value === '';
  }
  private hydrate(actor: string): void {
    if (this.hydratedActors.has(actor)) return;
    // An in-memory epoch is not durable authority. Anything already on disk at
    // this store's first observation is recovery-only, even if both scrub writes
    // failed before a previous process was killed. No write is needed to revoke
    // full-intent/UI access; only original-key receipt or hash cancellation may
    // settle these records. Empty first observation admits same-process drafts.
    const batch = this.storage.get(this.key(actor, 'batch')),
      command = this.storage.get(this.key(actor, 'command'));
    if (!this.absent(batch) || !this.absent(command))
      this.scrubRequired.add(actor);
    this.hydratedActors.add(actor);
  }
  assertLegacyClear(actor: string): void {
    try {
      for (let version = 1; version <= 11; version++) {
        if (
          !this.absent(
            this.storage.get(
              `whaleu.ratings.pending.v${version}:${this.origin}:${id(actor)}`,
            ),
          )
        )
          throw unavailable();
      }
    } catch {
      throw unavailable();
    }
  }
  isOpaque(actor: string): boolean {
    this.assertLegacyClear(actor);
    this.hydrate(actor);
    const batch = this.storage.get(this.key(actor, 'batch')),
      command = this.storage.get(this.key(actor, 'command'));
    return (
      (this.scrubRequired.has(actor) &&
        (!this.absent(batch) || !this.absent(command))) ||
      (isRecord(batch) && batch.phase === 'batch-opaque') ||
      (isRecord(command) && command.phase === 'command-opaque')
    );
  }
  opaqueRecovery(actor: string): OpaqueRatingDiscussionRecovery {
    try {
      this.assertLegacyClear(actor);
      this.hydrate(actor);
      const b = this.storage.get(this.key(actor, 'batch')),
        c = this.storage.get(this.key(actor, 'command'));
      const batch = this.absent(b) ? null : opaqueBatch(b, actor),
        command = this.absent(c) ? null : opaqueCommand(c, actor);
      if (
        batch &&
        command &&
        (batch.batchRequestId !== command.batchRequestId ||
          batch.commandRequestId !== command.requestId ||
          batch.identityHash !== command.identityHash ||
          batch.batchId !== command.batchId)
      )
        throw unavailable();
      if (command?.batchId && !batch && !command.receipt) throw unavailable();
      return { batch, command };
    } catch {
      throw unavailable();
    }
  }
  minimize(actor: string): void {
    const before = this.opaqueRecovery(actor);
    if (before.command || before.batch) this.scrubRequired.add(actor);
    // Command first: either partial write still blocks fresh full-intent work.
    // Neither key ever contains another actor's body, token, persona or paths.
    let failed = false;
    try {
      if (before.command)
        this.storage.set(this.key(actor, 'command'), before.command);
    } catch {
      failed = true;
    }
    // Still attempt the other original key after a first-key write failure.
    // Either successful opaque write revokes full-intent publication on reload.
    try {
      if (before.batch)
        this.storage.set(this.key(actor, 'batch'), before.batch);
    } catch {
      failed = true;
    }
    if (failed || !same(this.opaqueRecovery(actor), before))
      throw unavailable();
  }
  recordOpaqueReceipt(
    before: OpaqueRatingDiscussionCommand,
    receipt: RatingDiscussionMediaReceipt,
  ): OpaqueRatingDiscussionCommand {
    const current = this.opaqueRecovery(before.accountId);
    if (!same(current.command, before)) throw unavailable();
    matchOpaqueReceipt(before, receipt);
    const value = {
      ...before,
      receipt: decodeRatingDiscussionMediaReceipt(receipt),
    };
    this.storage.set(this.key(before.accountId, 'command'), value);
    if (!same(this.opaqueRecovery(before.accountId).command, value))
      throw unavailable();
    return value;
  }
  settleOpaque(
    before: OpaqueRatingDiscussionRecovery,
    batchRaw: DiscussionBatchRecovery | null,
    nativeComplete: boolean,
  ): void {
    const actor = before.command?.accountId ?? before.batch?.accountId;
    if (!actor || !nativeComplete || !same(this.opaqueRecovery(actor), before))
      throw unavailable();
    const command = before.command,
      batch = before.batch;
    if (command && !command.receipt) throw unavailable();
    const requestId = command?.batchRequestId ?? batch?.batchRequestId,
      identityHash = command?.identityHash ?? batch?.identityHash;
    if (requestId) {
      if (!batchRaw) throw unavailable();
      const response = decodeDiscussionBatchRecovery(batchRaw);
      if (response.batchRequestId !== requestId) throw unavailable();
      if (response.state === 'cancelled_before_prepare') {
        if (
          response.identityHash !== identityHash ||
          (command?.batchId ?? batch?.batchId) !== null ||
          command
        )
          throw unavailable();
      } else if (response.state === 'recorded') {
        const status = response.status;
        if (
          status.batchIdentityHash !== identityHash ||
          status.identity.commandRequestId !==
            (command?.requestId ?? batch?.commandRequestId) ||
          ((command?.batchId ?? batch?.batchId) !== null &&
            status.batchId !== (command?.batchId ?? batch?.batchId))
        )
          throw unavailable();
        if (command?.receipt?.outcome === 'applied') {
          const receipt = command.receipt;
          if (
            status.state !== 'consumed' ||
            status.sealedPlanDigest !== command.sealedPlanDigest ||
            !status.consumedParent ||
            status.consumedParent.targetId !== receipt.result.targetId ||
            status.consumedParent.resourceId !==
              (receipt.operation === 'create_comment_scoped'
                ? receipt.result.subjectId
                : receipt.result.replyId) ||
            (receipt.operation === 'create_reply_scoped' &&
              (status.consumedParent.resourceKind !== 'rating_reply' ||
                status.consumedParent.rootId !== receipt.result.rootId))
          )
            throw unavailable();
        } else if (status.state !== 'cancelled') throw unavailable();
      } else throw unavailable();
    } else if (batchRaw || batch) throw unavailable();
    this.storage.remove(this.key(actor, 'batch'));
    if (!this.absent(this.storage.get(this.key(actor, 'batch'))))
      throw unavailable();
    if (command && !same(this.opaqueRecovery(actor).command, command))
      throw unavailable();
    this.storage.remove(this.key(actor, 'command'));
    if (!this.absent(this.storage.get(this.key(actor, 'command'))))
      throw unavailable();
    this.scrubRequired.delete(actor);
  }
  load(actor: string): {
    batch: PendingRatingDiscussionBatch | null;
    command: PendingRatingDiscussionCommand | null;
  } {
    try {
      this.assertLegacyClear(actor);
      this.hydrate(actor);
      const b = this.storage.get(this.key(actor, 'batch')),
        c = this.storage.get(this.key(actor, 'command'));
      if (this.scrubRequired.has(actor) && (!this.absent(b) || !this.absent(c)))
        throw unavailable();
      const batch = this.absent(b)
        ? null
        : decodePendingRatingDiscussionBatch(b, actor);
      const command = this.absent(c)
        ? null
        : decodePendingRatingDiscussionCommand(c, actor);
      if (batch && command) this.match(batch, command.intent);
      // A receipt-bearing command can remain alone after a crash during later
      // cleanup. A fresh media command cannot silently lose its batch journal.
      if (
        command &&
        command.intent.payload.images.length > 0 &&
        !batch &&
        command.receipt === null
      )
        throw unavailable();
      return { batch, command };
    } catch {
      throw unavailable();
    }
  }
  start(raw: PendingRatingDiscussionBatch): PendingRatingDiscussionBatch {
    const value = decodePendingRatingDiscussionBatch(raw, raw.accountId),
      old = this.load(value.accountId);
    if (
      old.command ||
      old.batch ||
      value.batchId !== null ||
      value.members.length !== 0 ||
      value.orderedMemberIds.length !== 0 ||
      value.sealedPlanDigest !== null
    )
      throw unavailable();
    this.storage.set(this.key(value.accountId, 'batch'), value);
    if (!same(this.load(value.accountId).batch, value)) throw unavailable();
    return value;
  }
  update(
    before: PendingRatingDiscussionBatch,
    raw: PendingRatingDiscussionBatch,
  ): PendingRatingDiscussionBatch {
    const value = decodePendingRatingDiscussionBatch(raw, before.accountId),
      old = this.load(before.accountId);
    if (
      !same(old.batch, before) ||
      old.command ||
      !same(value.identity, before.identity) ||
      value.identityHash !== before.identityHash ||
      (before.batchId !== null && before.batchId !== value.batchId) ||
      (before.sealedPlanDigest !== null && !same(before, value))
    )
      throw unavailable();
    // Removed/retiring members stay in the ledger with their original bytes.
    for (const member of before.members) {
      const next = value.members.find((m) => m.memberId === member.memberId);
      if (
        !next ||
        next.clientRequestId !== member.clientRequestId ||
        next.sourceSlot !== member.sourceSlot ||
        next.requestHash !== member.requestHash ||
        !same(next.declaration, member.declaration) ||
        (member.assetId !== null &&
          (member.assetId !== next.assetId ||
            member.manifestDigest !== next.manifestDigest)) ||
        (member.state === 'retired' && next.state !== 'retired') ||
        (member.state === 'retiring' &&
          next.state !== 'retiring' &&
          next.state !== 'retired')
      )
        throw unavailable();
    }
    this.storage.set(this.key(value.accountId, 'batch'), value);
    if (!same(this.load(value.accountId).batch, value)) throw unavailable();
    return value;
  }
  private match(
    batch: PendingRatingDiscussionBatch,
    intent: RatingDiscussionMediaIntent,
  ): void {
    const i = batch.identity,
      p = intent.payload,
      t = i.target;
    if (
      batch.sealedPlanDigest === null ||
      batch.batchId === null ||
      p.batchId !== batch.batchId ||
      p.batchRequestId !== i.batchRequestId ||
      p.clientRequestId !== i.commandRequestId ||
      p.draftRevision !== i.draftRevision ||
      p.sealedPlanDigest !== batch.sealedPlanDigest ||
      p.categoryId !== i.categoryId ||
      p.expectedCategoryRevision !== i.expectedCategoryRevision ||
      p.targetId !== t.targetId ||
      p.expectedTargetRevision !== t.expectedTargetRevision ||
      p.expectedDefinitionRevision !== t.expectedDefinitionRevision ||
      p.expectedContentVersion !== t.expectedContentVersion ||
      !same(intent.context, i.context) ||
      p.images.length !== batch.orderedMemberIds.length ||
      p.images.some(
        (image, ordinal) =>
          image.memberId !== batch.orderedMemberIds[ordinal] ||
          image.assetId !==
            batch.members.find((m) => m.memberId === image.memberId)?.assetId,
      )
    )
      throw unavailable();
    if (
      intent.operation === 'create_comment_scoped'
        ? t.kind !== 'root'
        : t.kind !== 'reply' ||
          intent.payload.rootId !== t.rootId ||
          intent.payload.expectedRootRevision !== t.expectedRootRevision ||
          !same(intent.payload.replyTo, t.replyTo)
    )
      throw unavailable();
  }
  freezeCommand(
    actor: string,
    raw: RatingDiscussionMediaIntent,
  ): PendingRatingDiscussionCommand {
    const intent = decodeRatingDiscussionMediaIntent(raw),
      old = this.load(actor);
    if (old.command) {
      if (!same(old.command.intent, intent)) throw unavailable();
      return old.command;
    }
    if (intent.payload.images.length > 0) {
      if (!old.batch) throw unavailable();
      this.match(old.batch, intent);
    } else if (old.batch) throw unavailable();
    const value = decodePendingRatingDiscussionCommand(
      {
        version: 12,
        phase: 'command',
        accountId: actor,
        intent,
        receipt: null,
      },
      actor,
    );
    // Batch remains intact if this second write fails. The network owner command
    // may only be sent after the read-back succeeds.
    this.storage.set(this.key(actor, 'command'), value);
    if (!same(this.load(actor).command, value)) throw unavailable();
    return value;
  }
  recordReceipt(
    before: PendingRatingDiscussionCommand,
    receipt: RatingDiscussionMediaReceipt,
  ): PendingRatingDiscussionCommand {
    const old = this.load(before.accountId);
    if (!same(old.command, before)) throw unavailable();
    matchRatingDiscussionMediaReceipt(before.intent, receipt);
    const value = decodePendingRatingDiscussionCommand(
      { ...before, receipt },
      before.accountId,
    );
    this.storage.set(this.key(before.accountId, 'command'), value);
    if (!same(this.load(before.accountId).command, value)) throw unavailable();
    return value;
  }
  settleCommand(
    before: PendingRatingDiscussionCommand,
    batchRaw: DiscussionBatchStatus | null,
    nativeComplete: boolean,
  ): void {
    const current = this.load(before.accountId);
    if (
      !same(current.command, before) ||
      before.receipt === null ||
      !nativeComplete
    )
      throw unavailable();
    const receipt = before.receipt,
      intent = before.intent;
    matchRatingDiscussionMediaReceipt(intent, receipt);
    if (intent.payload.images.length > 0) {
      if (!batchRaw) throw unavailable();
      const batch = decodeDiscussionBatchStatus(batchRaw);
      if (
        batch.batchId !== intent.payload.batchId ||
        batch.identity.batchRequestId !== intent.payload.batchRequestId ||
        batch.identity.commandRequestId !== intent.payload.clientRequestId ||
        batch.sealedPlanDigest !== intent.payload.sealedPlanDigest ||
        batch.batchIdentityHash !==
          ratingDiscussionBatchIdentityHash(before.accountId, batch.identity)
      )
        throw unavailable();
      if (current.batch) {
        this.match(current.batch, intent);
        if (!same(current.batch.identity, batch.identity)) throw unavailable();
      }
      if (receipt.outcome === 'applied') {
        if (
          batch.state !== 'consumed' ||
          !batch.consumedParent ||
          batch.consumedParent.resourceId !==
            (receipt.operation === 'create_comment_scoped'
              ? receipt.result.subjectId
              : receipt.result.replyId) ||
          batch.consumedParent.targetId !== receipt.result.targetId ||
          (receipt.operation === 'create_reply_scoped' &&
            (batch.consumedParent.resourceKind !== 'rating_reply' ||
              batch.consumedParent.rootId !== receipt.result.rootId))
        )
          throw unavailable();
      } else if (batch.state !== 'cancelled') throw unavailable();
    } else if (current.batch || batchRaw) throw unavailable();
    // Persisted receipt first, batch removal second, command removal last. A
    // crash between these writes leaves a receipt-bearing recovery obligation.
    this.storage.remove(this.key(before.accountId, 'batch'));
    if (!this.absent(this.storage.get(this.key(before.accountId, 'batch'))))
      throw unavailable();
    if (!same(this.load(before.accountId).command, before)) throw unavailable();
    this.storage.remove(this.key(before.accountId, 'command'));
    if (!this.absent(this.storage.get(this.key(before.accountId, 'command'))))
      throw unavailable();
  }
  settleAbsentBatchCancellation(
    before: PendingRatingDiscussionBatch,
    raw: DiscussionBatchRecovery,
    nativeComplete: boolean,
  ): void {
    const current = this.load(before.accountId),
      result = decodeDiscussionBatchRecovery(raw);
    if (
      current.command ||
      !same(current.batch, before) ||
      !nativeComplete ||
      before.batchId !== null ||
      before.members.length !== 0 ||
      result.state !== 'cancelled_before_prepare' ||
      result.batchRequestId !== before.identity.batchRequestId ||
      result.identityHash !== before.identityHash
    )
      throw unavailable();
    this.storage.remove(this.key(before.accountId, 'batch'));
    if (this.load(before.accountId).batch !== null) throw unavailable();
  }
  settleBatchCancellation(
    before: PendingRatingDiscussionBatch,
    raw: DiscussionBatchStatus,
    nativeComplete: boolean,
  ): void {
    const current = this.load(before.accountId),
      status = decodeDiscussionBatchStatus(raw);
    if (
      current.command ||
      !same(current.batch, before) ||
      !nativeComplete ||
      status.state !== 'cancelled' ||
      status.batchId !== before.batchId ||
      status.batchIdentityHash !== before.identityHash ||
      !same(status.identity, before.identity)
    )
      throw unavailable();
    this.storage.remove(this.key(before.accountId, 'batch'));
    if (this.load(before.accountId).batch !== null) throw unavailable();
  }
}
