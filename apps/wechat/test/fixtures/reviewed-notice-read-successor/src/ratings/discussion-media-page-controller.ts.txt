import { ratingDeletionPath } from './deletion-contract';
import { runRatingCommand, settleRatingCommand } from './commands';
import {
  decodeRatingScopedIntent,
  ratingScopedCommandContext,
  canonicalRatingScopedJson,
  type RatingScopedContext,
} from './scoped-contract';
import type { RatingLikeState } from './like-contract';
import type { RatingSubscriptionState } from './subscription-contract';
import type { CommunityRuntime } from '../community/runtime';
import { ClientError, isRecord } from '../api/errors';
import { Cancellation, type Clock } from '../platform/contracts';
import { systemClock } from '../platform/clock';
import { invalidRating, ratingId } from './contract';
import {
  decodeRatingNavigationSelector,
  type RatingNavigationSelector,
} from './scoped-contract';
import { RatingDiscussionMediaContextLease } from './discussion-media-context';
import type { RatingDiscussionMediaContext } from './discussion-media-contract';
import {
  RatingDiscussionMediaController,
  initialDiscussionEditor,
  type DiscussionEditorView,
} from './discussion-media-controller';
import {
  RatingDiscussionGallery,
  initialDiscussionGallery,
  type DiscussionGalleryView,
} from './discussion-media-gallery';
import type {
  DiscussionRoot,
  DiscussionReply,
} from './discussion-media-read-contract';
export interface DiscussionMediaRoute {
  readonly selector: RatingNavigationSelector;
  readonly targetId: string | null;
  readonly rootId: string | null;
  readonly recovery: boolean;
  readonly replyId?: string;
  readonly notice?: {
    readonly id: string;
    readonly kind: 'updates' | 'like-updates' | 'subscription-updates';
  };
}
export function decodeDiscussionMediaRoute(raw: unknown): DiscussionMediaRoute {
  if (
    !isRecord(raw) ||
    Object.keys(raw).some(
      (key) =>
        ![
          'scope',
          'campusId',
          'targetId',
          'rootId',
          'recovery',
          'replyId',
          'noticeId',
          'noticeKind',
        ].includes(key),
    )
  )
    invalidRating();
  if (raw.recovery === '1' && Object.keys(raw).length === 1)
    return {
      selector: { kind: 'global' },
      targetId: null,
      rootId: null,
      recovery: true,
    };
  if (raw.noticeId !== undefined) {
    if (
      !ratingId(raw.noticeId) ||
      !['updates', 'like-updates', 'subscription-updates'].includes(
        String(raw.noticeKind),
      ) ||
      raw.targetId !== undefined ||
      raw.rootId !== undefined ||
      raw.replyId !== undefined ||
      raw.recovery !== undefined ||
      (raw.scope !== 'global' && raw.scope !== 'campus') ||
      (raw.scope === 'global' && raw.campusId !== undefined)
    )
      invalidRating();
    return {
      selector: decodeRatingNavigationSelector(
        raw.scope === 'global'
          ? { kind: 'global' }
          : { kind: 'campus', campusId: raw.campusId },
      ),
      targetId: null,
      rootId: null,
      recovery: false,
      notice: {
        id: raw.noticeId,
        kind: raw.noticeKind as
          'updates' | 'like-updates' | 'subscription-updates',
      },
    };
  }
  if (
    (raw.scope !== 'global' && raw.scope !== 'campus') ||
    (raw.scope === 'global' && raw.campusId !== undefined) ||
    !ratingId(raw.targetId) ||
    (raw.rootId !== undefined && !ratingId(raw.rootId)) ||
    (raw.replyId !== undefined &&
      (!ratingId(raw.replyId) || raw.rootId === undefined)) ||
    raw.recovery !== undefined ||
    raw.noticeKind !== undefined
  )
    invalidRating();
  return {
    selector: decodeRatingNavigationSelector(
      raw.scope === 'global'
        ? { kind: 'global' }
        : { kind: 'campus', campusId: raw.campusId },
    ),
    targetId: raw.targetId,
    rootId: typeof raw.rootId === 'string' ? raw.rootId : null,
    recovery: false,
    ...(typeof raw.replyId === 'string' ? { replyId: raw.replyId } : {}),
  };
}
export function discussionMediaPath(
  selector: RatingNavigationSelector,
  targetId: string,
  rootId?: string,
  replyId?: string,
): string {
  const scope = decodeRatingNavigationSelector(selector);
  if (
    !ratingId(targetId) ||
    (rootId !== undefined && !ratingId(rootId)) ||
    (replyId !== undefined && (!ratingId(replyId) || rootId === undefined))
  )
    invalidRating();
  return (
    '/pages/rating-discussion-media/rating-discussion-media?' +
    Object.entries({
      scope: scope.kind,
      ...(scope.kind === 'campus' ? { campusId: scope.campusId } : {}),
      targetId,
      ...(rootId ? { rootId } : {}),
      ...(replyId ? { replyId } : {}),
    })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&')
  );
}
interface Row {
  readonly id: string;
  readonly body: string;
  readonly author: string;
  readonly imageCount: number;
  readonly reply: boolean;
  readonly canReply: boolean;
}
export interface DiscussionMediaPageView {
  readonly busy: boolean;
  readonly error: string;
  readonly rows: readonly Row[];
  readonly hasMore: boolean;
  readonly canCompose: boolean;
  readonly composerOpen: boolean;
  readonly text: string;
  readonly authorMode: 'named' | 'anonymous' | null;
  readonly authorModes: readonly ('named' | 'anonymous')[];
  readonly editor: DiscussionEditorView;
  readonly gallery: DiscussionGalleryView;
  readonly cancelConfirmation: boolean;
  readonly recovery: boolean;
  readonly maximum: number;
  readonly likes: Readonly<Record<string, RatingLikeState>>;
  readonly subscription: RatingSubscriptionState;
  readonly noticePreview: {
    readonly body: string;
    readonly author: string;
    readonly imageCount: number;
  } | null;
}
export const initialDiscussionMediaPage = (): DiscussionMediaPageView => ({
  busy: false,
  error: '',
  rows: [],
  hasMore: false,
  canCompose: false,
  composerOpen: false,
  text: '',
  authorMode: null,
  authorModes: [],
  editor: initialDiscussionEditor(),
  gallery: initialDiscussionGallery(),
  cancelConfirmation: false,
  recovery: false,
  maximum: 9,
  likes: {},
  subscription: { status: 'unavailable' },
  noticePreview: null,
});
export class RatingDiscussionMediaPageController {
  private view = initialDiscussionMediaPage();
  private route: DiscussionMediaRoute | null = null;
  private cancel = new Cancellation();
  private generation = 0;
  private disposed = false;
  private read: RatingDiscussionMediaContext | null = null;
  private rows: readonly (DiscussionRoot | DiscussionReply)[] = [];
  private cursor: string | null = null;
  private sort: 'time' | 'likes' = 'time';
  private readonly cursors = new Set<string>();
  private readonly readLease: RatingDiscussionMediaContextLease;
  private readonly commandLease: RatingDiscussionMediaContextLease;
  private readonly editor: RatingDiscussionMediaController | undefined;
  private readonly gallery: RatingDiscussionGallery;
  private readonly stops: (() => void)[] = [];
  constructor(
    private readonly runtime: CommunityRuntime,
    private readonly render: (view: DiscussionMediaPageView) => void,
    clock: Clock = systemClock,
  ) {
    this.readLease = new RatingDiscussionMediaContextLease(
      runtime.sessions,
      clock,
      () => this.hide(),
    );
    this.commandLease = new RatingDiscussionMediaContextLease(
      runtime.sessions,
      clock,
      () => this.hide(),
    );
    this.gallery = new RatingDiscussionGallery(
      runtime.sessions,
      runtime.ratingDiscussionDownload,
      clock,
      (gallery) => this.update({ gallery }),
    );
    if (runtime.ratingDiscussionMedia && runtime.pendingRatingDiscussionMedia)
      this.editor = new RatingDiscussionMediaController(
        runtime.sessions,
        runtime.pendingRatingDiscussionMedia,
        runtime.ratingDiscussionMedia,
        runtime.ratingDiscussionUpload,
        runtime.newRequestId,
        (editor) => this.update({ editor }),
        () => {
          this.update({
            text: '',
            authorMode: null,
            composerOpen: false,
            canCompose: false,
          });
        },
      );
    const invalidate = () => this.hide();
    this.stops = [
      runtime.privateViews?.subscribe(invalidate),
      runtime.directoryScopeChanges?.subscribe(invalidate),
      runtime.browsingScopeChanges?.subscribe(invalidate),
      runtime.ratingCatalogChanges?.subscribe(invalidate),
      runtime.ratingTargetChanges?.subscribe(invalidate),
    ].filter((stop): stop is () => void => !!stop);
  }
  private update(patch: Partial<DiscussionMediaPageView>) {
    this.view = Object.freeze({ ...this.view, ...patch });
    this.render(this.view);
  }
  private current(generation: number) {
    if (
      this.disposed ||
      generation !== this.generation ||
      this.cancel.isCancelled
    )
      throw new ClientError('cancelled', 'Discussion page changed');
  }
  private async work(
    task: (generation: number, cancel: Cancellation) => Promise<void>,
  ) {
    if (this.view.busy || this.disposed) return;
    const generation = this.generation,
      cancel = this.cancel;
    this.update({ busy: true, error: '' });
    try {
      await task(generation, cancel);
      this.current(generation);
    } catch {
      if (generation === this.generation && !cancel.isCancelled)
        this.update({
          error: '当前内容或原请求暂不可用，请恢复原请求或重新核验范围。',
        });
    } finally {
      if (generation === this.generation) this.update({ busy: false });
    }
  }
  async load(raw: unknown): Promise<void> {
    this.hide();
    try {
      this.route = decodeDiscussionMediaRoute(raw);
    } catch {
      this.update({ error: '评分讨论路径无效' });
      return;
    }
    await this.reload();
  }
  async reload(): Promise<void> {
    await this.work(async (generation, cancel) => {
      const gateway = this.runtime.ratingDiscussionMedia,
        pending = this.runtime.pendingRatingDiscussionMedia,
        actor = this.runtime.sessions.snapshot().credentials?.accountId;
      if (!gateway || !pending || !actor || !this.route || !this.editor)
        throw new ClientError('configuration', 'Discussion unavailable');
      // A corrupt or pending old journal blocks before context or fresh selection.
      pending.assertLegacyClear(actor);
      if (pending.isOpaque(actor)) {
        await this.editor.recover();
        this.current(generation);
        this.update({ recovery: true });
        return;
      }
      const original = pending.load(actor);
      if (original.batch || original.command) {
        await this.editor.recover();
        this.current(generation);
        if (pending.load(actor).command) {
          this.update({ recovery: true });
          return;
        }
      }
      if (this.route.recovery) {
        this.update({ recovery: true });
        return;
      }
      const request = {
          selector: this.route.selector,
          mode: 'public' as const,
          purpose: 'read' as const,
        },
        capture = this.readLease.capture();
      this.read = this.readLease.accept(
        await gateway.context(request, cancel),
        request,
        capture,
      );
      this.current(generation);
      this.rows = [];
      this.cursor = null;
      this.cursors.clear();
      if (this.route.notice) {
        const notice = await gateway.notice(
          this.read,
          this.route.notice.id,
          this.route.notice.kind,
          cancel,
        );
        this.current(generation);
        if (notice.status !== 'available')
          throw new ClientError('business', 'Current notice unavailable');
        this.update({
          noticePreview: {
            body: notice.preview.body,
            author: notice.preview.author.displayName,
            imageCount: notice.preview.imageCount,
          },
        });
        const legacy =
          this.route.notice.kind === 'updates'
            ? this.runtime.ratingUpdates
            : this.route.notice.kind === 'like-updates'
              ? this.runtime.ratingLikeUpdates
              : this.runtime.ratingSubscriptionUpdates;
        if (legacy) await legacy.markRead(this.route.notice.id, cancel);
        this.current(generation);
        this.route = {
          selector: notice.target.selector,
          targetId: notice.target.targetId,
          rootId: notice.target.rootId,
          recovery: false,
          ...(notice.target.replyId ? { replyId: notice.target.replyId } : {}),
        };
      }
      if (this.route.rootId) {
        const thread = await gateway.thread(
          this.read,
          this.route.rootId,
          cancel,
        );
        this.current(generation);
        if (thread.root.targetId !== this.route.targetId) invalidRating();
        this.rows = [thread.root];
        const page = this.route.replyId
          ? (await gateway.position(this.read, this.route.replyId, cancel)).page
          : await gateway.replies(this.read, this.route.rootId, null, cancel);
        this.current(generation);
        this.rows = [...this.rows, ...page.items];
        this.cursor = page.nextCursor;
        this.update({
          canCompose: thread.allowedActions.createReply,
          maximum: 3,
        });
      } else {
        const page = await gateway.comments(
          this.read,
          this.route.targetId!,
          null,
          cancel,
          this.sort,
        );
        this.current(generation);
        this.rows = page.items;
        this.cursor = page.nextCursor;
        this.update({ canCompose: true, maximum: 9 });
      }
      this.publishRows();
      await this.loadAuxiliary(generation, cancel);
    });
  }
  async selectSort(sort: 'time' | 'likes') {
    if (this.view.busy || this.route?.rootId) return;
    this.sort = sort;
    await this.reload();
  }
  private publishRows() {
    this.update({
      rows: this.rows.map((subject) => ({
        id: subject.id,
        body: subject.body,
        author: subject.author.displayName,
        imageCount: subject.images.length,
        reply: 'rootId' in subject,
        canReply: 'rootId' in subject ? subject.allowedActions.reply : true,
      })),
      hasMore: this.cursor !== null,
    });
  }
  async more(): Promise<void> {
    await this.work(async (generation, cancel) => {
      if (!this.route || !this.cursor || !this.read) return;
      const before = this.cursor;
      if (this.cursors.has(before)) invalidRating();
      const gateway = this.runtime.ratingDiscussionMedia!;
      const page = this.route.rootId
        ? await gateway.replies(
            this.readLease.current(),
            this.route.rootId,
            before,
            cancel,
          )
        : await gateway.comments(
            this.readLease.current(),
            this.route.targetId!,
            before,
            cancel,
            this.sort,
          );
      this.current(generation);
      if (
        page.items.some((item) => this.rows.some((old) => old.id === item.id))
      )
        invalidRating();
      this.cursors.add(before);
      this.cursor = page.nextCursor;
      this.rows = [...this.rows, ...page.items];
      this.publishRows();
      await this.loadAuxiliary(generation, cancel);
    });
  }
  private async auxiliaryContext(
    purpose: 'read' | 'interact',
    cancel: Cancellation,
  ): Promise<RatingScopedContext> {
    if (!this.route || !this.read || !this.runtime.ratingScoped)
      throw new ClientError(
        'configuration',
        'Original scoped actions unavailable',
      );
    const context = await this.runtime.ratingScoped.context(
        { selector: this.route.selector, purpose, mode: 'public' },
        cancel,
      ),
      read = this.readLease.current();
    if (
      context.protocolGeneration !== read.protocolGeneration ||
      context.sourceDigest !== read.sourceDigest ||
      context.actorId !== read.actorId ||
      canonicalRatingScopedJson(context.heads) !==
        canonicalRatingScopedJson(read.heads) ||
      canonicalRatingScopedJson(context.selector) !==
        canonicalRatingScopedJson(read.selector)
    )
      invalidRating();
    return context;
  }
  private async loadAuxiliary(generation: number, cancel: Cancellation) {
    if (!this.read || !this.route?.targetId) return;
    const pairs = await Promise.all(
      this.rows.map(async (subject) => {
        try {
          const state = await this.runtime.ratingDiscussionMedia!.like(
            this.readLease.current(),
            subject.id,
            'rootId' in subject ? 'reply' : 'comment',
            cancel,
          );
          if (
            state.status === 'known' &&
            (state.targetId !== subject.targetId ||
              state.rootId !==
                ('rootId' in subject ? subject.rootId : subject.id))
          )
            invalidRating();
          return [subject.id, state] as const;
        } catch {
          return [
            subject.id,
            { status: 'unavailable' } as RatingLikeState,
          ] as const;
        }
      }),
    );
    this.current(generation);
    this.update({ likes: Object.fromEntries(pairs) });
    try {
      const context = await this.auxiliaryContext('read', cancel),
        subscription = await this.runtime.ratingScoped!.subscription(
          context,
          this.route.targetId,
          cancel,
        );
      this.current(generation);
      this.update({ subscription });
    } catch {
      this.current(generation);
      this.update({ subscription: { status: 'unavailable' } });
    }
  }
  async toggle(subjectId?: string) {
    await this.work(async (generation, cancel) => {
      if (
        !this.route?.targetId ||
        !this.read ||
        !this.runtime.pendingRatings ||
        !this.runtime.ratingScoped
      )
        return;
      const actor = this.runtime.sessions.snapshot().credentials?.accountId;
      if (!actor) return;
      const original = this.runtime.pendingRatingDiscussionMedia!.load(actor);
      if (original.batch || original.command)
        throw new ClientError('business', 'Finish original image draft first');
      const request = {
          selector: this.route.selector,
          purpose: 'interact' as const,
          mode: 'public' as const,
        },
        mediaContext = await this.runtime.ratingDiscussionMedia!.context(
          request,
          cancel,
        ),
        composer = await this.runtime.ratingDiscussionMedia!.composer(
          mediaContext,
          this.route.targetId,
          null,
          cancel,
        );
      this.current(generation);
      const scoped = await this.auxiliaryContext('interact', cancel);
      this.current(generation);
      if (
        scoped.protocolGeneration !== mediaContext.protocolGeneration ||
        scoped.sourceDigest !== mediaContext.sourceDigest ||
        canonicalRatingScopedJson(scoped.heads) !==
          canonicalRatingScopedJson(mediaContext.heads)
      )
        invalidRating();
      const context = ratingScopedCommandContext(scoped),
        clientRequestId = await this.runtime.newRequestId();
      this.current(generation);
      const base = {
        clientRequestId,
        targetId: composer.targetId,
        expectedTargetRevision: composer.targetRevision,
        categoryId: composer.categoryId,
        expectedCategoryRevision: composer.categoryRevision,
      };
      let intent: ReturnType<typeof decodeRatingScopedIntent>;
      if (subjectId) {
        const subject = this.rows.find((row) => row.id === subjectId),
          state = this.view.likes[subjectId];
        if (!subject || !state || state.status !== 'known') return;
        const root =
          'rootId' in subject
            ? this.rows.find((row) => row.id === subject.rootId)
            : subject;
        if (!root) invalidRating();
        const payload = {
          ...base,
          rootId: root.id,
          expectedRevision: subject.revision,
          expectedLikeRevision: state.revision,
          liked: !state.liked,
        };
        intent = decodeRatingScopedIntent({
          protocolVersion: 2,
          context,
          operation:
            'rootId' in subject
              ? 'set_reply_like_scoped'
              : 'set_comment_like_scoped',
          payload:
            'rootId' in subject
              ? {
                  ...payload,
                  replyId: subject.id,
                  expectedRootRevision: root.revision,
                }
              : payload,
        });
      } else {
        const state = this.view.subscription;
        if (state.status !== 'known') return;
        intent = decodeRatingScopedIntent({
          protocolVersion: 2,
          context,
          operation: 'set_target_subscription_scoped',
          payload: {
            ...base,
            expectedSubscriptionRevision: state.revision,
            subscribed: !state.subscribed,
          },
        });
      }
      const attempt = this.runtime.pendingRatings.freeze({
          version: 9,
          accountId: actor,
          intent,
        }),
        receipt = await runRatingCommand(this.runtime, attempt, cancel, true);
      this.current(generation);
      settleRatingCommand(this.runtime, attempt, receipt);
      await this.loadAuxiliary(generation, cancel);
    });
  }
  deletionPath(subjectId: string): string | null {
    const subject = this.rows.find((row) => row.id === subjectId);
    if (!subject) return null;
    return ratingDeletionPath({
      subjectKind: 'rootId' in subject ? 'reply' : 'comment',
      targetId: subject.targetId,
      rootId: 'rootId' in subject ? subject.rootId : subject.id,
      subjectId: subject.id,
    });
  }
  threadPath(id: string): string | null {
    if (
      !this.route ||
      !this.rows.some((row) => row.id === id && !('rootId' in row))
    )
      return null;
    return discussionMediaPath(this.route.selector, this.route.targetId!, id);
  }
  async compose(replyId?: string): Promise<void> {
    await this.work(async (generation, cancel) => {
      if (!this.route || !this.editor) return;
      const gateway = this.runtime.ratingDiscussionMedia!,
        actor = this.runtime.sessions.snapshot().credentials?.accountId;
      if (!actor) return;
      const pending = this.runtime.pendingRatingDiscussionMedia!.load(actor);
      if (pending.command)
        throw new ClientError('business', 'Original publication pending');
      let selector = this.route.selector,
        targetId = this.route.targetId,
        rootId = this.route.rootId,
        replyTo: null | { replyId: string; expectedRevision: string } = null;
      if (pending.batch) {
        const original = pending.batch.identity;
        selector = original.context.selector;
        targetId = original.target.targetId;
        rootId =
          original.target.kind === 'reply' ? original.target.rootId : null;
        replyTo =
          original.target.kind === 'reply' ? original.target.replyTo : null;
      } else if (replyId) {
        const reply = this.rows.find(
          (row) => row.id === replyId && 'rootId' in row,
        ) as DiscussionReply | undefined;
        if (!reply || !reply.allowedActions.reply || reply.rootId !== rootId)
          invalidRating();
        replyTo = { replyId: reply.id, expectedRevision: reply.revision };
      }
      if (!targetId)
        throw new ClientError('business', 'Choose a Ratings target first');
      const request = {
          selector,
          mode: 'public' as const,
          purpose: 'interact' as const,
        },
        capture = this.commandLease.capture(),
        context = this.commandLease.accept(
          await gateway.context(request, cancel),
          request,
          capture,
        );
      this.current(generation);
      const composer = await gateway.composer(
        context,
        targetId,
        rootId,
        cancel,
      );
      this.current(generation);
      if (
        rootId
          ? !composer.allowedActions.createReply
          : !composer.allowedActions.createComment
      )
        invalidRating();
      this.editor.configure(context, composer, replyTo);
      this.update({
        composerOpen: true,
        text: '',
        authorMode: null,
        authorModes: composer.authorModes,
        maximum: rootId ? 3 : 9,
        recovery: false,
      });
    });
  }
  text(value: string) {
    if (!this.view.busy && !this.view.editor.frozen)
      this.update({ text: value });
  }
  author(value: string) {
    if (
      (value === 'named' || value === 'anonymous') &&
      this.view.authorModes.includes(value) &&
      !this.view.editor.frozen
    )
      this.update({ authorMode: value });
  }
  closeComposer() {
    this.editor?.hide();
    this.commandLease.clear();
    this.update({
      composerOpen: false,
      text: '',
      authorMode: null,
      authorModes: [],
    });
  }
  async append() {
    this.gallery.close();
    await this.work(async () => {
      this.commandLease.current();
      await this.editor?.append();
    });
  }
  async remove(memberId: string) {
    await this.work(async () => {
      await this.editor?.remove(memberId);
    });
  }
  async reorder(memberId: string, direction: -1 | 1) {
    await this.work(async () => {
      await this.editor?.reorder(memberId, direction);
    });
  }
  async publish() {
    await this.work(async () => {
      this.commandLease.current();
      if (!this.view.authorMode) return;
      await this.editor?.publish(this.view.text, this.view.authorMode);
    });
  }
  async recover(retry = false) {
    await this.work(async () => {
      await this.editor?.recover(retry ? 'retry' : 'receipt');
    });
  }
  requestCancel() {
    this.update({ cancelConfirmation: true });
  }
  dismissCancel() {
    this.update({ cancelConfirmation: false });
  }
  async cancelOriginal() {
    if (!this.view.cancelConfirmation) return;
    this.update({ cancelConfirmation: false });
    await this.work(async () => {
      await this.editor?.recover('cancel');
    });
  }
  async openImage(subjectId: string) {
    const subject = this.rows.find((row) => row.id === subjectId),
      route = this.route;
    if (!subject || !route) return;
    const kind = 'rootId' in subject ? 'reply' : 'root';
    await this.gallery.open(async (cancel) => {
      const request = {
        selector: route.selector,
        mode: 'public' as const,
        purpose: 'read' as const,
      };
      const context = await this.runtime.ratingDiscussionMedia!.context(
          request,
          cancel,
        ),
        current = await this.runtime.ratingDiscussionMedia!.subject(
          context,
          subjectId,
          kind,
          cancel,
        );
      return { context, subject: current };
    });
  }
  moveImage(direction: -1 | 1) {
    return this.gallery.move(direction);
  }
  closeImage() {
    this.gallery.close();
  }
  hide() {
    ++this.generation;
    this.cancel.cancel();
    this.cancel = new Cancellation();
    this.read = null;
    this.rows = [];
    this.cursor = null;
    this.cursors.clear();
    this.readLease?.clear();
    this.commandLease?.clear();
    this.editor?.hide();
    this.gallery?.close();
    this.view = initialDiscussionMediaPage();
    this.render(this.view);
  }
  dispose() {
    this.hide();
    this.disposed = true;
    this.readLease.dispose();
    this.commandLease.dispose();
    this.editor?.dispose();
    this.gallery.dispose();
    for (const stop of this.stops) stop();
  }
}
