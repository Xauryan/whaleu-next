import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import { decodeErrandAdminAuthorization } from './admin-contract';
interface EntryView extends CommunityView {
  readonly allowed: boolean;
}
const initial = (): EntryView => ({
  ...initialCommunityView(),
  allowed: false,
});
/** The menu is advisory. Opening management performs its own fresh scope and server checks. */
export class ErrandAdminEntryController extends CommunityController<EntryView> {
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  constructor(runtime: CommunityRuntime, render: (view: EntryView) => void) {
    super(runtime, initial, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.stop();
      this.update({ allowed: false, busy: false });
    };
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeBrowse =
      runtime.browsingScopeChanges?.subscribe(invalidate) ?? (() => undefined);
  }
  async load(): Promise<void> {
    this.update({ allowed: false });
    if (!this.runtime.errandAdmin || !this.accountId()) return;
    await this.run(
      async (cancel) =>
        decodeErrandAdminAuthorization(
          await this.runtime.errandAdmin!.authorization(cancel),
        ),
      (auth) => this.update({ allowed: auth.role !== 'member' }),
      () => this.update({ allowed: false }),
    );
  }
  override dispose(): void {
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    super.dispose();
  }
}
