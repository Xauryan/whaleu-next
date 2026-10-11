import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { startTransactionDeadlines } from '../src/database/transaction-deadlines.js';
import {
  CategoryIconMediaProofRegistry,
  categoryIconMediaQualificationSchema,
  type AuthorizedCategoryIconMediaRead,
  type CategoryIconMediaReadRequest,
} from '../src/media/category-icon-owner-proof.js';

const id = (n: number) =>
  `88000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const release = () => ({
  releaseId: id(1),
  catalogId: id(2),
  effectiveRevision: id(3),
  identityId: id(4),
  baseSource: { id: id(5), revision: id(6) },
  overrideSource: null,
  definitionId: id(7),
  extensionDigest: 'a'.repeat(64),
});
const management = () => ({
  kind: 'management-root' as const,
  rootDefinitionId: id(8),
  closureRevision: 'b'.repeat(64),
  identityId: id(4),
  baseSource: { id: id(5), revision: id(6) },
  overrideSource: { id: id(9), revision: id(10) },
  definitionId: id(7),
  definitionDigest: 'c'.repeat(64),
});
function fixture(
  purpose: CategoryIconMediaReadRequest['purpose'],
  qualification: unknown,
) {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const request: CategoryIconMediaReadRequest = {
    categoryId: id(20),
    appearanceId: id(21),
    contextId: id(22),
    contextToken: 'a'.repeat(43),
    purpose,
    requestId: id(23),
  };
  const authority = {
    principal: {
      kind: 'authenticatedRatings',
      accountId: id(24),
      sessionId: id(25),
    },
    actorAccountId: id(24),
    categoryId: id(20),
    parent: {
      ownerKind: 'ratings',
      resourceKind: 'category_icon',
      resourceId: id(21),
      contentVersion: 1,
    },
    assetId: id(26),
    manifestDigest: 'd'.repeat(64),
    bindingId: id(27),
    ownerRevision: 'e'.repeat(64),
    reviewRevision: 'f'.repeat(64),
    qualification,
  } as AuthorizedCategoryIconMediaRead;
  const registry = new CategoryIconMediaProofRegistry({
    async authorizeCurrent() {
      return authority;
    },
  });
  return { tx, request, authority, registry };
}
test('Category icon release qualification retains its exact undiscriminated public shape', () => {
  assert.deepEqual(
    categoryIconMediaQualificationSchema.parse(release()),
    release(),
  );
  assert.equal(
    'kind' in categoryIconMediaQualificationSchema.parse(release()),
    false,
  );
  for (const patch of [
    { kind: 'release' },
    { kind: 'management-root' },
    { rootDefinitionId: id(8) },
    { definitionDigest: 'c'.repeat(64) },
  ])
    assert.equal(
      categoryIconMediaQualificationSchema.safeParse({ ...release(), ...patch })
        .success,
      false,
    );
});
test('Category icon management qualification is strict and cannot contain release authority', () => {
  assert.deepEqual(
    categoryIconMediaQualificationSchema.parse(management()),
    management(),
  );
  for (const patch of [
    { releaseId: id(1) },
    { catalogId: id(2) },
    { effectiveRevision: id(3) },
    { extensionDigest: 'a'.repeat(64) },
    { closureRevision: id(1) },
    { rootDefinitionId: undefined },
    { kind: undefined },
  ])
    assert.equal(
      categoryIconMediaQualificationSchema.safeParse({
        ...management(),
        ...patch,
      }).success,
      false,
    );
});
test('Category icon management preview accepts only management-root proof, never a current public release proof', async () => {
  const f = fixture('management-preview', management());
  const proof = await f.registry.authorize('token', f.request, f.tx);
  const checked = f.registry.require(proof, f.request, f.tx);
  assert.deepEqual(checked.qualification, management());
  assert.ok(Object.isFrozen(checked.qualification));
  assert.ok(Object.isFrozen(checked.qualification.baseSource));
  assert.ok(Object.isFrozen(checked.qualification.overrideSource));
  const wrong = fixture('management-preview', release());
  await assert.rejects(
    wrong.registry.authorize('token', wrong.request, wrong.tx),
  );
});
test('Every public Category icon purpose rejects management-root qualification', async () => {
  for (const purpose of [
    'list-projection',
    'direct-content',
    'download',
  ] as const) {
    const wrong = fixture(purpose, management());
    await assert.rejects(
      wrong.registry.authorize('token', wrong.request, wrong.tx),
    );
    const valid = fixture(purpose, release());
    const proof = await valid.registry.authorize(
      'token',
      valid.request,
      valid.tx,
    );
    assert.deepEqual(
      valid.registry.require(proof, valid.request, valid.tx).qualification,
      release(),
    );
  }
});
test('Management proof remains bound to the exact purpose, request, transaction and read epoch', async () => {
  const f = fixture('management-preview', management());
  const proof = await f.registry.authorize('token', f.request, f.tx);
  for (const patch of [
    { purpose: 'download' as const },
    { appearanceId: id(99) },
    { contextId: id(99) },
    { requestId: id(99) },
  ])
    assert.throws(() =>
      f.registry.require(proof, { ...f.request, ...patch }, f.tx),
    );
  assert.throws(() => f.registry.require(proof, f.request, {} as PoolClient));
  startTransactionDeadlines(f.tx);
  assert.throws(() => f.registry.require(proof, f.request, f.tx));
});
