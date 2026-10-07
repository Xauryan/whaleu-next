import { SessionStore } from '../src/auth/session';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import type {
  IdentityCampusIntent,
  IdentityCampusReceipt,
  IdentityCampusState,
  IdentityCampusSummary,
} from '../src/identity-campus/contract';
import type { IdentityCampusGateway } from '../src/identity-campus/gateway';
import { PendingIdentityCampusStore } from '../src/identity-campus/pending';
import type { IdentityCampusRuntime } from '../src/identity-campus/runtime';
import {
  IdentityCampusController,
  initialIdentityCampusView,
} from '../src/pages/identity-campus/controller';
import type { Cancellation } from '../src/platform/contracts';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
export const campusId = '33333333-3333-4333-8333-333333333333';
export const otherCampusId = '44444444-4444-4444-8444-444444444444';
export const requestId = '77777777-7777-4777-8777-777777777777';
export const revision = `ic1:${'a'.repeat(64)}`;
export const campus = (id = campusId): IdentityCampusSummary => ({
  id,
  name: '合成物理校区',
  operatingRegion: {
    id: '55555555-5555-4555-8555-555555555555',
    name: '合成运营地区',
  },
});
export const state = (
  overrides: Partial<IdentityCampusState> = {},
): IdentityCampusState => ({
  affiliation: 'verified',
  selection: 'unavailable',
  reason: 'history_unknown',
  selectedCampus: null,
  options: { status: 'known', items: [campus()] },
  writeEligibility: { phone: 'verified', safety: 'allowed' },
  canSelect: true,
  expectedStateRevision: revision,
  guidance: 'choose',
  ...overrides,
});
export const intent = (
  overrides: Partial<IdentityCampusIntent> = {},
): IdentityCampusIntent => ({
  requestId,
  campusId,
  expectedStateRevision: revision,
  ...overrides,
});
export const receipt = (
  overrides: Partial<IdentityCampusReceipt> = {},
): IdentityCampusReceipt => ({
  requestId,
  campusId,
  outcome: 'applied',
  selectionRevision: 1,
  ...overrides,
});
export class FakeIdentityCampusGateway implements IdentityCampusGateway {
  readonly calls: Array<{
    method: string;
    body?: IdentityCampusIntent | string;
    cancel: Cancellation;
  }> = [];
  stateImpl: IdentityCampusGateway['state'] = async () => state();
  selectImpl: IdentityCampusGateway['select'] = async (input) =>
    receipt({ requestId: input.requestId, campusId: input.campusId });
  receiptImpl: IdentityCampusGateway['receipt'] = async () => receipt();
  state(cancel: Cancellation) {
    this.calls.push({ method: 'state', cancel });
    return this.stateImpl(cancel);
  }
  select(input: IdentityCampusIntent, cancel: Cancellation) {
    this.calls.push({ method: 'select', body: input, cancel });
    return this.selectImpl(input, cancel);
  }
  receipt(requestId: string, cancel: Cancellation) {
    this.calls.push({ method: 'receipt', body: requestId, cancel });
    return this.receiptImpl(requestId, cancel);
  }
}
export function setup(loggedIn = true) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const storage = new MemoryStorage(),
    gateway = new FakeIdentityCampusGateway();
  const runtime: IdentityCampusRuntime = {
    sessions,
    gateway,
    pending: new PendingIdentityCampusStore(
      storage,
      'https://api.example.invalid',
    ),
    privateViews: new PrivateViewLifecycle(),
    newRequestId: async () => requestId,
  };
  let view = initialIdentityCampusView();
  const controller = new IdentityCampusController(runtime, (next) => {
    view = next;
  });
  return { sessions, storage, gateway, runtime, controller, view: () => view };
}
