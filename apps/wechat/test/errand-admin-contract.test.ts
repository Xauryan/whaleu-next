import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  canonicalErrandAdminKeyword,
  decodeErrandAdminAuthorization,
  decodeErrandAdminOrder,
  decodeErrandAdminPage,
  decodeErrandAdminQuery,
  errandAdminStatuses,
} from '../src/errands/admin-contract';
import { decodeErrandAdminRoute } from '../src/errands/admin-controller';
import {
  adminCursor,
  adminOrder,
  adminPage,
  adminQuery,
  adminRegion,
  authorization,
  otherAdminRegion,
} from './errand-admin-helpers';
const invalid = (fn: () => unknown) =>
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof ClientError && error.kind === 'protocol',
  );
test('administration decodes historical tombstones without rounding or overwriting lifecycle', () => {
  const row = decodeErrandAdminOrder(adminOrder());
  assert.equal(row.state, 'completed');
  assert.equal(row.displayState, 'deleted');
  assert.equal(row.reward, '12.345678901234567890123456789');
  assert.deepEqual(row.accepter, { status: 'unavailable' });
  assert.deepEqual(row.sourceRegion, {
    id: otherAdminRegion,
    status: 'unavailable',
  });
  assert.deepEqual(row.deletionReason, { status: 'unavailable' });
  assert.ok(Object.isFrozen(row));
  for (const status of errandAdminStatuses)
    assert.equal(decodeErrandAdminQuery(adminQuery({ status })).status, status);
});
test('all nested private, mutable-action and authority fields are rejected instead of stripped', () => {
  for (const key of [
    'privateText',
    'contacts',
    'contactHistory',
    'publisherAccountId',
    'studentNumber',
    'providerId',
    'review',
    'capabilities',
    'canDelete',
    'protectedTarget',
    'grantId',
  ]) {
    invalid(() =>
      decodeErrandAdminOrder({ ...adminOrder(), [key]: 'sentinel' }),
    );
    invalid(() =>
      decodeErrandAdminOrder({
        ...adminOrder(),
        publisher: { ...adminOrder().publisher, [key]: 'sentinel' },
      }),
    );
    invalid(() => decodeErrandAdminPage({ ...adminPage(), [key]: 'sentinel' }));
  }
  invalid(() =>
    decodeErrandAdminOrder({
      ...adminOrder(),
      sourceRegion: { ...adminOrder().sourceRegion, label: 'invented' },
    }),
  );
});
test('exact total discriminants cannot fabricate zero, estimates or numeric UID coverage', () => {
  assert.deepEqual(
    decodeErrandAdminPage(
      adminPage({ items: [], total: { status: 'known', value: '0' } }),
    ).total,
    { status: 'known', value: '0' },
  );
  assert.deepEqual(
    decodeErrandAdminPage(adminPage({ total: { status: 'unavailable' } }))
      .total,
    { status: 'unavailable' },
  );
  assert.equal(
    decodeErrandAdminPage(
      adminPage({ total: { status: 'known', value: '900719925474099300000' } }),
    ).total.status,
    'known',
  );
  for (const total of [
    { status: 'unavailable', value: '0' },
    { status: 'known', value: 1 },
    { status: 'known', value: '01' },
    { status: 'known', value: '-1' },
    { status: 'known', value: '0' },
    { status: 'estimated', value: '1' },
  ])
    invalid(() => decodeErrandAdminPage({ ...adminPage(), total }));
  invalid(() =>
    decodeErrandAdminPage(
      adminPage({ context: { ...adminPage().context, keyword: '12345' } }),
    ),
  );
  assert.equal(
    decodeErrandAdminPage(
      adminPage({
        context: { ...adminPage().context, keyword: '12345' },
        total: { status: 'unavailable' },
      }),
    ).total.status,
    'unavailable',
  );
});
test('status, context, version, lifecycle and continuation inconsistencies fail closed', () => {
  for (const patch of [
    { displayState: 'completed' },
    { state: 'pending' },
    { cancelledAt: 'bad' },
    { completedAt: null },
    { accepter: null },
    { deletionReason: null },
    { reward: '12.00' },
  ])
    invalid(() => decodeErrandAdminOrder({ ...adminOrder(), ...patch }));
  for (const patch of [
    { items: [adminOrder(), adminOrder()] },
    { context: { ...adminPage().context, regionId: otherAdminRegion } },
    { context: { ...adminPage().context, status: 'completed' } },
    { context: { ...adminPage().context, keyword: ' x ' } },
    {
      context: {
        ...adminPage().context,
        search: { matcher: 'v2', legacyNumericReferences: 'unavailable' },
      },
    },
    { nextCursor: adminCursor },
    { continuation: 'more' },
  ])
    invalid(() => decodeErrandAdminPage({ ...adminPage(), ...patch }));
  const sparse = decodeErrandAdminPage(
    adminPage({
      items: [],
      continuation: 'more',
      nextCursor: adminCursor,
      total: { status: 'unavailable' },
    }),
  );
  assert.equal(sparse.items.length, 0);
  assert.equal(sparse.continuation, 'more');
});
test('query and route require explicit public selectors; Unicode bounds and missing-grant capability contradictions reject', () => {
  assert.deepEqual(decodeErrandAdminRoute({}), {});
  assert.deepEqual(decodeErrandAdminRoute({ regionId: adminRegion }), {
    regionId: adminRegion,
  });
  for (const route of [
    { campusId: adminRegion },
    { schoolId: 12 },
    { role: 'developer' },
    { regionId: '123' },
    { regionId: adminRegion, keyword: 'private' },
  ])
    invalid(() => decodeErrandAdminRoute(route));
  assert.equal(canonicalErrandAdminKeyword('  123\r\n公开  '), '123\n公开');
  assert.equal([...canonicalErrandAdminKeyword('鲸'.repeat(100))].length, 100);
  for (const keyword of ['鲸'.repeat(101), '\ud800', '\u0000', 123])
    invalid(() => canonicalErrandAdminKeyword(keyword));
  invalid(() =>
    decodeErrandAdminQuery({ ...adminQuery(), accountId: adminRegion }),
  );
  invalid(() =>
    decodeErrandAdminAuthorization(authorization('school_admin', [])),
  );
  invalid(() =>
    decodeErrandAdminAuthorization(
      authorization('school_admin', [adminRegion, otherAdminRegion]),
    ),
  );
  invalid(() =>
    decodeErrandAdminAuthorization({
      ...authorization('member'),
      management: { global: true, operatingRegionIds: [] },
    }),
  );
});

test('historical timestamps retain causal order including offsets and microseconds', () => {
  const earlier = '2019-12-31T23:59:59.999Z';
  for (const patch of [
    { acceptedAt: earlier },
    { completedAt: earlier },
    { deletedAt: earlier },
    {
      state: 'cancelled',
      displayState: 'deleted',
      completedAt: null,
      cancelledAt: earlier,
    },
    { acceptedAt: '2020-01-02T00:00:00Z' },
    { completedAt: '2020-01-02T00:00:00Z' },
  ])
    invalid(() => decodeErrandAdminOrder({ ...adminOrder(), ...patch }));
  invalid(() =>
    decodeErrandAdminOrder({
      ...adminOrder(),
      createdAt: '2020-01-01T00:00:00.000002Z',
      acceptedAt: '2020-01-01T00:00:00.000001Z',
    }),
  );
  assert.equal(
    decodeErrandAdminOrder({
      ...adminOrder(),
      createdAt: '2020-01-01T01:00:00+01:00',
    }).createdAt,
    '2020-01-01T01:00:00+01:00',
  );
});

test('historical lifecycle and deletion chronology cannot move backwards', () => {
  const before = '2019-12-31T23:59:59.999Z';
  for (const patch of [
    { acceptedAt: before },
    { completedAt: before },
    { deletedAt: before },
    {
      state: 'cancelled',
      displayState: 'deleted',
      completedAt: null,
      cancelledAt: before,
    },
    {
      state: 'cancelled',
      displayState: 'deleted',
      acceptedAt: null,
      accepter: null,
      completedAt: null,
      cancelledAt: before,
    },
  ])
    invalid(() => decodeErrandAdminOrder({ ...adminOrder(), ...patch }));
});

test('historical region labels retain 200 Unicode code points without a UTF-16 truncation', () => {
  const targetRegion = {
    id: adminRegion,
    status: 'available',
    label: '🐋'.repeat(200),
    active: false,
  } as const;
  assert.equal(
    decodeErrandAdminOrder({ ...adminOrder(), targetRegion }).targetRegion
      .status,
    'available',
  );
  invalid(() =>
    decodeErrandAdminOrder({
      ...adminOrder(),
      targetRegion: { ...targetRegion, label: '🐋'.repeat(201) },
    }),
  );
});

test('new administrative tombstones preserve reason provided/not-provided while E1 historical reason stays unavailable', () => {
  for (const deletionReason of [
    { status: 'unavailable' },
    { status: 'not_provided' },
    { status: 'provided', value: '合成删除原因' },
  ]) {
    assert.deepEqual(
      decodeErrandAdminOrder({ ...adminOrder(), deletionReason })
        .deletionReason,
      deletionReason,
    );
  }
  for (const deletionReason of [
    { status: 'provided', value: '' },
    { status: 'provided', value: 'x'.repeat(501) },
    { status: 'provided', value: ' reason ' },
    { status: 'not_provided', value: '' },
  ]) {
    invalid(() => decodeErrandAdminOrder({ ...adminOrder(), deletionReason }));
  }
});
