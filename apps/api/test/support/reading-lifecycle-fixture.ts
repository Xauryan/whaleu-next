/** Disposable guarded lifecycle fact fixture only. It does not qualify M2 for
 * erasure, bypass the real erasure service, or issue any processing permit. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { initializeNativeExperienceAccount } from '../../src/experience/lifecycle.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';
import { initializeNativeVerificationAccount } from '../../src/verification/lifecycle.js';
import { inTransaction } from '../../src/database/database.js';
import { inventory, sha } from '../../src/account-deletion/owners/preflight.js';
import {
  readBaseline,
  validateNativeBaseline,
} from '../../src/account-deletion/owners/baseline.js';
import {
  INVENTORY_VERSION,
  SYNTHETIC_POLICY,
} from '../../src/account-deletion/contracts.js';
import { SYNTHETIC_APP } from '../../src/account-deletion/synthetic-policy.js';

export async function createReadingLifecycleSandbox(pool: Pool) {
  const id = randomUUID();
  await inTransaction(pool, async (tx) => {
    assert.equal(
      (await tx.query('SELECT current_database() name')).rows[0]!.name,
      'whaleu_test',
    );
    // Exact published inventory is sealed after the unchanged c27 0174 prefix,
    // BEFORE the unqualified M1 text-source extension and M2 draft.
    const rows = await inventory(tx, true);
    await tx.query(
      'INSERT INTO whaleu_account_deletion.sandboxes(id,now_at,inventory,policy,catalog_hash) VALUES($1,clock_timestamp(),$2,$3,$4)',
      [
        id,
        INVENTORY_VERSION,
        SYNTHETIC_POLICY,
        sha(rows.map(({ relation, shape_hash }) => ({ relation, shape_hash }))),
      ],
    );
    for (const row of rows)
      await tx.query(
        'INSERT INTO whaleu_account_deletion.inventory(sandbox_id,relation,shape_hash,rows_hash,row_count,supported) VALUES($1,$2,$3,$4,$5,$6)',
        [
          id,
          row.relation,
          row.shape_hash,
          row.rows_hash,
          row.row_count,
          row.supported,
        ],
      );
  });
  return id;
}
export async function createReadingLifecycleActor(
  app: INestApplication,
  pool: Pool,
  sandbox: string,
) {
  const accountId = randomUUID(),
    subject = 'synthetic-' + randomUUID();
  await inTransaction(pool, async (tx) => {
    await tx.query('INSERT INTO whaleu_identity.accounts(id) VALUES($1)', [
      accountId,
    ]);
    await initializeNativeExperienceAccount(accountId, tx);
    await initializeNativeSafetyAccount(accountId, tx);
    await tx.query(
      "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat',$1,$2,$3)",
      [SYNTHETIC_APP, subject, accountId],
    );
    await initializeNativeVerificationAccount(accountId, SYNTHETIC_APP, tx);
    const baseline = await readBaseline(tx, accountId);
    validateNativeBaseline(baseline, accountId);
    await tx.query(
      'INSERT INTO whaleu_account_deletion.fixture_accounts(account_id,sandbox_id,identity_digest,baseline) VALUES($1,$2,$3,$4::jsonb)',
      [
        accountId,
        sandbox,
        sha(['reading-lifecycle-fact-only', subject]),
        JSON.stringify(baseline),
      ],
    );
  });
  const accessToken = mintToken('access'),
    refreshToken = mintToken('refresh');
  const session = await app
    .get(IdentityRepository)
    .createSession(
      { provider: 'wechat', appId: SYNTHETIC_APP, subject },
      { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
    );
  return { ...session, accessToken, refreshToken };
}
/** Guarded causal SQL fixture, not AccountDeletionService acceptance. The real
 * service must reject this catalog because all four M2 tables are unqualified. */
export async function enterReadingLifecycleCooling(
  tx: PoolClient,
  accountId: string,
  sandbox: string,
) {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO whaleu_account_deletion.requests(id,account_id,generation,intent_hash,policy,inventory,phase,requested_at,eligible_at,receipt_key_hash) SELECT $1,a.id,a.lifecycle_generation+1,$4,$5,$6,'cooling',s.now_at,s.now_at+interval '604800 seconds',$4 FROM whaleu_identity.accounts a CROSS JOIN whaleu_account_deletion.sandboxes s WHERE a.id=$2 AND s.id=$3`,
    [
      id,
      accountId,
      sandbox,
      sha(['reading-lifecycle-counterexample', id]),
      SYNTHETIC_POLICY,
      INVENTORY_VERSION,
    ],
  );
  assert.equal(
    (
      await tx.query(
        'SELECT lifecycle FROM whaleu_identity.accounts WHERE id=$1',
        [accountId],
      )
    ).rows[0]!.lifecycle,
    'cooling',
  );
  return id;
}
