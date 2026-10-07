import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import type { ApplicationErrorCode } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { AuthorDisplayService } from '../profile/author-display.service.js';
import { LocalSafetyPhoneSource } from '../verification/safety-phone.source.js';
import { CommunityNamedBlockSourceFacade } from '../community/named-block-source.facade.js';
import { SafetyRepository } from './repository.js';
import type { StoredBlock } from './repository.js';
import { lockNamedPair, lockSafetyPolicy } from './locks.js';
import type {
  BlockReceipt,
  BlockRequest,
  BlockResult,
  BlockState,
  OwnBlock,
  OwnBlocksPage,
  OwnBlocksQuery,
  SafetyOperation,
  UnblockRequest,
} from './contracts.js';
const terminal = new Set<ApplicationErrorCode>([
  'BLOCK_TARGET_NOT_ALLOWED',
  'BLOCK_NOT_FOUND',
  'BLOCK_REVISION_CONFLICT',
  'PHONE_VERIFICATION_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
  'POST_NOT_FOUND',
  'COMMENT_NOT_FOUND',
  'REPLY_NOT_FOUND',
  'COMMUNITY_SCOPE_UNAVAILABLE',
]);
const state = (row: StoredBlock): BlockState => ({
  relationshipId: row.id,
  blocked: row.active,
  revision: row.revision,
});
const cursorSchema = z.strictObject({
  v: z.literal(1),
  owner: z.string().regex(/^[a-f0-9]{64}$/),
  limit: z.number().int().min(1).max(50),
  at: z.iso.datetime({ precision: 3 }),
  id: z.uuid(),
});
const ownerScope = (actor: string) =>
  createHash('sha256').update(`named-block-list:${actor}`).digest('hex');
@Injectable()
export class NamedBlockService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(SafetyRepository) private readonly records: SafetyRepository,
    @Inject(LocalSafetyPhoneSource)
    private readonly phone: LocalSafetyPhoneSource,
    @Inject(CommunityNamedBlockSourceFacade)
    private readonly sources: CommunityNamedBlockSourceFacade,
    @Inject(AuthorDisplayService)
    private readonly profiles: AuthorDisplayService,
  ) {}
  private async transaction<T>(
    write: boolean,
    work: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.transaction(async (tx) => {
        await lockSafetyPolicy(tx, write);
        return work(tx);
      });
    } catch (error) {
      if (
        error instanceof ApplicationError ||
        error instanceof BadRequestException
      )
        throw error;
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    }
  }
  private async eligible(
    actor: string,
    tx: PoolClient,
  ): Promise<{ phone: number | null; policy: number | null }> {
    const policy = await this.records.restriction(actor, tx);
    const phone = await this.phone.resolve(actor, tx);
    if (phone.status === 'unavailable')
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    if (phone.status !== 'verified')
      throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
    registerTransactionDeadline(
      tx,
      phone.validUntil,
      'PHONE_VERIFICATION_REQUIRED',
    );
    return { phone: phone.validUntil, policy };
  }
  private async final(
    token: string,
    tx: PoolClient,
    bounds?: { phone: number | null; policy: number | null },
  ) {
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    const session = await this.identity.session(token, tx);
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now.getTime();
    if (session.expiresAt <= now)
      throw new ApplicationError('ACCESS_TOKEN_EXPIRED');
    if (
      bounds?.policy !== null &&
      bounds?.policy !== undefined &&
      bounds.policy <= now
    )
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    if (
      bounds?.phone !== null &&
      bounds?.phone !== undefined &&
      bounds.phone <= now
    )
      throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
  }
  block(token: string, body: BlockRequest): Promise<BlockResult> {
    return this.mutate(
      token,
      body.clientRequestId,
      'block_named',
      { source: body.source, blocked: true },
      body,
    );
  }
  unblock(
    token: string,
    id: string,
    body: UnblockRequest,
  ): Promise<BlockResult> {
    return this.mutate(
      token,
      body.clientRequestId,
      'unblock_named',
      {
        relationshipId: id.toLowerCase(),
        blocked: false,
        expectedRevision: body.expectedRevision,
      },
      undefined,
      id.toLowerCase(),
      body.expectedRevision,
    );
  }
  private mutate(
    token: string,
    requestId: string,
    operation: SafetyOperation,
    intent: unknown,
    block?: BlockRequest,
    relationshipId?: string,
    expectedRevision?: string,
  ): Promise<BlockResult> {
    return this.transaction(true, async (tx) => {
      const actor = (await this.identity.session(token, tx)).accountId;
      const hash = createHash('sha256')
        .update(JSON.stringify({ operation, intent }))
        .digest('hex');
      await tx.query(
        'INSERT INTO whaleu_safety.requests(account_id,client_request_id,operation,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,client_request_id) DO NOTHING',
        [actor, requestId, operation, hash],
      );
      const request = (
        await tx.query<{ payload_hash: string; receipt: BlockReceipt | null }>(
          'SELECT payload_hash,receipt FROM whaleu_safety.requests WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE',
          [actor, requestId],
        )
      ).rows[0]!;
      if (request.payload_hash !== hash)
        throw new ApplicationError('REQUEST_CONFLICT');
      if (request.receipt) {
        await this.records.rate(actor, 'read_own_blocks', tx);
        const result = await this.result(actor, request.receipt, tx);
        await this.final(token, tx);
        return result;
      }
      await this.records.rate(actor, operation, tx);
      const deadlineCheckpoint = checkpointTransactionDeadlines(tx);
      await tx.query('SAVEPOINT named_block_work');
      let receipt: BlockReceipt;
      let bounds: { phone: number | null; policy: number | null } | undefined;
      try {
        bounds = await this.eligible(actor, tx);
        let row: StoredBlock;
        if (block) {
          const { namedAccountId } = await this.sources.resolve(
            block.source,
            actor,
            tx,
          );
          await lockNamedPair(actor, namedAccountId, tx);
          const current = (
            await tx.query<StoredBlock>(
              'SELECT * FROM whaleu_safety.blocks WHERE blocker_id=$1 AND blocked_id=$2 FOR UPDATE',
              [actor, namedAccountId],
            )
          ).rows[0];
          if (current?.active) row = current;
          else {
            const display = await this.profiles.find(namedAccountId, tx);
            const id = current?.id ?? randomUUID();
            row = (
              await tx.query<StoredBlock>(
                `INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,true,$4,$5,$6)
       ON CONFLICT(blocker_id,blocked_id) DO UPDATE SET active=true,revision=whaleu_safety.blocks.revision+1,display_snapshot=excluded.display_snapshot,updated_at=date_trunc('milliseconds',clock_timestamp()) RETURNING *`,
                [
                  id,
                  actor,
                  namedAccountId,
                  display?.displayName ?? null,
                  block.source.kind,
                  block.source.id,
                ],
              )
            ).rows[0]!;
            await this.event(actor, row, 'blocked', tx);
          }
        } else {
          row = await this.records.own(actor, relationshipId!, tx);
          await lockNamedPair(actor, row.blocked_id, tx);
          if (row.revision !== expectedRevision)
            throw new ApplicationError('BLOCK_REVISION_CONFLICT');
          if (row.active) {
            row = (
              await tx.query<StoredBlock>(
                "UPDATE whaleu_safety.blocks SET active=false,revision=revision+1,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE blocker_id=$1 AND id=$2 RETURNING *",
                [actor, row.id],
              )
            ).rows[0]!;
            await this.event(actor, row, 'unblocked', tx);
          }
        }
        receipt = { requestId, operation, outcome: 'applied', ...state(row) };
      } catch (error) {
        if (!(error instanceof ApplicationError) || !terminal.has(error.code))
          throw error;
        await tx.query('ROLLBACK TO SAVEPOINT named_block_work');
        restoreTransactionDeadlines(tx, deadlineCheckpoint);
        receipt = {
          requestId,
          operation,
          outcome: 'rejected',
          code: error.code,
        };
        bounds = undefined;
      }
      await tx.query('RELEASE SAVEPOINT named_block_work');
      await tx.query(
        'UPDATE whaleu_safety.requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2',
        [actor, requestId, JSON.stringify(receipt)],
      );
      const result = await this.result(actor, receipt, tx);
      // Clock after request uniqueness, relationship writes, audit and receipt waits.
      await this.final(token, tx, bounds);
      return result;
    });
  }
  private async event(
    actor: string,
    row: StoredBlock,
    kind: 'blocked' | 'unblocked',
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), actor, row.id, kind, row.revision],
    );
  }
  private async result(
    actor: string,
    receipt: BlockReceipt,
    tx: PoolClient,
  ): Promise<BlockResult> {
    return {
      receipt,
      current:
        receipt.outcome === 'applied'
          ? state(await this.records.own(actor, receipt.relationshipId, tx))
          : null,
    };
  }
  receipt(token: string, requestId: string): Promise<BlockResult> {
    return this.transaction(false, async (tx) => {
      const actor = (await this.identity.session(token, tx)).accountId;
      const row = (
        await tx.query<{ receipt: BlockReceipt }>(
          'SELECT receipt FROM whaleu_safety.requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
          [actor, requestId],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
      await this.records.rate(actor, 'read_own_blocks', tx);
      const result = await this.result(actor, row.receipt, tx);
      await this.final(token, tx);
      return result;
    });
  }
  status(token: string, id: string): Promise<BlockState> {
    return this.transaction(false, async (tx) => {
      const actor = (await this.identity.session(token, tx)).accountId;
      const bounds = await this.eligible(actor, tx);
      await this.records.rate(actor, 'read_own_blocks', tx);
      const result = state(await this.records.own(actor, id, tx));
      await this.final(token, tx, bounds);
      return result;
    });
  }
  list(token: string, query: OwnBlocksQuery): Promise<OwnBlocksPage> {
    return this.transaction(false, async (tx) => {
      const actor = (await this.identity.session(token, tx)).accountId;
      const bounds = await this.eligible(actor, tx);
      await this.records.rate(actor, 'read_own_blocks', tx);
      let seek: z.infer<typeof cursorSchema> | undefined;
      if (query.cursor) {
        try {
          seek = cursorSchema.parse(
            JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
          );
          if (seek.owner !== ownerScope(actor) || seek.limit !== query.limit)
            throw new Error();
        } catch {
          throw new BadRequestException('Invalid request');
        }
      }
      const rows = (
        await tx.query<StoredBlock>(
          'SELECT * FROM whaleu_safety.blocks WHERE blocker_id=$1 AND active AND ($2::timestamptz IS NULL OR (updated_at,id)<($2::timestamptz,$3::uuid)) ORDER BY updated_at DESC,id DESC LIMIT $4',
          [actor, seek?.at ?? null, seek?.id ?? null, query.limit + 1],
        )
      ).rows;
      const items: OwnBlock[] = [];
      for (const row of rows.slice(0, query.limit)) {
        const current = await this.profiles.find(row.blocked_id, tx);
        items.push({
          ...state(row),
          blocked: true,
          blockedAt: row.updated_at.toISOString(),
          display: current
            ? { kind: 'current', displayName: current.displayName }
            : row.display_snapshot
              ? { kind: 'snapshot', displayName: row.display_snapshot }
              : { kind: 'unavailable', displayName: null },
          canUnblock: true,
        });
      }
      const last = items.at(-1);
      const nextCursor =
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                owner: ownerScope(actor),
                limit: query.limit,
                at: last.blockedAt,
                id: last.relationshipId,
              }),
            ).toString('base64url')
          : null;
      await this.final(token, tx, bounds);
      return { items, nextCursor };
    });
  }
}
