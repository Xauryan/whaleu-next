import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CampusRatingScopedContextFacade } from '../../campus/rating-scoped-context.facade.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { RatingScopedReleaseRepository } from './release.repository.js';

export interface LegacyBridgeCatalogPlan {
  readonly logicalScopeKey: string;
  readonly beforeCatalogId: string;
  readonly afterCatalogId: string;
}
interface BridgeDomain {
  logicalScopeKey: string;
  scopeKeys: string[];
  validUntil: string;
}
interface BridgeRow {
  kind?: 'legacy_bridge' | 'legacy_boundary';
  bridgeId: string;
  revision: string;
  proof: {
    operation: string;
    intentHash: string;
    domains: BridgeDomain[];
    legacyCatalogs: LegacyBridgeCatalogPlan[];
    boundary?: { protocolTuples: { logicalScopeKey: string }[] };
  };
}
interface BridgeFact {
  actor: string;
  requestId: string;
  bridgeId: string;
  scopeKeys: string[];
  logicalKeys: string[];
  fingerprint: string;
}
const handles = new WeakMap<object, PoolClient>();
/** A handle is minted only after SQL has checked the original request, exact
 * original hash/preparation, all current domains and explicit source policy. */
export interface LegacyRatingBridge {
  readonly actor: string;
  readonly requestId: string;
  readonly row: BridgeRow;
}
async function snapshot(fact: Omit<BridgeFact, 'fingerprint'>, tx: PoolClient) {
  const row = (
    await tx.query<{ state: unknown }>(
      `SELECT jsonb_build_object(
      'sourceEpoch',(SELECT epoch::text FROM whaleu_ratings.scoped_source_epoch WHERE singleton AND version=1),
      'protocolEpoch',(SELECT epoch::text FROM whaleu_ratings.scope_protocol_epoch WHERE singleton AND version=1),
      'navigationEpoch',(SELECT epoch::text FROM whaleu_ratings.navigation_epoch WHERE singleton AND version=1),
      'poolEpoch',(SELECT epoch::text FROM whaleu_ratings.random_pool_epoch WHERE singleton AND version=1),
      'scopedHeads',whaleu_ratings.scoped_head_tuples($1::text[]),
      'legacyHeads',(SELECT jsonb_agg(to_jsonb(h) ORDER BY scope_key) FROM whaleu_ratings.catalog_heads h WHERE scope_key=ANY($2::text[])),
      'protocols',(SELECT jsonb_agg(to_jsonb(h) ORDER BY logical_scope_key) FROM whaleu_ratings.scope_protocol_heads h WHERE logical_scope_key=ANY($2::text[])),
      'compat',(SELECT jsonb_agg(to_jsonb(h) ORDER BY compat_key) FROM whaleu_ratings.compat_heads h WHERE compat_key=ANY(ARRAY(SELECT CASE WHEN key='global' THEN 'global_compat' ELSE 'region_compat:'||key END FROM unnest($2::text[]) key))),
      'request',(SELECT to_jsonb(q) FROM whaleu_ratings.requests q WHERE account_id=$3 AND request_id=$4),
      'cause',(SELECT to_jsonb(c) FROM whaleu_ratings.scoped_command_causes c WHERE account_id=$3 AND request_id=$4 AND cause_kind IN ('legacy_bridge','legacy_boundary') AND artifact_id=$5),
      'target',(SELECT jsonb_build_object('target',to_jsonb(t),'definition',to_jsonb(h)) FROM whaleu_ratings.requests q JOIN whaleu_ratings.targets t ON t.id=(q.receipt->>'targetId')::uuid LEFT JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id WHERE q.account_id=$3 AND q.request_id=$4)) state`,
      [
        fact.scopeKeys,
        fact.logicalKeys,
        fact.actor,
        fact.requestId,
        fact.bridgeId,
      ],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('RATING_UNAVAILABLE');
  return ownerFingerprint(row.state);
}
const bridgeProof: RequiredTransactionProof<BridgeFact> = {
  maximumFacts: 1,
  failureCode: 'RATING_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_SCOPE_UNAVAILABLE', async (read) => {
      if (facts.length !== 1)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      const fact = facts[0]!;
      await read.query(
        'LOCK TABLE whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch,whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN SHARE MODE NOWAIT',
      );
      if (fact.fingerprint !== (await snapshot(fact, read)))
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    }),
};

/** Companion transport, never a new request/preparation or a source issuer.
 * SQL derives only the exact append authorized by the genuine old command. */
@Injectable()
export class RatingLegacyBridgeService {
  constructor(
    @Inject(CampusRatingScopedContextFacade)
    private readonly campus: CampusRatingScopedContextFacade,
    @Inject(RatingScopedReleaseRepository)
    private readonly releases: RatingScopedReleaseRepository,
  ) {}
  async begin(
    actor: string,
    requestId: string,
    originalIntent: unknown,
    tx: PoolClient,
    catalogPlan: readonly LegacyBridgeCatalogPlan[] = [],
  ): Promise<LegacyRatingBridge | null> {
    const row = (
      await tx.query<{ bridge: BridgeRow | null }>(
        'SELECT whaleu_ratings.begin_legacy_scoped_bridge($1,$2,$3::jsonb,$4::jsonb) bridge',
        [
          actor,
          requestId,
          JSON.stringify(originalIntent),
          JSON.stringify(catalogPlan),
        ],
      )
    ).rows[0]?.bridge;
    if (!row) return null;
    for (const domain of row.proof.domains) {
      const deadline = Date.parse(domain.validUntil);
      if (!Number.isFinite(deadline))
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      registerTransactionDeadline(tx, deadline, 'RATING_SCOPE_UNAVAILABLE');
    }
    const result = Object.freeze({ actor, requestId, row });
    handles.set(result, tx);
    return result;
  }
  async finish(
    bridge: LegacyRatingBridge | null,
    tx: PoolClient,
  ): Promise<void> {
    if (!bridge) return;
    if (handles.get(bridge) !== tx)
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const { actor, requestId, row } = bridge;
    if (
      row.proof.operation === 'create_target' ||
      row.proof.operation === 'create_categories'
    ) {
      const proofs = [];
      // Resolve every domain through its owner before any source mutation. No
      // first-campus inference and no forged/merged Campus proof object.
      for (const domain of row.proof.domains) {
        const proof = await this.campus.resolveLegacyCompatDomain(
          domain.logicalScopeKey === 'global'
            ? { kind: 'global_compat' }
            : { kind: 'region_compat', regionId: domain.logicalScopeKey },
          tx,
        );
        if (
          JSON.stringify(proof.scopeKeys) !== JSON.stringify(domain.scopeKeys)
        )
          throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
        proofs.push(proof);
      }
      await tx.query('SELECT whaleu_ratings.legacy_bridge_sources($1,$2)', [
        actor,
        requestId,
      ]);
      await this.releases.publishMany(
        proofs,
        {
          kind: 'legacy_bridge',
          accountId: actor,
          requestId,
          bridgeId: row.bridgeId,
        },
        tx,
      );
    }
    await tx.query(
      row.kind === 'legacy_boundary'
        ? 'SELECT whaleu_ratings.verify_legacy_boundary($1,$2)'
        : 'SELECT whaleu_ratings.verify_legacy_scoped_bridge($1,$2)',
      [actor, requestId],
    );
    const fact = {
      actor,
      requestId,
      bridgeId: row.bridgeId,
      scopeKeys: row.proof.domains.flatMap((d) => d.scopeKeys).sort(),
      logicalKeys: (row.kind === 'legacy_boundary'
        ? (row.proof.boundary?.protocolTuples ?? [])
        : row.proof.domains
      )
        .map((d) => d.logicalScopeKey)
        .sort(),
    };
    enableRequiredTransactionProof(tx, bridgeProof);
    registerRequiredTransactionFact(
      tx,
      bridgeProof,
      row.bridgeId,
      Object.freeze({
        ...fact,
        fingerprint: await snapshot(fact, tx),
      }),
    );
    handles.delete(bridge);
  }
}
