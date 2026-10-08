import type {
  ErrandAdminOrder,
  ErrandAdminPage,
  ErrandAdminQuery,
} from '../src/errands/admin-contract';
import type { ErrandAdminGateway } from '../src/errands/admin-gateway';
import type { Authorization } from '../src/identity-privacy/overlay';
export const adminRegion = '11111111-1111-4111-8111-111111111111';
export const otherAdminRegion = '22222222-2222-4222-8222-222222222222';
export const adminOrderId = '33333333-3333-4333-8333-333333333333';
export const publicProfileId = '44444444-4444-4444-8444-444444444444';
export const adminTime = '2020-01-01T00:00:00.000Z';
export const adminCursor = 'a'.repeat(43);
export const nextAdminCursor = 'b'.repeat(43);
export const authorization = (
  role: Authorization['role'] = 'school_admin',
  ids = [adminRegion],
): Authorization => ({
  role,
  management: {
    global: role === 'developer' || role === 'super_admin',
    operatingRegionIds: role === 'member' ? [] : ids,
  },
  identityView: { allowed: role === 'developer', maxBatchSize: 20 },
});
export const adminQuery = (
  patch: Partial<ErrandAdminQuery> = {},
): ErrandAdminQuery => ({
  regionId: adminRegion,
  status: 'all',
  keyword: '',
  ...patch,
});
export const adminOrder = (
  patch: Partial<ErrandAdminOrder> = {},
): ErrandAdminOrder => ({
  id: adminOrderId,
  revision: publicProfileId,
  title: '合成历史订单',
  publicText: '合成公开说明',
  expectedTimeText: '某天下午',
  reward: '12.345678901234567890123456789',
  state: 'completed',
  displayState: 'deleted',
  createdAt: adminTime,
  acceptedAt: adminTime,
  completedAt: adminTime,
  cancelledAt: null,
  deletedAt: adminTime,
  deletionReason: { status: 'unavailable' },
  publisher: {
    status: 'available',
    profileId: publicProfileId,
    displayName: '合成发布者',
  },
  accepter: { status: 'unavailable' },
  relation: 'none',
  sourceRegion: { id: otherAdminRegion, status: 'unavailable' },
  targetRegion: {
    id: adminRegion,
    status: 'available',
    label: '合成目标地区',
    active: true,
  },
  ...patch,
});
export const adminPage = (
  patch: Partial<ErrandAdminPage> = {},
): ErrandAdminPage => ({
  context: {
    ...adminQuery(),
    management: 'fixed',
    search: {
      matcher: 'public-text-name-uuid-v1',
      legacyNumericReferences: 'unavailable',
    },
  },
  items: [adminOrder()],
  continuation: 'end',
  nextCursor: null,
  total: { status: 'known', value: '1' },
  ...patch,
});
export class FakeErrandAdminGateway implements ErrandAdminGateway {
  readonly calls: Array<{ method: string; args: readonly unknown[] }> = [];
  authorizationImpl: ErrandAdminGateway['authorization'] = async () =>
    authorization();
  listImpl: ErrandAdminGateway['list'] = async (query) =>
    adminPage({
      context: { ...adminPage().context, ...query },
      items:
        query.status === 'all' || query.status === 'deleted'
          ? [
              adminOrder({
                targetRegion: {
                  ...adminOrder().targetRegion,
                  id: query.regionId,
                },
              }),
            ]
          : [],
      total: /^[0-9]+$/.test(query.keyword)
        ? { status: 'unavailable' }
        : { status: 'known', value: '1' },
    });
  authorization(...args: Parameters<ErrandAdminGateway['authorization']>) {
    this.calls.push({ method: 'authorization', args });
    return this.authorizationImpl(...args);
  }
  list(...args: Parameters<ErrandAdminGateway['list']>) {
    this.calls.push({ method: 'list', args });
    return this.listImpl(...args);
  }
}
