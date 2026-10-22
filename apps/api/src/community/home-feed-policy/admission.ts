import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../../config/config.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { canonicalJson } from '../content-review/canonical-json.js';
import {
  HOME_POLICY_SOURCE,
  admissionDefinitionDigest,
  homeAdmissionCommandSchema,
  homeAdmissionDefinitionSchema,
} from './admission-contract.js';
import type {
  HomeAdmission,
  HomeAdmissionCommand,
  HomeAdmissionDefinition,
  HomeMapping,
  HomeMappingInput,
} from './admission-contract.js';

const unavailable = () => new Error('Home policy admission unavailable');
async function admissionLock(tx: PoolClient, write = false): Promise<void> {
  await lockSafetyPolicy(tx, write);
  await tx.query(
    `SELECT pg_advisory_xact_lock${write ? '' : '_shared'}(hashtextextended('whaleu:home-admission:v1',0))`,
  );
}
/** Metadata admission only. Neither this lookup nor its return grants publication/access. */
export async function loadHomeAdmission(
  tx: PoolClient,
): Promise<HomeAdmission | null> {
  await admissionLock(tx);
  const row = (
    await tx.query<{
      id: string;
      revision: number;
      definition: unknown;
      digest: string;
      valid_until: Date;
    }>(
      `SELECT a.id,a.revision,a.definition,a.digest,a.valid_until FROM whaleu_community.home_policy_head h JOIN whaleu_community.home_policy_admissions a ON (a.id,a.revision)=(h.admission_id,h.revision) WHERE h.slot=1 AND a.accepted_at<=clock_timestamp() AND a.valid_until>clock_timestamp() FOR SHARE OF h,a`,
    )
  ).rows[0];
  if (!row) return null;
  const definition = homeAdmissionDefinitionSchema.parse(row.definition);
  if (admissionDefinitionDigest(definition) !== row.digest) throw unavailable();
  return Object.freeze({
    ref: Object.freeze({
      id: row.id,
      revision: row.revision,
      digest: row.digest,
      sourceCommit: HOME_POLICY_SOURCE,
      validUntil: row.valid_until.toISOString(),
    }),
    definition,
  });
}
/** Pure mapping of already-held canonical facts. The caller still owns current
 * authority, policy deadline, source-aware Review and final transaction checks. */
export function resolveHomeMapping(
  admission: HomeAdmission,
  input: HomeMappingInput,
): HomeMapping {
  const d = homeAdmissionDefinitionSchema.parse(admission.definition);
  if (
    admission.ref.digest !== admissionDefinitionDigest(d) ||
    !d.authorModes.includes(input.authorMode)
  )
    throw unavailable();
  const category = d.categoryMappings.find(
    (m) =>
      m.nativeCategory === input.category && m.sourceKind === input.spaceKind,
  );
  const scopes = d.scopeMappings.filter(
    (m) =>
      m.sourceSpaceId === input.spaceId &&
      m.sourceKind === input.spaceKind &&
      m.sourceRegionId === input.regionId &&
      (input.spaceKind === 'regional' ||
        (input.authorOriginRegionId !== null &&
          m.targetRegionId === input.authorOriginRegionId)),
  );
  if (!category || scopes.length !== 1) throw unavailable();
  return {
    legacyChoose: category.legacyChoose,
    targetWaterSpaceId: scopes[0]!.targetWaterSpaceId,
    targetWaterRegionId: scopes[0]!.targetRegionId,
    admission: admission.ref,
  };
}
export interface HomePolicyPreflight {
  catalogReady: boolean;
  admissionPresent: boolean;
  publicationReady: false;
  blockers: string[];
  admission: HomeAdmission['ref'] | null;
}
export async function homePolicyPreflight(
  tx: PoolClient,
): Promise<HomePolicyPreflight> {
  const marker = (
    await tx.query<{ present: boolean }>(
      `SELECT to_regprocedure('whaleu_community.home_policy_protocol()') IS NOT NULL AS present`,
    )
  ).rows[0];
  if (!marker?.present)
    return {
      catalogReady: false,
      admissionPresent: false,
      publicationReady: false,
      blockers: [
        'home_policy_catalog_missing',
        'v7_publication_not_integrated',
      ],
      admission: null,
    };
  const row = (
    await tx.query<{ protocol: unknown; valid: boolean }>(
      `SELECT whaleu_community.home_policy_protocol() protocol,whaleu_community.home_policy_catalog_valid() valid`,
    )
  ).rows[0];
  const protocol = {
    version: 1,
    sourceCommit: HOME_POLICY_SOURCE,
    migration: '0177_home_policy_admission.sql',
    publicationReady: false,
  };
  if (!row?.valid || canonicalJson(row.protocol) !== canonicalJson(protocol))
    throw unavailable();
  const admitted = await loadHomeAdmission(tx);
  const blockers = ['v7_publication_not_integrated'];
  if (!admitted) blockers.push('current_admission_missing');
  if (admitted?.definition.exemptions.audit === 'institution5_owner')
    blockers.push('institution5_authority_adapter_unavailable');
  return {
    catalogReady: true,
    admissionPresent: admitted !== null,
    publicationReady: false,
    blockers,
    admission: admitted?.ref ?? null,
  };
}
async function scopeSnapshot(
  definition: HomeAdmissionDefinition,
  config: RuntimeConfig,
  tx: PoolClient,
  write: boolean,
) {
  const ids = [
    ...new Set(
      definition.scopeMappings.flatMap((m) => [
        m.sourceSpaceId,
        m.targetWaterSpaceId,
      ]),
    ),
  ].sort();
  const rows = (
    await tx.query<{
      id: string;
      kind: string;
      region_id: string | null;
      region_active: boolean | null;
    }>(
      `SELECT s.id,s.kind,s.operating_region_id region_id,r.is_active region_active FROM whaleu_community.spaces s LEFT JOIN whaleu_campus.operating_regions r ON r.id=s.operating_region_id WHERE s.id=ANY($1::uuid[]) AND s.is_active ORDER BY s.id FOR ${write ? 'UPDATE' : 'SHARE'} OF s`,
      [ids],
    )
  ).rows;
  // Region rows are locked independently: nullable outer-join sides cannot lock.
  const regions = [
    ...new Set(definition.scopeMappings.map((m) => m.targetRegionId)),
  ].sort();
  const active = (
    await tx.query<{ id: string }>(
      `SELECT id FROM whaleu_campus.operating_regions WHERE id=ANY($1::uuid[]) AND is_active ORDER BY id FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [regions],
    )
  ).rows;
  if (rows.length !== ids.length || active.length !== regions.length)
    throw unavailable();
  for (const m of definition.scopeMappings) {
    const source = rows.find((r) => r.id === m.sourceSpaceId),
      target = rows.find((r) => r.id === m.targetWaterSpaceId);
    if (
      source?.kind !== m.sourceKind ||
      source.region_id !== m.sourceRegionId ||
      target?.kind !== 'regional' ||
      target.region_id !== m.targetRegionId ||
      target.id !== config.COMMUNITY_TEXT_REVIEW_SPACE_ID ||
      target.region_id !== config.COMMUNITY_TEXT_REVIEW_REGION_ID
    )
      throw unavailable();
  }
  return rows;
}
/** Production-configurable source_manual operator, matching the existing Review
 * identity/configuration boundary. No catalog creation, grants, or auto-seeding. */
export async function configureHomeAdmission(
  value: HomeAdmissionCommand,
  config: RuntimeConfig,
  operator: string,
  tx: PoolClient,
): Promise<unknown> {
  const command = homeAdmissionCommandSchema.parse(value);
  if (
    config.COMMUNITY_TEXT_REVIEW !== 'source_manual' ||
    !config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID ||
    !config.COMMUNITY_TEXT_REVIEW_SPACE_ID ||
    !config.COMMUNITY_TEXT_REVIEW_REGION_ID ||
    !operator ||
    config.COMMUNITY_TEXT_REVIEW_OPERATOR !== operator
  )
    throw unavailable();
  if (command.command === 'preflight') return homePolicyPreflight(tx);
  const apply = command.command === 'apply';
  await admissionLock(tx, true);
  const preflight = await homePolicyPreflight(tx);
  if (!preflight.catalogReady) throw unavailable();
  const scopes = await scopeSnapshot(command.definition, config, tx, apply);
  const head = (
    await tx.query<{ revision: number; admission_id: string }>(
      `SELECT revision,admission_id FROM whaleu_community.home_policy_head WHERE slot=1 FOR ${apply ? 'UPDATE' : 'SHARE'}`,
    )
  ).rows[0];
  const previousRevision = head?.revision ?? 0,
    previousId = head?.admission_id ?? null;
  const databaseActor = (
    await tx.query<{ actor: string }>('SELECT current_user AS actor')
  ).rows[0]?.actor;
  if (!databaseActor) throw unavailable();
  // Prospective diagnostics describe this exact command, never the old head.
  const proposedBlockers = ['v7_publication_not_integrated'];
  if (command.definition.exemptions.audit === 'institution5_owner')
    proposedBlockers.push('institution5_authority_adapter_unavailable');
  const definitionDigest = admissionDefinitionDigest(command.definition);
  const basePayload = {
    previousRevision,
    previousId,
    scopes,
    definitionDigest,
    evidenceRef: command.evidenceRef,
    validForHours: command.validForHours,
    operator,
    databaseActor,
    sourceReviewPolicyId: config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID,
    configuredSpaceId: config.COMMUNITY_TEXT_REVIEW_SPACE_ID,
    configuredRegionId: config.COMMUNITY_TEXT_REVIEW_REGION_ID,
  };
  if (!apply) {
    const preparationId = randomUUID();
    // The database issues the immutable nonce and absolute time window in ONE
    // statement. No client timestamp or reproducible public hash proves issuance.
    const prepared = (
      await tx.query<{
        id: string;
        payload: Record<string, unknown>;
        digest: string;
        expires_at: Date;
        valid_until: Date;
      }>(
        `WITH instant AS (SELECT date_trunc('milliseconds',statement_timestamp()) AS issued),
       prepared AS (SELECT issued,issued+interval '5 minutes' expires,issued+($4*interval '1 hour') valid,
         $3::jsonb||jsonb_build_object('preparationId',$1::text,
           'issuedAt',to_char(issued AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'expiresAt',to_char((issued+interval '5 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'validUntil',to_char((issued+($4*interval '1 hour')) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS payload FROM instant)
       INSERT INTO whaleu_community.home_policy_preparations(id,definition,payload,digest,issued_at,expires_at,valid_until)
       SELECT $1::uuid,$2::jsonb,payload,encode(sha256(convert_to('whaleu-home-preview:v1'||chr(10)||whaleu_community.content_canonical_json(payload),'UTF8')),'hex'),issued,expires,valid FROM prepared
       RETURNING id,payload,digest,expires_at,valid_until`,
        [
          preparationId,
          JSON.stringify(command.definition),
          JSON.stringify(basePayload),
          command.validForHours,
        ],
      )
    ).rows[0];
    if (
      !prepared ||
      createHash('sha256')
        .update('whaleu-home-preview:v1\n' + canonicalJson(prepared.payload))
        .digest('hex') !== prepared.digest
    )
      throw unavailable();
    return {
      prepared: true,
      preparationId,
      currentRevision: previousRevision,
      previousAdmissionId: previousId,
      definitionDigest,
      previewDigest: prepared.digest,
      expiresAt: prepared.expires_at.toISOString(),
      validUntil: prepared.valid_until.toISOString(),
      scopes,
      publicationReady: false,
      blockers: proposedBlockers,
    };
  }
  const prepared = (
    await tx.query<{
      id: string;
      definition: unknown;
      payload: Record<string, unknown>;
      digest: string;
      issued_at: Date;
      expires_at: Date;
      valid_until: Date;
    }>(
      `SELECT p.* FROM whaleu_community.home_policy_preparations p WHERE p.id=$1 AND p.issued_at<=clock_timestamp() AND p.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM whaleu_community.home_policy_admissions a WHERE a.preparation_id=p.id) FOR SHARE OF p`,
      [command.preparationId],
    )
  ).rows[0];
  const expectedPayload = prepared
    ? {
        ...basePayload,
        preparationId: prepared.id,
        issuedAt: prepared.issued_at.toISOString(),
        expiresAt: prepared.expires_at.toISOString(),
        validUntil: prepared.valid_until.toISOString(),
      }
    : null;
  if (
    !prepared ||
    command.expectedRevision !== previousRevision ||
    command.previewDigest !== prepared.digest ||
    canonicalJson(command.definition) !== canonicalJson(prepared.definition) ||
    canonicalJson(expectedPayload) !== canonicalJson(prepared.payload) ||
    createHash('sha256')
      .update('whaleu-home-preview:v1\n' + canonicalJson(prepared.payload))
      .digest('hex') !== prepared.digest
  )
    throw new Error(
      'Stale, expired, consumed or mismatched home-policy preparation',
    );
  const previewDigest = prepared.digest;
  const id = randomUUID(),
    revision = previousRevision + 1;
  const inserted = (
    await tx.query<{ valid_until: Date }>(
      `INSERT INTO whaleu_community.home_policy_admissions(id,revision,previous_id,source_commit,definition,digest,operator_ref,database_actor,evidence_ref,accepted_at,valid_until,preparation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,current_user,$8,statement_timestamp(),$9,$10) RETURNING valid_until`,
      [
        id,
        revision,
        previousId,
        HOME_POLICY_SOURCE,
        JSON.stringify(command.definition),
        definitionDigest,
        operator,
        command.evidenceRef,
        prepared.valid_until,
        prepared.id,
      ],
    )
  ).rows[0];
  if (!inserted) throw unavailable();
  await tx.query(
    `INSERT INTO whaleu_community.home_policy_head(slot,revision,admission_id) VALUES(1,$1,$2) ON CONFLICT(slot) DO UPDATE SET revision=EXCLUDED.revision,admission_id=EXCLUDED.admission_id`,
    [revision, id],
  );
  return {
    applied: true,
    admission: {
      id,
      revision,
      digest: definitionDigest,
      sourceCommit: HOME_POLICY_SOURCE,
      validUntil: inserted.valid_until.toISOString(),
    },
    previewDigest,
    publicationReady: false,
    blockers: proposedBlockers,
  };
}
