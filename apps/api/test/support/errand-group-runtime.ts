import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ERRAND_GROUP_RUNTIME } from '../../src/notifications/errand-group/contracts.js';
import type {
  ErrandGroupRuntime,
  GroupDestination,
  GroupPermit,
  GroupStage,
  PreparedSyntheticGroupSend,
  SyntheticAck,
  SyntheticGroupAuthorityPort,
  SyntheticGroupSendPort,
} from '../../src/notifications/errand-group/contracts.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { errandMediaFixture } from './media/errand-runtime-fixture.js';
import { ErrandGroupWorker } from '../../src/notifications/errand-group/worker.js';
import { ErrandGroupRepository } from '../../src/notifications/errand-group/repository.js';
import { ErrandGroupSource } from '../../src/errands/group-source.js';
import { DatabaseService } from '../../src/database/database.js';
export class SyntheticGroupAuthority implements SyntheticGroupAuthorityPort {
  readonly groups = new Map<string, GroupDestination>();
  unavailable = false;
  validUntil = Date.now() + 3600000;
  readonly proof: RequiredTransactionProof<GroupDestination> = {
    maximumFacts: 128,
    failureCode: 'ERRAND_UNAVAILABLE',
    validate: async (facts) => {
      for (const fact of facts) this.check(fact);
    },
  };
  add(targetRegionId: string, stage: GroupStage, name: string) {
    const value = {
      id: `synthetic:${name}`,
      revision: 'r1',
      targetRegionId,
      stage,
    };
    this.groups.set(value.id, value);
    return value;
  }
  check(d: GroupDestination) {
    if (
      this.unavailable ||
      this.validUntil <= Date.now() ||
      JSON.stringify(this.groups.get(d.id)) !== JSON.stringify(d)
    )
      throw new ApplicationError('ERRAND_UNAVAILABLE');
  }
  async destinations(region: string, stage: GroupStage, _tx: PoolClient) {
    return this.unavailable
      ? null
      : [...this.groups.values()]
          .filter((d) => d.targetRegionId === region && d.stage === stage)
          .map((d) => ({ ...d }));
  }
  async requireCurrent(d: GroupDestination, tx: PoolClient) {
    this.check(d);
    enableRequiredTransactionProof(tx, this.proof);
    registerRequiredTransactionFact(
      tx,
      this.proof,
      JSON.stringify(d),
      Object.freeze({ ...d }),
    );
    registerTransactionDeadline(tx, this.validUntil, 'ERRAND_UNAVAILABLE');
  }
}
export class DurableSyntheticGroupSender implements SyntheticGroupSendPort {
  readonly attempts: GroupPermit[] = [];
  readonly reconciled: string[] = [];
  readonly actions = new Map<
    string,
    ('not_accepted' | 'lose_ack' | 'unknown')[]
  >();
  unresolved = false;
  beforeReady: (() => Promise<void>) | null = null;
  preparedExpiresAt: number | null = null;
  constructor(
    readonly directory: string,
    readonly now: () => number,
  ) {}
  private file(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw Error('Bad key');
    return join(this.directory, `${key}.json`);
  }
  async prepare(
    key: string,
    destination: GroupDestination,
  ): Promise<PreparedSyntheticGroupSend> {
    await this.beforeReady?.();
    return {
      key,
      destinationId: destination.id,
      expiresAt: this.preparedExpiresAt ?? performance.now() + 5000,
      dispatch: (permit) => {
        if (
          permit.key !== key ||
          permit.destination.id !== destination.id ||
          performance.now() >= permit.expiresAt
        )
          throw Error('Invalid synthetic permit');
        this.attempts.push(permit);
        const file = this.file(key);
        if (existsSync(file))
          return JSON.parse(readFileSync(file, 'utf8')) as SyntheticAck;
        const action = this.actions.get(destination.id)?.shift();
        if (action === 'not_accepted')
          return { status: 'not_accepted', key, destinationId: destination.id };
        if (action === 'unknown') {
          this.unresolved = true;
          throw Error('Synthetic outcome unknown');
        }
        const ack: SyntheticAck = {
          status: 'confirmed',
          key,
          destinationId: destination.id,
          receiptId: `synthetic:${randomUUID()}`,
          confirmedAt: this.now(),
        };
        writeFileSync(file, JSON.stringify(ack));
        if (action === 'lose_ack') throw Error('Synthetic ACK response lost');
        return ack;
      },
    };
  }
  async reconcile(key: string, destinationId: string): Promise<SyntheticAck> {
    this.reconciled.push(key);
    if (this.unresolved) return { status: 'unknown' };
    const file = this.file(key);
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as SyntheticAck)
      : { status: 'not_accepted', key, destinationId };
  }
}
export async function errandGroupFixture(
  fixtures: Parameters<typeof errandMediaFixture>[0] = [],
) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-errand-groups-'));
  let time = Date.now();
  const authority = new SyntheticGroupAuthority(),
    sender = new DurableSyntheticGroupSender(directory, () => time);
  const runtime: ErrandGroupRuntime = {
    mode: 'synthetic-only',
    authority,
    sender,
    shortlinks: null,
    now: () => time,
  };
  try {
    const f = await errandMediaFixture(
      fixtures.length
        ? fixtures
        : [{ sha256: '0'.repeat(64), verdict: 'allow' }],
      {
        configureTestModule(builder) {
          builder.overrideProvider(ERRAND_GROUP_RUNTIME).useValue(runtime);
        },
      },
    );
    const db = f.app.get(DatabaseService),
      records = f.app.get(ErrandGroupRepository),
      source = f.app.get(ErrandGroupSource);
    const restart = (next: ErrandGroupRuntime = runtime) =>
      new ErrandGroupWorker(db, records, source, next);
    return {
      ...f,
      db,
      records,
      source,
      directory,
      runtime,
      sender,
      authority,
      restart,
      groups: f.app.get(ErrandGroupWorker),
      setTime: (now: number) => {
        time = now;
      },
      rows: () =>
        f.pool.query(
          'SELECT * FROM whaleu_notifications.errand_group_deliveries ORDER BY stage,destination_id',
        ),
      close: async () => {
        try {
          await f.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (e) {
    rmSync(directory, { recursive: true, force: true });
    throw e;
  }
}
