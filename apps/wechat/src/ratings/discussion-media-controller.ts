import { ClientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { Cancellation } from '../platform/contracts';
import { canonicalRatingText, invalidRating } from './contract';
import { canonicalRatingScopedJson } from './scoped-contract';
import {
  decodeRatingDiscussionMediaIntent,
  matchRatingDiscussionMediaReceipt,
  ratingDiscussionMediaCommandContext,
  type RatingDiscussionMediaContext,
  type RatingDiscussionMediaReceipt,
} from './discussion-media-contract';
import {
  decodeRatingDiscussionBatchIdentity,
  ratingDiscussionBatchIdentityHash,
  ratingDiscussionMemberRequestHash,
  type RatingDiscussionBatchIdentity,
  type RatingDiscussionMember,
} from './discussion-media-batch-contract';
import {
  PendingRatingDiscussionMediaStore,
  type PendingRatingDiscussionBatch,
} from './discussion-media-pending';
import {
  RatingDiscussionUploadWindow,
  type RatingDiscussionInspected,
  type RatingDiscussionWindowView,
} from './discussion-media-window';
import type { DiscussionUploadTransfer } from './discussion-media-upload';
import type { RatingDiscussionMediaGateway } from './discussion-media-gateway';
import type { DiscussionComposerContext } from './discussion-media-read-contract';
import {
  RATING_DISCUSSION_WIRE_PROTOCOL as protocol,
  type DiscussionBatchStatus,
  type DiscussionBatchRecovery,
  type DiscussionMemberStatus,
} from './discussion-media-wire';
export interface DiscussionEditorView {
  readonly status:
    'idle' | 'editing' | 'busy' | 'pending' | 'settled' | 'unavailable';
  readonly selected: readonly {
    readonly memberId: string;
    readonly ready: boolean;
  }[];
  readonly upload: RatingDiscussionWindowView;
  readonly message: string;
  readonly frozen: boolean;
}
export const initialDiscussionEditor = (): DiscussionEditorView => ({
  status: 'idle',
  selected: [],
  upload: { active: false, progress: 0, completedMembers: 0, status: 'idle' },
  message: '',
  frozen: false,
});
/** One v12 branch of the original Ratings journal. Batch metadata never issues
 * publication; only prepare/commit on original ScopedCommands can do that. */
export class RatingDiscussionMediaController {
  private owner: SessionTicket;
  private generation = 0;
  private active = false;
  private disposed = false;
  private cancellation = new Cancellation();
  private window: RatingDiscussionUploadWindow | undefined;
  private view = initialDiscussionEditor();
  private readonly unsubscribe: () => void;
  private scope: {
    context: RatingDiscussionMediaContext;
    composer: DiscussionComposerContext;
    replyTo: { replyId: string; expectedRevision: string } | null;
  } | null = null;
  constructor(
    private readonly sessions: SessionStore,
    private readonly pending: PendingRatingDiscussionMediaStore,
    private readonly gateway: RatingDiscussionMediaGateway,
    private readonly transfer: DiscussionUploadTransfer | undefined,
    private readonly newRequestId: () => Promise<string>,
    private readonly render: (view: DiscussionEditorView) => void,
    private readonly changed?: (receipt: RatingDiscussionMediaReceipt) => void,
  ) {
    this.owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const now = sessions.snapshot();
      if (
        now.epoch !== this.owner.epoch ||
        now.credentials?.accountId !== this.owner.credentials?.accountId
      ) {
        const previous = this.owner.credentials?.accountId;
        if (previous) {
          try {
            this.pending.minimize(previous);
          } catch {
            /* Failed scrub retains an unreadable blocking obligation, never B authority. */
          }
        }
        this.hide();
        this.owner = now;
      }
    });
    if (transfer)
      this.window = new RatingDiscussionUploadWindow(
        sessions,
        transfer.localFiles,
        transfer,
        {
          start: (file, declaration, session, cancel, progress) =>
            this.startMember(file, declaration, session, cancel, progress),
          ready: (member) => this.observeReady(member),
        },
        (upload) => this.emit({ ...this.view, upload }),
      );
  }
  snapshot(): DiscussionEditorView {
    return this.view;
  }
  private emit(view: DiscussionEditorView): void {
    this.view = Object.freeze(view);
    this.render(this.view);
  }
  private actor(): string {
    const id = this.sessions.snapshot().credentials?.accountId;
    if (!id)
      throw new ClientError(
        'auth-required',
        'Original Ratings account required',
      );
    return id;
  }
  private state() {
    return this.pending.load(this.actor());
  }
  private commandPending(): boolean {
    try {
      return this.state().command !== null;
    } catch {
      return true;
    }
  }
  private renderState(message = ''): void {
    const state = this.state();
    this.emit({
      ...this.view,
      status: state.command ? 'pending' : state.batch ? 'editing' : 'idle',
      frozen: !!state.command,
      selected:
        state.batch?.orderedMemberIds.map((memberId) => ({
          memberId,
          ready:
            state.batch!.members.find((m) => m.memberId === memberId)?.state ===
            'ready',
        })) ?? [],
      message,
    });
  }
  configure(
    context: RatingDiscussionMediaContext,
    composer: DiscussionComposerContext,
    replyTo: { replyId: string; expectedRevision: string } | null,
  ): void {
    ratingDiscussionMediaCommandContext(context);
    if (composer.contextId !== context.id || context.actorId !== this.actor())
      invalidRating();
    const previous = this.state();
    if (previous.command)
      throw new ClientError(
        'business',
        'Recover the original Ratings intent first',
      );
    if (previous.batch) {
      const i = previous.batch.identity,
        t = i.target;
      if (
        i.categoryId !== composer.categoryId ||
        i.expectedCategoryRevision !== composer.categoryRevision ||
        t.targetId !== composer.targetId ||
        t.expectedTargetRevision !== composer.targetRevision ||
        t.expectedDefinitionRevision !== composer.definitionRevision ||
        t.expectedContentVersion !== composer.contentVersion ||
        (t.kind === 'reply'
          ? composer.root?.id !== t.rootId ||
            composer.root.revision !== t.expectedRootRevision ||
            canonicalRatingScopedJson(t.replyTo) !==
              canonicalRatingScopedJson(replyTo)
          : composer.root !== null) ||
        i.context.protocolGeneration !== context.protocolGeneration ||
        i.context.sourceDigest !== context.sourceDigest ||
        canonicalRatingScopedJson(i.context.selector) !==
          canonicalRatingScopedJson(context.selector)
      )
        invalidRating();
    }
    this.scope = { context, composer, replyTo };
    this.renderState();
  }
  private session(
    ticket: SessionTicket,
    generation: number,
    cancel: Cancellation,
  ): MediaSession {
    return {
      current: () => {
        this.sessions.assertCurrent(ticket);
        if (
          this.disposed ||
          generation !== this.generation ||
          cancel.isCancelled
        )
          throw new ClientError('cancelled', 'Discussion changed');
        return this.sessions.snapshot();
      },
    };
  }
  private async run(
    work: (session: MediaSession, cancel: Cancellation) => Promise<void>,
  ): Promise<void> {
    if (this.active || this.disposed) return;
    this.active = true;
    const ticket = this.sessions.snapshot(),
      generation = ++this.generation,
      cancel = (this.cancellation = new Cancellation()),
      session = this.session(ticket, generation, cancel);
    this.emit({ ...this.view, status: 'busy', message: '' });
    try {
      await work(session, cancel);
      session.current();
    } catch {
      if (!cancel.isCancelled && generation === this.generation) {
        this.emit({
          ...this.view,
          status: 'pending',
          frozen: this.commandPending(),
          message: '原请求尚待确认，请恢复或明确取消；不会另发一条',
        });
      }
    } finally {
      if (generation === this.generation) this.active = false;
    }
  }
  private async identity(
    session: MediaSession,
  ): Promise<RatingDiscussionBatchIdentity> {
    if (!this.scope)
      throw new ClientError('business', 'Current discussion composer required');
    const { context, composer, replyTo } = this.scope,
      commandRequestId = await this.newRequestId(),
      batchRequestId = await this.newRequestId(),
      draftRevision = await this.newRequestId();
    session.current();
    const target = {
      targetId: composer.targetId,
      expectedTargetRevision: composer.targetRevision,
      expectedDefinitionRevision: composer.definitionRevision,
      expectedContentVersion: composer.contentVersion,
    };
    return decodeRatingDiscussionBatchIdentity({
      protocol,
      batchRequestId,
      commandRequestId,
      draftRevision,
      categoryId: composer.categoryId,
      expectedCategoryRevision: composer.categoryRevision,
      context: ratingDiscussionMediaCommandContext(context),
      target: composer.root
        ? {
            ...target,
            kind: 'reply',
            rootId: composer.root.id,
            expectedRootRevision: composer.root.revision,
            replyTo,
          }
        : { ...target, kind: 'root' },
    });
  }
  private original(): PendingRatingDiscussionBatch {
    const value = this.state();
    if (!value.batch || value.command)
      throw new ClientError('storage', 'Original editable batch required');
    return value.batch;
  }
  private async serverBatch(
    original: PendingRatingDiscussionBatch,
    session: MediaSession,
    cancel: Cancellation,
    create = false,
  ): Promise<DiscussionBatchStatus> {
    const recovery = await this.gateway.recoverBatch(
      original.identity.batchRequestId,
      session,
      cancel,
    );
    session.current();
    if (recovery.batchRequestId !== original.identity.batchRequestId)
      invalidRating();
    const status =
      recovery.state === 'recorded'
        ? recovery.status
        : recovery.state === 'not_recorded' && create
          ? await this.gateway.batch(original.identity, session, cancel)
          : null;
    if (!status)
      throw new ClientError(
        'network',
        'Batch absence does not cancel the original intent',
      );
    this.gateway.matchBatch(original.identity, status, session);
    if (original.batchId !== null && original.batchId !== status.batchId)
      invalidRating();
    if (original.batchId === null)
      this.pending.update(original, { ...original, batchId: status.batchId });
    return status;
  }
  async append(): Promise<void> {
    if (this.active || !this.window || !this.transfer) {
      this.emit({
        ...this.view,
        message: '当前设备图片选择暂不可用，或上一张仍在结束处理中',
      });
      return;
    }
    await this.run(async (session, cancel) => {
      if (this.state().command) return;
      let original = this.state().batch;
      if (!original) {
        const identity = await this.identity(session);
        original = this.pending.start({
          version: 12,
          phase: 'batch',
          accountId: this.actor(),
          identity,
          identityHash: ratingDiscussionBatchIdentityHash(
            this.actor(),
            identity,
          ),
          batchId: null,
          members: [],
          orderedMemberIds: [],
          sealedPlanDigest: null,
        });
      }
      if (original.sealedPlanDigest !== null)
        throw new ClientError(
          'business',
          'Original sealed draft cannot change',
        );
      await this.serverBatch(original, session, cancel, true);
      session.current();
      original = this.original();
      if (
        original.members.some(
          (m) =>
            m.state === 'pending' ||
            m.state === 'unknown' ||
            m.state === 'retiring',
        )
      )
        throw new ClientError('business', 'Recover the original member first');
      try {
        await this.window!.append(
          original.identity.target.kind,
          original.orderedMemberIds.length,
        );
      } finally {
        try {
          session.current();
          this.renderState();
        } catch {
          /* Hidden UI has no projection authority. */
        }
      }
    });
  }
  private async startMember(
    file: LocalMediaFile,
    declaration: RatingDiscussionInspected,
    session: MediaSession,
    cancel: Cancellation,
    progress: (percent: number) => void,
  ) {
    const original = this.original();
    if (!this.transfer || !original.batchId || original.members.length >= 128)
      throw new ClientError('business', 'Original batch capacity unavailable');
    const memberId = await this.newRequestId(),
      clientRequestId = await this.newRequestId();
    session.current();
    const sourceSlot =
      original.members.length === 0
        ? 0
        : Math.max(...original.members.map((m) => m.sourceSlot)) + 1;
    const base = { memberId, clientRequestId, sourceSlot, declaration };
    const member: RatingDiscussionMember = {
      ...base,
      requestHash: ratingDiscussionMemberRequestHash(
        original.accountId,
        original.batchId,
        original.identityHash,
        base,
      ),
      state: 'pending',
      assetId: null,
      manifestDigest: null,
    };
    this.pending.update(original, {
      ...original,
      members: [...original.members, member],
      orderedMemberIds: [...original.orderedMemberIds, memberId],
    });
    const status = await this.gateway.prepareMember(
      {
        protocol,
        clientRequestId,
        batchId: original.batchId,
        batchIdentityHash: original.identityHash,
        memberId,
        sourceSlot,
        declaration,
      },
      session,
      cancel,
    );
    this.matchMember(original, member, status);
    if (status.status !== 'prepared' || status.upload !== 'none')
      throw new ClientError(
        'network',
        'Original member requires status recovery',
      );
    const grant = await this.gateway.grant(memberId, session, cancel);
    session.current();
    if (
      grant.batchId !== original.batchId ||
      grant.memberId !== memberId ||
      grant.intentId !== status.intentId ||
      grant.expectedSha256 !== declaration.sha256 ||
      grant.expectedBytes !== declaration.bytes ||
      grant.expectedMime !== declaration.mime
    )
      invalidRating();
    const effect = await this.transfer.upload(
      grant,
      file,
      session,
      cancel,
      progress,
    );
    return {
      complete: effect.complete,
      result: effect.result.then(async () => {
        session.current();
        const ready = await this.gateway.finalize(memberId, session, cancel);
        session.current();
        this.matchMember(original, member, ready);
        if (ready.status !== 'ready_unbound')
          throw new ClientError('network', 'Original image still processing');
        return {
          ...member,
          state: 'ready' as const,
          assetId: ready.assetId,
          manifestDigest: ready.manifestDigest,
        };
      }),
    };
  }
  private matchMember(
    batch: PendingRatingDiscussionBatch,
    member: RatingDiscussionMember,
    status: DiscussionMemberStatus,
  ): void {
    if (
      status.batchId !== batch.batchId ||
      status.memberId !== member.memberId ||
      status.requestId !== member.clientRequestId ||
      status.requestHash !== member.requestHash ||
      (member.assetId !== null &&
        (status.status === 'ready_unbound' ||
          status.status === 'bound_history') &&
        status.assetId !== member.assetId) ||
      (member.manifestDigest !== null &&
        status.status === 'ready_unbound' &&
        status.manifestDigest !== member.manifestDigest)
    )
      invalidRating();
  }
  private observeReady(member: RatingDiscussionMember): void {
    const original = this.original(),
      before = original.members.find((m) => m.memberId === member.memberId);
    if (!before || before.requestHash !== member.requestHash) invalidRating();
    this.pending.update(original, {
      ...original,
      members: original.members.map((m) =>
        m.memberId === member.memberId ? member : m,
      ),
    });
    this.renderState();
  }
  async reorder(memberId: string, direction: -1 | 1): Promise<void> {
    const original = this.original();
    if (this.active || original.sealedPlanDigest) return;
    const ids = [...original.orderedMemberIds],
      index = ids.indexOf(memberId),
      next = index + direction;
    if (index < 0 || next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next]!, ids[index]!];
    this.pending.update(original, { ...original, orderedMemberIds: ids });
    this.renderState();
  }
  async remove(memberId: string): Promise<void> {
    await this.run(async (session, cancel) => {
      let original = this.original();
      if (original.sealedPlanDigest)
        throw new ClientError('business', 'Sealed set cannot change');
      const member = original.members.find((m) => m.memberId === memberId);
      if (!member) invalidRating();
      const status = await this.serverBatch(original, session, cancel);
      session.current();
      const recovered = await this.gateway.recoverMember(
        member.clientRequestId,
        session,
        cancel,
      );
      session.current();
      if (
        recovered.requestId !== member.clientRequestId ||
        (recovered.state !== 'not_recorded' &&
          recovered.requestHash !== member.requestHash)
      )
        invalidRating();
      if (recovered.state === 'not_recorded') {
        const fenced = await this.gateway.cancelMemberRequest(
          member.clientRequestId,
          member.requestHash,
          session,
          cancel,
        );
        session.current();
        if (
          fenced.state !== 'cancelled_before_prepare' ||
          fenced.requestId !== member.clientRequestId ||
          fenced.requestHash !== member.requestHash
        )
          throw new ClientError(
            'network',
            'Original absent member cancellation still unknown',
          );
      } else if (recovered.state === 'recorded') {
        this.matchMember(original, member, recovered.status);
        const result = await this.gateway.mutateBatch(
          status,
          'remove',
          session,
          cancel,
          undefined,
          memberId,
        );
        session.current();
        this.gateway.matchBatch(original.identity, result, session);
        if (
          !result.members.some(
            (m) => m.memberId === memberId && m.state === 'removed',
          )
        )
          invalidRating();
      }
      original = this.original();
      this.pending.update(original, {
        ...original,
        members: original.members.map((m) =>
          m.memberId === memberId ? { ...m, state: 'retired' as const } : m,
        ),
        orderedMemberIds: original.orderedMemberIds.filter(
          (id) => id !== memberId,
        ),
      });
      this.renderState();
    });
  }
  async publish(
    bodyRaw: string,
    authorMode: 'named' | 'anonymous',
  ): Promise<void> {
    await this.run(async (session, cancel) => {
      const body = canonicalRatingText(bodyRaw, 500, false);
      if (!this.scope || !this.scope.composer.authorModes.includes(authorMode))
        invalidRating();
      if (this.state().command)
        throw new ClientError('business', 'Recover the original publication');
      let original = this.state().batch;
      const identity = original?.identity ?? (await this.identity(session));
      session.current();
      if (original) {
        if (original.orderedMemberIds.length === 0)
          throw new ClientError(
            'business',
            'Cancel the empty original batch first',
          );
        let status = await this.serverBatch(original, session, cancel);
        session.current();
        if (status.state === 'editing')
          status = await this.gateway.mutateBatch(
            status,
            'seal',
            session,
            cancel,
            original.orderedMemberIds,
          );
        session.current();
        this.gateway.matchBatch(original.identity, status, session);
        if (status.state !== 'sealed' || !status.sealedPlanDigest)
          invalidRating();
        original = this.original();
        if (!original.sealedPlanDigest)
          original = this.pending.update(original, {
            ...original,
            sealedPlanDigest: status.sealedPlanDigest,
          });
      }
      const target = identity.target,
        payload = {
          clientRequestId: identity.commandRequestId,
          categoryId: identity.categoryId,
          expectedCategoryRevision: identity.expectedCategoryRevision,
          targetId: target.targetId,
          expectedTargetRevision: target.expectedTargetRevision,
          expectedDefinitionRevision: target.expectedDefinitionRevision,
          expectedContentVersion: target.expectedContentVersion,
          draftRevision: identity.draftRevision,
          batchRequestId: original ? identity.batchRequestId : null,
          batchId: original?.batchId ?? null,
          sealedPlanDigest: original?.sealedPlanDigest ?? null,
          authorMode,
          body,
          images:
            original?.orderedMemberIds.map((memberId, ordinal) => ({
              ordinal,
              memberId,
              assetId: original!.members.find((m) => m.memberId === memberId)!
                .assetId,
            })) ?? [],
        };
      const intent = decodeRatingDiscussionMediaIntent({
        protocolVersion: 4,
        context: identity.context,
        operation:
          target.kind === 'root'
            ? 'create_comment_scoped'
            : 'create_reply_scoped',
        payload:
          target.kind === 'root'
            ? payload
            : {
                ...payload,
                rootId: target.rootId,
                expectedRootRevision: target.expectedRootRevision,
                replyTo: target.replyTo,
              },
      });
      this.pending.freezeCommand(this.actor(), intent);
      await this.command('commit', session, cancel);
    });
  }
  async recover(
    action: 'receipt' | 'retry' | 'cancel' = 'receipt',
  ): Promise<void> {
    await this.run(async (session, cancel) => {
      if (this.pending.isOpaque(this.actor())) {
        await this.recoverOpaque(action, session, cancel);
        return;
      }
      const state = this.state();
      // The business key is always checked before any batch recovery, even when
      // a crash occurred before the second journal write.
      if (state.command) {
        await this.command(
          action === 'retry' ? 'commit' : action,
          session,
          cancel,
        );
        return;
      }
      if (!state.batch) {
        this.renderState();
        return;
      }
      let receipt: RatingDiscussionMediaReceipt | null = null;
      try {
        receipt = await this.gateway.receipt(
          state.batch.identity.commandRequestId,
          cancel,
        );
      } catch (error) {
        session.current();
        if (
          !(error instanceof ClientError) ||
          error.details.serverCode !== 'REQUEST_NOT_FOUND'
        )
          throw error;
      }
      if (receipt)
        throw new ClientError(
          'storage',
          'A business receipt exists without its exact command journal',
        );
      const recovered =
        action === 'cancel'
          ? await this.gateway.cancelBatchRequest(
              state.batch.identity.batchRequestId,
              state.batch.identityHash,
              session,
              cancel,
            )
          : await this.gateway.recoverBatch(
              state.batch.identity.batchRequestId,
              session,
              cancel,
            );
      session.current();
      if (recovered.batchRequestId !== state.batch.identity.batchRequestId)
        invalidRating();
      if (recovered.state === 'cancelled_before_prepare') {
        this.pending.settleAbsentBatchCancellation(
          state.batch,
          recovered,
          this.transfer?.settled(this.actor()) ?? true,
        );
        this.scope = null;
        this.renderState('原图片批次已在准备前明确取消');
        return;
      }
      if (recovered.state !== 'recorded')
        throw new ClientError(
          'network',
          'Original batch absence is not cancellation',
        );
      let status = recovered.status;
      this.gateway.matchBatch(state.batch.identity, status, session);
      let original = this.original();
      if (original.batchId === null)
        original = this.pending.update(original, {
          ...original,
          batchId: status.batchId,
        });
      else if (original.batchId !== status.batchId) invalidRating();
      if (action === 'cancel' || status.state === 'cancelled') {
        if (status.state !== 'cancelled')
          status = await this.gateway.mutateBatch(
            status,
            'cancel',
            session,
            cancel,
          );
        session.current();
        this.pending.settleBatchCancellation(
          original,
          status,
          this.transfer?.settled(this.actor()) ?? true,
        );
        this.scope = null;
        this.renderState('原图片批次已明确取消');
        return;
      }
      if (status.state !== 'editing' && status.state !== 'sealed')
        throw new ClientError(
          'network',
          'Original batch requires explicit settlement',
        );
      for (const member of original.members) {
        if (member.state === 'retired') continue;
        const recovered = await this.gateway.recoverMember(
          member.clientRequestId,
          session,
          cancel,
        );
        session.current();
        if (
          recovered.state !== 'recorded' ||
          recovered.requestHash !== member.requestHash
        )
          throw new ClientError(
            'network',
            'Missing original bytes require cancelling this member before choosing again',
          );
        let current = recovered.status;
        this.matchMember(original, member, current);
        if (current.status === 'uploaded' || current.status === 'processing')
          current = await this.gateway.finalize(
            member.memberId,
            session,
            cancel,
          );
        session.current();
        this.matchMember(original, member, current);
        if (current.status === 'ready_unbound' && member.state !== 'ready') {
          this.observeReady({
            ...member,
            state: 'ready',
            assetId: current.assetId,
            manifestDigest: current.manifestDigest,
          });
          original = this.original();
        } else if (current.status !== 'ready_unbound')
          throw new ClientError(
            'network',
            'Original member remains unresolved; original bytes are not retained after restart',
          );
      }
      if (status.state === 'sealed' && !original.sealedPlanDigest)
        this.pending.update(original, {
          ...original,
          sealedPlanDigest: status.sealedPlanDigest,
        });
      this.renderState('原图片已恢复；重新核验范围后补充正文或明确取消');
    });
  }
  private async recoverOpaque(
    action: 'receipt' | 'retry' | 'cancel',
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<void> {
    const actor = this.actor();
    let original = this.pending.opaqueRecovery(actor),
      command = original.command;
    if (!command && !original.batch) {
      this.emit(initialDiscussionEditor());
      return;
    }
    const requestId = command?.requestId ?? original.batch!.commandRequestId;
    let receipt: RatingDiscussionMediaReceipt | null = null;
    // Opaque/cold recovery always observes the original business receipt first,
    // including when a previous process saved a terminal receipt. An unknown
    // response cannot authorize a cancel or discard that persisted evidence.
    try {
      receipt = await this.gateway.receipt(requestId, cancel);
    } catch (error) {
      session.current();
      if (
        !(error instanceof ClientError) ||
        error.details.serverCode !== 'REQUEST_NOT_FOUND'
      )
        throw error;
      if (command?.receipt)
        throw new ClientError(
          'network',
          'Persisted original receipt is not currently confirmed',
        );
      if (command && action === 'cancel')
        receipt = await this.gateway.cancelByHash(
          command.requestId,
          command.operation,
          command.intentHash,
          cancel,
        );
    }
    if (
      command?.receipt &&
      canonicalRatingScopedJson(command.receipt) !==
        canonicalRatingScopedJson(receipt)
    )
      invalidRating();
    session.current();
    if (command) {
      if (!receipt)
        throw new ClientError(
          'network',
          'Opaque original may only be recovered or explicitly cancelled; publication cannot be retried',
        );
      if (!command.receipt)
        command = this.pending.recordOpaqueReceipt(command, receipt);
      original = this.pending.opaqueRecovery(actor);
    } else if (receipt)
      throw new ClientError(
        'storage',
        'Foreign business receipt requires its exact original command proof',
      );
    const batchRequestId =
        command?.batchRequestId ?? original.batch?.batchRequestId,
      identityHash = command?.identityHash ?? original.batch?.identityHash;
    let recovered: DiscussionBatchRecovery | null = null;
    if (batchRequestId && identityHash) {
      recovered =
        receipt?.outcome === 'closed' || (action === 'cancel' && !receipt)
          ? await this.gateway.cancelBatchRequest(
              batchRequestId,
              identityHash,
              session,
              cancel,
            )
          : await this.gateway.recoverBatch(batchRequestId, session, cancel);
      session.current();
    }
    this.pending.settleOpaque(
      original,
      recovered,
      this.transfer?.settled(actor) ?? true,
    );
    this.emit({
      ...initialDiscussionEditor(),
      status: 'settled',
      message:
        receipt?.outcome === 'applied'
          ? '原发布已确认；未重复上传或发布'
          : '原请求已明确结束',
    });
    if (receipt) this.changed?.(receipt);
  }
  private async command(
    action: 'receipt' | 'commit' | 'cancel',
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<void> {
    let current = this.state().command;
    if (!current)
      throw new ClientError('storage', 'Original command journal required');
    let receipt = current.receipt;
    if (!receipt) {
      try {
        receipt = await this.gateway.receipt(
          current.intent.payload.clientRequestId,
          cancel,
        );
      } catch (error) {
        session.current();
        if (
          action === 'receipt' ||
          !(error instanceof ClientError) ||
          error.details.serverCode !== 'REQUEST_NOT_FOUND'
        )
          throw error;
      }
    }
    session.current();
    if (!receipt)
      receipt =
        action === 'cancel'
          ? await this.gateway.cancelCommand(current.intent, cancel)
          : await this.gateway.command(current.intent, cancel);
    session.current();
    matchRatingDiscussionMediaReceipt(current.intent, receipt);
    if (!current.receipt)
      current = this.pending.recordReceipt(current, receipt);
    let batch: DiscussionBatchStatus | null = null;
    if (current.intent.payload.batchId) {
      batch = await this.gateway.statusBatch(
        current.intent.payload.batchId,
        session,
        cancel,
      );
      session.current();
      if (receipt.outcome === 'closed' && batch.state !== 'cancelled')
        batch = await this.gateway.mutateBatch(
          batch,
          'cancel',
          session,
          cancel,
        );
      session.current();
    }
    this.pending.settleCommand(
      current,
      batch,
      this.transfer?.settled(this.actor()) ?? true,
    );
    this.scope = null;
    this.emit({
      ...initialDiscussionEditor(),
      status: 'settled',
      message:
        receipt.outcome === 'applied'
          ? '正文与完整图片集合已共同发布'
          : '原发布请求已明确结束',
    });
    this.changed?.(receipt);
  }
  hide(): void {
    ++this.generation;
    this.cancellation.cancel();
    this.window?.hide();
    this.transfer?.clearSession(this.owner);
    this.scope = null;
    this.active = false;
    this.emit(initialDiscussionEditor());
  }
  dispose(): void {
    this.hide();
    this.disposed = true;
    this.unsubscribe();
    this.window?.dispose();
  }
}
