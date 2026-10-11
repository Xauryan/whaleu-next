import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  CategoryIconMediaReadRequest,
  AuthorizedCategoryIconMediaRead,
} from '../../../src/media/category-icon-owner-proof.js';
import { CategoryIconMediaProofRegistry } from '../../../src/media/category-icon-owner-proof.js';
import { sealManifest } from '../../../src/media/manifest.js';
import { manifestFixture } from './discovery-manifest.js';

/** Pure trusted test DI. No provider, owner inference or normal runtime wiring. */
export function categoryIconReadFixture() {
  const actor = randomUUID(),
    viewer = randomUUID();
  const request: CategoryIconMediaReadRequest = {
    categoryId: randomUUID(),
    contextId: randomUUID(),
    contextToken: 'a'.repeat(43),
    appearanceId: randomUUID(),
    requestId: randomUUID(),
    purpose: 'list-projection',
  };
  const authority: AuthorizedCategoryIconMediaRead = {
    principal: {
      kind: 'authenticatedRatings',
      accountId: viewer,
      sessionId: randomUUID(),
    },
    actorAccountId: actor,
    categoryId: request.categoryId,
    parent: {
      ownerKind: 'ratings',
      resourceKind: 'category_icon',
      resourceId: request.appearanceId,
      contentVersion: 1,
    },
    assetId: randomUUID(),
    manifestDigest: 'a'.repeat(64),
    bindingId: randomUUID(),
    ownerRevision: 'b'.repeat(64),
    reviewRevision: 'c'.repeat(64),
    qualification: {
      releaseId: randomUUID(),
      catalogId: randomUUID(),
      effectiveRevision: randomUUID(),
      identityId: randomUUID(),
      baseSource: { id: randomUUID(), revision: randomUUID() },
      overrideSource: null,
      definitionId: randomUUID(),
      extensionDigest: 'd'.repeat(64),
    },
  };
  const registry = new CategoryIconMediaProofRegistry({
    async authorizeCurrent(credential) {
      if (credential !== 'valid-token') throw new Error('Invalid session');
      return authority;
    },
  });
  return { actor, viewer, request, authority, registry };
}
export function categoryIconAssetRow(actor: string, id = randomUUID()) {
  const sealed = sealManifest(manifestFixture());
  return {
    id,
    actor_id: actor,
    intent_id: randomUUID(),
    owner_kind: 'ratings',
    resource_kind: 'category_icon',
    purpose: 'ratings-category-icon-image',
    audience: 'content-gated',
    target_kind: 'edit',
    resource_id: randomUUID(),
    scope_revision: 'a'.repeat(64),
    slot: 'icon',
    ordinal: 0,
    content_version: '1',
    protocol_version: 8,
    created_at: new Date(),
    manifest_digest: sealed.digest,
    manifest: sealed.manifest,
    policy_revision: 'media-static-v1',
  };
}
/** Synthetic final-proof metadata; each query is retained for lock-order tests. */
export function categoryIconQueryClient(
  handler?: (
    sql: string,
    values: unknown[],
  ) => { rows: unknown[]; rowCount?: number } | undefined,
) {
  let epoch = 0;
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      const custom = handler?.(sql, values);
      if (custom) return custom;
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              capacity: 32,
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
          rowCount: 1,
        };
      if (sql.startsWith('SELECT slot,version,epoch::text'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: String(epoch),
          })),
          rowCount: 128,
        };
      if (sql.startsWith('SELECT clock_timestamp()'))
        return { rows: [{ now: new Date() }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  return {
    tx,
    calls,
    bump: () => {
      epoch++;
    },
  };
}
