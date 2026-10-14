import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { SchoolUidCoverageFacade } from './coverage.facade.js';

const MAX = 9223372036854775807n;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z
  .string()
  .uuid()
  .regex(/^[0-9a-f-]{36}$/);
const boundedInteger = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((v) => BigInt(v) <= MAX);
const rawInteger = z.strictObject({
  type: z.enum(['string', 'integer', 'float', 'null']),
  value: z.string().max(100).nullable(),
});
const reservation = z.strictObject({
  uid: rawInteger,
  sourceAccountId: z.string().min(1).max(200).nullable(),
  accountId: uuid.nullable(),
  sourceSchoolId: z.string().min(1).max(200),
  kind: z.enum(['current', 'historical', 'deleted', 'transferred', 'reserved']),
});
const school = z.strictObject({
  sourceSchoolId: z.string().min(1).max(200),
  institutionId: uuid,
  schoolCode: z.string().regex(/^[0-9]{5}$/),
  classification: z.enum(['known_new', 'reconciled']),
  issuanceAvailable: z.boolean().optional(),
  sourceEmptyVerified: z.boolean(),
  trustedCeiling: boundedInteger.nullable(),
  ceilingJustificationDigest: digest.nullable(),
  priorAdmittedFloor: boundedInteger,
  trustedCounters: z.array(rawInteger).max(100),
  counterReset: z.boolean(),
  unknownHistoryBounded: z.boolean(),
  reservations: z.array(reservation).max(100_000),
  accountCoverage: z
    .array(
      z.strictObject({
        sourceAccountId: z.string().min(1).max(128),
        accountId: uuid,
        status: z.enum(['known_missing', 'known_assigned']),
      }),
    )
    .max(100_000)
    .optional(),
  unresolvedConflicts: z.array(z.string().min(1).max(200)).max(1000),
});
export const schoolUidInventorySchema = z.strictObject({
  format: z.literal('school-uid-inventory/v1'),
  classification: z.enum(['synthetic', 'real']),
  sourceInstance: z.string().min(1).max(200),
  sourceCutoff: z.iso.datetime({ offset: true }),
  snapshotDigest: digest,
  schoolCrosswalkDigest: digest,
  accountCrosswalkDigest: digest,
  reviewerAcceptanceDigest: digest.nullable(),
  writerQuiescenceDigest: digest.nullable(),
  finalDeltaDigest: digest.nullable(),
  schools: z.array(school).min(1).max(100),
});
export type SchoolUidInventory = z.infer<typeof schoolUidInventorySchema>;
export type InventoryQuarantineReason =
  | 'MAPPING_AMBIGUOUS'
  | 'ACCEPTANCE_MISSING'
  | 'WRITER_CUTOVER_MISSING'
  | 'SOURCE_CUTOFF_FUTURE'
  | 'TRUSTED_CEILING_MISSING'
  | 'UNBOUNDED_HISTORY'
  | 'COUNTER_MISSING'
  | 'COUNTER_RESET'
  | 'RAW_INTEGER_INVALID'
  | 'COUNTER_BELOW_OBSERVATION'
  | 'CEILING_BELOW_OBSERVATION'
  | 'DUPLICATE_UID_OWNERS'
  | 'ACCOUNT_MAPPING_CONFLICT'
  | 'ACCOUNT_SCHOOL_MISMATCH'
  | 'KNOWN_NEW_CONFLICT'
  | 'UNRESOLVED_CONFLICT';
export interface AcceptedSchoolInventory {
  institutionId: string;
  schoolCode: string;
  sourceSchoolId: string;
  classification: 'known_new' | 'reconciled';
  reservedFloor: string;
  issuanceAvailable: boolean;
  observedMaximum: string;
  counterMaximum: string;
  reservationCount: number;
}
export interface InventoryReport {
  format: 'school-uid-inventory-report/v1';
  packageDigest: string;
  classification: 'synthetic' | 'real';
  realApplyAvailable: false;
  acceptedSchools: AcceptedSchoolInventory[];
  quarantinedSchools: {
    institutionId: string;
    schoolCode: string;
    reasons: InventoryQuarantineReason[];
  }[];
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) +
          ':' +
          canonical((value as Record<string, unknown>)[key]),
      )
      .join(',') +
    '}'
  );
}
export function inventoryDigest(value: unknown): string {
  return createHash('sha256')
    .update('whaleu:school-uid-inventory:v1\n' + canonical(value))
    .digest('hex');
}
/** Raw types are retained in the digest; floats and numeric coercion are forbidden. */
function rawValue(
  input: z.infer<typeof rawInteger>,
  positive: boolean,
): bigint | null {
  if (
    !['string', 'integer'].includes(input.type) ||
    typeof input.value !== 'string' ||
    !/^[0-9]{1,19}$/.test(input.value)
  )
    return null;
  const n = BigInt(input.value);
  return n > MAX || n < (positive ? 1n : 0n) ? null : n;
}
const max = (...values: bigint[]) =>
  values.reduce((a, b) => (a > b ? a : b), 0n);

/** Offline validation is evidence assessment, never permission to import real data. */
export function validateSchoolUidInventory(
  input: unknown,
  now = new Date(),
): InventoryReport {
  const value = schoolUidInventorySchema.parse(input);
  const acceptedSchools: AcceptedSchoolInventory[] = [];
  const quarantinedSchools: InventoryReport['quarantinedSchools'] = [];
  const counts = new Map<string, number>();
  const sourceAccounts = new Map<string, Set<string>>();
  const targetAccounts = new Map<string, Set<string>>();
  for (const item of value.schools)
    for (const r of [...item.reservations, ...(item.accountCoverage ?? [])]) {
      if (r.sourceAccountId === null || r.accountId === null) continue;
      sourceAccounts.set(
        r.sourceAccountId,
        (sourceAccounts.get(r.sourceAccountId) ?? new Set()).add(r.accountId),
      );
      targetAccounts.set(
        r.accountId,
        (targetAccounts.get(r.accountId) ?? new Set()).add(r.sourceAccountId),
      );
    }
  for (const s of value.schools)
    for (const key of [
      'source:' + s.sourceSchoolId,
      'institution:' + s.institutionId,
      'code:' + s.schoolCode,
    ])
      counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const s of value.schools) {
    const reasons = new Set<InventoryQuarantineReason>();
    if (
      [
        'source:' + s.sourceSchoolId,
        'institution:' + s.institutionId,
        'code:' + s.schoolCode,
      ].some((key) => counts.get(key)! > 1)
    )
      reasons.add('MAPPING_AMBIGUOUS');
    if (!value.reviewerAcceptanceDigest) reasons.add('ACCEPTANCE_MISSING');
    if (!value.writerQuiescenceDigest || !value.finalDeltaDigest)
      reasons.add('WRITER_CUTOVER_MISSING');
    if (!Number.isFinite(now.getTime()) || new Date(value.sourceCutoff) > now)
      reasons.add('SOURCE_CUTOFF_FUTURE');
    if (s.trustedCeiling === null || s.ceilingJustificationDigest === null)
      reasons.add('TRUSTED_CEILING_MISSING');
    if (!s.unknownHistoryBounded) reasons.add('UNBOUNDED_HISTORY');
    if (s.counterReset) reasons.add('COUNTER_RESET');
    if (!s.trustedCounters.length && s.classification !== 'known_new')
      reasons.add('COUNTER_MISSING');
    if (s.unresolvedConflicts.length) reasons.add('UNRESOLVED_CONFLICT');
    let observedMaximum = 0n;
    const owners = new Map<string, string>();
    const accountMappings = new Map<string, string>();
    for (const r of s.reservations) {
      const n = rawValue(r.uid, true);
      if (n === null) {
        reasons.add('RAW_INTEGER_INVALID');
        continue;
      }
      observedMaximum = max(observedMaximum, n);
      if (r.sourceSchoolId !== s.sourceSchoolId)
        reasons.add('ACCOUNT_SCHOOL_MISMATCH');
      if ((r.sourceAccountId === null) !== (r.accountId === null))
        reasons.add('ACCOUNT_MAPPING_CONFLICT');
      if (r.sourceAccountId !== null && r.accountId !== null) {
        if (
          sourceAccounts.get(r.sourceAccountId)!.size > 1 ||
          targetAccounts.get(r.accountId)!.size > 1
        )
          reasons.add('ACCOUNT_MAPPING_CONFLICT');
        const mapped = accountMappings.get(r.sourceAccountId);
        if (mapped && mapped !== r.accountId)
          reasons.add('ACCOUNT_MAPPING_CONFLICT');
        accountMappings.set(r.sourceAccountId, r.accountId);
        const owner = owners.get(n.toString());
        if (owner && owner !== r.accountId) reasons.add('DUPLICATE_UID_OWNERS');
        owners.set(n.toString(), r.accountId);
      }
    }
    let counterMaximum = 0n;
    for (const counter of s.trustedCounters) {
      const n = rawValue(counter, false);
      if (n === null) reasons.add('RAW_INTEGER_INVALID');
      else {
        counterMaximum = max(counterMaximum, n);
        if (n < observedMaximum) reasons.add('COUNTER_BELOW_OBSERVATION');
      }
    }
    const currentOwners = new Map<string, Set<string>>();
    for (const r of s.reservations)
      if (r.kind === 'current' && r.accountId !== null) {
        const n = rawValue(r.uid, true);
        if (n !== null)
          currentOwners.set(
            r.accountId,
            (currentOwners.get(r.accountId) ?? new Set()).add(n.toString()),
          );
      }
    if ([...currentOwners.values()].some((uids) => uids.size > 1))
      reasons.add('ACCOUNT_MAPPING_CONFLICT');
    const coverageAccounts = new Set<string>();
    const coverageSources = new Set<string>();
    for (const covered of s.accountCoverage ?? []) {
      if (
        coverageAccounts.has(covered.accountId) ||
        coverageSources.has(covered.sourceAccountId)
      )
        reasons.add('ACCOUNT_MAPPING_CONFLICT');
      coverageAccounts.add(covered.accountId);
      coverageSources.add(covered.sourceAccountId);
      if (
        (sourceAccounts.get(covered.sourceAccountId)?.size ?? 0) > 1 ||
        (targetAccounts.get(covered.accountId)?.size ?? 0) > 1
      )
        reasons.add('ACCOUNT_MAPPING_CONFLICT');
      const matched = s.reservations.filter(
        (r) =>
          r.accountId === covered.accountId ||
          r.sourceAccountId === covered.sourceAccountId,
      );
      if (
        matched.some(
          (r) =>
            r.accountId !== covered.accountId ||
            r.sourceAccountId !== covered.sourceAccountId,
        )
      )
        reasons.add('ACCOUNT_MAPPING_CONFLICT');
      const currents = matched.filter((r) => r.kind === 'current');
      if (
        (covered.status === 'known_missing' && currents.length > 0) ||
        (covered.status === 'known_assigned' && currents.length !== 1)
      )
        reasons.add('ACCOUNT_MAPPING_CONFLICT');
    }
    const prior = BigInt(s.priorAdmittedFloor);
    const ceiling = s.trustedCeiling === null ? 0n : BigInt(s.trustedCeiling);
    if (
      s.trustedCeiling !== null &&
      ceiling < max(observedMaximum, counterMaximum, prior)
    )
      reasons.add('CEILING_BELOW_OBSERVATION');
    if (
      s.classification === 'known_new' &&
      (!s.sourceEmptyVerified ||
        observedMaximum !== 0n ||
        counterMaximum !== 0n ||
        ceiling !== 0n ||
        prior !== 0n ||
        s.reservations.length !== 0)
    )
      reasons.add('KNOWN_NEW_CONFLICT');
    if (reasons.size)
      quarantinedSchools.push({
        institutionId: s.institutionId,
        schoolCode: s.schoolCode,
        reasons: [...reasons].sort(),
      });
    else
      acceptedSchools.push({
        institutionId: s.institutionId,
        schoolCode: s.schoolCode,
        sourceSchoolId: s.sourceSchoolId,
        classification: s.classification,
        issuanceAvailable: s.issuanceAvailable ?? true,
        reservedFloor: max(
          ceiling,
          counterMaximum,
          observedMaximum,
          prior,
        ).toString(),
        observedMaximum: observedMaximum.toString(),
        counterMaximum: counterMaximum.toString(),
        reservationCount: s.reservations.length,
      });
  }
  return {
    format: 'school-uid-inventory-report/v1',
    packageDigest: inventoryDigest(value),
    classification: value.classification,
    realApplyAvailable: false,
    acceptedSchools,
    quarantinedSchools,
  };
}
export interface SyntheticAdmissionResult {
  packageDigest: string;
  institutionId: string;
  admissionId: string;
  revision: number;
  reservedFloor: string;
  highWater: string;
  replay: boolean;
  stale: boolean;
}
export async function requireSyntheticDatabase(tx: PoolClient): Promise<void> {
  if (process.env['NODE_ENV'] !== 'test')
    throw new Error('SYNTHETIC_UID_REQUIRES_TEST_RUNTIME');
  const status = (
    await tx.query<{ database: string; local: boolean }>(
      "SELECT current_database() database,(inet_server_addr() IS NULL OR inet_server_addr() <<= inet '127.0.0.0/8' OR inet_server_addr()=inet '::1') local",
    )
  ).rows[0];
  if (!status || status.database !== 'whaleu_test' || !status.local)
    throw new Error('SYNTHETIC_UID_REQUIRES_LOCAL_TEST_DATABASE');
}
/** Bounded synthetic fixture owner only. No real package can reach a write. */
export async function applySyntheticInventory(
  input: unknown,
  institutionId: string,
  tx: PoolClient,
): Promise<SyntheticAdmissionResult> {
  const value = schoolUidInventorySchema.parse(input);
  if (value.classification !== 'synthetic')
    throw new Error('REAL_SCHOOL_UID_APPLY_UNAVAILABLE');
  await requireSyntheticDatabase(tx);
  const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() now'))
    .rows[0]!.now;
  const report = validateSchoolUidInventory(value, now);
  const school = report.acceptedSchools.find(
    (s) => s.institutionId === institutionId,
  );
  if (!school) throw new Error('SCHOOL_UID_INVENTORY_QUARANTINED');
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:school-uid-admission:v1:'||$1,0))",
    [institutionId],
  );
  const old = (
    await tx.query<{
      id: string;
      revision: number;
      reserved_floor: string;
      high_water: string;
    }>(
      `SELECT a.id,a.revision,a.reserved_floor::text,t.new_value::text high_water FROM whaleu_school_uid.school_admissions a JOIN whaleu_school_uid.inventory_batches b ON b.id=a.batch_id JOIN whaleu_school_uid.counter_transitions t ON t.admission_id=a.id AND t.kind='admission' WHERE b.package_digest=$1 AND a.institution_id=$2`,
      [report.packageDigest, institutionId],
    )
  ).rows[0];
  if (old)
    return {
      packageDigest: report.packageDigest,
      institutionId,
      admissionId: old.id,
      revision: old.revision,
      reservedFloor: old.reserved_floor,
      highWater: old.high_water,
      replay: true,
      stale: false,
    };
  const current = (
    await tx.query<{
      admission_id: string;
      revision: number;
      reserved_floor: string;
      high_water: string;
    }>(
      `SELECT h.admission_id,h.revision,a.reserved_floor::text,h.high_water::text FROM whaleu_school_uid.admission_heads h JOIN whaleu_school_uid.school_admissions a ON a.id=h.admission_id WHERE h.institution_id=$1 FOR UPDATE OF h`,
      [institutionId],
    )
  ).rows[0];
  if (
    current &&
    (BigInt(school.reservedFloor) < BigInt(current.reserved_floor) ||
      school.classification === 'known_new')
  )
    return {
      packageDigest: report.packageDigest,
      institutionId,
      admissionId: current.admission_id,
      revision: current.revision,
      reservedFloor: current.reserved_floor,
      highWater: current.high_water,
      replay: false,
      stale: true,
    };
  const batch = randomUUID();
  await tx.query(
    `INSERT INTO whaleu_school_uid.inventory_batches(id,format_version,package_digest,source_instance,source_cutoff,snapshot_digest,mapping_digest,acceptance_digest,writer_cutover_digest,classification,manifest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'synthetic',$10::jsonb) ON CONFLICT(package_digest) DO NOTHING`,
    [
      batch,
      value.format,
      report.packageDigest,
      value.sourceInstance,
      value.sourceCutoff,
      value.snapshotDigest,
      inventoryDigest([
        value.schoolCrosswalkDigest,
        value.accountCrosswalkDigest,
      ]),
      value.reviewerAcceptanceDigest,
      inventoryDigest([value.writerQuiescenceDigest, value.finalDeltaDigest]),
      JSON.stringify({
        package: value,
        acceptedSchools: report.acceptedSchools,
      }),
    ],
  );
  const batchId = (
    await tx.query<{ id: string }>(
      'SELECT id FROM whaleu_school_uid.inventory_batches WHERE package_digest=$1',
      [report.packageDigest],
    )
  ).rows[0]!.id;
  const admissionId = randomUUID();
  const revision = (current?.revision ?? 0) + 1;
  await tx.query(
    `INSERT INTO whaleu_school_uid.school_admissions(id,institution_id,revision,batch_id,classification,reserved_floor,issuance_available) VALUES($1,$2,$3,$4,$5,$6::bigint,$7)`,
    [
      admissionId,
      institutionId,
      revision,
      batchId,
      school.classification,
      school.reservedFloor,
      school.issuanceAvailable,
    ],
  );
  return {
    packageDigest: report.packageDigest,
    institutionId,
    admissionId,
    revision,
    reservedFloor: school.reservedFloor,
    highWater: max(
      BigInt(current?.high_water ?? '0'),
      BigInt(school.reservedFloor),
    ).toString(),
    replay: false,
    stale: false,
  };
}

export interface SyntheticAccountImport {
  institutionId: string;
  accountId: string;
  mode: 'current' | 'historical' | 'covered_missing';
  uid?: string;
}
/** One account per transaction. Imported history is always inside accepted floor. */
export async function applySyntheticAccountInventory(
  input: unknown,
  target: SyntheticAccountImport,
  tx: PoolClient,
): Promise<{
  causeId: string;
  allocationId: string | null;
  eventId: string | null;
  replay: boolean;
}> {
  const value = schoolUidInventorySchema.parse(input);
  if (value.classification !== 'synthetic')
    throw new Error('REAL_SCHOOL_UID_APPLY_UNAVAILABLE');
  await requireSyntheticDatabase(tx);
  if ((target.mode === 'covered_missing') !== (target.uid === undefined))
    throw new Error('SCHOOL_UID_IMPORT_MODE_MISMATCH');
  if (
    target.uid !== undefined &&
    (!/^[1-9][0-9]{0,18}$/.test(target.uid) || BigInt(target.uid) > MAX)
  )
    throw new Error('SCHOOL_UID_IMPORT_INVALID_NUMBER');
  const school = value.schools.find(
    (s) => s.institutionId === target.institutionId,
  );
  const account = school?.accountCoverage?.find(
    (a) => a.accountId === target.accountId,
  );
  if (
    !school ||
    !account ||
    (target.mode !== 'historical' &&
      account.status !==
        (target.mode === 'covered_missing'
          ? 'known_missing'
          : 'known_assigned'))
  )
    throw new Error('SCHOOL_UID_IMPORT_ACCOUNT_NOT_COVERED');
  const observation = await new SchoolUidCoverageFacade().observeNativeAbsence(
    target.accountId,
    tx,
  );
  const verification = (
    await tx.query<{
      revision: number;
      snapshot_id: string;
      assertion_id: string;
      event_id: string;
    }>(
      `SELECT h.revision,h.snapshot_id,s.affiliation_assertion_id assertion_id,e.id event_id FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON (s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision) JOIN whaleu_verification.events e ON (e.snapshot_id,e.account_id,e.revision)=(s.id,s.account_id,s.revision) WHERE h.account_id=$1 FOR UPDATE OF h`,
      [target.accountId],
    )
  ).rows[0];
  if (!verification?.assertion_id)
    throw new Error('SCHOOL_UID_IMPORT_VERIFICATION_UNAVAILABLE');
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:school-uid-account:v1:'||$1,0))",
    [target.accountId],
  );
  const old = (
    await tx.query<{ revision: number; allocation_id: string | null }>(
      'SELECT revision,allocation_id FROM whaleu_school_uid.account_heads WHERE account_id=$1 FOR UPDATE',
      [target.accountId],
    )
  ).rows[0];
  // Account lock precedes every admission lock, even when the package is new.
  const admission = await applySyntheticInventory(
    value,
    target.institutionId,
    tx,
  );
  const batch = (
    await tx.query<{ id: string }>(
      'SELECT id FROM whaleu_school_uid.inventory_batches WHERE package_digest=$1',
      [admission.packageDigest],
    )
  ).rows[0];
  if (!batch) throw new Error('SCHOOL_UID_IMPORT_ADMISSION_UNAVAILABLE');
  const previous = (
    await tx.query<{
      cause_id: string;
      allocation_id: string | null;
      event_id: string | null;
    }>(
      `SELECT im.cause_id,a.id allocation_id,e.id event_id FROM whaleu_school_uid.import_sources im LEFT JOIN whaleu_school_uid.allocations a ON a.cause_id=im.cause_id LEFT JOIN whaleu_school_uid.assignment_events e ON e.cause_id=im.cause_id WHERE im.batch_id=$1 AND im.account_id=$2 AND im.institution_id=$3 AND im.mode=$4 AND im.uid IS NOT DISTINCT FROM $5::bigint`,
      [
        batch.id,
        target.accountId,
        target.institutionId,
        target.mode,
        target.uid ?? null,
      ],
    )
  ).rows[0];
  if (previous)
    return {
      causeId: previous.cause_id,
      allocationId: previous.allocation_id,
      eventId: previous.event_id,
      replay: true,
    };
  const causeId = randomUUID(),
    sourceId = randomUUID();
  await tx.query(
    `INSERT INTO whaleu_school_uid.import_sources(id,cause_id,batch_id,account_id,institution_id,source_account_id,mode,uid,mapping_proof,initial_generation,observation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::bigint,'[]','',$9)`,
    [
      sourceId,
      causeId,
      batch.id,
      target.accountId,
      target.institutionId,
      account.sourceAccountId,
      target.mode,
      target.uid ?? null,
      observation.id,
    ],
  );
  await tx.query(
    `INSERT INTO whaleu_school_uid.producing_causes(id,kind,account_id,actor_account_id,source_id,institution_id,affiliation_assertion_id,snapshot_id,verification_event_id,old_snapshot_id,old_revision) VALUES($1,'imported',$2,$2,$3,$4,$5,$6,$7,$6,$8)`,
    [
      causeId,
      target.accountId,
      sourceId,
      target.institutionId,
      verification.assertion_id,
      verification.snapshot_id,
      verification.event_id,
      verification.revision,
    ],
  );
  const coverage = (
    await tx.query(
      'SELECT id FROM whaleu_school_uid.account_coverage WHERE account_id=$1',
      [target.accountId],
    )
  ).rowCount;
  if (!coverage)
    await tx.query(
      `INSERT INTO whaleu_school_uid.account_coverage(id,account_id,kind,cause_id,batch_id,source_account_id,mapping_proof) SELECT $1,im.account_id,'accepted_import',im.cause_id,im.batch_id,im.source_account_id,im.mapping_proof FROM whaleu_school_uid.import_sources im WHERE im.id=$2`,
      [randomUUID(), sourceId],
    );
  let allocationId: string | null = null;
  if (target.mode !== 'covered_missing') {
    allocationId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_school_uid.allocations(id,account_id,institution_id,uid,admission_id,cause_id,predecessor_allocation_id) SELECT $1,$2,$3,$4::bigint,h.admission_id,$5,$6 FROM whaleu_school_uid.admission_heads h WHERE h.institution_id=$3`,
      [
        allocationId,
        target.accountId,
        target.institutionId,
        target.uid,
        causeId,
        old?.allocation_id ?? null,
      ],
    );
  }
  let eventId: string | null = null;
  if (target.mode !== 'historical') {
    eventId = randomUUID();
    const revision = (old?.revision ?? 0) + 1;
    await tx.query(
      `INSERT INTO whaleu_school_uid.assignment_events(id,cause_id,account_id,institution_id,previous_allocation_id,resulting_allocation_id,affiliation_assertion_id,snapshot_id,revision,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        eventId,
        causeId,
        target.accountId,
        target.institutionId,
        old?.allocation_id ?? null,
        allocationId,
        verification.assertion_id,
        verification.snapshot_id,
        revision,
        target.mode === 'current' ? 'imported' : 'covered_missing',
      ],
    );
    if (old)
      await tx.query(
        'UPDATE whaleu_school_uid.account_heads SET revision=$2,event_id=$3,allocation_id=$4,institution_id=$5,cause_id=$6 WHERE account_id=$1 AND revision=$7',
        [
          target.accountId,
          revision,
          eventId,
          allocationId,
          target.institutionId,
          causeId,
          old.revision,
        ],
      );
    else
      await tx.query(
        'INSERT INTO whaleu_school_uid.account_heads(account_id,revision,event_id,allocation_id,institution_id,cause_id) VALUES($1,$2,$3,$4,$5,$6)',
        [
          target.accountId,
          revision,
          eventId,
          allocationId,
          target.institutionId,
          causeId,
        ],
      );
  }
  return { causeId, allocationId, eventId, replay: false };
}
