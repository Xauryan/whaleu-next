import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNativeBaseline } from '../src/account-deletion/owners/baseline.js';
import type { Baseline } from '../src/account-deletion/owners/baseline.js';
const account = '11111111-1111-4111-8111-111111111111',
  at = '2026-10-20T00:00:00+00:00';
function baseline(): Baseline {
  return {
    'whaleu_experience.owners': [{ owner_id: account }],
    'whaleu_experience.baselines': [
      {
        owner_id: account,
        origin: 'native_account_creation',
        opening_balance: 0,
        opening_signin_day: null,
        opening_streak: 0,
        history_coverage: 'complete',
        entitlement_coverage: 'complete',
        rule_version: 'local-experience-v1',
        recorded_at: at,
      },
    ],
    'whaleu_experience.account_states': [
      {
        owner_id: account,
        balance: 0,
        last_signin_day: null,
        streak: 0,
        revision: 0,
      },
    ],
    'whaleu_experience.appearance': [
      { owner_id: account, title_key: null, color_id: null, revision: 0 },
    ],
    'whaleu_experience.entitlements': ['default_jingxiaoyu', 'level_1'].map(
      (title_key) => ({
        owner_id: account,
        title_key,
        origin: 'registration',
        settlement_id: null,
        earned_at: at,
        recorded_at: at,
        redemption_request_id: null,
        creation_transaction: null,
        maintenance_actor_id: null,
        maintenance_request_id: null,
        school_admin_actor_id: null,
        school_admin_request_id: null,
      }),
    ),
    'whaleu_safety.account_heads': [
      {
        account_id: account,
        block_coverage: 'complete',
        restriction_coverage: 'complete',
        provenance: 'native_account_creation',
        actions_allowed: true,
        valid_until: null,
        created_at: at,
      },
    ],
    'whaleu_safety.events': [
      {
        id: '22222222-2222-4222-8222-222222222222',
        account_id: account,
        relationship_id: null,
        kind: 'native_account_created',
        revision: null,
        created_at: at,
      },
    ],
    'whaleu_verification.account_heads': [],
    'whaleu_verification.assertions': [],
    'whaleu_verification.snapshots': [],
    'whaleu_verification.events': [],
    'whaleu_verification.native_enrollments': [],
    'whaleu_verification.relevant_fact_generations': [],
  };
}
test('only exact native zero-state and genuinely absent verification graph are retained', () => {
  assert.doesNotThrow(() => validateNativeBaseline(baseline(), account));
  for (const value of [null, false, '0', '', 1]) {
    const b = baseline();
    b['whaleu_experience.account_states']![0]!['balance'] = value;
    assert.throws(() => validateNativeBaseline(b, account));
  }
  for (const table of Object.keys(baseline())) {
    const b = baseline();
    delete b[table];
    assert.throws(() => validateNativeBaseline(b, account));
  }
  const extra = baseline();
  extra['unknown.owner'] = [];
  assert.throws(() => validateNativeBaseline(extra, account));
});
test('fixed baseline schema rejects arbitrary private fields, foreign owners and semantic non-baseline facts', () => {
  for (const [table, rows] of Object.entries(baseline()))
    if (rows.length) {
      const privateRow = baseline();
      privateRow[table]![0]!['private_payload'] = 'private sentinel';
      assert.throws(() => validateNativeBaseline(privateRow, account));
      const reassigned = baseline();
      reassigned[table]![0]![
        table.startsWith('whaleu_experience.') ? 'owner_id' : 'account_id'
      ] = 'another-account';
      assert.throws(() => validateNativeBaseline(reassigned, account));
    }
  for (const [table, key, value] of [
    ['whaleu_safety.account_heads', 'provenance', 'import'],
    ['whaleu_safety.events', 'kind', 'restriction_created'],
    ['whaleu_experience.entitlements', 'origin', 'redemption'],
    ['whaleu_experience.appearance', 'title_key', 'private-title'],
  ] as const) {
    const b = baseline();
    b[table]![0]![key] = value;
    assert.throws(() => validateNativeBaseline(b, account));
  }
});
test('partial Verification history is never certified as absent', () => {
  for (const table of Object.keys(baseline()).filter((t) =>
    t.startsWith('whaleu_verification.'),
  )) {
    const b = baseline();
    b[table] = [{ account_id: account, student_number: 'private-number' }];
    assert.throws(() => validateNativeBaseline(b, account));
  }
});
