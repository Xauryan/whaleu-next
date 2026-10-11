import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';
import { retainRatingReadBytes } from '../target-cover-current.js';
import { scopedId } from '../scoped/contracts.js';
import { RATING_SCOPED_SCOPE_LIMIT } from '../scoped/constants.js';
import { categoryIconScopeAdopted } from './icon-scope-marker.js';

interface Availability {
  registration_relation: string | null;
  current_function: string | null;
}
interface Head {
  scope_key: string;
  catalog_id: string;
  head_revision: string;
  release_id: string;
  cause: unknown;
}
interface Protocol {
  id: string;
  logical_scope_key: string;
  current: boolean;
}
interface Registration {
  id: string;
  protocol_version_id: string;
  logical_scope_key: string;
  current: boolean;
  valid_until: Date;
}
interface Observation {
  availability: Availability;
  heads: Head[];
  protocols: Protocol[];
  registrations: Registration[];
}
interface Fact {
  readonly protocolIds: readonly string[];
  readonly keys: readonly string[];
  readonly fingerprint: string;
  readonly installed: boolean;
}
function unavailable(): never {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
async function observe(
  protocolIds: readonly string[],
  keys: readonly string[],
  tx: PoolClient,
  retainBytes = true,
): Promise<Observation> {
  // Dispatch from original heads first. A mixed publication's explicit legacy
  // scopes must not acquire a Category registry dependency from a sibling.
  const heads = (
    await tx.query<Head>(
      `SELECT h.scope_key,h.catalog_id,h.head_revision,h.release_id,r.cause
    FROM whaleu_ratings.scoped_catalog_heads h
    JOIN whaleu_ratings.scoped_releases r ON r.id=h.release_id
    WHERE h.scope_key=ANY($1::text[]) ORDER BY h.scope_key COLLATE "C"`,
      [keys],
    )
  ).rows;
  if (
    heads.length !== keys.length ||
    heads.some(
      (head, index) =>
        head.scope_key !== keys[index] ||
        !scopedId.safeParse(head.catalog_id).success ||
        !scopedId.safeParse(head.head_revision).success ||
        !scopedId.safeParse(head.release_id).success ||
        !head.cause ||
        typeof head.cause !== 'object' ||
        Array.isArray(head.cause),
    )
  )
    unavailable();
  const adopted = heads.map((head) =>
    categoryIconScopeAdopted(head.cause, head.scope_key),
  );
  const explicitlyLegacy = heads.every(
    (head, index) =>
      !adopted[index] &&
      Object.hasOwn(head.cause as object, 'categoryIconScopeKeys'),
  );
  const protocols = (
    await tx.query<Protocol>(
      `SELECT v.id,v.logical_scope_key,
    coalesce(v.phase='adopted' AND h.version_id=v.id,false) current
    FROM whaleu_ratings.scope_protocol_versions v
    LEFT JOIN whaleu_ratings.scope_protocol_heads h ON h.logical_scope_key=v.logical_scope_key
    WHERE v.id=ANY($1::uuid[]) ORDER BY v.id`,
      [protocolIds],
    )
  ).rows;
  if (
    protocols.length !== protocolIds.length ||
    protocols.some(
      (protocol, index) =>
        protocol.id !== protocolIds[index] ||
        protocol.current !== true ||
        typeof protocol.logical_scope_key !== 'string',
    ) ||
    new Set(protocols.map((protocol) => protocol.logical_scope_key)).size !==
      protocols.length
  )
    unavailable();
  // A genuinely unmarked scope can still negotiate its first explicit
  // adoption through a registration. An explicitly excluded mixed scope stays
  // on its original protocol without touching the extension schema.
  const available = explicitlyLegacy
    ? [{ registration_relation: null, current_function: null }]
    : (
        await tx.query<Availability>(`SELECT
    to_regclass('whaleu_ratings.category_icon_capability_sources')::text registration_relation,
    to_regprocedure('whaleu_ratings.category_icon_capability_current(uuid,timestamp with time zone)')::text current_function`)
      ).rows;
  if (
    available.length !== 1 ||
    (available[0]!.registration_relation !== null &&
      typeof available[0]!.registration_relation !== 'string') ||
    (available[0]!.current_function !== null &&
      typeof available[0]!.current_function !== 'string')
  )
    unavailable();
  const availability = available[0]!;
  if (
    (availability.registration_relation === null) !==
    (availability.current_function === null)
  )
    unavailable();
  const registrations =
    availability.registration_relation === null
      ? []
      : (
          await tx.query<Registration>(
            `SELECT c.id,c.protocol_version_id,v.logical_scope_key,
      whaleu_ratings.category_icon_capability_current(c.id,clock_timestamp()) current,c.valid_until
      FROM whaleu_ratings.category_icon_capability_sources c
      JOIN whaleu_ratings.scope_protocol_versions v ON v.id=c.protocol_version_id
      WHERE v.logical_scope_key=ANY($1::text[]) ORDER BY v.logical_scope_key,c.protocol_version_id,c.id LIMIT 100001`,
            [protocols.map((protocol) => protocol.logical_scope_key)],
          )
        ).rows;
  if (registrations.length > 100000) unavailable();
  const result = { availability, heads, protocols, registrations };
  if (retainBytes) retainRatingReadBytes(tx, result);
  return result;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 8,
  failureCode: 'RATING_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_SCOPE_UNAVAILABLE', async (read) => {
      await read.query(`LOCK TABLE whaleu_ratings.scoped_catalog_heads,
      whaleu_ratings.scope_protocol_heads,whaleu_ratings.scope_protocol_versions IN SHARE MODE NOWAIT`);
      if (facts.some((fact) => fact.installed))
        await read.query(
          'LOCK TABLE whaleu_ratings.category_icon_capability_sources IN SHARE MODE NOWAIT',
        );
      for (const fact of facts)
        if (
          fact.fingerprint !==
          ownerFingerprint(
            await observe(fact.protocolIds, fact.keys, read, false),
          )
        )
          unavailable();
    }),
};

/** A legacy result is positive absence evidence, never an error fallback. Search
 * every registered version of each relevant logical scope, so held, future,
 * stale and unknown registrations cannot be hidden by the adopted-head filter.
 * Shared by public entry contexts and management selector negotiation. */
export async function negotiateCategoryIconProtocol(
  protocolIds: readonly string[],
  keys: readonly string[],
  tx: PoolClient,
): Promise<'icon' | 'legacy'> {
  const exactIds = [...new Set(protocolIds)].sort(),
    exactKeys = [...new Set(keys)].sort();
  if (
    !exactIds.length ||
    exactIds.length > RATING_SCOPED_SCOPE_LIMIT ||
    exactIds.length !== protocolIds.length ||
    exactIds.some((id) => !scopedId.safeParse(id).success) ||
    !exactKeys.length ||
    exactKeys.length > RATING_SCOPED_SCOPE_LIMIT ||
    exactKeys.length !== keys.length ||
    exactKeys.some(
      (key) => key !== 'global' && !/^campus:[0-9a-f-]{36}$/.test(key),
    )
  )
    unavailable();
  const observed = await observe(exactIds, exactKeys, tx);
  const marked = observed.heads
    .map((head) => categoryIconScopeAdopted(head.cause, head.scope_key))
    .some(Boolean);
  const exact = exactIds.map((id) =>
    observed.registrations.filter((row) => row.protocol_version_id === id),
  );
  const icon = exact.every(
    (rows) =>
      rows.length === 1 &&
      rows[0]!.current === true &&
      scopedId.safeParse(rows[0]!.id).success &&
      rows[0]!.valid_until instanceof Date &&
      Number.isFinite(rows[0]!.valid_until.getTime()),
  );
  if (!icon && (marked || observed.registrations.length > 0)) unavailable();
  for (const rows of icon ? exact : [])
    registerTransactionDeadline(
      tx,
      rows[0]!.valid_until.getTime(),
      'RATING_SCOPE_UNAVAILABLE',
    );
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    ownerFingerprint([exactIds, exactKeys]),
    Object.freeze({
      protocolIds: Object.freeze(exactIds),
      keys: Object.freeze(exactKeys),
      fingerprint: ownerFingerprint(observed),
      installed: observed.availability.registration_relation !== null,
    }),
  );
  return icon ? 'icon' : 'legacy';
}
