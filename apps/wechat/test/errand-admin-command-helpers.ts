import {
  ErrandAdminCommandController,
  initialErrandAdminCommandView,
} from '../src/errands/admin-command-controller';
import { errandAdminAuthority } from '../src/errands/admin-authority';
import type {
  ErrandAdminIntent,
  ErrandAdminReceipt,
} from '../src/errands/admin-command-contract';
import type { ErrandAdminCommandsGateway } from '../src/errands/admin-command-gateway';
import { PendingErrandAdminStore } from '../src/errands/admin-pending';
import type { ErrandAdminRuntime } from '../src/errands/admin-runtime';
import type {
  ErrandRestriction,
  ErrandRestrictionHistory,
  ErrandRestrictionPage,
} from '../src/errands/restriction-contract';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { SafetyChanges } from '../src/community/safety-changes';
import { setup, requestId } from './community-helpers';
import {
  adminOrder,
  adminOrderId,
  adminRegion,
  adminTime,
  authorization,
  publicProfileId,
} from './errand-admin-helpers';
export const restrictionId = '55555555-5555-4555-8555-555555555555';
export const eventId = '66666666-6666-4666-8666-666666666666';
export const mutationOrder = () =>
  adminOrder({
    displayState: 'completed',
    deletedAt: null,
    deletionReason: null,
  });
export const scope = () => errandAdminAuthority(authorization(), adminRegion);
export const globalScope = () =>
  errandAdminAuthority(authorization('developer'), null);
export const deleteIntent = (): ErrandAdminIntent => ({
  operation: 'admin_delete',
  orderId: adminOrderId,
  payload: {
    clientRequestId: requestId,
    expectedRevision: publicProfileId,
    deleteReason: '',
    publisherRestriction: null,
  },
});
export const applied = (
  intent: ErrandAdminIntent = deleteIntent(),
): ErrandAdminReceipt => {
  if (
    intent.operation === 'admin_delete' ||
    intent.operation === 'restrict_accepter'
  )
    return {
      requestId: intent.payload.clientRequestId,
      operation: intent.operation,
      outcome: 'applied',
      orderId: intent.orderId,
      revision:
        intent.operation === 'restrict_accepter'
          ? intent.payload.expectedRevision
          : eventId,
      occurredAt: adminTime,
    };
  return {
    requestId: intent.payload.clientRequestId,
    operation: intent.operation,
    outcome: 'applied',
    restrictionId:
      intent.operation === 'release' ? intent.restrictionId : restrictionId,
    eventId,
    occurredAt: adminTime,
  };
};
export const restriction = (
  patch: Partial<ErrandRestriction> = {},
): ErrandRestriction => ({
  restrictionId,
  subject: {
    status: 'available',
    profileId: publicProfileId,
    displayName: '合成受限账号',
  },
  action: 'all',
  reason: '合成理由',
  startsAt: adminTime,
  endsAt: null,
  state: 'active',
  origin: 'local',
  recordedAt: adminTime,
  operator: { status: 'unavailable' },
  source: { kind: 'global' },
  terminal: null,
  ...patch,
});
export const restrictionPage = (
  patch: Partial<ErrandRestrictionPage> = {},
): ErrandRestrictionPage => ({
  items: [restriction()],
  continuation: 'end',
  nextCursor: null,
  recordedTotal: { status: 'known', value: '1' },
  historyCoverage: 'unknown_before_boundary',
  ...patch,
});
export const restrictionHistory = (
  patch: Partial<ErrandRestrictionHistory> = {},
): ErrandRestrictionHistory => ({
  restriction: restriction(),
  events: [
    {
      eventId,
      kind: 'issued',
      effectiveAt: adminTime,
      recordedAt: adminTime,
      reason: '合成理由',
      operator: { status: 'unavailable' },
      replacementRestrictionId: null,
    },
  ],
  continuation: 'end',
  nextCursor: null,
  historyCoverage: 'unknown_before_boundary',
  ...patch,
});
export class FakeErrandAdminCommands implements ErrandAdminCommandsGateway {
  readonly calls: {
    method: keyof ErrandAdminCommandsGateway;
    args: readonly unknown[];
  }[] = [];
  authorizationImpl: ErrandAdminCommandsGateway['authorization'] = async () =>
    authorization();
  commandImpl: ErrandAdminCommandsGateway['command'] = async (intent) =>
    applied(intent);
  receiptImpl: ErrandAdminCommandsGateway['receipt'] = async (intent) =>
    applied(intent);
  restrictionsImpl: ErrandAdminCommandsGateway['restrictions'] = async () =>
    restrictionPage();
  historyImpl: ErrandAdminCommandsGateway['history'] = async () =>
    restrictionHistory();
  authorization(
    ...args: Parameters<ErrandAdminCommandsGateway['authorization']>
  ) {
    this.calls.push({ method: 'authorization', args });
    return this.authorizationImpl(...args);
  }
  command(...args: Parameters<ErrandAdminCommandsGateway['command']>) {
    this.calls.push({ method: 'command', args });
    return this.commandImpl(...args);
  }
  receipt(...args: Parameters<ErrandAdminCommandsGateway['receipt']>) {
    this.calls.push({ method: 'receipt', args });
    return this.receiptImpl(...args);
  }
  restrictions(
    ...args: Parameters<ErrandAdminCommandsGateway['restrictions']>
  ) {
    this.calls.push({ method: 'restrictions', args });
    return this.restrictionsImpl(...args);
  }
  history(...args: Parameters<ErrandAdminCommandsGateway['history']>) {
    this.calls.push({ method: 'history', args });
    return this.historyImpl(...args);
  }
}
export function commandHarness() {
  const s = setup(),
    gateway = new FakeErrandAdminCommands(),
    journal = new PendingErrandAdminStore(s.storage, 'synthetic');
  let view = initialErrandAdminCommandView(),
    lost = 0;
  const settled: ErrandAdminReceipt[] = [];
  const runtime: ErrandAdminRuntime = {
    ...s.runtime,
    errandAdminCommands: gateway,
    pendingErrandAdmin: journal,
    directoryScopeChanges: new PrivateViewLifecycle(),
    browsingScopeChanges: new PrivateViewLifecycle(),
    safetyChanges: new SafetyChanges(s.runtime.privateViews),
  };
  const controller = new ErrandAdminCommandController(
    runtime,
    (next) => {
      view = next;
    },
    (receipt) => {
      settled.push(receipt);
    },
    () => {
      lost++;
    },
  );
  return {
    ...s,
    runtime,
    gateway,
    journal,
    controller,
    view: () => view,
    commands: () => gateway.calls.filter((call) => call.method === 'command'),
    receipts: () => gateway.calls.filter((call) => call.method === 'receipt'),
    settled,
    lost: () => lost,
  };
}
