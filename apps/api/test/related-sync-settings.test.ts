import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import type { CommunityDistributionService } from '../src/community/related-sync/service.js';
import { currentAccountPolicyAction } from '../src/safety/account-policy/context.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { DatabaseService } from '../src/database/database.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import type { SchoolConfigurationAccess } from '../src/school-configuration/access.js';
import {
  saveSchoolPostingPolicySchema,
  schoolPostingCommandHash,
  schoolPostingReceiptSchema,
  schoolPostingViewSchema,
} from '../src/school-posting-policy/contracts.js';
import type { SaveSchoolPostingPolicy } from '../src/school-posting-policy/contracts.js';
import {
  projectSchoolPostingPolicy,
  SchoolPostingPolicyService,
} from '../src/school-posting-policy/service.js';
import type {
  SchoolPostingPolicyRepository,
  SchoolPostingRow,
} from '../src/school-posting-policy/repository.js';

const id = (n: number) =>
  `20000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const actor = id(1),
  region = id(2),
  requestId = id(3);
const now = Date.parse('2026-10-13T12:00:00.000Z');
const policy = {
  unverifiedPostEnabled: false,
  unverifiedCommentEnabled: true,
  unverifiedCategories: ['discussion' as const],
  expiry: { kind: 'policy_exempt' as const },
};
const v1 = { clientRequestId: requestId, expectedRevision: 1, policy };
const command = (enabled: boolean): SaveSchoolPostingPolicy => ({
  ...v1,
  version: 2,
  policy: { ...policy, relatedSyncEnabled: enabled },
});
const current = (): SchoolPostingRow => ({
  id: id(4),
  region_id: region,
  revision: 1,
  unverified_post_enabled: false,
  unverified_comment_enabled: true,
  unverified_categories: ['discussion'],
  related_sync_enabled: true,
  coverage_state: 'complete',
  provenance_state: 'accepted',
  source_reference: 'synthetic native command',
  policy_reference: 'synthetic accepted configuration',
  effective_at: new Date(now - 1000),
  expiry_kind: 'policy_exempt',
  valid_until: null,
});
const receipt = (input: SaveSchoolPostingPolicy) =>
  schoolPostingReceiptSchema.parse({
    requestId,
    requestHash: schoolPostingCommandHash(actor, region, input),
    regionId: region,
    revision: 2,
    revisionId: id(5),
    outcome: 'saved',
  });

test('settings v2 has exact explicit flag and a separate hash domain; v1 bytes remain unchanged', () => {
  const legacy = createHash('sha256')
    .update('whaleu-school-posting-policy-command:v1\n')
    .update(canonicalJson({ actorId: actor, regionId: region, command: v1 }))
    .digest('hex');
  assert.equal(schoolPostingCommandHash(actor, region, v1), legacy);
  const enabled = saveSchoolPostingPolicySchema.parse(command(true));
  const expected = createHash('sha256')
    .update('whaleu-school-posting-policy-command:v2\n')
    .update(
      canonicalJson({ actorId: actor, regionId: region, command: enabled }),
    )
    .digest('hex');
  assert.equal(schoolPostingCommandHash(actor, region, enabled), expected);
  assert.notEqual(
    expected,
    schoolPostingCommandHash(actor, region, command(false)),
  );
  assert.notEqual(
    legacy,
    schoolPostingCommandHash(actor, region, command(false)),
  );
  for (const bad of [
    { ...v1, version: 2 },
    { ...command(true), version: 3 },
    { ...v1, policy: { ...policy, relatedSyncEnabled: true } },
    { ...command(true), grantId: id(7) },
  ])
    assert.equal(saveSchoolPostingPolicySchema.safeParse(bad).success, false);
});

test('updated settings view exposes exact true sync while legacy projection stays read-only', () => {
  const prior = current();
  assert.equal(projectSchoolPostingPolicy(prior, now).editable, false);
  const updated = projectSchoolPostingPolicy(prior, now, true);
  assert.equal(updated.editable, true);
  assert.equal(updated.blocker, null);
  assert.equal(updated.policy?.relatedSyncEnabled, true);
  assert.equal(
    schoolPostingViewSchema.safeParse({
      context: {
        regionId: region,
        regionName: 'Synthetic A',
        management: 'fixed',
      },
      ...updated,
    }).success,
    true,
  );
  assert.equal(
    projectSchoolPostingPolicy(
      { ...prior, provenance_state: 'unknown' },
      now,
      true,
    ).editable,
    false,
  );
});

function service(
  options: {
    recovered?: ReturnType<typeof receipt>;
    cancelled?: string;
    failEnable?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const proofQueries: string[] = [];
  const tx = {
    query: async (sql: string) => {
      proofQueries.push(sql);
      return {
        rows: sql.includes('clock_timestamp() AS now')
          ? [{ now: new Date(now) }]
          : sql.includes("current_setting('transaction_isolation')")
            ? [
                {
                  isolation: 'read committed',
                  statement_timeout: '15s',
                  lock_timeout: '0',
                },
              ]
            : [],
      };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(work: (tx: PoolClient) => Promise<T>) => {
      startTransactionDeadlines(tx);
      try {
        const result = await work(tx);
        await checkTransactionDeadlines(tx);
        return result;
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as unknown as DatabaseService;
  const access = {
    authenticate: async () => {
      calls.push('authenticate');
      return { accountId: actor };
    },
    management: async () => {
      calls.push('management');
      return { session: { accountId: actor }, grant: { id: id(6) } };
    },
  } as unknown as SchoolConfigurationAccess;
  const records = {
    lockRequest: async () => {
      calls.push('lock');
    },
    recover: async () => {
      calls.push('recover');
      return options.recovered ?? null;
    },
    cancelled: async () => options.cancelled ?? null,
    current: async () => current(),
    save: async (input: { command: SaveSchoolPostingPolicy }) => {
      calls.push('save');
      return receipt(input.command);
    },
  } as unknown as SchoolPostingPolicyRepository;
  const distribution = {
    requirePolicyEnable: async (actualRegion: string) => {
      assert.equal(actualRegion, region);
      calls.push('enable');
      if (options.failEnable)
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    },
  } as unknown as CommunityDistributionService;
  return {
    value: new SchoolPostingPolicyService(
      database,
      access,
      records,
      distribution,
    ),
    calls,
    proofQueries,
  };
}

test('v2 disable remains possible after topology/applicability withdrawal and preserves exact grant gate', async () => {
  const owner = service({ failEnable: true });
  assert.equal(
    (await owner.value.save('token', region, command(false))).outcome,
    'saved',
  );
  assert.deepEqual(owner.calls, [
    'authenticate',
    'lock',
    'recover',
    'management',
    'save',
  ]);
});

test('v2 enable requires current owner proof before revision write', async () => {
  const owner = service();
  await owner.value.save('token', region, command(true));
  assert.deepEqual(owner.calls, [
    'authenticate',
    'lock',
    'recover',
    'management',
    'enable',
    'save',
  ]);
  assert.ok(owner.proofQueries.includes('SET CONSTRAINTS ALL IMMEDIATE'));
  assert.ok(
    owner.proofQueries.some((sql) => sql.includes('IN SHARE MODE NOWAIT')),
  );
  assert.equal(
    owner.proofQueries.filter((sql) =>
      sql.includes('jsonb_agg(jsonb_build_array(to_jsonb(g)'),
    ).length,
    2,
  );
  const missing = service({ failEnable: true });
  await assert.rejects(missing.value.save('token', region, command(true)));
  assert.equal(missing.calls.includes('save'), false);
});

test('legacy v1 may not silently disable a previously enabled related setting', async () => {
  const owner = service();
  await assert.rejects(
    owner.value.save('token', region, v1),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'SCHOOL_POSTING_POLICY_SOURCE_UNRESOLVED',
  );
  assert.equal(owner.calls.includes('save'), false);
});

test('same-key receipt recovery precedes current grant, topology and applicability reads', async () => {
  const saved = receipt(command(true)),
    owner = service({ recovered: saved, failEnable: true });
  assert.deepEqual(
    await owner.value.save('token', region, command(true)),
    saved,
  );
  assert.deepEqual(owner.calls, ['authenticate', 'lock', 'recover']);
  await assert.rejects(
    owner.value.save('token', region, command(false)),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'SCHOOL_POSTING_POLICY_REQUEST_CONFLICT',
  );
});

test('same-key cancelled v2 stays cancelled before grant or topology recovery', async () => {
  const owner = service({
    cancelled: schoolPostingCommandHash(actor, region, command(true)),
  });
  await assert.rejects(
    owner.value.save('token', region, command(true)),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'SCHOOL_POSTING_POLICY_CANCELLED',
  );
  assert.deepEqual(owner.calls, ['authenticate', 'lock', 'recover']);
  await assert.rejects(
    owner.value.save('token', region, command(false)),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'SCHOOL_POSTING_POLICY_REQUEST_CONFLICT',
  );
});

test('suspended settings actor can recover same key but fresh write keeps noncontent management action', async () => {
  const owner = service({ recovered: receipt(command(true)) });
  const restrictedAccess = {
    authenticate: async () => {
      assert.equal(
        currentAccountPolicyAction('interaction'),
        'restricted_self_service',
      );
      return { accountId: actor };
    },
    management: async () => {
      throw new Error('Recovery must not consult fresh authority');
    },
  };
  Object.assign(owner.value, { access: restrictedAccess });
  assert.equal(
    (await owner.value.save('token', region, command(true))).outcome,
    'saved',
  );
  const fresh = service();
  Object.assign(fresh.value, {
    access: {
      authenticate: restrictedAccess.authenticate,
      management: async () => {
        assert.equal(
          currentAccountPolicyAction('interaction'),
          'noncontent_management',
        );
        throw new ApplicationError('SAFETY_ACCESS_SUSPENDED');
      },
    },
  });
  await assert.rejects(
    fresh.value.save('token', region, command(false)),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'SAFETY_ACCESS_SUSPENDED',
  );
});
