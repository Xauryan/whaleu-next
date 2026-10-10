export interface MediaSafetyEvent {
  state: string;
  manifest_digest: string;
  policy_revision: string;
  effective_at: Date;
  valid_until: Date;
}
/** Known deny is authoritative only for this exact manifest and current policy,
 * with complete, presently valid evidence. Missing/expired/mismatched evidence
 * remains unknown and must never become an empty page or an allow decision. */
export function currentMediaSafety(
  event: MediaSafetyEvent | undefined,
  manifestDigest: string,
  policyRevision: string,
  now: number | undefined,
): 'allow' | 'deny' | 'unknown' {
  if (
    !event ||
    now === undefined ||
    !Number.isFinite(now) ||
    event.manifest_digest !== manifestDigest ||
    event.policy_revision !== policyRevision ||
    !Number.isFinite(event.effective_at.getTime()) ||
    !Number.isFinite(event.valid_until.getTime()) ||
    event.effective_at.getTime() > now ||
    event.valid_until.getTime() <= now ||
    event.valid_until.getTime() <= event.effective_at.getTime()
  )
    return 'unknown';
  return event.state === 'allow'
    ? 'allow'
    : ['held', 'revoked'].includes(event.state)
      ? 'deny'
      : 'unknown';
}
