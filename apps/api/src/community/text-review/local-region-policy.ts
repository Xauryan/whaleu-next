import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { RuntimeConfig } from '../../config/config.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { canonicalJson } from '../content-review/contracts.js';
import { categorySchema } from '../contracts.js';

const fields = {
  postEnabled: z.boolean(),
  commentEnabled: z.boolean(),
  namedOnly: z.literal(true),
  categories: z
    .array(categorySchema.exclude(['trading']))
    .max(9)
    .refine((v) => new Set(v).size === v.length),
  validForHours: z.number().int().min(1).max(168),
  basis: z.string().trim().min(1).max(160),
};
export const previewRegionPolicySchema = z.strictObject({
  command: z.literal('preview-region'),
  ...fields,
});
export const applyRegionPolicySchema = z.strictObject({
  command: z.literal('apply-region'),
  ...fields,
  expectedRevision: z.number().int().nonnegative(),
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
type Command =
  | z.infer<typeof previewRegionPolicySchema>
  | z.infer<typeof applyRegionPolicySchema>;
interface ScopeRow {
  space_id: string;
  space_name: string;
  region_id: string;
  region_name: string;
}

/** Explicit non-production operator configuration of an EXISTING exact scope.
 * No catalog, topology, identity, verification, role or startup provisioning. */
export async function configureLocalRegionPolicy(
  command: Command,
  config: RuntimeConfig,
  operator: string,
  tx: PoolClient,
): Promise<unknown> {
  if (
    config.NODE_ENV === 'production' ||
    config.COMMUNITY_TEXT_REVIEW !== 'local_manual' ||
    !config.COMMUNITY_TEXT_REVIEW_SPACE_ID ||
    !config.COMMUNITY_TEXT_REVIEW_REGION_ID ||
    config.COMMUNITY_TEXT_REVIEW_OPERATOR !== operator ||
    command.namedOnly !== true ||
    (command.postEnabled
      ? command.categories.length === 0
      : command.categories.length !== 0)
  )
    throw new Error('Explicit single-region configuration unavailable');
  const apply = command.command === 'apply-region';
  await lockSafetyPolicy(tx, apply);
  const scope = (
    await tx.query<ScopeRow>(
      `SELECT s.id AS space_id,s.name AS space_name,r.id AS region_id,r.name AS region_name
    FROM whaleu_community.spaces s JOIN whaleu_campus.operating_regions r ON r.id=s.operating_region_id
    WHERE s.id=$1 AND r.id=$2 AND s.kind='regional' AND s.is_active AND r.is_active
    FOR ${apply ? 'UPDATE' : 'SHARE'} OF s,r`,
      [
        config.COMMUNITY_TEXT_REVIEW_SPACE_ID,
        config.COMMUNITY_TEXT_REVIEW_REGION_ID,
      ],
    )
  ).rows[0];
  if (!scope)
    throw new Error('Configured existing regional scope is unavailable');
  const head = (
    await tx.query<{ revision: number; revision_id: string | null }>(
      `SELECT revision,revision_id FROM whaleu_community.region_policy_heads WHERE region_id=$1 FOR ${apply ? 'UPDATE' : 'SHARE'}`,
      [scope.region_id],
    )
  ).rows[0];
  const revision = head?.revision ?? 0;
  const proposed = {
    postEnabled: command.postEnabled,
    commentEnabled: command.commentEnabled,
    namedOnly: true,
    categories: command.categories,
    relatedSyncEnabled: false,
    validForHours: command.validForHours,
    basis: command.basis,
  };
  const previewDigest = createHash('sha256')
    .update(canonicalJson({ version: 1, scope, revision, proposed }))
    .digest('hex');
  if (!apply)
    return { scope, currentRevision: revision, proposed, previewDigest };
  if (
    command.expectedRevision !== revision ||
    command.previewDigest !== previewDigest
  )
    throw new Error(
      'Preview is stale or does not match the explicit requested policy',
    );
  const databaseActor = (
    await tx.query<{ actor: string }>('SELECT current_user AS actor')
  ).rows[0]!.actor;
  const source = JSON.stringify({ localOperator: operator, databaseActor });
  if ([...source].length > 200)
    throw new Error(
      'Operator audit reference exceeds existing policy contract',
    );
  const policyReference = `local-named-text-experiment/v1: ${command.basis}`;
  await tx.query(
    'INSERT INTO whaleu_community.region_policy_heads(region_id) VALUES($1) ON CONFLICT DO NOTHING',
    [scope.region_id],
  );
  const id = randomUUID();
  await tx.query(
    `INSERT INTO whaleu_community.region_policy_revisions
    (id,region_id,revision,unverified_post_enabled,unverified_comment_enabled,unverified_categories,related_sync_enabled,
     coverage_state,provenance_state,effective_at,expiry_kind,valid_until,source_reference,policy_reference)
    VALUES($1,$2,$3,$4,$5,$6::text[],false,'complete','accepted',statement_timestamp(),'at',statement_timestamp()+($7*interval '1 hour'),$8,$9)`,
    [
      id,
      scope.region_id,
      revision + 1,
      command.postEnabled,
      command.commentEnabled,
      command.categories,
      command.validForHours,
      source,
      policyReference,
    ],
  );
  await tx.query(
    'UPDATE whaleu_community.region_policy_heads SET revision=$2,revision_id=$3 WHERE region_id=$1',
    [scope.region_id, revision + 1, id],
  );
  return {
    scope,
    revision: revision + 1,
    revisionId: id,
    applied: true,
    previewDigest,
  };
}
