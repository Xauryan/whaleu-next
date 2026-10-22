import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { RuntimeConfig } from '../../config/config.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { canonicalJson } from '../content-review/canonical-json.js';
import { loadHomeAdmission } from './admission.js';
import type { AdmissionRef } from './admission-contract.js';

/** Exact finalized formal-migration catalog collector body, not a SQL self-attestation. */
export const HOME_PUBLICATION_CATALOG_BODY_SHA256 =
  '979a75b0216e1d2e8b27487ad9f3c40275b317f31a999f23da7f6423e8127fc7';
const id = z.uuid().refine((v) => v === v.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z.string().refine(
  (v) =>
    v.length > 0 &&
    v === v.trim() &&
    [...v].length <= 1000 &&
    [...v].every((c) => {
      const n = c.codePointAt(0)!;
      return (
        n >= 32 && !(n >= 127 && n <= 159) && !(n >= 0xd800 && n <= 0xdfff)
      );
    }),
);
export const homeActivationCommandSchema = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('preflight') }),
  z.strictObject({
    command: z.literal('prepare'),
    evidenceRef: evidence,
    validForHours: z.number().int().min(1).max(168),
  }),
  z.strictObject({
    command: z.literal('apply'),
    preparationId: id,
    expectedRevision: z.number().int().min(0).max(2147483646),
    previewDigest: digest,
  }),
]);
export type HomeActivationCommand = z.infer<typeof homeActivationCommandSchema>;
const payloadSchema = z.strictObject({
  previousRevision: z.number().int().nonnegative(),
  previousId: id.nullable(),
  admissionId: id,
  admissionRevision: z.number().int().positive(),
  admissionDigest: digest,
  catalogRevision: z.literal(1),
  catalogDigest: digest,
  sourceReviewPolicyId: id,
  explicitReviewPolicyId: z.null(),
  configuredSpaceId: id,
  configuredRegionId: id,
  operator: z.string().min(1).max(200),
  databaseActor: z.string().min(1),
  evidenceRef: evidence,
  preparationId: id,
  issuedAt: z.iso.datetime({ precision: 3 }),
  expiresAt: z.iso.datetime({ precision: 3 }),
  validUntil: z.iso.datetime({ precision: 3 }),
});
const protocolSchema = z.strictObject({
  version: z.literal(1),
  migration: z.literal('0178_home_publication_protocol.sql'),
  envelopeVersions: z.tuple([z.literal(7), z.literal(8)]),
  catalogRevision: z.literal(1),
  catalog: digest,
  publicationReady: z.literal(true),
});
export interface HomeActivationPreflight {
  catalogReady: boolean;
  admission: AdmissionRef | null;
  sourceReviewPolicyId: string | null;
  explicitReviewPolicyId: null;
  configuredSpaceId: string | null;
  configuredRegionId: string | null;
  canPrepare: boolean;
  activationPresent: boolean;
  publicationReady: boolean;
  blockers: string[];
}
interface Context {
  admission: AdmissionRef;
  catalogDigest: string;
  sourceReviewPolicyId: string;
  configuredSpaceId: string;
  configuredRegionId: string;
  operator: string;
  databaseActor: string;
  latestValidUntil: string;
  previousRevision: number;
  previousId: string | null;
}
const failed = () => new Error('Home publication activation unavailable');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const preparationDigest = (value: unknown) =>
  sha('whaleu-home-publication-preview:v1\n' + canonicalJson(value));
async function lock(tx: PoolClient, write: boolean) {
  await lockSafetyPolicy(tx, write);
  await tx.query(
    `SELECT pg_advisory_xact_lock${write ? '' : '_shared'}(hashtextextended('whaleu:home-admission:v1',0))`,
  );
}
function configured(config: RuntimeConfig, operator: string): boolean {
  return (
    config.COMMUNITY_TEXT_REVIEW === 'source_manual' &&
    !!config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID &&
    !config.COMMUNITY_TEXT_REVIEW_POLICY_ID &&
    !!config.COMMUNITY_TEXT_REVIEW_SPACE_ID &&
    !!config.COMMUNITY_TEXT_REVIEW_REGION_ID &&
    config.COMMUNITY_TEXT_REVIEW_OPERATOR === operator &&
    operator.startsWith('manual:')
  );
}
async function inspect(
  config: RuntimeConfig,
  operator: string,
  tx: PoolClient,
): Promise<{ result: HomeActivationPreflight; context: Context | null }> {
  const result: HomeActivationPreflight = {
    catalogReady: false,
    admission: null,
    sourceReviewPolicyId: null,
    explicitReviewPolicyId: null,
    configuredSpaceId: config.COMMUNITY_TEXT_REVIEW_SPACE_ID ?? null,
    configuredRegionId: config.COMMUNITY_TEXT_REVIEW_REGION_ID ?? null,
    canPrepare: false,
    activationPresent: false,
    publicationReady: false,
    blockers: [],
  };
  if (!configured(config, operator)) {
    result.blockers.push('source_manual_reviewer_configuration_required');
    return { result, context: null };
  }
  result.sourceReviewPolicyId = config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID!;
  const present = (
    await tx.query<{ present: boolean }>(
      `SELECT to_regprocedure('whaleu_community.home_publication_protocol()') IS NOT NULL AND to_regprocedure('whaleu_community.home_publication_catalog()') IS NOT NULL AS present`,
    )
  ).rows[0]?.present;
  if (!present) {
    result.blockers.push('home_publication_catalog_missing');
    return { result, context: null };
  }
  const catalog = (
    await tx.query<{
      protocol: unknown;
      catalog: string;
      body: string;
      safe: boolean;
    }>(`SELECT whaleu_community.home_publication_protocol() protocol,whaleu_community.home_publication_catalog() catalog,p.prosrc body,
  (NOT p.prosecdef AND p.provolatile='s' AND NOT p.proretset AND p.prorettype='text'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.proconfig=ARRAY['search_path=pg_catalog']
   AND EXISTS(SELECT 1 FROM pg_proc marker WHERE marker.oid=to_regprocedure('whaleu_community.home_publication_protocol()') AND NOT marker.prosecdef AND marker.provolatile='i' AND NOT marker.proretset AND marker.prorettype='jsonb'::regtype AND marker.prolang=p.prolang AND marker.proowner=p.proowner AND marker.proconfig=ARRAY['search_path=pg_catalog'])) safe FROM pg_proc p WHERE p.oid=to_regprocedure('whaleu_community.home_publication_catalog()')`)
  ).rows[0];
  const protocol = protocolSchema.safeParse(catalog?.protocol);
  if (
    !catalog?.safe ||
    typeof catalog.body !== 'string' ||
    sha(catalog.body) !== HOME_PUBLICATION_CATALOG_BODY_SHA256 ||
    !protocol.success ||
    protocol.data.catalog !== catalog.catalog
  ) {
    result.blockers.push('home_publication_catalog_drift');
    return { result, context: null };
  }
  result.catalogReady = true;
  const admission = await loadHomeAdmission(tx);
  result.admission = admission?.ref ?? null;
  if (!admission) result.blockers.push('current_home_admission_missing');
  else if (admission.definition.exemptions.audit !== 'none')
    result.blockers.push('institution5_authority_adapter_unavailable');
  const policy = (
    await tx.query<{ valid_until: Date | null }>(
      `SELECT valid_until FROM whaleu_community.content_approval_policies WHERE id=$1 AND policy_key='local-text-source-v1' AND version=1 AND coverage='complete' AND provenance='accepted' AND issuer=$2 AND length(whaleu_profile.moderation_trim(provenance_ref))>0 AND valid_from<=clock_timestamp() AND (valid_until IS NULL OR valid_until>clock_timestamp()) FOR SHARE`,
      [config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID, operator],
    )
  ).rows[0];
  if (!policy) result.blockers.push('current_source_review_policy_missing');
  const head = (
    await tx.query<{
      revision: number;
      activation_id: string;
      payload: unknown;
      valid_until: Date;
      current: boolean;
    }>(
      `SELECT h.revision,h.activation_id,p.payload,a.valid_until,(a.accepted_at<=clock_timestamp() AND a.valid_until>clock_timestamp() AND whaleu_community.home_activation_payload_current(p.payload)) current FROM whaleu_community.home_publication_head h JOIN whaleu_community.home_publication_activations a ON (a.id,a.revision)=(h.activation_id,h.revision) JOIN whaleu_community.home_publication_preparations p ON p.id=a.preparation_id WHERE h.slot=1 FOR SHARE OF h,a,p`,
    )
  ).rows[0];
  result.activationPresent = !!head;
  if (result.blockers.length || !admission || !policy)
    return { result, context: null };
  const databaseActor = (
    await tx.query<{ actor: string }>('SELECT current_user AS actor')
  ).rows[0]?.actor;
  if (!databaseActor) throw failed();
  const latestValidUntil = new Date(
    Math.min(
      Date.parse(admission.ref.validUntil),
      policy.valid_until?.getTime() ?? Infinity,
    ),
  ).toISOString();
  const context: Context = {
    admission: admission.ref,
    catalogDigest: catalog.catalog,
    sourceReviewPolicyId: config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID!,
    configuredSpaceId: config.COMMUNITY_TEXT_REVIEW_SPACE_ID!,
    configuredRegionId: config.COMMUNITY_TEXT_REVIEW_REGION_ID!,
    operator,
    databaseActor,
    latestValidUntil,
    previousRevision: head?.revision ?? 0,
    previousId: head?.activation_id ?? null,
  };
  const available = (
    await tx.query<{ available: boolean }>(
      `SELECT whaleu_community.home_activation_payload_current($1::jsonb) available`,
      [
        JSON.stringify({
          ...basePayload(context),
          validUntil: latestValidUntil,
        }),
      ],
    )
  ).rows[0]?.available;
  if (available !== true) {
    result.blockers.push('current_mapping_scope_or_review_unavailable');
    return { result, context: null };
  }
  result.canPrepare = true;
  const current = payloadSchema.safeParse(head?.payload);
  result.publicationReady =
    !!head?.current &&
    current.success &&
    current.data.sourceReviewPolicyId === context.sourceReviewPolicyId &&
    current.data.explicitReviewPolicyId === null &&
    current.data.configuredSpaceId === context.configuredSpaceId &&
    current.data.configuredRegionId === context.configuredRegionId &&
    current.data.operator === operator;
  if (!result.publicationReady)
    result.blockers.push(
      head ? 'configured_activation_not_current' : 'activation_not_configured',
    );
  return { result, context };
}
function basePayload(c: Context) {
  return {
    previousRevision: c.previousRevision,
    previousId: c.previousId,
    admissionId: c.admission.id,
    admissionRevision: c.admission.revision,
    admissionDigest: c.admission.digest,
    catalogRevision: 1,
    catalogDigest: c.catalogDigest,
    sourceReviewPolicyId: c.sourceReviewPolicyId,
    explicitReviewPolicyId: null,
    configuredSpaceId: c.configuredSpaceId,
    configuredRegionId: c.configuredRegionId,
    operator: c.operator,
    databaseActor: c.databaseActor,
  };
}
export async function homeActivationPreflight(
  config: RuntimeConfig,
  operator: string,
  tx: PoolClient,
): Promise<HomeActivationPreflight> {
  await lock(tx, false);
  return (await inspect(config, operator, tx)).result;
}
/** Explicit source-manual activation, not new Review issuance or access grants. */
export async function configureHomePublication(
  value: HomeActivationCommand,
  config: RuntimeConfig,
  operator: string,
  tx: PoolClient,
): Promise<unknown> {
  const command = homeActivationCommandSchema.parse(value);
  if (command.command === 'preflight')
    return homeActivationPreflight(config, operator, tx);
  if (!configured(config, operator)) throw failed();
  await lock(tx, true);
  const { result, context } = await inspect(config, operator, tx);
  if (!result.canPrepare || !context) throw failed();
  if (command.command === 'prepare') {
    const preparationId = randomUUID();
    const prepared = (
      await tx.query<{
        id: string;
        payload: unknown;
        digest: string;
        expires_at: Date;
        valid_until: Date;
      }>(
        `WITH instant AS (SELECT date_trunc('milliseconds',statement_timestamp()) issued),
   dates AS (SELECT issued,issued+interval '5 minutes' expires,least(issued+($3*interval '1 hour'),$4::timestamptz) valid FROM instant),
   prepared AS (SELECT issued,expires,valid,$2::jsonb||jsonb_build_object('preparationId',$1::text,'issuedAt',to_char(issued AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(expires AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'validUntil',to_char(valid AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) payload FROM dates)
   INSERT INTO whaleu_community.home_publication_preparations(id,payload,digest,issued_at,expires_at,valid_until)
   SELECT $1::uuid,payload,encode(sha256(convert_to('whaleu-home-publication-preview:v1'||chr(10)||whaleu_community.content_canonical_json(payload),'UTF8')),'hex'),issued,expires,valid FROM prepared RETURNING id,payload,digest,expires_at,valid_until`,
        [
          preparationId,
          JSON.stringify({
            ...basePayload(context),
            evidenceRef: command.evidenceRef,
          }),
          command.validForHours,
          context.latestValidUntil,
        ],
      )
    ).rows[0];
    if (
      !prepared ||
      !payloadSchema.safeParse(prepared.payload).success ||
      preparationDigest(prepared.payload) !== prepared.digest
    )
      throw failed();
    return {
      prepared: true,
      preparationId,
      currentRevision: context.previousRevision,
      previewDigest: prepared.digest,
      expiresAt: prepared.expires_at.toISOString(),
      validUntil: prepared.valid_until.toISOString(),
      publicationReady: result.publicationReady,
    };
  }
  const row = (
    await tx.query<{
      id: string;
      payload: unknown;
      digest: string;
      issued_at: Date;
      expires_at: Date;
      valid_until: Date;
    }>(
      `SELECT p.* FROM whaleu_community.home_publication_preparations p WHERE p.id=$1 AND p.issued_at<=clock_timestamp() AND p.expires_at>clock_timestamp() AND p.valid_until>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM whaleu_community.home_publication_activations a WHERE a.preparation_id=p.id) FOR SHARE OF p`,
      [command.preparationId],
    )
  ).rows[0];
  const payload = payloadSchema.safeParse(row?.payload);
  if (
    !row ||
    !payload.success ||
    command.expectedRevision !== context.previousRevision ||
    command.previewDigest !== row.digest ||
    preparationDigest(payload.data) !== row.digest ||
    row.valid_until.getTime() > Date.parse(context.latestValidUntil) ||
    canonicalJson(payload.data) !==
      canonicalJson({
        ...basePayload(context),
        evidenceRef: payload.data.evidenceRef,
        preparationId: row.id,
        issuedAt: row.issued_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        validUntil: row.valid_until.toISOString(),
      })
  )
    throw new Error(
      'Stale, expired, consumed or mismatched Home activation preparation',
    );
  const activationId = randomUUID(),
    revision = context.previousRevision + 1;
  await tx.query(
    `INSERT INTO whaleu_community.home_publication_activations(id,preparation_id,revision,previous_id,admission_id,admission_revision,admission_digest,catalog_revision,catalog_digest,source_review_policy_id,explicit_review_policy_id,configured_space_id,configured_region_id,operator_ref,database_actor,evidence_ref,accepted_at,valid_until)
 VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,NULL,$10,$11,$12,current_user,$13,statement_timestamp(),$14)`,
    [
      activationId,
      row.id,
      revision,
      context.previousId,
      context.admission.id,
      context.admission.revision,
      context.admission.digest,
      context.catalogDigest,
      context.sourceReviewPolicyId,
      context.configuredSpaceId,
      context.configuredRegionId,
      operator,
      payload.data.evidenceRef,
      row.valid_until,
    ],
  );
  await tx.query(
    `INSERT INTO whaleu_community.home_publication_head(slot,revision,activation_id) VALUES(1,$1,$2) ON CONFLICT(slot) DO UPDATE SET revision=EXCLUDED.revision,activation_id=EXCLUDED.activation_id`,
    [revision, activationId],
  );
  const current = (await inspect(config, operator, tx)).result;
  if (!current.publicationReady) throw failed();
  return {
    applied: true,
    activationId,
    revision,
    admission: context.admission,
    validUntil: row.valid_until.toISOString(),
    publicationReady: true,
    configuredSpaceId: context.configuredSpaceId,
    configuredRegionId: context.configuredRegionId,
    sourceReviewPolicyId: context.sourceReviewPolicyId,
    explicitReviewPolicyId: null,
  };
}
