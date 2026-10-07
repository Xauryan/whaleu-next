import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';

const HASH = /^[a-f0-9]{64}$/;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_POSITION_BYTES = 4096;
const MAX_CLEANUP = 1024;
export interface DiscoveryCursorBucket {
  readonly hash: string;
  readonly limit: 256 | 1024;
}
export interface DiscoveryPosition {
  readonly v: number;
  readonly [key: string]: unknown;
}
interface StoredCursor {
  cursor: string;
  scope_hash: string;
  bucket_hash: string;
  coordinate_hash: string;
  position: unknown;
  created_at: Date;
  expires_at: Date;
  now: Date;
}

/** Stable, bounded JSON, with no lossy undefined/nonfinite/toJSON conversion. */
function canonical(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  function encode(current: unknown, depth: number): string {
    if (++nodes > 512 || depth > 8) throw new Error('Invalid cursor metadata');
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean')
      return JSON.stringify(current);
    if (typeof current === 'number' && Number.isFinite(current))
      return JSON.stringify(current);
    if (typeof current !== 'object' || seen.has(current))
      throw new Error('Invalid cursor metadata');
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        // Sparse arrays must not silently become different coordinates.
        if (Object.keys(current).length !== current.length)
          throw new Error('Invalid cursor metadata');
        return `[${current.map((item) => encode(item, depth + 1)).join(',')}]`;
      }
      if (
        Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null
      )
        throw new Error('Invalid cursor metadata');
      const record = current as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map(
          (key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`,
        )
        .join(',')}}`;
    } finally {
      seen.delete(current);
    }
  }
  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_POSITION_BYTES)
    throw new Error('Invalid cursor metadata');
  return encoded;
}
function hash(domain: string, value: string): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex');
}
/** Owners supply every scope dimension, including explicit guest/session state. */
export function discoveryScopeHash(parts: readonly unknown[]): string {
  return hash('whaleu:discovery:scope:v1', canonical(parts));
}
/** Account-wide across sessions/list types; all guests share one bounded bucket. */
export function discoveryCursorBucket(
  accountId: string | null,
): DiscoveryCursorBucket {
  return {
    hash: hash(
      'whaleu:discovery:bucket:v1',
      canonical(
        accountId === null ? ['guest'] : ['account', accountId.toLowerCase()],
      ),
    ),
    limit: accountId === null ? 1024 : 256,
  };
}
function validToken(cursor: string): boolean {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(cursor))
    return false;
  const bytes = Buffer.from(cursor, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === cursor;
}
function positionJson(position: unknown): string {
  if (
    !position ||
    typeof position !== 'object' ||
    Array.isArray(position) ||
    !('v' in position) ||
    !Number.isInteger(position.v) ||
    (position.v as number) < 1 ||
    (position.v as number) > 999999999
  )
    throw new Error('Invalid cursor metadata');
  return canonical(position);
}
function coordinateHash(json: string): string {
  return hash('whaleu:discovery:position:v1', json);
}
function restart(): never {
  throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
}
function readPosition(
  row: StoredCursor,
  scopeHash: string,
  tx: PoolClient,
): unknown {
  if (row.scope_hash !== scopeHash)
    throw new BadRequestException('Invalid request');
  try {
    if (
      !validToken(row.cursor) ||
      !HASH.test(row.bucket_hash) ||
      !HASH.test(row.coordinate_hash) ||
      !(row.created_at instanceof Date) ||
      !(row.expires_at instanceof Date) ||
      !(row.now instanceof Date) ||
      !Number.isFinite(row.now.getTime()) ||
      row.expires_at.getTime() - row.created_at.getTime() !== TTL_MS ||
      row.expires_at.getTime() <= row.now.getTime() ||
      coordinateHash(positionJson(row.position)) !== row.coordinate_hash
    )
      restart();
  } catch {
    restart();
  }
  // Metadata is immutable. A concurrent eviction can revoke later navigation,
  // but cannot change this read's position. No cursor lock precedes owner locks.
  registerTransactionDeadline(
    tx,
    row.expires_at.getTime(),
    'DISCOVERY_RESTART_REQUIRED',
  );
  return row.position;
}

/** Derived navigation metadata only: never authorization, payloads or snapshots.
 * Each replay freshly scans from the immutable input coordinate. Different live
 * results may have different successors; identical endpoints reuse a valid ref.
 */
@Injectable()
export class DiscoveryCursorRepository {
  get(cursor: string, scopeHash: string, tx: PoolClient): Promise<unknown>;
  get<T>(
    cursor: string,
    scopeHash: string,
    tx: PoolClient,
    validate: (position: unknown) => T,
  ): Promise<T>;
  async get(
    cursor: string,
    scopeHash: string,
    tx: PoolClient,
    validate?: (position: unknown) => unknown,
  ): Promise<unknown> {
    if (!validToken(cursor) || !HASH.test(scopeHash))
      throw new BadRequestException('Invalid request');
    const row = (
      await tx.query<StoredCursor>(
        `SELECT cursor,scope_hash,bucket_hash,coordinate_hash,position,created_at,expires_at,clock_timestamp() AS now
         FROM whaleu_community.discovery_cursors WHERE cursor=$1`,
        [cursor],
      )
    ).rows[0];
    if (!row) restart();
    const position = readPosition(row, scopeHash, tx);
    if (!validate) return position;
    try {
      return validate(position);
    } catch {
      return restart();
    }
  }

  /** Call only AFTER every domain lock/projection/session recheck. The quota
   * lock stays until commit; never await another domain lock after this method.
   * Expiry and caps revoke navigation references, never underlying history.
   */
  async create(
    scopeHash: string,
    bucket: DiscoveryCursorBucket,
    position: DiscoveryPosition,
    tx: PoolClient,
  ): Promise<string> {
    if (
      !HASH.test(scopeHash) ||
      !HASH.test(bucket.hash) ||
      bucket.limit !==
        (bucket.hash === discoveryCursorBucket(null).hash ? 1024 : 256)
    )
      throw new Error('Invalid cursor scope');
    const json = positionJson(position);
    const digest = coordinateHash(json);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `whaleu:discovery:quota:v1:${bucket.hash}`,
    ]);
    const existing = (
      await tx.query<StoredCursor>(
        `SELECT cursor,scope_hash,bucket_hash,coordinate_hash,position,created_at,expires_at,clock_timestamp() AS now
         FROM whaleu_community.discovery_cursors WHERE scope_hash=$1 AND coordinate_hash=$2`,
        [scopeHash, digest],
      )
    ).rows[0];
    if (existing) {
      if (existing.bucket_hash !== bucket.hash) restart();
      if (existing.expires_at.getTime() > existing.now.getTime()) {
        readPosition(existing, scopeHash, tx);
        return existing.cursor;
      }
      // Do not renew/reopen an expired token, even for the exact same endpoint.
      await tx.query(
        'DELETE FROM whaleu_community.discovery_cursors WHERE cursor=$1',
        [existing.cursor],
      );
    }
    await tx.query(
      `DELETE FROM whaleu_community.discovery_cursors WHERE cursor IN (
         SELECT cursor FROM whaleu_community.discovery_cursors
          WHERE bucket_hash=$1 AND expires_at<=clock_timestamp()
          ORDER BY expires_at,cursor LIMIT $2)`,
      [bucket.hash, bucket.limit],
    );
    await tx.query(
      `DELETE FROM whaleu_community.discovery_cursors WHERE cursor IN (
         SELECT cursor FROM whaleu_community.discovery_cursors WHERE bucket_hash=$1
          ORDER BY created_at DESC,cursor DESC OFFSET $2 LIMIT $3)`,
      [bucket.hash, bucket.limit - 1, bucket.limit],
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const cursor = randomBytes(32).toString('base64url');
      const inserted = await tx.query<{ cursor: string }>(
        `WITH instant AS (SELECT clock_timestamp() AS now)
         INSERT INTO whaleu_community.discovery_cursors
           (cursor,scope_hash,bucket_hash,coordinate_hash,position,created_at,expires_at)
         SELECT $1,$2,$3,$4,$5::jsonb,now,now+interval '24 hours' FROM instant
         ON CONFLICT (cursor) DO NOTHING RETURNING cursor`,
        [cursor, scopeHash, bucket.hash, digest, json],
      );
      if (inserted.rows[0]) return cursor;
    }
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  }

  /** Operator-callable bounded derived-data cleanup. No job is enabled here. */
  async cleanupExpired(tx: PoolClient, batch = 256): Promise<number> {
    if (!Number.isInteger(batch) || batch < 1 || batch > MAX_CLEANUP)
      throw new Error('Invalid cursor cleanup bound');
    return (
      (
        await tx.query(
          `WITH expired AS (
         SELECT cursor FROM whaleu_community.discovery_cursors
          WHERE expires_at<=clock_timestamp() ORDER BY expires_at,cursor
          LIMIT $1 FOR UPDATE SKIP LOCKED
       ) DELETE FROM whaleu_community.discovery_cursors c USING expired e WHERE c.cursor=e.cursor`,
          [batch],
        )
      ).rowCount ?? 0
    );
  }
}
