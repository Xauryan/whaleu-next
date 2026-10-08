import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { DirectoryAccessService } from '../src/organizations/directory/access.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { LocalSafetyPhoneSource } from '../src/verification/safety-phone.source.js';
import type { LocalPublicationEligibilitySource } from '../src/verification/publication-eligibility.source.js';
import type { CampusCommunityPolicyService } from '../src/campus/community-policy/campus-community-policy.service.js';
import type { SafetyDirectoryReadFacade } from '../src/safety/directory-read.facade.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
function fixture(
  overrides: {
    phone?: string;
    affiliation?: string;
    safety?: 'SAFETY_UNAVAILABLE' | 'SAFETY_ACTION_RESTRICTED';
    campus?: string;
    relation?: string;
    deadline?: number;
  } = {},
) {
  const events: string[] = [];
  const home = randomUUID();
  const account = randomUUID();
  let target: string | null | undefined;
  const tx = {
    query: async (sql: string) => {
      events.push(sql.includes('pg_advisory') ? 'outer-gate' : 'clock');
      return { rows: [{ now: new Date(2000) }] };
    },
  } as unknown as PoolClient;
  const service = new DirectoryAccessService(
    {
      session: async () => {
        events.push('session');
        return {
          accountId: account,
          sessionId: randomUUID(),
          expiresAt: 10000,
          refreshExpiresAt: 20000,
        };
      },
    } as unknown as IdentityService,
    {
      resolve: async () => {
        events.push('phone');
        return {
          status: overrides.phone ?? 'verified',
          validUntil: overrides.deadline ?? null,
        };
      },
    } as unknown as LocalSafetyPhoneSource,
    {
      resolve: async () => {
        events.push('affiliation');
        return {
          status: overrides.affiliation ?? 'verified',
          assertionId: randomUUID(),
          snapshotId: randomUUID(),
          institutionId: randomUUID(),
          originRegionId: randomUUID(),
          validUntil: overrides.deadline ?? null,
        };
      },
    } as unknown as LocalPublicationEligibilitySource,
    {
      resolve: async (
        _account: unknown,
        _affiliation: unknown,
        region: string | null,
      ) => {
        events.push('campus');
        target = region;
        return {
          status: overrides.campus ?? 'valid',
          identityRegionId: home,
          selectionId: randomUUID(),
          topologySnapshotId: randomUUID(),
          relation: overrides.relation ?? (region === null ? 'global' : 'home'),
          validUntil: overrides.deadline ?? null,
        };
      },
    } as unknown as CampusCommunityPolicyService,
    {
      requireAllowed: async () => {
        events.push('safety');
        if (overrides.safety) throw new ApplicationError(overrides.safety);
      },
    } as unknown as SafetyDirectoryReadFacade,
  );
  return { events, home, account, tx, service, target: () => target };
}
test('directory requires current canonical member owners in one outer-gated read; context resolves rather than guesses home', async () => {
  const f = fixture();
  const result = await f.service.resolve('token', null, f.tx);
  assert.equal(result.regionId, f.home);
  assert.equal(result.session.accountId, f.account);
  assert.equal(f.target(), null);
  assert.deepEqual(f.events, [
    'outer-gate',
    'session',
    'phone',
    'safety',
    'affiliation',
    'campus',
  ]);
  await f.service.recheck('token', f.tx);
  assert.equal(f.events.at(-1), 'session');
});
test('all member-denial and unavailable outcomes are required; home is distinct from related, foreign and global', async () => {
  for (const [options, code] of [
    [{ phone: 'unverified' }, 'PHONE_VERIFICATION_REQUIRED'],
    [{ phone: 'unavailable' }, 'VERIFICATION_UNAVAILABLE'],
    [{ safety: 'SAFETY_ACTION_RESTRICTED' }, 'SAFETY_ACTION_RESTRICTED'],
    [{ safety: 'SAFETY_UNAVAILABLE' }, 'SAFETY_UNAVAILABLE'],
    [{ affiliation: 'unverified' }, 'AFFILIATION_VERIFICATION_REQUIRED'],
    [{ affiliation: 'unavailable' }, 'VERIFICATION_UNAVAILABLE'],
    [{ campus: 'selection_required' }, 'IDENTITY_CAMPUS_REQUIRED'],
    [{ campus: 'unavailable' }, 'IDENTITY_CAMPUS_UNAVAILABLE'],
    [{ relation: 'related' }, 'DIRECTORY_SCOPE_UNAVAILABLE'],
    [{ relation: 'foreign' }, 'DIRECTORY_SCOPE_UNAVAILABLE'],
    [{ relation: 'global' }, 'DIRECTORY_SCOPE_UNAVAILABLE'],
  ] as const) {
    const f = fixture(options);
    await assert.rejects(f.service.resolve('token', f.home, f.tx), { code });
  }
  const f = fixture();
  await assert.rejects(f.service.resolve('token', randomUUID(), f.tx), {
    code: 'DIRECTORY_SCOPE_UNAVAILABLE',
  });
});
test('finite owner deadlines invalidate every directory field after transaction waits', async () => {
  const f = fixture({ deadline: 1000 });
  startTransactionDeadlines(f.tx);
  try {
    await f.service.resolve('token', f.home, f.tx);
    await assert.rejects(checkTransactionDeadlines(f.tx), {
      code: 'VERIFICATION_UNAVAILABLE',
    });
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
