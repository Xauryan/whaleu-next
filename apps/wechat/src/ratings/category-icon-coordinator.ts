import { ClientError } from '../api/errors';
import type { CommunityRuntime } from '../community/runtime';
import type { MediaSession } from '../media/contracts';
import { Cancellation, type Clock } from '../platform/contracts';
import { invalidRating } from './contract';
import { canonicalRatingScopedJson } from './scoped-contract';
import type { RatingCategoryScopedIntent } from './category-scoped-contract';
import { RATING_CATEGORY_SCOPED_DRAFT_BODY_BUDGET } from './category-scoped-contract';
import {
  categoryIconDraftBodyBytes,
  sealCategoryIconDraft,
  type CategoryIconDraftSlot,
} from './category-icon-draft';
import {
  decodeRatingCategoryIconPrepared,
  matchRatingCategoryIconPreparation,
  matchRatingCategoryIconReceipt,
  ratingCategoryIconRequestBodyBytes,
  type RatingCategoryIconPreparation,
  type RatingCategoryIconPrepared,
  type RatingCategoryIconReceipt,
} from './category-icon-contract';
import {
  decodeRatingCategoryIconReceipt,
  decodeRatingCategoryIconRetirementRequest,
  decodeRatingCategoryIconRetirementStatusRequest,
  decodeRatingCategoryIconRetirementStatus,
  decodeRatingCategoryIconRetirementCleanup,
  matchRatingCategoryIconRetirementIds,
  type RatingCategoryIconRetirementRequest,
  type RatingCategoryIconRetirementStatusRequest,
  type RatingCategoryIconRetirementStatus,
  type RatingCategoryIconRetirementCleanup,
} from './category-icon-contract';
import {
  categoryIconPrepareHash,
  type CategoryIconMediaStatus,
} from './category-icon-media-contract';
import {
  categoryIconPrepareForScope,
  categoryIconScopeRequestHash,
  decodeCategoryIconScopeInput,
  type CategoryIconSlot,
} from './category-icon-upload-scope';
import {
  ratingCategoryIconUploadIdentityHash,
  type PendingRatingCategoryIconUploads,
  type PendingRatingCategoryIconCommand,
  type RatingCategoryIconUploadMember,
  type CategoryIconUploadSettlement,
  type CategoryIconUploadObligation,
} from './category-icon-pending';
import {
  CategoryIconUploadWindow,
  type CategoryIconWindowView,
  type CategoryIconUploadEffect,
} from './category-icon-window';
export interface CategoryIconCoordinatorState {
  readonly requestId: string;
  readonly operation: RatingCategoryScopedIntent['operation'];
  readonly opaque: boolean;
  readonly command: PendingRatingCategoryIconCommand | null;
  readonly uploads: PendingRatingCategoryIconUploads | null;
}
/** Coordinates the existing Category editor with the independent v13 journal.
 * Every network effect has a durable identity. Recovery always asks for the
 * original business receipt before any upload status or cancellation. */
export class CategoryIconCoordinator {
  private window: CategoryIconUploadWindow | null = null;
  private selectedSlot: string | null = null;
  constructor(
    private readonly runtime: CommunityRuntime,
    private readonly clock: Clock,
    render: (view: CategoryIconWindowView) => void,
  ) {
    const transfer = runtime.ratingCategoryIconUpload;
    if (transfer)
      this.window = new CategoryIconUploadWindow(
        runtime.sessions,
        transfer.localFiles,
        transfer,
        {
          start: async (file, declaration, session, cancel, progress) => {
            const actor = session.current().credentials?.accountId;
            if (!actor || !this.selectedSlot) invalidRating();
            const uploads = this.store.load(actor).uploads;
            if (!uploads) invalidRating();
            const slot = uploads.identity.slots.find(
              (s) => s.key === this.selectedSlot,
            );
            if (!slot || slot.selection !== 'replace') invalidRating();
            let member = uploads.members.find(
              (m) =>
                m.slotKey === slot.key &&
                m.state !== 'retired' &&
                m.state !== 'retiring',
            );
            if (member?.state === 'ready')
              throw new ClientError('business', 'Icon already uploaded');
            if (member) {
              if (
                canonicalRatingScopedJson(member.scopeInput.declaration) !==
                canonicalRatingScopedJson(declaration)
              )
                throw new ClientError(
                  'business',
                  'Choose the original image bytes to resume this upload',
                );
            } else {
              const requestId = await runtime.newRequestId();
              session.current();
              const inputSlot: CategoryIconSlot =
                slot.nodeKey !== null
                  ? { kind: 'new', key: slot.nodeKey }
                  : slot.kind === 'override'
                    ? {
                        kind: 'override',
                        categoryId: slot.categoryId!,
                        campusId: slot.campusId!,
                      }
                    : { kind: 'base', categoryId: slot.categoryId! };
              const scopeInput = decodeCategoryIconScopeInput({
                ...uploads.identity.textIntent,
                protocolVersion: 5,
                mediaSnapshot: uploads.identity.mediaSnapshot,
                clientRequestId: requestId,
                draftRevision: uploads.identity.draftRevision,
                slot: inputSlot,
                declaration,
              });
              member = {
                memberId: requestId,
                slotKey: slot.key,
                scopeInput,
                scope: null,
                prepare: null,
                status: null,
                state: 'pending',
                assetId: null,
              };
              this.store.update(uploads, {
                ...uploads,
                members: [...uploads.members, member],
              });
            }
            const memberId = member.memberId;
            if (!member.scope) {
              const scope = await this.media.scope(
                member.scopeInput,
                session,
                cancel,
              );
              session.current();
              member = this.changeMember(actor, memberId, (m) => ({
                ...m,
                scope,
                prepare: categoryIconPrepareForScope(m.scopeInput, scope),
              }));
            }
            const prepare = member.prepare!;
            let status = member.status;
            if (!status) {
              const recovery = await this.media.recover(
                prepare.clientRequestId,
                session,
                cancel,
              );
              session.current();
              if (recovery.state === 'cancelled_before_prepare')
                throw new ClientError(
                  'business',
                  'Original upload is cancelled',
                );
              if (recovery.state === 'recorded') {
                if (
                  recovery.requestHash !==
                  categoryIconPrepareHash(actor, prepare)
                )
                  invalidRating();
                status = recovery.status;
              } else
                status = await this.media.prepare(prepare, session, cancel);
              session.current();
            }
            this.matchStatus(actor, member, status);
            if (status.status === 'ready_unbound') {
              return {
                complete: Promise.resolve(),
                result: Promise.resolve(status),
              };
            }
            if (
              status.status === 'uploaded' ||
              status.status === 'processing'
            ) {
              return {
                complete: Promise.resolve(),
                result: this.awaitReady(
                  actor,
                  memberId,
                  status,
                  session,
                  cancel,
                ),
              };
            }
            if (status.status !== 'prepared')
              throw new ClientError(
                'business',
                'Original icon upload is unavailable',
              );
            this.changeMember(actor, memberId, (m) => ({
              ...m,
              status,
              state: 'pending',
            }));
            const grant = await this.media.grant(
              prepare.editScopeId,
              session,
              cancel,
            );
            session.current();
            if (
              grant.editScopeId !== prepare.editScopeId ||
              grant.intentId !== status.intentId ||
              grant.expectedBytes !== declaration.bytes ||
              grant.expectedSha256 !== declaration.sha256 ||
              grant.expectedMime !== declaration.mime
            )
              invalidRating();
            const effect = await transfer.upload(
              grant,
              file,
              session,
              cancel,
              progress,
            );
            const result = effect.result.then(async () => {
              session.current();
              const next = await this.media.finalize(
                prepare.editScopeId,
                session,
                cancel,
              );
              session.current();
              return this.awaitReady(actor, memberId, next, session, cancel);
            });
            return {
              result,
              complete: effect.complete,
            } satisfies CategoryIconUploadEffect;
          },
          ready: (status) => {
            const actor = this.actor(),
              uploads = this.store.load(actor).uploads;
            if (!uploads) invalidRating();
            const member = uploads.members.find(
              (m) =>
                m.scope?.editScopeId === status.editScopeId &&
                m.scopeInput.clientRequestId === status.requestId,
            );
            if (!member) invalidRating();
            this.matchStatus(actor, member, status);
            this.changeMember(actor, member.memberId, (m) => ({
              ...m,
              status,
              state: 'ready',
              assetId: status.assetId,
            }));
          },
        },
        render,
      );
  }
  private get store() {
    if (!this.runtime.pendingRatingCategoryIcon)
      throw new ClientError(
        'configuration',
        'Category icon journal unavailable',
      );
    return this.runtime.pendingRatingCategoryIcon;
  }
  private get gateway() {
    if (!this.runtime.ratingCategoryIcon)
      throw new ClientError(
        'configuration',
        'Category icon gateway unavailable',
      );
    return this.runtime.ratingCategoryIcon;
  }
  private get media() {
    if (!this.runtime.ratingCategoryIconMedia)
      throw new ClientError(
        'configuration',
        'Category icon upload unavailable',
      );
    return this.runtime.ratingCategoryIconMedia;
  }
  private actor() {
    const ticket = this.runtime.sessions.snapshot();
    if (!ticket.credentials)
      throw new ClientError(
        'auth-required',
        'Original Category account required',
      );
    return ticket.credentials.accountId;
  }
  private session(cancel: Cancellation): MediaSession {
    const ticket = this.runtime.sessions.snapshot();
    return {
      current: () => {
        this.runtime.sessions.assertCurrent(ticket);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Category operation changed');
        if (!ticket.credentials)
          throw new ClientError(
            'auth-required',
            'Original Category account required',
          );
        return this.runtime.sessions.snapshot();
      },
    };
  }
  private changeMember(
    actor: string,
    memberId: string,
    change: (
      member: RatingCategoryIconUploadMember,
    ) => RatingCategoryIconUploadMember,
  ): RatingCategoryIconUploadMember {
    const uploads = this.store.load(actor).uploads;
    if (!uploads) invalidRating();
    let result: RatingCategoryIconUploadMember | undefined;
    const members = uploads.members.map((member) =>
      member.memberId === memberId ? (result = change(member)) : member,
    );
    if (!result) invalidRating();
    this.store.update(uploads, { ...uploads, members });
    return result;
  }
  private matchStatus(
    actor: string,
    member: RatingCategoryIconUploadMember,
    status: CategoryIconMediaStatus,
  ) {
    if (
      !member.prepare ||
      status.editScopeId !== member.prepare.editScopeId ||
      status.requestId !== member.scopeInput.clientRequestId ||
      status.requestHash !== categoryIconPrepareHash(actor, member.prepare)
    )
      invalidRating();
  }
  private async awaitReady(
    actor: string,
    memberId: string,
    initial: CategoryIconMediaStatus,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<Extract<CategoryIconMediaStatus, { status: 'ready_unbound' }>> {
    let status = initial;
    while (true) {
      session.current();
      const member = this.store
        .load(actor)
        .uploads?.members.find((m) => m.memberId === memberId);
      if (!member) invalidRating();
      this.matchStatus(actor, member, status);
      if (status.status === 'ready_unbound') return status;
      if (status.status !== 'uploaded' && status.status !== 'processing')
        throw new ClientError('business', 'Original image remains unavailable');
      this.changeMember(actor, memberId, (m) => ({
        ...m,
        status,
        state: 'pending',
      }));
      if (status.status === 'processing')
        await new Promise<void>((resolve, reject) => {
          let stopCancel = () => {};
          const stop = this.clock.schedule(
            () => {
              stopCancel();
              resolve();
            },
            status.status === 'processing' ? status.retryAfterMs : 250,
          );
          stopCancel = cancel.subscribe(() => {
            stop();
            reject(new ClientError('cancelled', 'Processing wait stopped'));
          });
        });
      session.current();
      status = await this.media.finalize(
        member.prepare!.editScopeId,
        session,
        cancel,
      );
    }
  }
  state(): CategoryIconCoordinatorState | null {
    const actor = this.actor();
    if (this.store.isOpaque(actor)) {
      const old = this.store.opaqueRecovery(actor),
        command = old.command,
        uploads = old.uploads;
      if (!command && !uploads) return null;
      return {
        requestId: command?.requestId ?? uploads!.commandRequestId,
        operation: command?.operation ?? 'create_categories_scoped',
        opaque: true,
        command: null,
        uploads: null,
      };
    }
    const { uploads, command } = this.store.load(actor);
    if (!uploads && !command) return null;
    const intent = command?.intent ?? uploads!.identity.textIntent;
    return {
      requestId: intent.payload.clientRequestId,
      operation: intent.operation,
      opaque: false,
      command,
      uploads,
    };
  }
  start(
    textIntent: RatingCategoryScopedIntent,
    mediaSnapshot: string,
    draftRevision: string,
    slots: readonly CategoryIconDraftSlot[],
  ): PendingRatingCategoryIconUploads {
    if (
      categoryIconDraftBodyBytes(textIntent, mediaSnapshot, slots) >
      RATING_CATEGORY_SCOPED_DRAFT_BODY_BUDGET
    )
      throw new ClientError(
        'business',
        'Complete Category draft exceeds body budget',
        { serverCode: 'CATEGORY_DRAFT_TOO_LARGE' },
      );
    const accountId = this.actor(),
      identity = { draftRevision, textIntent, mediaSnapshot, slots };
    return this.store.start({
      version: 13,
      phase: 'uploads',
      accountId,
      identity,
      identityHash: ratingCategoryIconUploadIdentityHash(accountId, identity),
      members: [],
    });
  }
  async append(slotKey: string, cancel: Cancellation): Promise<void> {
    if (!this.window)
      throw new ClientError('configuration', 'Native icon picker unavailable');
    const state = this.state();
    if (!state?.uploads || state.command) invalidRating();
    const count = state.uploads.members.filter(
      (m) => m.state === 'ready',
    ).length;
    this.selectedSlot = slotKey;
    const stop = cancel.subscribe(() => this.window?.hide());
    try {
      await this.window.append(count);
    } finally {
      stop();
      this.selectedSlot = null;
    }
  }
  async prepare(cancel: Cancellation): Promise<RatingCategoryIconPrepared> {
    const actor = this.actor(),
      state = this.state();
    if (!state || state.opaque)
      throw new ClientError(
        'storage',
        'Original Category request requires receipt recovery',
      );
    let command = state.command;
    if (!command) {
      const uploads = state.uploads!;
      const intent = sealCategoryIconDraft(
        uploads.identity.textIntent,
        uploads.identity.mediaSnapshot,
        uploads.identity.slots,
        uploads.members
          .filter((m) => m.state === 'ready' && m.assetId && m.scope)
          .map((m) => ({
            slotKey: m.slotKey,
            assetId: m.assetId!,
            uploadScopeId: m.scope!.editScopeId,
          })),
      );
      if (
        ratingCategoryIconRequestBodyBytes(intent).maximum >
        RATING_CATEGORY_SCOPED_DRAFT_BODY_BUDGET
      )
        throw new ClientError(
          'business',
          'Complete Category intent exceeds body budget',
          { serverCode: 'CATEGORY_DRAFT_TOO_LARGE' },
        );
      command = this.store.freezeCommand(actor, intent);
    }
    if (command.receipt) {
      await this.finish(command.receipt, cancel);
      return command.receipt;
    }
    const result = decodeRatingCategoryIconPrepared(
      await this.gateway.prepare(command.intent, cancel),
    );
    if ('outcome' in result) {
      matchRatingCategoryIconReceipt(command.intent, result);
      await this.finish(result, cancel);
    } else matchRatingCategoryIconPreparation(command.intent, result);
    return result;
  }
  async commit(
    prepared: RatingCategoryIconPreparation,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconReceipt> {
    const command = this.state()?.command;
    if (!command) invalidRating();
    if (Date.parse(prepared.expiresAt) <= this.clock.now())
      throw new ClientError('business', 'Category preview expired');
    matchRatingCategoryIconPreparation(command.intent, prepared);
    const receipt = await this.gateway.commit(command.intent, prepared, cancel);
    await this.finish(receipt, cancel);
    return receipt;
  }
  private async proofs(
    obligations: readonly CategoryIconUploadObligation[],
    cancel: Cancellation,
    cancelling: boolean,
  ): Promise<readonly CategoryIconUploadSettlement[]> {
    const session = this.session(cancel),
      proofs: CategoryIconUploadSettlement[] = [];
    for (const obligation of obligations) {
      session.current();
      const response = await (cancelling
        ? this.media.cancelScope(
            obligation.clientRequestId,
            obligation.scopeRequestHash,
            session,
            cancel,
          )
        : this.media.recoverScope(
            obligation.clientRequestId,
            obligation.scopeRequestHash,
            session,
            cancel,
          ));
      session.current();
      proofs.push({
        clientRequestId: obligation.clientRequestId,
        scopeRequestHash: obligation.scopeRequestHash,
        response,
      });
    }
    return proofs;
  }
  private settled(actor: string): boolean {
    return this.runtime.ratingCategoryIconUpload?.settled(actor) ?? true;
  }
  async finish(
    receipt: RatingCategoryIconReceipt,
    cancel: Cancellation,
  ): Promise<void> {
    const actor = this.actor();
    if (this.store.isOpaque(actor)) {
      const old = this.store.opaqueRecovery(actor);
      if (!old.command) invalidRating();
      const command = this.store.recordOpaqueReceipt(old.command, receipt);
      const proofs = await this.proofs(
        command.obligations,
        cancel,
        receipt.outcome === 'closed',
      );
      this.store.settleOpaque({ ...old, command }, proofs, this.settled(actor));
    } else {
      const old = this.store.load(actor).command;
      if (!old) invalidRating();
      const command = this.store.recordReceipt(old, receipt),
        proofs = await this.proofs(
          command.obligations,
          cancel,
          receipt.outcome === 'closed',
        );
      this.store.settleCommand(command, proofs, this.settled(actor));
    }
  }
  async recover(
    cancel: Cancellation,
  ): Promise<RatingCategoryIconReceipt | null> {
    const state = this.state();
    if (!state) return null;
    // No current context or scope request is made before this original receipt.
    try {
      const receipt = await this.gateway.receipt(state.requestId, cancel);
      if (!state.command && !state.opaque)
        throw new ClientError(
          'protocol',
          'Receipt without sealed original command',
        );
      await this.finish(receipt, cancel);
      return receipt;
    } catch (error) {
      if (
        !(error instanceof ClientError) ||
        error.details.serverCode !== 'REQUEST_NOT_FOUND'
      )
        throw error;
    }
    const actor = this.actor();
    if (state.opaque) {
      const old = this.store.opaqueRecovery(actor);
      await this.proofs(
        old.command?.obligations ?? old.uploads?.obligations ?? [],
        cancel,
        false,
      );
      return null;
    }
    if (state.command) return null;
    const session = this.session(cancel);
    for (const original of state.uploads!.members) {
      if (original.state === 'retired') continue;
      const response = await this.media.recoverScope(
        original.scopeInput.clientRequestId,
        categoryIconScopeRequestHash(original.scopeInput),
        session,
        cancel,
      );
      session.current();
      if (response.state === 'unknown') continue;
      if (response.scope) {
        const scope = response.scope,
          prepare = categoryIconPrepareForScope(original.scopeInput, scope),
          status =
            response.recovery?.state === 'recorded'
              ? response.recovery.status
              : null;
        if (
          !status ||
          status.status === 'ready_unbound' ||
          original.assetId === null
        )
          this.changeMember(actor, original.memberId, (m) => ({
            ...m,
            scope,
            prepare,
            ...(status
              ? {
                  status,
                  state:
                    status.status === 'ready_unbound'
                      ? ('ready' as const)
                      : ('unknown' as const),
                  assetId:
                    status.status === 'ready_unbound'
                      ? status.assetId
                      : m.assetId,
                }
              : {}),
          }));
      }
    }
    return null;
  }
  async cancel(
    cancel: Cancellation,
  ): Promise<RatingCategoryIconReceipt | null> {
    const state = this.state();
    if (!state) return null;
    const recovered = await this.recover(cancel);
    if (recovered) return recovered;
    const actor = this.actor();
    if (state.opaque) {
      const old = this.store.opaqueRecovery(actor);
      if (old.command) {
        const receipt = await this.gateway.cancelByHash(
          old.command.requestId,
          old.command.operation,
          old.command.intentHash,
          cancel,
        );
        await this.finish(receipt, cancel);
        return receipt;
      }
      const proofs = await this.proofs(old.uploads!.obligations, cancel, true);
      this.store.settleOpaque(old, proofs, this.settled(actor));
      return null;
    }
    const current = this.state()!;
    if (current.command) {
      const receipt = await this.gateway.cancel(current.command.intent, cancel);
      await this.finish(receipt, cancel);
      return receipt;
    }
    const uploads = current.uploads!,
      session = this.session(cancel),
      proofs: CategoryIconUploadSettlement[] = [];
    for (const member of uploads.members) {
      const requestHash = categoryIconScopeRequestHash(member.scopeInput),
        response = await this.media.cancelScope(
          member.scopeInput.clientRequestId,
          requestHash,
          session,
          cancel,
        );
      proofs.push({
        clientRequestId: member.scopeInput.clientRequestId,
        scopeRequestHash: requestHash,
        response,
      });
    }
    this.store.settleUploadsCancellation(uploads, proofs, this.settled(actor));
    return null;
  }
  /** This read is independent of upload settlement and never rewrites journal v13.
   * Request-only status restores the server's exact queue after a native restart. */
  async inspectRetirement(
    raw: RatingCategoryIconRetirementStatusRequest,
    cancel: Cancellation,
    onReceipt?: (receipt: RatingCategoryIconReceipt) => void,
  ): Promise<{
    readonly receipt: RatingCategoryIconReceipt;
    readonly status: RatingCategoryIconRetirementStatus;
  }> {
    const request = decodeRatingCategoryIconRetirementStatusRequest(raw),
      session = this.session(cancel);
    session.current();
    const receipt = decodeRatingCategoryIconReceipt(
      await this.gateway.receipt(request.requestId, cancel),
    );
    session.current();
    if (receipt.requestId !== request.requestId) invalidRating();
    if (receipt.outcome !== 'applied')
      throw new ClientError(
        'business',
        'Only an applied original Category request can inspect old appearances',
        { serverCode: 'CATEGORY_ICON_RETIREMENT_NOT_APPLIED' },
      );
    // Business success remains authoritative even if the independent current
    // authorization/status read below is held, unavailable or loses its response.
    onReceipt?.(receipt);
    const status = decodeRatingCategoryIconRetirementStatus(
      await this.gateway.retirementStatus(request, cancel),
    );
    session.current();
    if ('appearanceIds' in request)
      matchRatingCategoryIconRetirementIds(
        request.appearanceIds,
        status.items.map((item) => item.appearanceId),
      );
    return { receipt, status };
  }
  /** Explicit cleanup rechecks the original receipt and current eligibility.
   * A queued cleanup is not proof that any object has physically been erased. */
  async cleanupRetirement(
    raw: RatingCategoryIconRetirementRequest,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconRetirementCleanup> {
    const request = decodeRatingCategoryIconRetirementRequest(raw),
      session = this.session(cancel);
    session.current();
    const { status } = await this.inspectRetirement(request, cancel);
    session.current();
    if (status.items.some((item) => item.state !== 'eligible'))
      throw new ClientError(
        'business',
        'Original appearances are currently held or already retired',
        { serverCode: 'CATEGORY_ICON_RETIREMENT_HELD' },
      );
    const result = decodeRatingCategoryIconRetirementCleanup(
      await this.gateway.cleanupRetirement(request, cancel),
    );
    session.current();
    matchRatingCategoryIconRetirementIds(
      request.appearanceIds,
      result.appearanceIds,
    );
    return result;
  }
  hide(): void {
    this.window?.hide();
    this.selectedSlot = null;
  }
  dispose(): void {
    this.window?.dispose();
    this.window = null;
  }
}
