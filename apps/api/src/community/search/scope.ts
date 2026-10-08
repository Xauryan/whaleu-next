import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  CampusSearchRegionFacade,
  SEARCH_REGION_BATCH_LIMIT,
} from '../../campus/search-region.facade.js';
import { ApplicationError } from '../../http/application-error.js';
import type { CommunitySpace } from '../contracts.js';
import type { SearchSelector } from './contracts.js';

export const SEARCH_ENROLLMENT_VERSION = 'supported-space-categories-v1';
export const SEARCH_CATALOG_BATCH = 256;
const canonicalId = z.uuid().refine((id) => id === id.toLowerCase());
const spaceSchema = z
  .strictObject({
    id: canonicalId,
    kind: z.enum(['regional', 'global']),
    name: z.string(),
    isActive: z.literal(true),
    operatingRegionId: canonicalId.nullable(),
  })
  .refine(
    (space) =>
      (space.kind === 'regional') === (space.operatingRegionId !== null),
  );
export type SearchScopeMember = Readonly<CommunitySpace>;
export interface ResolvedSearchScope {
  readonly membershipFingerprint: string;
  readonly regionalSpaceIds: readonly string[];
  readonly globalSpaceIds: readonly string[];
  readonly members: readonly SearchScopeMember[];
  readonly space: (id: string) => SearchScopeMember | undefined;
}

/** Exact semantic membership; stable across names, caller order and batching.
 * Stream each descriptor, never put an unbounded member list in cursor JSON. */
export function searchMembershipFingerprint(
  selector: SearchSelector,
  members: readonly SearchScopeMember[],
): string {
  const hash = createHash('sha256').update(
    'whaleu-community-search-membership:v2\n',
  );
  hash.update(JSON.stringify([selector, SEARCH_ENROLLMENT_VERSION]) + '\n');
  let previous: string | null = null;
  for (const member of [...members].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    const parsed = spaceSchema.safeParse(member);
    if (
      !parsed.success ||
      member.id === previous ||
      (selector !== 'all' && member.kind !== selector)
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    hash.update(
      JSON.stringify([
        member.id,
        member.kind,
        member.operatingRegionId,
        SEARCH_ENROLLMENT_VERSION,
      ]) + '\n',
    );
    previous = member.id;
  }
  return hash.digest('hex');
}

/** Complete transaction-local catalog, not a public source inventory. The
 * shared common gate must precede this read and be retained through commit.
 * Catalog writers own its exclusive mode before count-epoch or source locks. */
@Injectable()
export class CommunitySearchScopeResolver {
  constructor(
    @Inject(CampusSearchRegionFacade)
    private readonly campuses: CampusSearchRegionFacade,
  ) {}
  async resolve(
    selector: SearchSelector,
    tx: PoolClient,
  ): Promise<ResolvedSearchScope> {
    try {
      const catalog: SearchScopeMember[] = [];
      let after: string | null = null;
      for (;;) {
        const result = await tx.query<CommunitySpace>(
          `SELECT id,kind,name,is_active AS "isActive",operating_region_id AS "operatingRegionId"
           FROM whaleu_community.spaces
           WHERE is_active AND kind IN ('regional','global') AND ($1::text='all' OR kind=$1)
             AND ($2::uuid IS NULL OR id>$2::uuid)
           ORDER BY id LIMIT ${SEARCH_CATALOG_BATCH} FOR SHARE`,
          [selector, after],
        );
        if (result.rows.length > SEARCH_CATALOG_BATCH)
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        if (!result.rows.length) break;
        const ids: string[] = [];
        for (const raw of result.rows) {
          const parsed = spaceSchema.safeParse(raw);
          if (
            !parsed.success ||
            (after !== null && parsed.data.id <= after) ||
            (selector !== 'all' && parsed.data.kind !== selector)
          )
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          ids.push(parsed.data.id);
          after = parsed.data.id;
        }
        // Fresh facts after all batch row waits, with no partial-list fallback.
        const reread = await tx.query<CommunitySpace>(
          `SELECT id,kind,name,is_active AS "isActive",operating_region_id AS "operatingRegionId"
           FROM whaleu_community.spaces WHERE id=ANY($1::uuid[]) ORDER BY id`,
          [ids],
        );
        if (reread.rows.length !== ids.length)
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        for (const [index, raw] of reread.rows.entries()) {
          const parsed = spaceSchema.safeParse(raw);
          if (
            !parsed.success ||
            parsed.data.id !== ids[index] ||
            (selector !== 'all' && parsed.data.kind !== selector)
          )
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          catalog.push(Object.freeze(parsed.data));
        }
        if (result.rows.length < SEARCH_CATALOG_BATCH) break;
      }
      // Collect before locking so owner-region locks are globally sorted even
      // when region IDs and community-space IDs have different order.
      const regionIds = [
        ...new Set(
          catalog.flatMap((space) =>
            space.operatingRegionId ? [space.operatingRegionId] : [],
          ),
        ),
      ].sort();
      const activity = new Map<string, boolean>();
      for (
        let offset = 0;
        offset < regionIds.length;
        offset += SEARCH_REGION_BATCH_LIMIT
      ) {
        const ids = regionIds.slice(offset, offset + SEARCH_REGION_BATCH_LIMIT);
        const batch = await this.campuses.readSearchRegionActivity(ids, tx);
        if (
          batch.size !== ids.length ||
          ids.some((id) => typeof batch.get(id) !== 'boolean')
        )
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        for (const id of ids) activity.set(id, batch.get(id)!);
      }
      const members = Object.freeze(
        catalog.filter(
          (space) =>
            space.kind === 'global' ||
            activity.get(space.operatingRegionId!) === true,
        ),
      );
      const byId = new Map(members.map((space) => [space.id, space]));
      return Object.freeze({
        membershipFingerprint: searchMembershipFingerprint(selector, members),
        members,
        regionalSpaceIds: Object.freeze(
          members
            .filter((space) => space.kind === 'regional')
            .map((space) => space.id),
        ),
        globalSpaceIds: Object.freeze(
          members
            .filter((space) => space.kind === 'global')
            .map((space) => space.id),
        ),
        space: (id: string) => byId.get(id),
      });
    } catch {
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }
  }
}
