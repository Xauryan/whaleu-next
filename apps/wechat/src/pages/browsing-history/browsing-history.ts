import type { WhaleuApp } from '../../app';
import type { SessionStore, SessionTicket } from '../../auth/session';
import {
  BrowsingHistoryController,
  initialHistoryView,
} from '../../browsing-history/controller';
import { nativeBrowsingHistory } from '../../browsing-history/native';

interface ClearLease {
  readonly sessionId: string;
  readonly pageGeneration: number;
  readonly owner: SessionTicket;
  readonly sessions: SessionStore;
  readonly controller: BrowsingHistoryController;
  generation: number | null;
  attempt: number;
  phase: 'locking' | 'opening' | 'open' | 'pending' | 'clearing' | 'closing';
}
interface DialogDetail {
  sessionId?: unknown;
  generation?: unknown;
  attemptKey?: unknown;
  id?: unknown;
  reason?: unknown;
}
const detailOf = (event: unknown): DialogDetail | null => {
  if (!event || typeof event !== 'object') return null;
  const detail = (event as { detail?: unknown }).detail;
  return detail && typeof detail === 'object' ? detail : null;
};
let openingSequence = 0;
const initialDialog = () => ({
  historyOverlayLocked: false,
  historyPageStyle: '',
  clearDialogOpen: false,
  clearDialogSessionId: '',
  clearDialogAttempt: 0,
  clearDialogLoading: false,
  clearDialogError: '',
});
Page({
  data: { ...initialHistoryView(), ...initialDialog() },
  controller: undefined as BrowsingHistoryController | undefined,
  clearLease: undefined as ClearLease | undefined,
  historyVisible: false,
  historyGeneration: 0,
  onShow() {
    this.onHide();
    this.historyVisible = true;
    const pageGeneration = this.historyGeneration;
    this.setData({ ...initialHistoryView(), ...initialDialog() });
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.controller = new BrowsingHistoryController(
      runtime,
      nativeBrowsingHistory(runtime.sessions),
      (view) => {
        if (!this.historyVisible || this.historyGeneration !== pageGeneration)
          return;
        this.setData({ ...view });
        const lease = this.clearLease;
        if (
          lease &&
          (!this.ownsClearLease(lease) ||
            (!view.confirmClear && lease.phase !== 'clearing'))
        )
          this.closeClearDialog(lease);
      },
    );
    void this.controller.load();
  },
  ownsClearLease(lease: ClearLease): boolean {
    if (
      !this.historyVisible ||
      this.clearLease !== lease ||
      this.historyGeneration !== lease.pageGeneration ||
      this.controller !== lease.controller ||
      !lease.owner.credentials
    )
      return false;
    try {
      lease.sessions.assertCurrent(lease.owner);
      return true;
    } catch {
      return false;
    }
  },
  backgroundAvailable(): boolean {
    // This page has no exposure/read/visibility observers to suspend. Its
    // existing controller loads authorized summaries; it never records visits.
    // The lease also rejects queued native taps before setData reaches the UI.
    return (
      this.historyVisible && !this.clearLease && !this.data.historyOverlayLocked
    );
  },
  onReload() {
    if (this.backgroundAvailable()) void this.controller?.load();
  },
  onMore() {
    if (this.backgroundAvailable()) void this.controller?.more();
  },
  onPrevious() {
    if (this.backgroundAvailable()) void this.controller?.previous();
  },
  onRequestClear() {
    if (
      !this.backgroundAvailable() ||
      this.data.busy ||
      !this.data.hasSession ||
      !this.controller ||
      openingSequence >= Number.MAX_SAFE_INTEGER
    )
      return;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) return;
    this.controller.requestClear();
    if (!this.data.confirmClear) return;
    const lease: ClearLease = {
      sessionId: `history-clear-${++openingSequence}`,
      pageGeneration: this.historyGeneration,
      owner: runtime.sessions.snapshot(),
      sessions: runtime.sessions,
      controller: this.controller,
      generation: null,
      attempt: 0,
      phase: 'locking',
    };
    this.clearLease = lease;
    // Candidate native page-meta page-style lock, never a backdrop-only lock.
    // Official scroll-lock documentation retrieval and native-renderer checks
    // remain acceptance gates; mocked setData proves ordering, not scrolling.
    // Wait for this render acknowledgement BEFORE opening the mounted dialog.
    this.setData(
      {
        historyOverlayLocked: true,
        historyPageStyle: 'overflow: hidden;',
        clearDialogSessionId: lease.sessionId,
        clearDialogAttempt: 0,
        clearDialogError: '',
        clearDialogLoading: false,
      },
      () => {
        if (!this.ownsClearLease(lease) || lease.phase !== 'locking') return;
        lease.phase = 'opening';
        this.setData({ clearDialogOpen: true });
      },
    );
  },
  onClearDialogOpened(event: unknown) {
    const lease = this.clearLease;
    const detail = detailOf(event);
    if (
      !lease ||
      !this.ownsClearLease(lease) ||
      lease.phase !== 'opening' ||
      detail?.sessionId !== lease.sessionId ||
      typeof detail.generation !== 'number' ||
      !Number.isSafeInteger(detail.generation) ||
      detail.generation <= 0
    )
      return;
    lease.generation = detail.generation;
    lease.phase = 'open';
  },
  clearIntent(event: unknown): ClearLease | undefined {
    const lease = this.clearLease;
    const detail = detailOf(event);
    if (
      lease &&
      this.ownsClearLease(lease) &&
      lease.phase === 'open' &&
      lease.generation !== null &&
      detail?.sessionId === lease.sessionId &&
      detail.generation === lease.generation &&
      detail.attemptKey === lease.attempt &&
      detail.attemptKey === this.data.clearDialogAttempt &&
      this.data.confirmClear &&
      !this.data.busy &&
      !this.data.clearDialogLoading
    )
      return lease;
    return undefined;
  },
  onDismissClear(event: unknown) {
    const lease = this.clearIntent(event);
    if (!lease || detailOf(event)?.reason !== 'cancel') return;
    lease.phase = 'closing';
    lease.controller.dismissClear();
    this.closeClearDialog(lease);
  },
  onConfirmClear(event: unknown) {
    const lease = this.clearIntent(event);
    const detail = detailOf(event);
    if (!lease || detail?.id !== 'clear-history') return;
    // Latch before setData or synchronous controller callbacks. The only
    // mutation is the existing, synchronous account-local history clear.
    lease.phase = 'pending';
    this.setData({ clearDialogLoading: true }, () => {
      if (!this.ownsClearLease(lease) || lease.phase !== 'pending') return;
      lease.phase = 'clearing';
      lease.controller.clear();
      if (!this.ownsClearLease(lease)) return;
      if (this.data.loaded && !this.data.error) {
        this.closeClearDialog(lease);
      } else {
        // clear() has returned a known storage failure, not an uncertain
        // network mutation. Preserve its hidden summaries/error semantics;
        // only an explicit fresh tap can retry the settled local attempt.
        lease.controller.requestClear();
        if (!this.ownsClearLease(lease) || !this.data.confirmClear) {
          this.closeClearDialog(lease);
          return;
        }
        lease.attempt += 1;
        lease.phase = 'open';
        this.setData({
          clearDialogError: this.data.error,
          clearDialogLoading: false,
          clearDialogAttempt: lease.attempt,
        });
      }
    });
  },
  closeClearDialog(lease: ClearLease) {
    if (this.clearLease !== lease || !this.historyVisible) return;
    if (lease.phase === 'locking') {
      // Nothing opened, so no native closed event can exist. Invalidating the
      // token also makes a delayed lock acknowledgement unable to open it.
      this.clearLease = undefined;
      this.setData(initialDialog());
      return;
    }
    lease.phase = 'closing';
    this.setData({
      clearDialogOpen: false,
      clearDialogLoading: false,
      clearDialogError: '',
    });
  },
  onClearDialogClosed(event: unknown) {
    const lease = this.clearLease;
    const detail = detailOf(event);
    if (
      !lease ||
      !this.historyVisible ||
      this.historyGeneration !== lease.pageGeneration ||
      lease.phase !== 'closing' ||
      this.data.clearDialogOpen ||
      detail?.sessionId !== lease.sessionId ||
      typeof detail.generation !== 'number' ||
      !Number.isSafeInteger(detail.generation) ||
      detail.generation <= 0 ||
      (lease.generation !== null && detail.generation !== lease.generation)
    )
      return;
    // An auth change may close during opening, before opened is emitted.
    // Its unique session binds that first closed generation; an already-open
    // dialog additionally requires its previously accepted generation.
    lease.generation = detail.generation;
    this.clearLease = undefined;
    this.setData(initialDialog());
  },
  onLogin() {
    if (!this.backgroundAvailable() || this.data.hasSession) return;
    if (!wx.navigateTo) {
      this.setData({ error: '当前环境不能打开登录页' });
      return;
    }
    const generation = this.historyGeneration;
    wx.navigateTo({
      url: '/pages/login/login',
      success: () => undefined,
      fail: () => {
        if (
          this.backgroundAvailable() &&
          this.historyGeneration === generation &&
          !this.data.hasSession
        )
          this.setData({ error: '暂不能打开登录页，请重试' });
      },
    });
  },
  onOpen(event: { currentTarget: { dataset: { id: string } } }) {
    if (!this.backgroundAvailable() || this.data.busy || !this.data.loaded)
      return;
    const item = this.data.items.find(
      (row) => row.postId === event.currentTarget.dataset.id,
    );
    if (!item) return;
    if (!wx.navigateTo) {
      this.setData({ error: '当前环境不能打开帖子' });
      return;
    }
    const generation = this.historyGeneration;
    wx.navigateTo({
      url: `/pages/community-detail/community-detail?postId=${encodeURIComponent(item.postId)}`,
      success: () => undefined,
      fail: () => {
        if (this.backgroundAvailable() && this.historyGeneration === generation)
          this.setData({ error: '暂不能打开帖子，请重试' });
      },
    });
  },
  onHide() {
    this.historyVisible = false;
    this.historyGeneration += 1;
    this.clearLease = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    // Hidden/unloaded owners invalidate leases without resuming a background
    // page. A later onShow resets the lock for its own fresh page generation.
    this.setData({
      ...initialHistoryView(),
      ...initialDialog(),
      historyOverlayLocked: true,
      historyPageStyle: 'overflow: hidden;',
    });
  },
  onUnload() {
    this.onHide();
  },
});
