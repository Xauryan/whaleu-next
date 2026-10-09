import { Injectable } from '@nestjs/common';
import { ApplicationError } from '../http/application-error.js';
import { safetyCountProofOwner } from './count-epochs.js';

/** Owner-controlled metadata relation, never a list of vector candidates.
 * The community owner supplies a trusted CTE with node_key, author_mode,
 * named_account_id (uuid, NULL for anonymous), and purpose. Each ancestor must
 * be a separate node: anonymous/self/guest bypass applies only to that node.
 * No body, target-reply identity, or underlying anonymous identity is accepted.
 */
export interface SafetySearchEligibilityRelation {
  readonly nodes: string;
  readonly viewerParameter: number;
}

@Injectable()
export class SafetySearchEligibilityFacade {
  /** The coordinator captures before reading and registers a REQUIRED proof in
   * community -> Safety -> Campus order. A SQL relation is not a commit proof.
   * Its final fences run only after all scalar/identity/source waits finish. */
  readonly proofOwner = safetyCountProofOwner;

  /** Returns node_key, decision (allow/deny/unknown), valid_until. The caller
   * must preserve parent-first scalar short circuits, fail on relevant unknown,
   * register the minimum relevant deadline (including denials), then materialize
   * the allowed relation BEFORE joining/ranking vectors. No corpus size ceiling
   * or relationship identities cross this owner boundary.
   *
   * Input is internal SQL metadata, never request text. Identifiers are restricted
   * to a single quoted CTE name; the viewer is always a bound UUID parameter.
   */
  relation(input: SafetySearchEligibilityRelation): string {
    if (
      !/^[a-z][a-z0-9_]{0,62}$/.test(input.nodes) ||
      !Number.isSafeInteger(input.viewerParameter) ||
      input.viewerParameter < 1 ||
      input.viewerParameter > 65535
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const viewer = `$${input.viewerParameter}::uuid`;
    return `WITH safety_clock AS MATERIALIZED (
      SELECT clock_timestamp() AS checked_at
    ), safety_nodes AS MATERIALIZED (
      SELECT n.node_key,n.author_mode,n.named_account_id,n.purpose,
        (${viewer} IS NULL OR n.author_mode='anonymous'
          OR (n.author_mode='named' AND n.named_account_id=${viewer})) AS bypass
      FROM "${input.nodes}" n
    ), safety_facts AS MATERIALIZED (
      SELECT n.*,
        (v.account_id IS NOT NULL AND v.block_coverage='complete'
          AND v.provenance='native_account_creation'
          AND (v.valid_until IS NULL OR
            (isfinite(v.valid_until) AND v.valid_until>c.checked_at))) AS viewer_valid,
        (a.account_id IS NOT NULL AND a.block_coverage='complete'
          AND a.provenance='native_account_creation'
          AND (a.valid_until IS NULL OR
            (isfinite(a.valid_until) AND a.valid_until>c.checked_at))) AS author_valid,
        v.valid_until AS viewer_until,a.valid_until AS author_until,
        (coalesce(outgoing.active,false) OR
          (n.purpose='direct_post' AND coalesce(incoming.active,false))) AS blocked
      FROM safety_nodes n CROSS JOIN safety_clock c
      LEFT JOIN whaleu_safety.account_heads v
        ON NOT n.bypass AND v.account_id=${viewer}
      LEFT JOIN whaleu_safety.account_heads a
        ON NOT n.bypass AND n.purpose='direct_post' AND a.account_id=n.named_account_id
      LEFT JOIN whaleu_safety.blocks outgoing
        ON NOT n.bypass AND outgoing.blocker_id=${viewer}
          AND outgoing.blocked_id=n.named_account_id
      LEFT JOIN whaleu_safety.blocks incoming
        ON NOT n.bypass AND n.purpose='direct_post'
          AND incoming.blocker_id=n.named_account_id AND incoming.blocked_id=${viewer}
    ), safety_decisions AS MATERIALIZED (
      SELECT node_key,
        CASE
          WHEN purpose IS NULL OR purpose NOT IN ('list_projection','direct_post')
            OR author_mode IS NULL OR author_mode NOT IN ('anonymous','named')
            OR (author_mode='anonymous' AND named_account_id IS NOT NULL)
            OR (author_mode='named' AND named_account_id IS NULL) THEN 'unknown'
          WHEN bypass THEN 'allow'
          WHEN viewer_valid IS NOT TRUE
            OR (purpose='direct_post' AND author_valid IS NOT TRUE) THEN 'unknown'
          WHEN blocked THEN 'deny' ELSE 'allow' END AS decision,
        CASE WHEN bypass THEN NULL::timestamptz
          WHEN purpose='direct_post' THEN least(viewer_until,author_until)
          ELSE viewer_until END AS valid_until
      FROM safety_facts
    ) SELECT node_key,decision,
      CASE WHEN decision='unknown' THEN NULL::timestamptz ELSE valid_until END AS valid_until
      FROM safety_decisions`;
  }
}
