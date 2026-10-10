import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { RatingScopedCampusProof } from '../../campus/rating-scoped-context.facade.js';
import { RatingScopedSourceFacade } from './source.facade.js';
import {
  RatingScopedCatalogCompiler,
  RatingScopedCompilationBudget,
} from './compiler.js';
import { ratingScopedDigest } from './protocol-registry.js';
import { RATING_SCOPED_COMPILER_VERSION } from './constants.js';
interface PublicationFact {
  scopeKeys: readonly string[];
  logicalKeys: readonly string[];
  fingerprint: string;
}
async function publicationSnapshot(
  scopeKeys: readonly string[],
  logicalKeys: readonly string[],
  tx: PoolClient,
) {
  const row = (
    await tx.query<{ state: unknown }>(
      `SELECT jsonb_build_object(
  'sourceEpoch',(SELECT epoch::text FROM whaleu_ratings.scoped_source_epoch WHERE singleton AND version=1),
  'protocolEpoch',(SELECT epoch::text FROM whaleu_ratings.scope_protocol_epoch WHERE singleton AND version=1),
  'navigationEpoch',(SELECT epoch::text FROM whaleu_ratings.navigation_epoch WHERE singleton AND version=1),
  'poolEpoch',(SELECT epoch::text FROM whaleu_ratings.random_pool_epoch WHERE singleton AND version=1),
  'heads',whaleu_ratings.scoped_head_tuples($1::text[]),
  'protocols',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY logical_scope_key),'[]'::jsonb) FROM whaleu_ratings.scope_protocol_heads h WHERE logical_scope_key=ANY($2::text[])),
  'compat',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY compat_key),'[]'::jsonb) FROM whaleu_ratings.compat_heads h WHERE compat_key=ANY(ARRAY(SELECT CASE WHEN k='global' THEN 'global_compat' ELSE 'region_compat:'||k END FROM unnest($2::text[]) k)))) state`,
      [scopeKeys, logicalKeys],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('RATING_UNAVAILABLE');
  return ownerFingerprint(row.state);
}
const publicationProof: RequiredTransactionProof<PublicationFact> = {
  maximumFacts: 1,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      if (facts.length !== 1) throw new ApplicationError('RATING_UNAVAILABLE');
      const fact = facts[0]!;
      await read.query(
        'LOCK TABLE whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch,whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN SHARE MODE NOWAIT',
      );
      if (
        fact.fingerprint !==
        (await publicationSnapshot(fact.scopeKeys, fact.logicalKeys, read))
      )
        throw new ApplicationError('RATING_UNAVAILABLE');
    }),
};
export type ScopedReleaseCause =
  | {
      kind: 'source_release';
      issuanceSourceId: string;
      issuanceSourceRevision: string;
    }
  | {
      kind: 'create_target_scoped' | 'category_management';
      accountId: string;
      requestId: string;
    }
  | {
      kind: 'legacy_bridge';
      accountId: string;
      requestId: string;
      bridgeId: string;
    }
  | {
      kind: 'protocol_activation';
      generation: string;
      capabilitySourceId: string;
      capabilitySourceRevision: string;
      logicalScopeKeys: readonly string[];
    };
@Injectable()
export class RatingScopedReleaseRepository {
  constructor(
    @Inject(RatingScopedSourceFacade)
    private readonly sources: RatingScopedSourceFacade,
  ) {}
  async publish(
    proof: RatingScopedCampusProof,
    cause: ScopedReleaseCause,
    tx: PoolClient,
  ) {
    return this.publishMany([proof], cause, tx);
  }
  async publishMany(
    proofs: readonly RatingScopedCampusProof[],
    cause: ScopedReleaseCause,
    tx: PoolClient,
  ) {
    if (!proofs.length || proofs.length > 1001)
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const proof = proofs[0]!;
    const scopeKeys = proofs.flatMap((p) => [...p.scopeKeys]).sort();
    if (
      scopeKeys.length > 1001 ||
      new Set(scopeKeys).size !== scopeKeys.length ||
      proofs.some(
        (p) =>
          p.topologySnapshotId !== proof.topologySnapshotId ||
          p.topologyRevision !== proof.topologyRevision ||
          p.inventoryFingerprint !== proof.inventoryFingerprint,
      )
    )
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0))",
    );
    await tx.query(
      'LOCK TABLE whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch,whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE',
    );
    const budget = new RatingScopedCompilationBudget();
    // compilerInputs validates each original owner-branded proof. An object
    // spread cannot mint authority for a combined or inferred domain.
    const inputs = [];
    for (const domain of proofs)
      inputs.push(...(await this.sources.compilerInputs(domain, tx, budget)));
    inputs.sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
    const outputs = new RatingScopedCatalogCompiler().compile(inputs, budget),
      releaseId = randomUUID();
    const sourceVector = (
      await tx.query<{ vector: unknown[] }>(
        'SELECT whaleu_ratings.scoped_current_source_vector($1::text[]) vector',
        [scopeKeys],
      )
    ).rows[0]!.vector;
    const sourceDigest = ratingScopedDigest('vector', sourceVector),
      validUntil = new Date(
        Math.min(...outputs.map((o) => o.validUntil.getTime())),
      );
    budget.observe({
      sourceVector,
      cause,
      negative: proof.inventoryFingerprint,
    });
    await tx.query(
      `INSERT INTO whaleu_ratings.scoped_releases(id,compiler_version,cause_kind,cause,source_vector,source_digest,affected_scope_keys,negative_digest,valid_until) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)`,
      [
        releaseId,
        RATING_SCOPED_COMPILER_VERSION,
        cause.kind,
        JSON.stringify({
          ...cause,
          sourceDigest,
          topologySnapshotId: proof.topologySnapshotId,
          inventoryFingerprint: proof.inventoryFingerprint,
        }),
        JSON.stringify(sourceVector),
        sourceDigest,
        scopeKeys,
        ratingScopedDigest('negative', {
          inventory: proof.inventoryFingerprint,
          sources: sourceVector,
        }),
        validUntil,
      ],
    );
    for (const out of outputs) {
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_catalogs(id,scope_key,campus_id,region_id,head_revision,release_id,source_vector,source_digest,category_count,membership_count,category_digest,membership_digest,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)`,
        [
          out.id,
          out.scopeKey,
          out.campusId,
          out.regionId,
          out.headRevision,
          releaseId,
          JSON.stringify(out.sourceVector),
          out.sourceDigest,
          out.categories.length,
          out.memberships.length,
          out.categoryDigest,
          out.membershipDigest,
          out.validUntil,
        ],
      );
      const rows = out.categories.map((c) => ({
        catalogId: out.id,
        categoryId: c.expected.body.id,
        revision: c.revision,
        digest: c.digest,
        ...c.expected.body,
        expected: c.expected,
      }));
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_categories(catalog_id,category_id,effective_revision,effective_digest,parent_id,level,kind,system_key,is_system,origin_kind,name,description,active,hidden,ordinal)
    SELECT (r->>'catalogId')::uuid,(r->>'categoryId')::uuid,(r->>'revision')::uuid,r->>'digest',(r->>'parentId')::uuid,(r->>'level')::integer,r->>'kind',r->>'systemKey',(r->>'isSystem')::boolean,r->>'originKind',r->>'name',r->>'description',(r->>'active')::boolean,(r->>'hidden')::boolean,(r->>'ordinal')::bigint FROM jsonb_array_elements($1::jsonb) r`,
        [JSON.stringify(rows)],
      );
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_category_lineage(catalog_id,category_id,effective_revision,identity_kind,identity_id,base_source_id,base_source_revision,override_source_id,override_source_revision,lifecycle_source_id,lifecycle_source_revision,order_source_id,order_source_revision,placement_revision,proof)
    SELECT (r->>'catalogId')::uuid,(r->>'categoryId')::uuid,(r->>'revision')::uuid,r->>'identityKind',(r->>'identityId')::uuid,(r->'expected'->>'baseSourceId')::uuid,(r->'expected'->>'baseSourceRevision')::uuid,(r->'expected'->>'overrideSourceId')::uuid,(r->'expected'->>'overrideSourceRevision')::uuid,(r->'expected'->>'lifecycleSourceId')::uuid,(r->'expected'->>'lifecycleSourceRevision')::uuid,(r->'expected'->>'orderSourceId')::uuid,(r->'expected'->>'orderSourceRevision')::uuid,(r->'expected'->>'placementRevision')::uuid,r->'expected' FROM jsonb_array_elements($1::jsonb) r`,
        [JSON.stringify(rows)],
      );
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_target_memberships(catalog_id,target_id,category_id,ordinal,placement_revision) SELECT $1,(r->>'targetId')::uuid,(r->>'categoryId')::uuid,(r->>'ordinal')::bigint,(r->>'placementRevision')::uuid FROM jsonb_array_elements($2::jsonb) r`,
        [out.id, JSON.stringify(out.memberships)],
      );
      await tx.query(
        'UPDATE whaleu_ratings.scoped_catalogs SET sealed=true WHERE id=$1',
        [out.id],
      );
      await tx.query(
        'INSERT INTO whaleu_ratings.scoped_release_scopes(release_id,scope_key,before_catalog_id,before_head_revision,after_catalog_id,after_head_revision) VALUES($1,$2,$3,$4,$5,$6)',
        [
          releaseId,
          out.scopeKey,
          out.before?.catalogId ?? null,
          out.before?.headRevision ?? null,
          out.id,
          out.headRevision,
        ],
      );
      const changed = out.before
        ? await tx.query(
            `UPDATE whaleu_ratings.scoped_catalog_heads SET catalog_id=$2,release_id=$3,head_revision=$4 WHERE scope_key=$1 AND catalog_id=$5 AND head_revision=$6`,
            [
              out.scopeKey,
              out.id,
              releaseId,
              out.headRevision,
              out.before.catalogId,
              out.before.headRevision,
            ],
          )
        : await tx.query(
            `INSERT INTO whaleu_ratings.scoped_catalog_heads(scope_key,catalog_id,release_id,head_revision) VALUES($1,$2,$3,$4) ON CONFLICT(scope_key) DO NOTHING`,
            [out.scopeKey, out.id, releaseId, out.headRevision],
          );
      if (changed.rowCount !== 1)
        throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
    }
    if (cause.kind === 'protocol_activation')
      await tx.query('SELECT whaleu_ratings.activate_rating_scopes($1)', [
        releaseId,
      ]);
    else if (cause.kind === 'legacy_bridge')
      await tx.query('SELECT whaleu_ratings.publish_legacy_bridge_compat($1)', [
        releaseId,
      ]);
    else
      await tx.query('SELECT whaleu_ratings.publish_scoped_compat($1)', [
        releaseId,
      ]);
    const logicalKeys = [
      ...new Set(outputs.map((o) => o.regionId ?? 'global')),
    ].sort();
    enableRequiredTransactionProof(tx, publicationProof);
    registerRequiredTransactionFact(
      tx,
      publicationProof,
      releaseId,
      Object.freeze({
        scopeKeys,
        logicalKeys,
        fingerprint: await publicationSnapshot(scopeKeys, logicalKeys, tx),
      }),
    );
    return { releaseId, sourceDigest, outputs, budget: budget.snapshot() };
  }
}
