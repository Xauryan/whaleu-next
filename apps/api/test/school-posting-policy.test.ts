import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  saveSchoolPostingPolicySchema,
  schoolPostingCommandHash,
  schoolPostingCategories,
  schoolPostingQuerySchema,
} from '../src/school-posting-policy/contracts.js';
import { projectSchoolPostingPolicy } from '../src/school-posting-policy/service.js';
import type { SchoolPostingRow } from '../src/school-posting-policy/repository.js';
const now = Date.parse('2026-10-11T12:00:00.000Z');
function row(patch: Partial<SchoolPostingRow> = {}): SchoolPostingRow {
  return {
    id: randomUUID(),
    region_id: randomUUID(),
    revision: 1,
    coverage_state: 'complete',
    provenance_state: 'accepted',
    source_reference: 'synthetic published command',
    policy_reference: 'synthetic policy',
    unverified_post_enabled: true,
    unverified_comment_enabled: true,
    unverified_categories: ['discussion'],
    related_sync_enabled: false,
    effective_at: new Date(now - 60000),
    expiry_kind: 'policy_exempt',
    valid_until: null,
    ...patch,
  };
}
function command() {
  return {
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    policy: {
      unverifiedPostEnabled: true,
      unverifiedCommentEnabled: false,
      unverifiedCategories: ['discussion' as const],
      expiry: { kind: 'policy_exempt' as const },
    },
  };
}
test('missing policy is unconfigured, never an accepted off default', () => {
  assert.deepEqual(projectSchoolPostingPolicy(null, now), {
    revision: 0,
    revisionId: null,
    state: 'unconfigured',
    editable: true,
    blocker: null,
    policy: null,
  });
});
test('active accepted settings expose exact named-post categories, independent comments and expiry', () => {
  const input = row({
      unverified_comment_enabled: false,
      unverified_categories: [...schoolPostingCategories],
    }),
    view = projectSchoolPostingPolicy(input, now);
  assert.equal(view.state, 'active');
  assert.equal(view.editable, true);
  assert.equal(view.revisionId, input.id);
  assert.deepEqual(view.policy, {
    unverifiedPostEnabled: true,
    unverifiedCommentEnabled: false,
    unverifiedCategories: schoolPostingCategories,
    expiry: { kind: 'policy_exempt' },
    effectiveAt: input.effective_at.toISOString(),
  });
});
test('expired accepted false-sync facts can only be explicitly replaced as a new policy', () => {
  const input = row({ expiry_kind: 'at', valid_until: new Date(now - 1) }),
    view = projectSchoolPostingPolicy(input, now);
  assert.equal(view.state, 'expired');
  assert.equal(view.editable, true);
  assert.equal(view.revision, 1);
  assert.equal(view.policy?.expiry.kind, 'at');
});
test('unknown and conflicting provenance, future effectiveness, unknown expiry, duplicate or unsupported categories stay read-only', () => {
  for (const patch of [
    { coverage_state: 'missing' as const },
    { coverage_state: 'conflicting' as const },
    { provenance_state: 'unknown' as const },
    { provenance_state: 'conflicting' as const },
    { source_reference: null },
    { policy_reference: ' ' },
    { expiry_kind: 'unknown' as const },
    { effective_at: new Date(now + 1) },
    { unverified_categories: ['discussion', 'discussion'] },
    { unverified_categories: ['trading'] },
    { unverified_categories: ['feedback'] },
    { expiry_kind: 'at' as const, valid_until: null },
    { expiry_kind: 'policy_exempt' as const, valid_until: new Date(now + 1) },
  ]) {
    const view = projectSchoolPostingPolicy(row(patch), now);
    assert.equal(view.state, 'unavailable', JSON.stringify(patch));
    assert.equal(view.editable, false);
    assert.equal(view.blocker, 'untrusted_source');
    assert.equal(view.policy, null);
  }
});
test('related synchronization is never silently disabled or exposed as a supported toggle', () => {
  const view = projectSchoolPostingPolicy(
    row({ related_sync_enabled: true }),
    now,
  );
  assert.equal(view.state, 'active');
  assert.equal(view.editable, false);
  assert.equal(view.blocker, 'related_sync_unsupported');
});
test('command is strict and excludes authority/provenance, unverified trading/feedback, duplicate categories and unsafe integer', () => {
  const input = command();
  assert.ok(saveSchoolPostingPolicySchema.safeParse(input).success);
  for (const bad of [
    { ...input, actorId: randomUUID() },
    { ...input, expectedRevision: 2147483647 },
    { ...input, policy: { ...input.policy, relatedSyncEnabled: false } },
    {
      ...input,
      policy: { ...input.policy, unverifiedCategories: ['trading'] },
    },
    {
      ...input,
      policy: { ...input.policy, unverifiedCategories: ['feedback'] },
    },
    {
      ...input,
      policy: {
        ...input.policy,
        unverifiedCategories: ['discussion', 'discussion'],
      },
    },
    {
      ...input,
      policy: {
        ...input.policy,
        expiry: { kind: 'at', validUntil: '2026-10-11T13:00:00+01:00' },
      },
    },
  ])
    assert.equal(
      saveSchoolPostingPolicySchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
});
test('request digest binds actor, target, key, CAS, exact expiry spelling and category order', () => {
  const actor = randomUUID(),
    region = randomUUID(),
    input = command(),
    digest = schoolPostingCommandHash(actor, region, input);
  assert.equal(
    schoolPostingCommandHash(actor, region, JSON.parse(JSON.stringify(input))),
    digest,
  );
  assert.notEqual(
    schoolPostingCommandHash(randomUUID(), region, input),
    digest,
  );
  assert.notEqual(schoolPostingCommandHash(actor, randomUUID(), input), digest);
  assert.notEqual(
    schoolPostingCommandHash(actor, region, { ...input, expectedRevision: 1 }),
    digest,
  );
  assert.notEqual(
    schoolPostingCommandHash(actor, region, {
      ...input,
      clientRequestId: randomUUID(),
    }),
    digest,
  );
  const a = {
      ...input,
      policy: {
        ...input.policy,
        unverifiedCategories: ['discussion', 'pets'] as (
          'discussion' | 'pets'
        )[],
      },
    },
    b = {
      ...a,
      policy: {
        ...a.policy,
        unverifiedCategories: [...a.policy.unverifiedCategories].reverse(),
      },
    };
  assert.notEqual(
    schoolPostingCommandHash(actor, region, a),
    schoolPostingCommandHash(actor, region, b),
  );
});

test('new owner rejects noncanonical uppercase UUIDs instead of failing after hashing or SQL casting', () => {
  const input = command();
  assert.equal(
    saveSchoolPostingPolicySchema.safeParse({
      ...input,
      clientRequestId: 'ABCDEFAB-1234-4ABC-8ABC-ABCDEFABCDEF',
    }).success,
    false,
  );
  assert.equal(
    schoolPostingQuerySchema.safeParse({
      regionId: 'ABCDEFAB-1234-4ABC-8ABC-ABCDEFABCDEF',
    }).success,
    false,
  );
});
