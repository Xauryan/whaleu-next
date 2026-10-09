import {
  baseView,
  MessagingController,
  type BaseView,
  type Render,
} from './controller';
import type { Coverage } from './contract';
import type { MessagingRuntime } from './runtime';
export interface UnreadView extends BaseView {
  readonly count: number | null;
  readonly coverage: Coverage | null;
}
export const initialUnreadView = (): UnreadView => ({
  ...baseView(),
  count: null,
  coverage: null,
});
export class MessagingUnreadController extends MessagingController<UnreadView> {
  constructor(runtime: MessagingRuntime, render: Render<UnreadView>) {
    super(runtime, initialUnreadView, render);
  }
  protected override invalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    await this.run(async (cancel, current) => {
      try {
        const result = await this.runtime.gateway!.unread(cancel);
        current();
        this.update({
          count: result.count,
          coverage: result.coverage,
          loaded: true,
          status:
            result.coverage === 'local' ? '已核验的本地私信未读' : '私信未读',
        });
      } catch (error) {
        current();
        this.update({ count: null, coverage: null, loaded: false });
        throw error;
      }
    });
    this.schedule(() => this.load(), 10000);
  }
}
