import assert from 'node:assert/strict';
/** Isolated unit-fixture SQL leaf for a deliberately unpunished actor.
 * Never imported by runtime or real-PG fixtures. It handles only this exact new
 * overlay query; every other SQL remains with the existing strict fixture owner.
 * Original owner query counters intentionally exclude this separate policy leaf.
 */
export function unpunishedAccountPolicyObservation(
  sql: string,
  params?: unknown[],
) {
  if (
    sql !==
    'SELECT * FROM whaleu_safety.account_punishment_policy_observation($1,$2)'
  )
    return undefined;
  assert.equal(params?.length, 2);
  assert.equal(typeof params![0], 'string');
  assert.ok(
    [
      'browse',
      'interaction',
      'content_management',
      'privileged_read',
      'noncontent_management',
      'private_self_service',
      'protective_cleanup',
      'passive_bookkeeping',
    ].includes(params![1] as string),
  );
  return {
    rows: [
      {
        fingerprint: '0'.repeat(64),
        allowed: true,
        suspended: false,
        until: null,
      },
    ],
    rowCount: 1,
  };
}
