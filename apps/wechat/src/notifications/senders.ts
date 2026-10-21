import type { ApiClient } from '../api/client';
import type { CommunityRuntime } from '../community/runtime';
import { SystemTimelineController } from './system-timeline';
export { systemNoticeSummary } from './system-summary';
export interface NoticeSenderSnapshot {
  readonly kind: 'activity' | 'system';
  readonly name: string;
  readonly url: string;
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly error: string;
  readonly latest: {
    readonly summary: string;
    readonly createdAt: string;
  } | null;
  readonly unreadCount: number | null;
  readonly hasUnread: boolean;
  readonly partial: boolean;
}

export const initialNoticeSenders = (): readonly NoticeSenderSnapshot[] => [];
/** Actual events only. Loading this projection never acknowledges any owner notice. */
export class NoticeSendersController {
  private rows: readonly NoticeSenderSnapshot[] = [];
  private readonly reader: SystemTimelineController;
  private disposed = false;
  constructor(
    runtime: CommunityRuntime,
    private readonly render: (rows: readonly NoticeSenderSnapshot[]) => void,
    api?: ApiClient,
  ) {
    this.reader = new SystemTimelineController(
      runtime,
      (view) => {
        if (this.disposed) return;
        const latest = view.items[0];
        this.rows = latest
          ? [
              {
                kind: 'system',
                name: '系统消息',
                url: '/pages/system-notices/system-notices',
                loaded: view.loaded,
                busy: view.busy,
                error: '',
                latest: {
                  summary: latest.summary,
                  createdAt: latest.createdAt,
                },
                unreadCount: null,
                hasUnread: view.hasUnread,
                partial: view.sources.some((s) => !s.loaded),
              },
            ]
          : [];
        this.render(this.rows);
      },
      api,
    );
  }
  snapshot(): readonly NoticeSenderSnapshot[] {
    return this.rows;
  }
  async load(): Promise<void> {
    if (!this.disposed) await this.reader.load();
  }
  dispose(): void {
    this.disposed = true;
    this.reader.dispose();
    this.rows = [];
    this.render(this.rows);
  }
}
