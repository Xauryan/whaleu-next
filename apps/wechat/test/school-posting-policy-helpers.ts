import { SessionStore } from '../src/auth/session';
import { postingPolicyCommandHash } from '../src/school-posting-policy/contract';
import type {
  PostingPolicyCommand,
  PostingPolicyInput,
  PostingPolicyReceipt,
  PostingPolicyView,
} from '../src/school-posting-policy/contract';
import {
  SchoolPostingPolicyController,
  initialSchoolPostingPolicyView,
} from '../src/school-posting-policy/controller';
import type { SchoolPostingPolicyGateway } from '../src/school-posting-policy/gateway';
import { PostingPolicyJournal } from '../src/school-posting-policy/pending';
import type { SchoolConfigurationGateway } from '../src/school-configuration/gateway';
import type { ProfileGateway } from '../src/profile/gateway';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
export const postingRegion = '33333333-3333-4333-8333-333333333333';
export const postingOther = '44444444-4444-4444-8444-444444444444';
export const postingRequest = '55555555-5555-4555-8555-555555555555';
export const postingRevisionId = '66666666-6666-4666-8666-666666666666';
export const postingOrigin = 'https://school-posting.invalid';
export const postingPolicy = (): PostingPolicyInput => ({
  unverifiedPostEnabled: true,
  unverifiedCommentEnabled: false,
  unverifiedCategories: ['discussion', 'pets'],
  expiry: { kind: 'policy_exempt' },
});
export const postingCommand = (): PostingPolicyCommand => ({
  clientRequestId: postingRequest,
  expectedRevision: 0,
  policy: postingPolicy(),
});
export function postingView(
  overrides: Partial<PostingPolicyView> = {},
): PostingPolicyView {
  return {
    context: {
      regionId: postingRegion,
      regionName: '合成大学',
      management: 'fixed',
    },
    revision: 0,
    revisionId: null,
    state: 'unconfigured',
    editable: true,
    blocker: null,
    policy: null,
    ...overrides,
  };
}
export function postingReceipt(
  command = postingCommand(),
  regionId = postingRegion,
  actorId = wireCredentials().accountId,
): PostingPolicyReceipt {
  return {
    requestId: command.clientRequestId,
    requestHash: postingPolicyCommandHash(actorId, regionId, command),
    regionId,
    revision: command.expectedRevision + 1,
    revisionId: postingRevisionId,
    outcome: 'saved',
  };
}
export function postingHarness() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const storage = new MemoryStorage(),
    journal = new PostingPolicyJournal(storage, postingOrigin);
  const calls = {
    capabilities: 0,
    management: [] as (string | null)[],
    saves: [] as PostingPolicyCommand[],
    ids: 0,
  };
  const gateway: SchoolPostingPolicyGateway = {
    management: async (regionId) => {
      calls.management.push(regionId);
      return postingView();
    },
    save: async (regionId, command) => {
      calls.saves.push(command);
      return postingReceipt(command, regionId);
    },
    recover: async (requestId) => ({ state: 'not_recorded', requestId }),
    cancel: async (requestId, requestHash) => ({
      state: 'cancelled',
      requestId,
      requestHash,
    }),
  };
  const schools: Pick<SchoolConfigurationGateway, 'capabilities' | 'public'> = {
    capabilities: async () => {
      calls.capabilities++;
      return {
        management: 'fixed',
        region: { id: postingRegion, name: '合成大学' },
      };
    },
    public: async (campusId) => ({
      context: {
        campusId,
        campusName: '合成校区',
        region: { id: postingRegion, name: '合成大学' },
      },
      entries: [],
    }),
  };
  const profiles: Pick<ProfileGateway, 'campuses'> = {
    campuses: async () => ({ items: [], page: 1, pageSize: 20, total: 0 }),
  };
  let view = initialSchoolPostingPolicyView();
  const newRequestId = async () => {
    calls.ids++;
    return postingRequest;
  };
  const create = (requestId = newRequestId) =>
    new SchoolPostingPolicyController(
      sessions,
      gateway,
      schools,
      profiles,
      journal,
      requestId,
      (next) => {
        view = next;
      },
      () => Date.parse('2026-10-11T00:00:00Z'),
    );
  return {
    sessions,
    storage,
    journal,
    calls,
    gateway,
    schools,
    profiles,
    create,
    view: () => view,
  };
}
