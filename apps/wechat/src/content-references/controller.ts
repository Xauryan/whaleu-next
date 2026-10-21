import { clientError } from '../api/errors';
import type { SessionTicket } from '../auth/session';
import type { CommunityRuntime } from '../community/runtime';
import { cancellable } from '../platform/cancellable';
import { Cancellation } from '../platform/contracts';
import type { WxApi } from '../platform/wechat';
import {
  decodeReferenceCapability,
  decodeReferenceDestination,
  decodeReferenceLookup,
  decodeReferenceTarget,
  invalidReference,
  referenceDestinationPath,
  referenceTargetKey,
  type ReferenceTarget,
} from './contract';
import type { ContentReferencesGateway } from './gateway';
import { splitContentReferenceText } from './text';
export interface ReferenceRow extends ReferenceTarget {
  readonly text: string;
  readonly thread?: {
    readonly postId: string;
    readonly rootCommentId: string;
    readonly replyId?: string;
  };
}
export interface ReferencePress {
  readonly rowKey: string;
  readonly generation: number;
  readonly code?: string;
  readonly start?: number;
}
export interface ReferenceView {
  readonly available: boolean;
  readonly generation: number;
  readonly busy: boolean;
  readonly error: string;
  readonly codes: Readonly<Record<string, string>>;
}
export const initialReferenceView = (): ReferenceView => ({
  available: false,
  generation: 0,
  busy: false,
  error: '',
  codes: {},
});
type Runtime = Pick<
  CommunityRuntime,
  'sessions' | 'privateViews' | 'safetyChanges' | 'browsingScopeChanges'
>;
/** Page-local hints only. Resolved destinations/positive authority are never cached. */
export class ContentReferenceController {
  private view = initialReferenceView();
  private readonly owner: SessionTicket;
  private rows: readonly ReferenceRow[] = [];
  private generation = 0;
  private revision = -1;
  private minimumRevision = -1;
  private disposed = false;
  private read: Cancellation | undefined;
  private resolveRead: Cancellation | undefined;
  private readonly unsubscribes: (() => void)[] = [];
  constructor(
    private readonly runtime: Runtime,
    private readonly gateway: ContentReferencesGateway | undefined,
    private readonly native: Pick<WxApi, 'navigateTo'>,
    private readonly render: (view: ReferenceView) => void,
    private readonly viewSpaceId?: string,
    private readonly allowedToNavigate: () => boolean = () => true,
  ) {
    this.owner = runtime.sessions.snapshot();
    this.unsubscribes.push(
      runtime.sessions.subscribe(() => {
        try {
          runtime.sessions.assertCurrent(this.owner);
        } catch {
          this.dispose();
        }
      }),
    );
    this.unsubscribes.push(
      runtime.privateViews?.subscribe((accountId) => {
        if (accountId === undefined) this.dispose();
        else if (accountId === this.owner.credentials?.accountId)
          this.invalidate();
      }) ?? (() => undefined),
    );
    this.unsubscribes.push(
      runtime.safetyChanges?.subscribe((accountId) => {
        if (accountId === this.owner.credentials?.accountId) this.invalidate();
      }) ?? (() => undefined),
    );
    // A browse-scope change cannot reuse the current detail's old scope proof.
    this.unsubscribes.push(
      runtime.browsingScopeChanges?.subscribe(() => this.dispose()) ??
        (() => undefined),
    );
    this.publish();
  }
  private publish(patch: Partial<ReferenceView> = {}): void {
    this.view = { ...this.view, ...patch, generation: this.generation };
    this.render(this.view);
  }
  private stop(): void {
    this.generation++;
    this.read?.cancel();
    this.read = undefined;
    this.resolveRead?.cancel();
    this.resolveRead = undefined;
  }
  suspend(): void {
    this.invalidate();
  }
  private invalidate(): void {
    if (this.disposed) return;
    this.minimumRevision = this.revision + 1;
    this.stop();
    this.rows = [];
    this.publish({ ...initialReferenceView() });
  }
  private current(generation: number): boolean {
    if (this.disposed || generation !== this.generation) return false;
    try {
      this.runtime.sessions.assertCurrent(this.owner);
      return !!this.owner.credentials;
    } catch {
      return false;
    }
  }
  reconcile(rows: readonly ReferenceRow[], revision: number): void {
    if (this.disposed || revision < this.minimumRevision) return;
    if (
      revision === this.revision &&
      rows.length === this.rows.length &&
      rows.every((row, i) => {
        const previous = this.rows[i];
        return (
          previous &&
          referenceTargetKey(row) === referenceTargetKey(previous) &&
          row.text === previous.text
        );
      })
    )
      return;
    this.stop();
    this.revision = revision;
    this.rows = rows.map((row) => ({
      ...row,
      ...(row.thread ? { thread: { ...row.thread } } : {}),
    }));
    this.publish({ ...initialReferenceView() });
    if (!rows.length || !this.gateway || !this.current(this.generation)) return;
    const cancel = new Cancellation();
    this.read = cancel;
    void this.load(this.generation, cancel);
  }
  private async load(generation: number, cancel: Cancellation): Promise<void> {
    try {
      const capability = decodeReferenceCapability(
        await cancellable(this.gateway!.capability(cancel), cancel),
      );
      if (!this.current(generation) || capability.available !== true) return;
      this.publish({ available: true });
      // First slice exposes just the parent post's canonical code. No offscreen
      // child scan, unbounded batches, allocation, body transmission or read ack.
      const post = this.rows.find((row) => row.kind === 'post');
      if (!post) return;
      const target = decodeReferenceTarget({
        kind: post.kind,
        targetId: post.targetId,
      });
      const result = decodeReferenceLookup(
        await cancellable(
          this.gateway!.lookup([target], cancel, this.viewSpaceId),
          cancel,
        ),
      );
      if (!this.current(generation)) return;
      const key = referenceTargetKey(target);
      if (result.items.some((item) => referenceTargetKey(item) !== key))
        invalidReference();
      this.publish({
        codes: Object.fromEntries(
          result.items.map((item) => [referenceTargetKey(item), item.code]),
        ),
      });
    } catch {
      // Unavailable optional lookup never invents a number or hides source text.
      if (this.current(generation)) this.publish({ codes: {} });
    } finally {
      if (this.current(generation)) this.read = undefined;
    }
  }
  private row(event: ReferencePress): ReferenceRow | undefined {
    if (!this.current(event.generation) || this.view.busy) return undefined;
    return this.rows.find((row) => referenceTargetKey(row) === event.rowKey);
  }
  async open(event: ReferencePress): Promise<void> {
    const row = this.row(event);
    if (
      !row ||
      !this.gateway ||
      !this.view.available ||
      !splitContentReferenceText(row.text, true).some(
        (segment) =>
          segment.kind === 'reference' &&
          segment.code === event.code &&
          segment.start === event.start,
      )
    )
      return;
    const generation = this.generation,
      cancel = new Cancellation();
    this.resolveRead = cancel;
    this.publish({ busy: true, error: '' });
    try {
      const destination = decodeReferenceDestination(
        await cancellable(
          this.gateway.resolve(event.code!, cancel, this.viewSpaceId),
          cancel,
        ),
      );
      if (!this.current(generation)) return;
      if (destination.viewSpaceId !== this.viewSpaceId) invalidReference();
      this.navigate(referenceDestinationPath(destination), generation);
    } catch (error) {
      if (!this.current(generation)) return;
      this.publish({
        busy: false,
        error:
          clientError(error).details.serverCode === 'REFERENCE_NOT_FOUND'
            ? '引用不存在或当前不可查看'
            : '暂不能打开此引用，请稍后重试',
      });
    } finally {
      if (this.current(generation)) this.resolveRead = undefined;
    }
  }
  /** Successor of the old preview navigator: current ancestor IDs, no dataset URL. */
  openThread(event: ReferencePress): void {
    const row = this.row(event);
    if (!row?.thread) return;
    const destination = decodeReferenceDestination({
      kind: row.thread.replyId ? 'reply' : 'comment',
      ...row.thread,
      ...(this.viewSpaceId ? { viewSpaceId: this.viewSpaceId } : {}),
    });
    this.publish({ busy: true, error: '' });
    this.navigate(
      referenceDestinationPath(destination).replace(
        '/community-detail/community-detail?',
        '/community-thread/community-thread?',
      ),
      this.generation,
    );
  }
  private navigate(url: string, generation: number): void {
    if (!this.current(generation)) return;
    // A newer menu, dialog or preview wins over an older tap. Closing it does
    // not resume this intent; the user must explicitly tap again.
    if (!this.allowedToNavigate()) {
      this.publish({ busy: false });
      return;
    }
    const failed = () => {
      if (this.current(generation))
        this.publish({ busy: false, error: '暂不能打开此内容，请重试' });
    };
    if (!this.native.navigateTo) {
      failed();
      return;
    }
    try {
      this.native.navigateTo({
        url,
        success: () => {
          if (this.current(generation)) this.publish({ busy: false });
        },
        fail: failed,
      });
    } catch {
      failed();
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.rows = [];
    this.disposed = true;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.publish({ ...initialReferenceView() });
  }
}
