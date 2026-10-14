import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertionStatus } from '../src/verification/policy.js';
import { syntheticAssertion } from './support/verification-fixtures.js';

const account = randomUUID();
const institution = randomUUID();
const command = randomUUID();
const now = new Date();
const corrected = () =>
  syntheticAssertion(account, institution, 'affiliation', {
    method: 'administrator_correction',
    source_reference: `school_identity_correction:${command}`,
    policy_reference: 'verified-school-correction/v1',
  });

test('administrator correction requires all three exact discriminators and affiliation fact', () => {
  assert.equal(
    assertionStatus(corrected(), account, 'affiliation', now),
    'verified',
  );
  for (const patch of [
    { method: 'document_review' as const },
    { source_reference: 'other_source' },
    { source_reference: 'school_identity_correction:not-a-command' },
    { policy_reference: 'other_policy' },
    { fact_kind: 'phone' as const },
    { fact_kind: 'student_number' as const },
    { source_account_id: randomUUID() },
  ]) {
    assert.equal(
      assertionStatus(
        { ...corrected(), ...patch },
        account,
        'affiliation',
        now,
      ),
      'unavailable',
    );
  }
  for (const fact of ['phone', 'student_number'] as const) {
    assert.equal(
      assertionStatus({ ...corrected(), fact_kind: fact }, account, fact, now),
      'unavailable',
    );
  }
  for (const state of ['revoked', 'expired'] as const) {
    assert.equal(
      assertionStatus(
        { ...corrected(), assertion_state: state },
        account,
        'affiliation',
        now,
      ),
      state,
    );
  }
  assert.equal(
    assertionStatus(
      { ...corrected(), expires_at: now },
      account,
      'affiliation',
      now,
    ),
    'expired',
  );
});

test('forward migration preserves all six accepted consumer definitions except affiliation method', async () => {
  const migration = await readFile(
    new URL(
      '../migrations/0142_school_identity_verification.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const [file, name] of [
    ['0113_course_comments.sql', 'whaleu_verification.course_comment_fact'],
    ['0114_window_ratings.sql', 'whaleu_verification.window_rating_fact'],
    ['0121_major_discussion.sql', 'whaleu_verification.major_rating_fact'],
    [
      '0133_school_admin_management.sql',
      'whaleu_authorization.school_admin_region_allowed',
    ],
    [
      '0138_related_campus_distribution.sql',
      'whaleu_community.related_sync_root_admitted',
    ],
    [
      '0138_related_campus_distribution.sql',
      'whaleu_community.related_sync_child_scope_current',
    ],
  ]) {
    const source = await readFile(
      new URL(`../migrations/${file}`, import.meta.url),
      'utf8',
    );
    const start = source.indexOf(`CREATE FUNCTION ${name}(`);
    assert.ok(start >= 0, name);
    const bodyStart = source.indexOf('AS $$', start) + 5;
    const end = source.slice(bodyStart).search(/\$\$\s*;/);
    const terminator = source.slice(bodyStart + end).match(/^\$\$\s*;/)![0];
    const exact = source
      .slice(start, bodyStart + end + terminator.length)
      .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
      .replace(
        "'document_review','institutional_email','institutional_sso','reconciled_import'",
        "'document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction'",
      );
    assert.ok(
      migration.includes(exact),
      `${name} changed more than the affiliation allowlist`,
    );
  }
});
