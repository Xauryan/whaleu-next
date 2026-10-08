/** Explicit synthetic evidence, only for disposable local tests. Never imported by runtime. */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { RecordAction } from '../../src/experience/catalog.js';
async function localFixture(tx: PoolClient) {
  const peer = (
    tx as PoolClient & { connection?: { stream?: { remoteAddress?: string } } }
  ).connection?.stream?.remoteAddress;
  if (
    !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(tx.host) ||
    !peer ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)
  )
    throw new Error('Experience fixtures require actual loopback connection');
  const row = (
    await tx.query<{ allowed: boolean }>(
      'SELECT whaleu_experience.synthetic_fixture_allowed() AS allowed',
    )
  ).rows[0];
  if (!row?.allowed)
    throw new Error(
      'Experience fixtures require disposable loopback whaleu_test',
    );
}
export async function establishSyntheticExperienceBaseline(
  tx: PoolClient,
  owner: string,
  input: {
    balance: bigint;
    lastDay?: string | null;
    streak?: number;
    historyCoverage?: 'complete' | 'partial';
    entitlementCoverage?: 'complete' | 'partial';
  },
) {
  await localFixture(tx);
  await tx.query(
    'INSERT INTO whaleu_experience.owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
    [owner],
  );
  await tx.query(
    "INSERT INTO whaleu_experience.baselines(owner_id,origin,opening_balance,opening_signin_day,opening_streak,history_coverage,entitlement_coverage) VALUES($1,'synthetic_fixture',$2,$3,$4,$5,$6)",
    [
      owner,
      input.balance.toString(),
      input.lastDay ?? null,
      input.streak ?? 0,
      input.historyCoverage ?? 'partial',
      input.entitlementCoverage ?? 'partial',
    ],
  );
  await tx.query(
    'INSERT INTO whaleu_experience.account_states(owner_id,balance,last_signin_day,streak) VALUES($1,$2,$3,$4)',
    [owner, input.balance.toString(), input.lastDay ?? null, input.streak ?? 0],
  );
}
export async function grantSyntheticTitle(
  tx: PoolClient,
  owner: string,
  titleKey: string,
  earnedAt: Date | null = null,
) {
  await localFixture(tx);
  await tx.query(
    'INSERT INTO whaleu_experience.owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
    [owner],
  );
  await tx.query(
    "INSERT INTO whaleu_experience.entitlements(owner_id,title_key,origin,earned_at) VALUES($1,$2,'synthetic_fixture',$3)",
    [owner, titleKey, earnedAt],
  );
}
export async function recordSyntheticHistory(
  tx: PoolClient,
  owner: string,
  input: {
    action: RecordAction;
    occurredAt?: Date | null;
    nominalDelta?: bigint | null;
  },
) {
  await localFixture(tx);
  await tx.query(
    'INSERT INTO whaleu_experience.owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
    [owner],
  );
  const id = randomUUID();
  await tx.query(
    "INSERT INTO whaleu_experience.records(id,owner_id,action,origin,outcome,nominal_delta,occurred_at) VALUES($1,$2,$3,'synthetic_fixture','historical',$4,$5)",
    [
      id,
      owner,
      input.action,
      input.nominalDelta?.toString() ?? null,
      input.occurredAt ?? null,
    ],
  );
  return id;
}
