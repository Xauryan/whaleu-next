import type { CommunityRuntime } from '../community/runtime';
import type { ErrandAdminCommandsGateway } from './admin-command-gateway';
import type { PendingErrandAdminStore } from './admin-pending';
/** Additive surface kept separate from the E1 lifecycle journal. */
export interface ErrandAdminRuntime extends CommunityRuntime {
  readonly errandAdminCommands?: ErrandAdminCommandsGateway;
  readonly pendingErrandAdmin?: PendingErrandAdminStore;
}
