import { randomUUID } from 'node:crypto';
import {
  captureOfficialInbox,
  drainOfficialCauses,
  hasOfficialPending,
} from './inbox.js';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { boundHotTransaction } from '../community/hot-score/transaction.js';
import { ApplicationError } from '../http/application-error.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { OFFICIAL_PROFILE, officialUuid, officialDigest } from './profile.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import type { OfficialSourceFact, OfficialSourcePort } from './source.js';

// Canonical owner proofs share the fixed five-second transaction with inbox conversion.
// Keep their work below the 32-row wire cap; this never extends any deadline.
const OFFICIAL_COVERAGE_BATCH = 16;
const OFFICIAL_DEPENDENCY_PREFIX = 32;

/** Each arm uses an independent partial time index; no historical score scan. */
export const OFFICIAL_TIME_FRONTIER = `SELECT DISTINCT space_id,post_id FROM (
 (SELECT space_id,post_id FROM whaleu_official.source_ranks WHERE space_id=ANY($1::uuid[]) AND daily_active AND published_at<=$2::timestamptz-interval '26 hours' LIMIT ${OFFICIAL_COVERAGE_BATCH})
 UNION ALL (SELECT space_id,post_id FROM whaleu_official.source_ranks WHERE space_id=ANY($1::uuid[]) AND daily_active AND published_at>$2::timestamptz LIMIT ${OFFICIAL_COVERAGE_BATCH})
 UNION ALL (SELECT space_id,post_id FROM whaleu_official.source_ranks WHERE space_id=ANY($1::uuid[]) AND NOT daily_active AND structural_present AND published_at>$2::timestamptz-interval '26 hours' AND published_at<=$2::timestamptz LIMIT ${OFFICIAL_COVERAGE_BATCH})
 UNION ALL (SELECT space_id,post_id FROM whaleu_official.source_ranks WHERE space_id=ANY($1::uuid[]) AND daily_active AND valid_until<=$2::timestamptz LIMIT ${OFFICIAL_COVERAGE_BATCH})
 UNION ALL (SELECT space_id,post_id FROM whaleu_official.source_ranks WHERE space_id=ANY($1::uuid[]) AND daily_active AND decision='unknown' AND next_proof_at<=$2::timestamptz LIMIT ${OFFICIAL_COVERAGE_BATCH})
) frontier LIMIT ${OFFICIAL_COVERAGE_BATCH}`;

export interface OfficialRoot {
  space_id: string;
  head: string;
  baseline_highwater: string | null;
  baseline_snapshot: string | null;
  baseline_capture_domain: string | null;
  baseline_cursor: string | null;
  baseline_started: boolean;
  baseline_exhausted: boolean;
  settled_head: string;
  ready: boolean;
  rebuild_generation: string;
  dependency_cursor: string;
  dependency_post_cursor: string | null;
  dependency_head: string;
}
export const OFFICIAL_ROOT_COLUMNS =
  'space_id,head::text,baseline_snapshot::text,baseline_capture_domain,baseline_highwater,baseline_cursor,baseline_started,baseline_exhausted,settled_head::text,ready,rebuild_generation::text,dependency_cursor::text,dependency_post_cursor,(SELECT head::text FROM whaleu_official.dependency_root WHERE singleton) dependency_head';
const proof: RequiredTransactionProof<OfficialRoot> = {
  maximumFacts: 4,
  failureCode: 'OFFICIAL_SOURCE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'OFFICIAL_SOURCE_UNAVAILABLE', async (read) => {
      await read.query(
        'SELECT head FROM whaleu_official.dependency_root WHERE singleton FOR SHARE NOWAIT',
      );
      const rows = (
        await read.query<OfficialRoot>(
          `SELECT ${OFFICIAL_ROOT_COLUMNS} FROM whaleu_official.source_roots WHERE space_id=ANY($1::uuid[]) ORDER BY space_id FOR SHARE NOWAIT`,
          [facts.map((f) => f.space_id)],
        )
      ).rows;
      for (const fact of facts)
        if (
          JSON.stringify(rows.find((r) => r.space_id === fact.space_id)) !==
          JSON.stringify(fact)
        )
          throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    }),
};
export async function captureOfficialRoots(
  spaceIds: string[],
  tx: PoolClient,
  requireReady: boolean,
): Promise<OfficialRoot[]> {
  await captureOfficialInbox(tx, spaceIds, requireReady);
  const rows = (
    await tx.query<OfficialRoot>(
      `SELECT ${OFFICIAL_ROOT_COLUMNS} FROM whaleu_official.source_roots WHERE space_id=ANY($1::uuid[]) ORDER BY space_id`,
      [spaceIds],
    )
  ).rows;
  if (
    rows.length !== new Set(spaceIds).size ||
    (requireReady &&
      rows.some(
        (r) =>
          !r.ready ||
          !r.baseline_exhausted ||
          r.head !== r.settled_head ||
          r.dependency_cursor !== r.dependency_head,
      ))
  )
    throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
  enableRequiredTransactionProof(tx, proof);
  for (const row of rows)
    registerRequiredTransactionFact(
      tx,
      proof,
      row.space_id,
      Object.freeze(row),
    );
  return rows;
}
/** Manual-only, durable finite bootstrap plus deduplicated incremental delta closure.
 * No timer, read-side repair, complete seed, cursor reset or per-program source fanout. */
export class OfficialDraftCoverageMaintainer {
  private stopping = false;
  constructor(
    private readonly database: DatabaseService,
    private readonly source: OfficialSourcePort,
  ) {}
  stopAdmission() {
    this.stopping = true;
  }
  async runCycle(input: { programId: string }): Promise<{
    programId: string;
    examined: number;
    state: 'ready' | 'not_ready' | 'unavailable';
    more: boolean;
  }> {
    const programId = officialUuid.parse(input.programId),
      deadline = performance.now() + OFFICIAL_PROFILE.maintenanceMs;
    let examined = 0;
    const token = randomUUID();
    let claimed = false;
    try {
      claimed = await this.database.transaction(
        async (tx) => {
          await boundHotTransaction(tx);
          return (
            (
              await tx.query(
                "UPDATE whaleu_official.maintenance_claim SET token=$1,lease_until=clock_timestamp()+interval '20 seconds' WHERE singleton AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING singleton",
                [token],
              )
            ).rowCount === 1
          );
        },
        { isolationLevel: 'read committed' },
      );
      if (!claimed)
        return { programId, examined: 0, state: 'not_ready', more: true };
      for (
        let batch = 0;
        batch < OFFICIAL_PROFILE.maintenanceBatches &&
        !this.stopping &&
        deadline - performance.now() >= OFFICIAL_PROFILE.transactionMs;
        batch++
      ) {
        const result = await this.database.transaction(
          async (tx) => {
            await boundHotTransaction(tx);
            const claim = (
              await tx.query<{ next_phase: 'drain' | 'canonical' }>(
                "SELECT next_phase FROM whaleu_official.maintenance_claim WHERE singleton AND token=$1 AND lease_until>=clock_timestamp()+interval '5 seconds' FOR SHARE",
                [token],
              )
            ).rows[0];
            if (!claim) return { examined: 0, ready: false, busy: true };
            const nextPhase = async (phase: 'drain' | 'canonical') => {
              const changed = await tx.query(
                'UPDATE whaleu_official.maintenance_claim SET next_phase=$2 WHERE singleton AND token=$1',
                [token, phase],
              );
              if (changed.rowCount !== 1)
                throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
            };
            if (
              !(
                await tx.query<{ locked: boolean }>(
                  "SELECT pg_try_advisory_xact_lock(hashtextextended('official:coverage-maintenance:v1',0)) locked",
                )
              ).rows[0]?.locked
            )
              return { examined: 0, ready: false, busy: true };
            const program = (
              await tx.query<{
                school_space_id: string;
                city_space_id: string | null;
              }>(
                `SELECT school_space_id,city_space_id FROM whaleu_official.programs WHERE id=$1 AND revoked_at IS NULL`,
                [programId],
              )
            ).rows[0];
            if (!program)
              throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
            const spaces = [
              ...new Set([
                program.school_space_id,
                ...(program.city_space_id ? [program.city_space_id] : []),
              ]),
            ].sort();
            for (const id of spaces)
              await tx.query(
                'INSERT INTO whaleu_official.source_roots(space_id) VALUES($1) ON CONFLICT DO NOTHING',
                [id],
              );
            // A conversion-only batch consumes one of the same four transaction
            // slots. Its durable phase guarantees the next slot/round attempts
            // canonical facts even while producers keep the inbox nonempty.
            if (
              claim.next_phase === 'drain' &&
              (await drainOfficialCauses(tx, spaces)) > 0
            ) {
              await nextPhase('canonical');
              return { examined: 0, ready: false, busy: false };
            }
            const roots = (
              await tx.query<OfficialRoot>(
                `SELECT ${OFFICIAL_ROOT_COLUMNS} FROM whaleu_official.source_roots WHERE space_id=ANY($1::uuid[]) ORDER BY space_id`,
                [spaces],
              )
            ).rows;
            const batchClock = (
              await tx.query<{ now: Date; domain: string }>(
                'SELECT clock_timestamp() now,whaleu_official.current_capture_domain() domain',
              )
            ).rows[0]!;
            const batchAt = batchClock.now.toISOString();
            let root = roots.find(
              (r) =>
                !r.ready ||
                r.head !== r.settled_head ||
                r.dependency_cursor !== r.dependency_head,
            );
            if (!root) {
              const expired = (
                await tx.query<{ space_id: string }>(OFFICIAL_TIME_FRONTIER, [
                  spaces,
                  batchAt,
                ])
              ).rows[0];
              if (!expired && !(await hasOfficialPending(tx, spaces))) {
                await captureOfficialInbox(tx, spaces, true);
                enableRequiredTransactionProof(tx, proof);
                for (const currentRoot of roots)
                  registerRequiredTransactionFact(
                    tx,
                    proof,
                    currentRoot.space_id,
                    Object.freeze(currentRoot),
                  );
                await nextPhase('drain');
                return { examined: 0, ready: true, busy: false };
              }
              root = expired
                ? roots.find((r) => r.space_id === expired.space_id)!
                : roots[0]!;
            }
            if (!root.baseline_started) {
              const high =
                (
                  await tx.query<{ id: string }>(
                    'SELECT id FROM whaleu_community.posts WHERE space_id=$1 ORDER BY id DESC LIMIT 1',
                    [root.space_id],
                  )
                ).rows[0]?.id ?? null;
              await tx.query(
                `UPDATE whaleu_official.source_roots SET baseline_started=true,baseline_snapshot=pg_current_snapshot(),baseline_capture_domain=whaleu_official.current_capture_domain(),baseline_highwater=$2,baseline_exhausted=($2::uuid IS NULL),dependency_cursor=$4 WHERE space_id=$1 AND head=$3 RETURNING baseline_snapshot::text`,
                [root.space_id, high, root.head, root.dependency_head],
              );
              root.baseline_snapshot = (
                await tx.query<{ snapshot: string }>(
                  'SELECT baseline_snapshot::text snapshot FROM whaleu_official.source_roots WHERE space_id=$1',
                  [root.space_id],
                )
              ).rows[0]!.snapshot;
              root.baseline_capture_domain = batchClock.domain;
              root.baseline_started = true;
              root.baseline_highwater = high;
              root.baseline_exhausted = high === null;
              root.dependency_cursor = root.dependency_head;
            }
            const dependencyCursorBeforePrefix = root.dependency_cursor;
            // Only a bounded contiguous prefix already committed before the fixed
            // bootstrap snapshot is redundant. Late-committing low xids are not visible.
            if (
              root.baseline_snapshot &&
              root.baseline_capture_domain === batchClock.domain &&
              root.dependency_post_cursor === null
            ) {
              const prior = (
                await tx.query<{ sequence: string; visible: boolean }>(
                  `SELECT sequence::text,(source_domain=$3 AND pg_visible_in_snapshot(source_xid,$2::pg_snapshot)) IS TRUE visible FROM whaleu_official.dependency_events WHERE sequence>$1::bigint ORDER BY sequence LIMIT ${OFFICIAL_DEPENDENCY_PREFIX}`,
                  [
                    root.dependency_cursor,
                    root.baseline_snapshot,
                    root.baseline_capture_domain,
                  ],
                )
              ).rows;
              for (const event of prior) {
                if (!event.visible) break;
                root.dependency_cursor = event.sequence;
              }
            }
            const dependency =
              root.baseline_exhausted &&
              root.dependency_cursor !== root.dependency_head
                ? (
                    await tx.query<{
                      sequence: string;
                      kind: string;
                      target_id: string;
                    }>(
                      'SELECT sequence::text,kind,target_id FROM whaleu_official.dependency_events WHERE sequence=$1::bigint+1',
                      [root.dependency_cursor],
                    )
                  ).rows[0]
                : undefined;
            if (
              root.baseline_exhausted &&
              root.dependency_cursor !== root.dependency_head &&
              !dependency
            )
              throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
            // Select from the changed owner's indexed reverse relation. A correlated
            // OR over every publication would hide a history scan behind LIMIT ${OFFICIAL_COVERAGE_BATCH}.
            const dependencyQueries: Record<string, string> = {
              media_intent: `SELECT DISTINCT p.id post_id FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id JOIN whaleu_community.posts p ON p.id=b.resource_id WHERE a.intent_id=$3 AND b.owner_kind='community' AND b.resource_kind='post' AND p.space_id=$1 AND ($2::uuid IS NULL OR p.id>$2) ORDER BY p.id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
              category_policy: `SELECT DISTINCT p.id post_id FROM whaleu_community.post_category_events e JOIN whaleu_community.posts p ON p.id=e.post_id WHERE e.policy_id=$3 AND p.space_id=$1 AND ($2::uuid IS NULL OR p.id>$2) ORDER BY p.id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
              category_review: `SELECT p.id post_id FROM whaleu_community.post_category_events e JOIN whaleu_community.posts p ON p.id=e.post_id WHERE e.review_id=$3 AND p.space_id=$1 AND ($2::uuid IS NULL OR p.id>$2) ORDER BY p.id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
              category_issuer: `SELECT DISTINCT p.id post_id FROM whaleu_community.post_category_reviews r JOIN whaleu_community.post_category_events e ON e.review_id=r.id JOIN whaleu_community.posts p ON p.id=e.post_id WHERE r.issuer_id=$3 AND p.space_id=$1 AND ($2::uuid IS NULL OR p.id>$2) ORDER BY p.id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,

              account: `SELECT id post_id FROM whaleu_community.posts WHERE space_id=$1 AND account_id=$3 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
              post: `SELECT id post_id FROM whaleu_community.posts WHERE space_id=$1 AND id=$3 AND ($2::uuid IS NULL OR id>$2) LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
              asset: `SELECT DISTINCT p.id post_id FROM whaleu_media.bindings b JOIN whaleu_community.posts p ON p.id=b.resource_id WHERE b.asset_id=$3 AND b.owner_kind='community' AND b.resource_kind='post' AND p.space_id=$1 AND ($2::uuid IS NULL OR p.id>$2) ORDER BY p.id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
              decision: `SELECT DISTINCT p.id post_id FROM whaleu_community.content_approval_bindings b JOIN whaleu_community.posts p ON p.id=b.content_id WHERE b.decision_id=$3 AND b.content_kind='post' AND p.space_id=$1 AND ($2::uuid IS NULL OR p.id>$2) ORDER BY p.id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
              policy: `SELECT DISTINCT p.id post_id FROM whaleu_community.content_approval_decisions d JOIN whaleu_community.content_approval_bindings b ON b.decision_id=d.id JOIN whaleu_community.posts p ON p.id=b.content_id WHERE d.policy_revision_id=$3 AND b.content_kind='post' AND p.space_id=$1 AND ($2::uuid IS NULL OR p.id>$2) ORDER BY p.id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
              space: `SELECT id post_id FROM whaleu_community.posts WHERE space_id=$1 AND $1::uuid=$3 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
              region: `SELECT id post_id FROM whaleu_community.posts WHERE space_id=$1 AND EXISTS(SELECT 1 FROM whaleu_community.spaces WHERE id=$1 AND operating_region_id=$3) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
              institution: `SELECT id post_id FROM whaleu_community.posts WHERE space_id=$1 AND EXISTS(SELECT 1 FROM whaleu_community.spaces s JOIN whaleu_campus.campus_region_assignments a ON a.operating_region_id=s.operating_region_id JOIN whaleu_campus.campuses c ON c.id=a.campus_id WHERE s.id=$1 AND c.institution_id=$3) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
              campus: `SELECT id post_id FROM whaleu_community.posts WHERE space_id=$1 AND EXISTS(SELECT 1 FROM whaleu_community.spaces s JOIN whaleu_campus.campus_region_assignments a ON a.operating_region_id=s.operating_region_id WHERE s.id=$1 AND a.campus_id=$3) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
            };
            if (dependency && !dependencyQueries[dependency.kind])
              throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
            const dependentIds = dependency
              ? (
                  await tx.query<{ post_id: string }>(
                    dependencyQueries[dependency.kind]!,
                    [
                      root.space_id,
                      root.dependency_post_cursor,
                      dependency.target_id,
                    ],
                  )
                ).rows
              : null;
            const expiredIds =
              root.baseline_exhausted && !dependency
                ? (
                    await tx.query<{ post_id: string }>(
                      OFFICIAL_TIME_FRONTIER,
                      [[root.space_id], batchAt],
                    )
                  ).rows
                : [];
            const ids =
              (expiredIds.length ? expiredIds : null) ??
              dependentIds ??
              (!root.baseline_exhausted
                ? (
                    await tx.query<{ post_id: string }>(
                      `SELECT id post_id FROM whaleu_community.posts WHERE space_id=$1 AND id<=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
                      [
                        root.space_id,
                        root.baseline_highwater,
                        root.baseline_cursor,
                      ],
                    )
                  ).rows
                : (
                    await tx.query<{ post_id: string }>(
                      `SELECT post_id FROM whaleu_official.source_dirty WHERE space_id=$1 ORDER BY first_sequence,post_id LIMIT ${OFFICIAL_COVERAGE_BATCH}`,
                      [root.space_id],
                    )
                  ).rows);
            for (const { post_id } of ids) {
              const structural = (
                await tx.query<{
                  space_id: string;
                  published_at: Date;
                  revision: string;
                }>(
                  'SELECT space_id,published_at,local_creation_transaction::text revision FROM whaleu_community.posts WHERE id=$1 FOR SHARE',
                  [post_id],
                )
              ).rows[0];
              const active =
                !!structural &&
                structural.published_at.getTime() <=
                  new Date(batchAt).getTime() &&
                structural.published_at.getTime() >
                  new Date(batchAt).getTime() - OFFICIAL_PROFILE.dailyWindowMs;
              let fact: OfficialSourceFact | null = null;
              if (structural) {
                const unknown = {
                  postId: post_id,
                  spaceId: structural.space_id,
                  publishedAt: structural.published_at.toISOString(),
                  revision: structural.revision,
                  eligibilityRevision: '',
                  decision: 'unknown' as const,
                  score: null,
                  certificateHash: null,
                  validUntil: null,
                };
                fact = { ...unknown, digest: officialDigest(unknown) };
                if (active) {
                  const checkpoint = checkpointTransactionDeadlines(tx);
                  await tx.query('SAVEPOINT official_coverage_fact');
                  try {
                    fact = await this.source.inspect(post_id, true, tx);
                  } catch (error) {
                    await tx.query(
                      'ROLLBACK TO SAVEPOINT official_coverage_fact',
                    );
                    restoreTransactionDeadlines(tx, checkpoint);
                    if (
                      !(error instanceof ApplicationError) ||
                      error.getStatus() !== 503
                    )
                      throw error;
                    // A proved structural row with unavailable owner facts stays
                    // explicitly unknown. It never turns into a denial or zero.
                  }
                  await tx.query('RELEASE SAVEPOINT official_coverage_fact');
                }
              }
              let rankWrites: number;
              if (!fact || fact.spaceId !== root.space_id)
                rankWrites =
                  (
                    await tx.query(
                      "UPDATE whaleu_official.source_ranks SET decision='deny',score=NULL,certificate_hash=NULL,valid_until=NULL,daily_active=false,structural_present=false,next_proof_at=NULL WHERE space_id=$1 AND post_id=$2",
                      [root.space_id, post_id],
                    )
                  ).rowCount ?? 0;
              else
                rankWrites =
                  (
                    await tx.query(
                      `INSERT INTO whaleu_official.source_ranks(space_id,post_id,published_at,score,certificate_hash,decision,source_digest,settled_sequence,valid_until,daily_active,next_proof_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10 AND $6='unknown' THEN clock_timestamp()+interval '5 seconds' END) ON CONFLICT(space_id,post_id) DO UPDATE SET published_at=EXCLUDED.published_at,score=EXCLUDED.score,certificate_hash=EXCLUDED.certificate_hash,decision=EXCLUDED.decision,source_digest=EXCLUDED.source_digest,settled_sequence=EXCLUDED.settled_sequence,valid_until=EXCLUDED.valid_until,daily_active=EXCLUDED.daily_active,structural_present=true,next_proof_at=EXCLUDED.next_proof_at`,
                      [
                        root.space_id,
                        post_id,
                        fact.publishedAt,
                        fact.score,
                        fact.certificateHash,
                        fact.decision,
                        fact.digest,
                        root.head,
                        fact.validUntil,
                        active,
                      ],
                    )
                  ).rowCount ?? 0;
              // The rank trigger contributes exactly one event per changed row.
              // Do not adopt the current DB head: that could swallow a concurrent
              // external event before our first rank write acquired its row lock.
              root.head = (BigInt(root.head) + BigInt(rankWrites)).toString();
              await tx.query(
                'DELETE FROM whaleu_official.source_dirty WHERE space_id=$1 AND post_id=$2 AND last_sequence<=$3',
                [root.space_id, post_id, root.head],
              );
            }
            // Parent/post/source proofs complete before root fence: a concurrent change aborts
            // only this batch; prior committed cursor/ranks remain, never reset on traffic.
            await boundedOwnerProof(
              tx,
              'OFFICIAL_SOURCE_UNAVAILABLE',
              async (read) => {
                const dh = (
                  await read.query<{ head: string }>(
                    'SELECT head::text FROM whaleu_official.dependency_root WHERE singleton FOR SHARE NOWAIT',
                  )
                ).rows[0];
                if (dh?.head !== root.dependency_head)
                  throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
                const current = (
                  await read.query<{ head: string }>(
                    'SELECT head::text FROM whaleu_official.source_roots WHERE space_id=$1 FOR UPDATE NOWAIT',
                    [root.space_id],
                  )
                ).rows[0];
                if (current?.head !== root.head)
                  throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
                const otherRoots = roots.filter(
                  (r) => r.space_id !== root.space_id,
                );
                if (otherRoots.length) {
                  const currentOthers = (
                    await read.query<OfficialRoot>(
                      `SELECT ${OFFICIAL_ROOT_COLUMNS} FROM whaleu_official.source_roots WHERE space_id=ANY($1::uuid[]) ORDER BY space_id FOR SHARE NOWAIT`,
                      [otherRoots.map((r) => r.space_id)],
                    )
                  ).rows;
                  if (
                    JSON.stringify(currentOthers) !== JSON.stringify(otherRoots)
                  )
                    throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
                }
              },
            );
            // Do not take a root write lock merely to record a redundant prefix
            // before canonical owner reads. The final head fence above must still
            // observe any independent derived-rank write during those reads.
            if (
              !dependency &&
              root.dependency_cursor !== dependencyCursorBeforePrefix
            )
              await tx.query(
                'UPDATE whaleu_official.source_roots SET dependency_cursor=$2 WHERE space_id=$1',
                [root.space_id, root.dependency_cursor],
              );
            if (dependency) {
              root.dependency_cursor =
                ids.length < OFFICIAL_COVERAGE_BATCH
                  ? dependency.sequence
                  : root.dependency_cursor;
              root.dependency_post_cursor =
                ids.length < OFFICIAL_COVERAGE_BATCH
                  ? null
                  : ids.at(-1)!.post_id;
              await tx.query(
                'UPDATE whaleu_official.source_roots SET dependency_cursor=$2,dependency_post_cursor=$3 WHERE space_id=$1',
                [
                  root.space_id,
                  root.dependency_cursor,
                  root.dependency_post_cursor,
                ],
              );
            }
            if (!root.baseline_exhausted) {
              root.baseline_cursor =
                ids.at(-1)?.post_id ?? root.baseline_cursor;
              root.baseline_exhausted =
                ids.length < OFFICIAL_COVERAGE_BATCH ||
                root.baseline_cursor === root.baseline_highwater;
              await tx.query(
                'UPDATE whaleu_official.source_roots SET baseline_cursor=$2,baseline_exhausted=$3 WHERE space_id=$1',
                [root.space_id, root.baseline_cursor, root.baseline_exhausted],
              );
            }
            const dirty =
              (
                await tx.query(
                  'SELECT 1 FROM whaleu_official.source_dirty WHERE space_id=$1 LIMIT 1',
                  [root.space_id],
                )
              ).rowCount !== 0;
            // Event sequence is allocated by the same locked root transaction as dirty
            // insertion. Immutable no-gap events plus empty dirty establishes delta closure.
            const finalAt = (
              await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
            ).rows[0]!.now.toISOString();
            const timePending =
              (
                await tx.query(OFFICIAL_TIME_FRONTIER, [
                  [root.space_id],
                  finalAt,
                ])
              ).rows.length > 0;
            const unknown =
              (
                await tx.query(
                  "SELECT 1 FROM whaleu_official.source_ranks WHERE space_id=$1 AND daily_active AND decision='unknown' LIMIT 1",
                  [root.space_id],
                )
              ).rows.length > 0;
            const pending = await hasOfficialPending(tx, [root.space_id]);
            const ready =
              !pending &&
              !unknown &&
              !timePending &&
              root.baseline_exhausted &&
              !dirty &&
              root.dependency_cursor === root.dependency_head;
            await tx.query(
              'UPDATE whaleu_official.source_roots SET ready=$2,settled_head=CASE WHEN $2 THEN head ELSE settled_head END WHERE space_id=$1',
              [root.space_id, ready],
            );
            await tx.query(
              'UPDATE whaleu_official.source_roots SET rebuild_generation=rebuild_generation+1 WHERE space_id=$1',
              [root.space_id],
            );
            if (ready) await captureOfficialInbox(tx, [root.space_id], true);
            await nextPhase('drain');
            return {
              examined: Math.max(ids.length, dependency ? 1 : 0),
              ready:
                ready &&
                !(await hasOfficialPending(tx, spaces)) &&
                (await tx.query(OFFICIAL_TIME_FRONTIER, [spaces, finalAt])).rows
                  .length === 0 &&
                roots.every(
                  (r) =>
                    r.space_id === root.space_id ||
                    (r.ready &&
                      r.head === r.settled_head &&
                      r.dependency_cursor === r.dependency_head),
                ),
              busy: unknown && ids.length === 0,
            };
          },
          { isolationLevel: 'read committed' },
        );
        examined += result.examined;
        if (result.ready)
          return { programId, examined, state: 'ready', more: false };
        if (result.busy) break;
      }
      return { programId, examined, state: 'not_ready', more: true };
    } catch {
      return { programId, examined, state: 'unavailable', more: true };
    } finally {
      if (claimed)
        await this.database.transaction(
          async (tx) => {
            await boundHotTransaction(tx);
            await tx.query(
              'UPDATE whaleu_official.maintenance_claim SET token=NULL,lease_until=NULL WHERE singleton AND token=$1',
              [token],
            );
          },
          { isolationLevel: 'read committed' },
        );
    }
  }
}
