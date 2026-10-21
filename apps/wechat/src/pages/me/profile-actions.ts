import { isRecord } from '../../api/errors';
import type { SessionStore, SessionTicket } from '../../auth/session';
import type { WxApi } from '../../platform/wechat';
import { isUuid } from '../../profile/contract';
import { decodePublicProfile } from '../../profile/discovery-contract';

export interface ProfileShare {
  readonly title: string;
  readonly path: string;
  readonly imageUrl: '/assets/share/profile.png';
}

/** Never let WeChat take a screenshot of Me's private saved/liked content. */
export function buildOwnProfileShare(
  profile: unknown,
  sessions: SessionStore | undefined,
  owner: SessionTicket | null | undefined,
): ProfileShare {
  const fallback: ProfileShare = {
    title: 'WhaleU 校园社区',
    path: '/pages/community-feed/community-feed',
    imageUrl: '/assets/share/profile.png',
  };
  if (!sessions || !owner?.credentials) return fallback;
  try {
    sessions.assertCurrent(owner);
    const checked = decodePublicProfile(profile);
    if (checked.status !== 'available' || !checked.isOwn) return fallback;
    return {
      title: 'WhaleU 个人主页',
      path: `/pages/public-profile/public-profile?profileId=${checked.profileId}`,
      imageUrl: '/assets/share/profile.png',
    };
  } catch {
    return fallback;
  }
}

export interface SafeProfileScanRoute {
  readonly kind: 'profile' | 'post';
  readonly path: string;
}

/**
 * QR text is data, not a URL or a native scan path. Accept just these two exact
 * canonical public routes and their single selector. Do not decode or normalize
 * the input: encoded separators, duplicate/unknown parameters and redirects fail.
 */
export function parseProfileScanRoute(
  value: unknown,
): SafeProfileScanRoute | null {
  if (typeof value !== 'string' || value.length > 120) return null;
  const routes = [
    ['profile', '/pages/public-profile/public-profile?profileId='],
    ['post', '/pages/community-detail/community-detail?postId='],
  ] as const;
  for (const [kind, prefix] of routes) {
    if (!value.startsWith(prefix)) continue;
    const id = value.slice(prefix.length);
    if (!isUuid(id)) return null;
    return Object.freeze({ kind, path: `${prefix}${id}` });
  }
  return null;
}

/** Optional native capability, deliberately not added to the shared WxApi. */
export interface ProfileScannerNative extends Pick<
  WxApi,
  'showModal' | 'navigateTo'
> {
  scanCode?(options: {
    onlyFromCamera: true;
    scanType: ['qrCode'];
    success(result: { result?: unknown; path?: unknown }): void;
    fail(error: unknown): void;
  }): void;
}
export interface ProfileScanView {
  readonly busy: boolean;
  readonly error: string;
}
export const initialProfileScanView = (): ProfileScanView => ({
  busy: false,
  error: '',
});

type ScanPhase =
  'idle' | 'preflight' | 'scanning' | 'pending' | 'confirming' | 'navigating';
type ScanOutcome =
  | { readonly route: SafeProfileScanRoute; readonly error?: never }
  | { readonly route?: never; readonly error: string };

const unavailable = '当前微信暂不支持扫码，请更新微信后重试';
const unreadable = '暂不支持这个二维码，仅可打开 WhaleU 公开主页或帖子';
const cameraDenied =
  '未获得相机权限，已停止扫码；你可以稍后自行在微信设置中允许相机访问';
const scanFailed = '扫码未完成，请稍后主动重试';

/**
 * Keep this instance across page hide/show, and dispose it on unload. Native
 * scanning may hide the page; only its sanitized outcome survives that boundary.
 * Normal modal/navigation callbacks never survive hide or a login-owner change.
 */
export class ProfileScanner {
  private visible = true;
  private disposed = false;
  private phase: ScanPhase = 'idle';
  private generation = 0;
  private owner: SessionTicket | null = null;
  private pending: ScanOutcome | null = null;
  private view = initialProfileScanView();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly native: ProfileScannerNative,
    private readonly sessions: SessionStore,
    private readonly render: (view: ProfileScanView) => void,
  ) {
    this.unsubscribe = sessions.subscribe(() => {
      if (this.owner && !this.ownerCurrent()) this.invalidate();
    });
  }

  snapshot(): ProfileScanView {
    return this.view;
  }

  scan(): void {
    if (this.disposed || !this.visible || this.phase !== 'idle') return;
    if (
      !this.native.scanCode ||
      !this.native.showModal ||
      !this.native.navigateTo
    ) {
      this.publish({ busy: false, error: unavailable });
      return;
    }
    const owner = this.sessions.snapshot();
    if (!owner.credentials) {
      this.publish({ busy: false, error: '请先登录后扫码' });
      return;
    }
    this.owner = owner;
    const generation = ++this.generation;
    this.phase = 'preflight';
    this.publish({ busy: true, error: '' });
    try {
      this.native.showModal({
        title: '扫一扫',
        content:
          '继续后将打开微信相机扫描二维码。仅支持 WhaleU 公开主页和帖子，不会自动修改相机权限或执行二维码中的操作。',
        success: (result) => {
          if (!this.current(generation, 'preflight') || !this.visible) return;
          if (result.confirm !== true) {
            this.finish();
            return;
          }
          this.openCamera(generation);
        },
        fail: () => {
          if (this.current(generation, 'preflight')) this.finish(scanFailed);
        },
      });
    } catch {
      if (this.current(generation, 'preflight')) this.finish(scanFailed);
    }
  }

  onHide(): void {
    if (this.disposed) return;
    this.visible = false;
    if (this.phase === 'scanning' || this.phase === 'pending') {
      this.publish({ busy: true, error: '' });
      return;
    }
    this.invalidate();
  }

  onShow(): void {
    if (this.disposed) return;
    this.visible = true;
    if (this.phase !== 'pending') return;
    if (!this.ownerCurrent()) {
      this.invalidate();
      return;
    }
    const outcome = this.pending;
    this.pending = null;
    if (outcome) this.handleOutcome(outcome, this.generation);
    else this.finish();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    this.unsubscribe();
  }

  private ownerCurrent(): boolean {
    if (!this.owner?.credentials) return false;
    try {
      this.sessions.assertCurrent(this.owner);
      return true;
    } catch {
      return false;
    }
  }

  private current(generation: number, phase: ScanPhase): boolean {
    return (
      !this.disposed &&
      this.generation === generation &&
      this.phase === phase &&
      this.ownerCurrent()
    );
  }

  private openCamera(generation: number): void {
    this.phase = 'scanning';
    try {
      this.native.scanCode!({
        onlyFromCamera: true,
        scanType: ['qrCode'],
        success: (result) => {
          if (!this.current(generation, 'scanning')) return;
          // Never use result.path: WeChat/native paths are untrusted too.
          const route = parseProfileScanRoute(result?.result);
          this.acceptOutcome(
            route ? { route } : { error: unreadable },
            generation,
          );
        },
        fail: (error) => {
          if (!this.current(generation, 'scanning')) return;
          // Inspect only to select fixed text; never render/log/store native errors.
          const message =
            isRecord(error) && typeof error.errMsg === 'string'
              ? error.errMsg
              : '';
          const cancelled = /cancel/i.test(message);
          const denied = /auth|permission|denied|authorize/i.test(message);
          this.acceptOutcome(
            { error: cancelled ? '' : denied ? cameraDenied : scanFailed },
            generation,
          );
        },
      });
    } catch {
      if (this.current(generation, 'scanning'))
        this.acceptOutcome({ error: scanFailed }, generation);
    }
  }

  private acceptOutcome(outcome: ScanOutcome, generation: number): void {
    // Move out of scanning before any external callback can fire a second time.
    this.phase = 'pending';
    if (!this.visible) {
      this.pending = outcome;
      return;
    }
    this.handleOutcome(outcome, generation);
  }

  private handleOutcome(outcome: ScanOutcome, generation: number): void {
    if (!outcome.route) {
      this.finish(outcome.error);
      return;
    }
    const route = outcome.route;
    this.phase = 'confirming';
    try {
      this.native.showModal!({
        title: route.kind === 'profile' ? '打开公开主页' : '打开社区帖子',
        content:
          route.kind === 'profile'
            ? '识别到 WhaleU 公开主页。是否在小程序内打开？'
            : '识别到 WhaleU 社区帖子。是否在小程序内打开？',
        success: (result) => {
          if (!this.current(generation, 'confirming') || !this.visible) return;
          if (result.confirm !== true) {
            this.finish();
            return;
          }
          this.phase = 'navigating';
          try {
            this.native.navigateTo!({
              url: route.path,
              success: () => {
                if (this.current(generation, 'navigating')) this.finish();
              },
              fail: () => {
                if (this.current(generation, 'navigating'))
                  this.finish('暂时无法打开，请稍后重试');
              },
            });
          } catch {
            if (this.current(generation, 'navigating'))
              this.finish('暂时无法打开，请稍后重试');
          }
        },
        fail: () => {
          if (this.current(generation, 'confirming')) this.finish(scanFailed);
        },
      });
    } catch {
      if (this.current(generation, 'confirming')) this.finish(scanFailed);
    }
  }

  private finish(error = ''): void {
    this.generation++;
    this.phase = 'idle';
    this.owner = null;
    this.pending = null;
    this.publish({ busy: false, error: this.visible ? error : '' });
  }

  private invalidate(): void {
    this.finish();
  }

  private publish(view: ProfileScanView): void {
    this.view = Object.freeze(view);
    if (!this.disposed) this.render(this.view);
  }
}
