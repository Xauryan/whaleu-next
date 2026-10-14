import { dependencyRows } from '../../database/dependency-read-budget.js';
import { retainRatingReadBytes } from '../target-cover-current.js';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  canonicalEqual,
  canonicalJson,
} from '../../community/content-review/contracts.js';
import { ownerFingerprint } from '../../database/required-owner-proof.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import {
  ratingTargetBindingSchema,
  ratingTargetLinkCapabilitySchema,
  type RatingTargetBinding,
  type RatingTargetLinkReference,
} from '../../community/rating-target-link/contracts.js';
import type { Decision } from '../../community/community-policy.js';
import { RatingScopedContextService } from '../scoped/context.service.js';
import type {
  ResolvedRatingReadScope,
  ResolvedRatingScope,
} from '../scoped/context.service.js';
import { RatingScopedRepository } from '../scoped/repository.js';
import type { CurrentTargetRow, CategoryRow } from '../repository.js';

type Destination = {
  spaceId: string;
  category: 'discussion';
  authorMode: 'named' | 'anonymous';
};
interface Placement {
  target_id: string;
  origin_source_id: string;
  source_id: string;
  source_revision: string;
  placement_revision: string;
}
export interface QualifiedRatingTargetLink {
  binding: RatingTargetBinding;
  currentName: string;
  purpose: 'course' | 'canteen';
  sourceRevision: string;
  sourceDigest: string;
  validUntil: number;
}
export interface CurrentRatingTargetLink {
  name: string;
  generation: string;
  selector: RatingTargetBinding['selector'];
  validUntil: number;
}
function fail(): never {
  throw new ApplicationError('RATING_UNAVAILABLE');
}
/** Ratings owns identity continuity and public target qualification. Community
 * retains the immutable original binding; names are separately current-owned. */
@Injectable()
export class RatingTargetLinkFacade {
  constructor(
    @Inject(RatingScopedContextService)
    private readonly contexts: RatingScopedContextService,
    @Inject(RatingScopedRepository)
    private readonly records: RatingScopedRepository,
  ) {}
  private async placement(
    scope: ResolvedRatingReadScope,
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<Map<string, Placement>> {
    if (!ids.length) return new Map();
    const rows = await dependencyRows<Placement>(
      tx,
      `SELECT t.id target_id,t.source_id origin_source_id,p.source_id,p.source_revision,p.placement_revision
      FROM whaleu_ratings.scoped_target_memberships m JOIN whaleu_ratings.targets t ON t.id=m.target_id
      JOIN whaleu_ratings.target_scope_placements p ON (p.target_id,p.placement_revision)=(m.target_id,m.placement_revision)
      WHERE m.catalog_id=$1 AND m.target_id=ANY($2::uuid[]) AND $3=ANY(p.scope_keys)
      AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp())`,
      [scope.catalog.id, ids, scope.catalog.scopeKey],
      256,
    );
    retainRatingReadBytes(tx, rows);
    if (rows.length !== ids.length) fail();
    return new Map(rows.map((row) => [row.target_id, row]));
  }
  private async purposes(
    scope: ResolvedRatingReadScope,
    paths: readonly (readonly CategoryRow[])[],
    tx: PoolClient,
  ): Promise<ReadonlyMap<string, 'course' | 'canteen' | null | 'unknown'>> {
    if (paths.length > 256) fail();
    const result = new Map<string, 'course' | 'canteen' | null | 'unknown'>();
    const wanted: {
      leafId: string;
      categoryId: string;
      key: 'course' | 'canteen';
    }[] = [];
    for (const path of paths) {
      const current = path.at(-1),
        root = path[0];
      if (!current || !root) fail();
      const key = current.system_key ?? root.system_key;
      if (key !== 'course' && key !== 'canteen') {
        result.set(current.id, null);
        continue;
      }
      if (
        path.some((node) => node.system_key !== null && node.system_key !== key)
      ) {
        result.set(current.id, 'unknown');
        continue;
      }
      result.set(current.id, 'unknown');
      wanted.push({
        leafId: current.id,
        categoryId: current.system_key === null ? root.id : current.id,
        key,
      });
    }
    if (!wanted.length) return result;
    const rows = await dependencyRows<{
      leaf_id: string;
      valid: boolean;
      valid_until: Date;
    }>(
      tx,
      `SELECT w."leafId" leaf_id,
      registry.payload->>'systemKey'=w.key AND registry.payload->>'consumer'='ratings_general_v1'
      AND registry.payload->>'kind'=c.kind AND registry.payload->'enabled'='true'::jsonb
      AND l.proof->'body'->'isSystem'='true'::jsonb
      AND whaleu_ratings.scoped_source_current(registry.id,registry.revision,clock_timestamp()) valid,registry.valid_until
      FROM jsonb_to_recordset($2::jsonb) w("leafId" uuid,"categoryId" uuid,key text)
      JOIN whaleu_ratings.scoped_categories c ON c.catalog_id=$1 AND c.category_id=w."categoryId"
      JOIN whaleu_ratings.scoped_category_lineage l ON (l.catalog_id,l.category_id,l.effective_revision)=(c.catalog_id,c.category_id,c.effective_revision)
      JOIN whaleu_ratings.scoped_source_attestations base ON (base.id,base.revision)=(l.base_source_id,l.base_source_revision)
      JOIN whaleu_ratings.scoped_source_attestations registry ON registry.id::text=base.payload->>'registrySourceId' AND registry.revision::text=base.payload->>'registrySourceRevision'
      JOIN whaleu_ratings.scoped_source_heads h ON (h.source_id,h.source_revision)=(registry.id,registry.revision)
      WHERE registry.source_kind='scoped_category_system_registry'`,
      [scope.catalog.id, JSON.stringify(wanted)],
      256,
    );
    retainRatingReadBytes(tx, rows);
    for (const item of wanted) {
      const matches = rows.filter((row) => row.leaf_id === item.leafId);
      if (matches.length === 1 && matches[0]?.valid === true) {
        registerTransactionDeadline(
          tx,
          matches[0].valid_until.getTime(),
          'RATING_UNAVAILABLE',
        );
        result.set(item.leafId, item.key);
      }
    }
    return result;
  }
  private async purpose(
    scope: ResolvedRatingReadScope,
    path: readonly CategoryRow[],
    tx: PoolClient,
  ): Promise<'course' | 'canteen' | null> {
    const result = (await this.purposes(scope, [path], tx)).get(
      path.at(-1)!.id,
    );
    if (result === undefined || result === 'unknown') fail();
    return result;
  }
  private async snapshot(
    scope: ResolvedRatingReadScope,
    row: CurrentTargetRow,
    tx: PoolClient,
  ): Promise<QualifiedRatingTargetLink | null> {
    const path = await this.records.qualifiedPath(scope, row.category_id, tx);
    const purpose = await this.purpose(scope, path, tx);
    if (purpose === null) return null;
    const placement = (await this.placement(scope, [row.id], tx)).get(row.id)!;
    const binding = ratingTargetBindingSchema.parse({
      version: 1,
      targetId: row.id,
      categoryId: row.category_id,
      targetRevision: row.revision,
      definitionRevision: row.definition.definitionRevision,
      contentVersion: row.definition.contentVersion,
      originSourceId: placement.origin_source_id,
      sourceId: placement.source_id,
      sourceRevision: placement.source_revision,
      placementRevision: placement.placement_revision,
      categoryRevision: path.at(-1)!.revision,
      catalogId: scope.catalog.id,
      headRevision: scope.catalog.headRevision,
      protocolGeneration: scope.protocolGeneration,
      sourceDigest: scope.catalog.sourceDigest,
      selector: scope.selector,
      originRegionId: row.region_id,
      systemKey: purpose,
      ancestry: path.map((node) => ({
        categoryId: node.id,
        revision: node.revision,
      })),
    });
    await this.records.retainAfter(scope, tx);
    return {
      binding,
      currentName: row.name,
      purpose,
      sourceRevision: placement.source_revision,
      sourceDigest: createHash('sha256')
        .update(canonicalJson(binding))
        .digest('hex'),
      validUntil: scope.deadline,
    };
  }
  async capability(
    scope: ResolvedRatingScope,
    row: CurrentTargetRow,
    tx: PoolClient,
  ) {
    if (
      scope.context.mode !== 'public' ||
      !['read', 'interact'].includes(scope.context.purpose)
    )
      return undefined;
    const current = await this.snapshot(scope, row, tx);
    return current
      ? ratingTargetLinkCapabilitySchema.parse({
          systemKey: current.purpose,
          targetId: row.id,
          selector: scope.selector,
          expectedTargetRevision: row.revision,
          expectedCategoryRevision: current.binding.categoryRevision,
          expectedSourceRevision: current.sourceRevision,
        })
      : undefined;
  }
  async qualify(
    scope: ResolvedRatingReadScope,
    input: Omit<RatingTargetLinkReference, 'selector'> & {
      destination: Destination;
    },
    tx: PoolClient,
  ): Promise<QualifiedRatingTargetLink> {
    if (
      'context' in scope &&
      (scope.context.mode !== 'public' ||
        !['read', 'interact'].includes(scope.context.purpose))
    )
      fail();
    const space = (
      await tx.query<{
        operating_region_id: string | null;
        kind: string;
        is_active: boolean;
      }>(
        'SELECT operating_region_id,kind,is_active FROM whaleu_community.spaces WHERE id=$1 FOR SHARE',
        [input.destination.spaceId],
      )
    ).rows[0];
    if (
      !space ||
      !space.is_active ||
      space.kind !== 'regional' ||
      space.operating_region_id === null ||
      input.destination.category !== 'discussion' ||
      (scope.selector.kind === 'campus' &&
        scope.catalog.regionId !== space.operating_region_id)
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    const { row } = await this.records.target(scope, input.targetId, tx);
    const current = await this.snapshot(scope, row, tx);
    if (!current) throw new ApplicationError('RATING_NOT_FOUND');
    if (
      row.revision !== input.expectedTargetRevision ||
      current.binding.categoryRevision !== input.expectedCategoryRevision ||
      current.sourceRevision !== input.expectedSourceRevision
    )
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    return current;
  }
  async publication(
    actor: string,
    input: RatingTargetLinkReference,
    destination: Destination,
    tx: PoolClient,
  ) {
    const scope = await this.contexts.resolveRecipient(
      actor,
      input.selector,
      tx,
    );
    if (!canonicalEqual(scope.selector, input.selector))
      throw new ApplicationError('RATING_NOT_FOUND');
    return this.qualify(scope, { ...input, destination }, tx);
  }
  /** One target query per bounded vector, not a target read per post/count row. */
  async currentBatch(
    viewer: string | null,
    bindings: readonly RatingTargetBinding[],
    tx: PoolClient,
  ): Promise<ReadonlyMap<string, Decision<CurrentRatingTargetLink>>> {
    if (bindings.length > 256) fail();
    const result = new Map<string, Decision<CurrentRatingTargetLink>>();
    if (viewer === null) {
      for (const binding of bindings)
        result.set(canonicalJson(binding), {
          kind: 'deny',
          reason: 'POST_NOT_FOUND',
        });
      return result;
    }
    const groups = new Map<string, RatingTargetBinding[]>();
    for (const binding of bindings) {
      const key = binding.selector.kind,
        group = groups.get(key) ?? [];
      group.push(binding);
      groups.set(key, group);
    }
    for (const all of groups.values()) {
      try {
        // Campus semantics always resolve the viewer's one current identity, so
        // even 256 foreign-campus cards need at most one campus owner capture.
        const scope = await this.contexts.resolveRecipient(
          viewer,
          all[0]!.selector,
          tx,
        );
        const group = all.filter((binding) =>
          canonicalEqual(scope.selector, binding.selector),
        );
        for (const binding of all)
          if (!canonicalEqual(scope.selector, binding.selector))
            result.set(canonicalJson(binding), {
              kind: 'deny',
              reason: 'POST_NOT_FOUND',
            });
        if (!group.length) continue;
        const ids = [...new Set(group.map((b) => b.targetId))],
          decisions = await this.records.targetLinkBatch(scope, ids, tx),
          rows = new Map<string, CurrentTargetRow>();
        const paths = new Map<string, readonly CategoryRow[]>();
        for (const [id, decision] of decisions)
          if (decision.kind === 'allow') {
            const { row, path } = decision.value;
            rows.set(id, row);
            if (!paths.has(row.category_id)) paths.set(row.category_id, path);
          }
        const purposes = await this.purposes(scope, [...paths.values()], tx);
        const placement = await this.placement(scope, [...rows.keys()], tx);
        for (const binding of group) {
          const row = rows.get(binding.targetId),
            source = placement.get(binding.targetId);
          if (!row) {
            const decision = decisions.get(binding.targetId);
            result.set(
              canonicalJson(binding),
              decision?.kind === 'deny'
                ? { kind: 'deny', reason: 'POST_NOT_FOUND' }
                : { kind: 'unavailable' },
            );
            continue;
          }
          if (
            !source ||
            row.category_id !== binding.categoryId ||
            row.region_id !== binding.originRegionId ||
            source.origin_source_id !== binding.originSourceId
          ) {
            result.set(canonicalJson(binding), { kind: 'unavailable' });
            continue;
          }
          if (purposes.get(row.category_id) === 'unknown') {
            result.set(canonicalJson(binding), { kind: 'unavailable' });
            continue;
          }
          if (purposes.get(row.category_id) !== binding.systemKey) {
            result.set(canonicalJson(binding), {
              kind: 'deny',
              reason: 'POST_NOT_FOUND',
            });
            continue;
          }
          result.set(canonicalJson(binding), {
            kind: 'allow',
            value: {
              name: row.name,
              selector: scope.selector,
              validUntil: scope.deadline,
              generation: ownerFingerprint({
                targetId: row.id,
                revision: row.revision,
                definition: row.definition.definitionRevision,
                source,
                ancestry: paths
                  .get(row.category_id)!
                  .map((node) => ({ id: node.id, revision: node.revision })),
                catalog: scope.catalog,
                protocol: scope.protocolGeneration,
              }),
            },
          });
        }
        await this.records.retainAfter(scope, tx);
      } catch (error) {
        const denied =
          error instanceof ApplicationError &&
          [
            'AFFILIATION_VERIFICATION_REQUIRED',
            'PHONE_VERIFICATION_REQUIRED',
            'SAFETY_ACCESS_SUSPENDED',
          ].includes(error.code);
        for (const binding of all)
          result.set(
            canonicalJson(binding),
            denied
              ? { kind: 'deny', reason: 'POST_NOT_FOUND' }
              : { kind: 'unavailable' },
          );
      }
    }
    return result;
  }
}
