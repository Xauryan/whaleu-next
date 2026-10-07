import { ClientError } from '../api/errors';
import type { Cancellation } from '../platform/contracts';
import {
  decodeBlockSource,
  decodeBlockResult,
  matchBlockResult,
  decodeBlocksList,
  type BlockSource,
  type BlockEntry,
  type BlockIntent,
  type BlockResult,
  type BlockState,
} from './block-contract';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  reasonMessage,
  type CommunityView,
} from './controller';
import type { PendingBlock } from './block-pending';
import type { CommunityRuntime } from './runtime';
export interface BlockMutationView extends CommunityView {
  readonly frozen: boolean;
  readonly confirmSource: BlockSource | null;
  readonly activeRelationshipId: string;
  readonly receiptStatus: string;
  readonly current: BlockState | null;
}
export const initialBlockMutationView = (): BlockMutationView => ({
  ...initialCommunityView(),
  frozen: false,
  confirmSource: null,
  activeRelationshipId: '',
  receiptStatus: '',
  current: null,
});
type NewIntent =
  | {
      readonly operation: 'block_named';
      readonly source: BlockSource;
      readonly blocked: true;
    }
  | {
      readonly operation: 'unblock_named';
      readonly relationshipId: string;
      readonly expectedRevision: string;
      readonly blocked: false;
    };
/** Confirmation is transient; frozen intents carry only content references or own opaque relationships. */
export class BlockMutationController extends CommunityController<BlockMutationView> {
  private pending: PendingBlock | null = null;
  constructor(
    runtime: CommunityRuntime,
    render: (view: BlockMutationView) => void,
  ) {
    super(runtime, initialBlockMutationView, render);
  }
  protected override resetPrivate(): void {
    this.pending = null;
  }
  protected override onSafetyInvalidated(): void {
    this.load();
    const owner = this.runtime.sessions.snapshot();
    // The visibility event precedes synchronous journal cleanup. Reconcile other
    // open controllers afterward without erasing a newly rendered receipt/current state.
    void Promise.resolve().then(() => {
      if (!this.view.frozen || !this.available()) return;
      try {
        this.runtime.sessions.assertCurrent(owner);
        const accountId = this.accountId();
        if (accountId && !this.runtime.pendingBlocks?.load(accountId)) {
          this.pending = null;
          this.update({ frozen: false, activeRelationshipId: '' });
        }
      } catch {
        /* Preserve the barrier on storage, lifecycle or ownership uncertainty. */
      }
    });
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (!this.runtime.blocks || !this.runtime.pendingBlocks) {
      this.update({ error: '当前构建尚未配置屏蔽服务', status: '暂不可用' });
      return false;
    }
    return true;
  }
  load(): void {
    this.stop();
    this.update({ busy: false, confirmSource: null, current: null, error: '' });
    if (!this.ready()) return;
    try {
      const pending = this.runtime.pendingBlocks!.load(this.accountId()!);
      if (pending) this.show(pending);
      else {
        this.pending = null;
        this.update({
          frozen: false,
          activeRelationshipId: '',
          status: '屏蔽请求恢复已就绪',
        });
      }
    } catch (error) {
      this.update({
        frozen: true,
        error: communityError(error),
        status: '无法读取原请求，禁止发送新请求',
      });
    }
  }
  private show(pending: PendingBlock): void {
    this.pending = pending;
    this.update({
      frozen: true,
      confirmSource: null,
      activeRelationshipId:
        pending.intent.operation === 'unblock_named'
          ? pending.intent.relationshipId
          : '',
      status: '原屏蔽设置请求结果待确认，请查询或重试完全相同的请求',
    });
  }
  requestBlock(
    kind: BlockSource['kind'],
    item: {
      readonly id: string;
      readonly author: { readonly kind: 'named' | 'anonymous' };
      readonly viewer: { readonly isSelf: boolean };
    },
  ): void {
    if (
      this.view.busy ||
      this.view.frozen ||
      this.view.confirmSource ||
      item.author.kind !== 'named' ||
      item.viewer.isSelf ||
      !this.ready()
    )
      return;
    try {
      const pending = this.runtime.pendingBlocks!.load(this.accountId()!);
      if (pending) {
        this.show(pending);
        return;
      }
      this.update({
        confirmSource: decodeBlockSource({ kind, id: item.id }),
        error: '',
        receiptStatus: '',
        current: null,
      });
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
    }
  }
  dismissBlock(): void {
    this.update({ confirmSource: null });
  }
  async confirmBlock(): Promise<void> {
    const source = this.view.confirmSource;
    if (!source || this.view.busy || this.view.frozen) return;
    this.update({ confirmSource: null });
    await this.apply({ operation: 'block_named', source, blocked: true });
  }
  async unblock(raw: BlockEntry): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      this.view.confirmSource ||
      !this.ready()
    )
      return;
    try {
      const entry = decodeBlocksList({ items: [raw], nextCursor: null })
        .items[0]!;
      await this.apply({
        operation: 'unblock_named',
        relationshipId: entry.relationshipId,
        expectedRevision: entry.revision,
        blocked: false,
      });
    } catch (error) {
      this.update({ error: communityError(error) });
    }
  }
  private async apply(intent: NewIntent): Promise<void> {
    if (this.view.busy || this.view.frozen || !this.ready()) return;
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    try {
      const old = this.runtime.pendingBlocks!.load(accountId);
      if (old) {
        this.show(old);
        return;
      }
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
      return;
    }
    this.update({
      activeRelationshipId:
        intent.operation === 'unblock_named' ? intent.relationshipId : '',
      receiptStatus: '',
      current: null,
    });
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const pending = this.runtime.pendingBlocks!.freeze({
          version: 1,
          accountId,
          intent: { ...intent, clientRequestId } as BlockIntent,
        });
        this.show(pending);
        return this.dispatch(pending, cancel);
      },
      (result) => this.settle(result),
      () => this.update({ status: '屏蔽设置结果未知，请保留原请求并查询回执' }),
    );
  }
  private dispatch(
    pending: PendingBlock,
    cancel: Cancellation,
  ): Promise<BlockResult> {
    if (pending.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    if (
      JSON.stringify(this.runtime.pendingBlocks!.load(pending.accountId)) !==
      JSON.stringify(pending)
    )
      throw new ClientError('storage', 'Pending block changed');
    return this.runtime.blocks!.apply(pending.intent, cancel);
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    try {
      const pending = this.runtime.pendingBlocks!.load(this.accountId()!);
      if (!pending) {
        this.update({ error: '未找到原屏蔽请求，请重新打开页面' });
        return;
      }
      this.show(pending);
      await this.run(
        (cancel) =>
          retry
            ? this.dispatch(pending, cancel)
            : this.runtime.blocks!.receipt(
                pending.intent.clientRequestId,
                cancel,
              ),
        (result) => this.settle(result),
        () => this.update({ frozen: true, status: '原屏蔽请求仍待确认' }),
      );
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
    }
  }
  private settle(result: BlockResult): void {
    const pending = this.pending;
    if (!pending || pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Missing original block request');
    const settled = decodeBlockResult(result);
    matchBlockResult(pending.intent, settled);
    // Clear current readers before any fallible local persistence step.
    this.runtime.safetyChanges?.invalidate(pending.accountId);
    let cleanupError: unknown;
    try {
      this.runtime.pendingBlocks!.settle(pending, settled);
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      this.pending = pending;
      this.update({
        busy: false,
        frozen: true,
        confirmSource: null,
        activeRelationshipId:
          pending.intent.operation === 'unblock_named'
            ? pending.intent.relationshipId
            : '',
        current: null,
        receiptStatus: '',
        status: '服务端已返回原请求结果；本地恢复记录尚未清理，请保留原请求',
        error: communityError(cleanupError),
      });
      return;
    }
    this.pending = null;
    this.update({
      busy: false,
      frozen: false,
      confirmSource: null,
      activeRelationshipId: '',
      current: settled.current,
      receiptStatus:
        settled.receipt.outcome === 'applied'
          ? `原${settled.receipt.blocked ? '屏蔽' : '解除屏蔽'}请求已确认；当前${settled.current!.blocked ? '已屏蔽' : '未屏蔽'}`
          : reasonMessage(settled.receipt.code),
      status: '原请求已确认，已重新检查当前内容',
      error: '',
    });
  }
}
