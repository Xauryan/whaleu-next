import { ApplicationError } from '../../http/application-error.js';

export type HomeDistributionSurface =
  'home' | 'following' | 'hot' | 'official' | 'related_sync';

/** Structural exclusion only, never an authorization proof. The post alias and
 * viewer come from the server's canonical query/session, not public parameters.
 * Each surviving row must still pass the bounded immutable disposition owner.
 * Missing/malformed metadata stays a candidate and fails that mandatory proof.
 */
export function homeDistributionCandidateSql(
  alias: string,
  viewer: string | null,
  surface: HomeDistributionSurface,
  parameters: unknown[],
): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  let denied = 'true';
  if (surface === 'home' || surface === 'following' || surface === 'hot') {
    const actor = parameters.push(viewer);
    denied = `${alias}.account_id IS DISTINCT FROM $${actor}::uuid`;
    if (surface === 'following')
      denied = `(${denied} OR ${alias}.author_mode<>'named' OR home_admission.definition->'surfaces'->>'following'='excluded')`;
    if (surface === 'hot')
      denied = `(${denied} OR home_admission.definition->'surfaces'->>'hot'='disabled')`;
  }
  return `NOT EXISTS (
    SELECT 1 FROM whaleu_community.home_post_dispositions home_disposition
    LEFT JOIN whaleu_community.home_policy_admissions home_admission
      ON home_admission.id=(home_disposition.evidence->'admission'->>'id')::uuid
      AND home_admission.revision::text=home_disposition.evidence->'admission'->>'revision'
      AND home_admission.digest=home_disposition.evidence->'admission'->>'digest'
    WHERE home_disposition.post_id=${alias}.id
      AND home_disposition.evidence->>'result' IN ('short_text','reference_only')
      AND (${denied}) OFFSET 0
  )`;
}

/** Hot's water exclusion is independent of author-only Home disposition. An
 * indexed exact head lookup preserves original hot score/scope seek planning;
 * current-category proof still validates every surviving row before emission.
 */
export function hotCurrentWaterExcludedSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  return `COALESCE((SELECT home_category.current_category
    FROM whaleu_community.post_category_heads home_category
    WHERE home_category.post_id=${alias}.id),${alias}.category)<>'water'`;
}
