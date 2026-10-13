import { AccountPolicy } from '../account-policy/decorator.js';
import {
  observeAccountModerationAuthority,
  retainAccountModerationAuthority,
} from './authority-proof.js';
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { hashToken } from '../../identity/tokens.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { SafetyRepository } from '../repository.js';
import { ApplicationError } from '../../http/application-error.js';
import {
  requiredOwnerEpoch,
  boundedOwnerProof,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { safetyCountProofOwner } from '../count-epochs.js';
import { AccountPunishmentOwner } from './owner.js';
import { accountModerationProofOwner } from './count-epochs.js';
import { retainAccountModerationIdentity } from './identity-proof.js';
import { moderationCursor, encodeModerationCursor } from './cursor.js';
import {
  punishmentReleaseReceiptSchema,
  punishmentStatusSchema,
  punishmentManagementViewSchema,
} from './contracts.js';
import type {
  ModerationPageQuery,
  PunishmentReleaseCommand,
  PunishmentReleaseReceipt,
  PunishmentView,
} from './contracts.js';

const code = 'SAFETY_MODERATION_UNAVAILABLE' as const;
const retainEpoch = requiredOwnerEpoch(accountModerationProofOwner, code);
const retainBase = requiredOwnerEpoch(safetyCountProofOwner, code);
interface CommandFact {
  actor: string;
  requestId: string;
}
const commandProof: RequiredTransactionProof<CommandFact> = {
  maximumFacts: 1,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      for (const fact of facts) {
        const result = await read.query(
          `SELECT whaleu_safety.account_punishment_release_complete(q)
        FROM whaleu_safety.account_punishment_release_commands q WHERE actor_id=$1 AND request_id=$2`,
          [fact.actor, fact.requestId],
        );
        if (result.rowCount !== 1) throw new ApplicationError(code);
      }
    }),
};
@Injectable()
export class AccountModerationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(SafetyRepository) private readonly safety: SafetyRepository,
    @Inject(AccountPunishmentOwner)
    private readonly owner: AccountPunishmentOwner,
  ) {}
  private run<T>(work: (tx: PoolClient) => Promise<T>) {
    return this.database
      .transaction(work, { isolationLevel: 'read committed' })
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error &&
              String(error.constraint).startsWith('account_punishment')))
        )
          throw new ApplicationError(code);
        throw error;
      });
  }
  private async session(token: string, tx: PoolClient) {
    const session = await this.identity.session(token, tx);
    await retainAccountModerationIdentity(
      {
        actor: session.accountId,
        sessionId: session.sessionId,
        tokenHash: hashToken(token),
      },
      tx,
    );
    return session;
  }
  private async admin(
    actor: string,
    tx: PoolClient,
    action: 'privileged_read' | 'noncontent_management',
  ) {
    const initial = await observeAccountModerationAuthority(actor, tx);
    await this.safety.restriction(actor, tx, action);
    const grants = await this.authorization.grants(actor, tx);
    const grant = grants
      .filter((g) => g.role === 'super_admin' && g.operatingRegionId === null)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (!grant) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    retainAccountModerationAuthority(
      actor,
      grant.id,
      initial,
      grant.validUntil,
      tx,
    );
    return grant;
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  status(token: string) {
    return this.run(async (tx) => {
      const { accountId } = await this.session(token, tx);
      await retainEpoch(tx);
      await retainBase(tx);
      const row = (
        await tx.query<{
          coverage: 'complete' | 'unavailable';
          checkedAt: string;
          muted: boolean;
          suspended: boolean;
          until: string | null;
        }>(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp() at)
         SELECT CASE WHEN EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=$1
         AND restriction_coverage='complete' AND block_coverage='complete' AND provenance<>'unknown'
         AND actions_allowed AND (valid_until IS NULL OR valid_until>instant.at)) THEN 'complete' ELSE 'unavailable' END coverage,
         to_char(instant.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "checkedAt",
         whaleu_safety.account_punishment_effective_at($1,'interaction_mute',instant.at) muted,
         whaleu_safety.account_punishment_effective_at($1,'access_suspension',instant.at) suspended,
         (SELECT min(boundary)::text FROM (
           SELECT valid_until boundary FROM whaleu_safety.account_heads WHERE account_id=$1 AND valid_until>instant.at
           UNION ALL
           SELECT p.ends_at FROM whaleu_safety.account_punishment_heads h JOIN whaleu_safety.account_punishments p ON p.id=h.punishment_id
           WHERE h.subject_id=$1 AND p.starts_at<=instant.at AND p.ends_at>instant.at
           AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals t WHERE t.punishment_id=p.id)
         ) deadlines) until FROM instant`,
          [accountId],
        )
      ).rows[0]!;
      registerTransactionExactDeadline(tx, row.until, code);
      const ids = (
        await tx.query<{ id: string }>(
          'SELECT punishment_id id FROM whaleu_safety.account_punishment_heads WHERE subject_id=$1 ORDER BY kind',
          [accountId],
        )
      ).rows;
      const current: PunishmentView[] = [];
      for (const { id } of ids) current.push(await this.owner.view(id, tx));
      return punishmentStatusSchema.parse({
        coverage: row.coverage,
        checkedAt: row.checkedAt,
        current,
        effective: row.suspended
          ? 'access_suspension'
          : row.muted
            ? 'interaction_mute'
            : row.coverage === 'complete'
              ? 'clear'
              : 'unavailable',
      });
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  ownList(token: string, query: ModerationPageQuery) {
    return this.run(async (tx) => {
      const { accountId } = await this.session(token, tx);
      return this.page(accountId, accountId, 'own', query, tx, false);
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  ownDetail(token: string, id: string) {
    return this.run(async (tx) => {
      const { accountId } = await this.session(token, tx);
      const row = (
        await tx.query<{ id: string }>(
          'SELECT id FROM whaleu_safety.account_punishments WHERE id=$1 AND subject_id=$2',
          [id, accountId],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('SAFETY_MODERATION_NOT_FOUND');
      return this.owner.view(id, tx);
    });
  }
  private async management(id: string, tx: PoolClient) {
    const view = await this.owner.view(id, tx);
    const row = (
      await tx.query<{ version: string }>(
        'SELECT whaleu_safety.account_punishment_version($1) version',
        [id],
      )
    ).rows[0]!;
    return punishmentManagementViewSchema.parse({
      ...view,
      stateVersion: row.version,
      canRelease: view.state === 'active',
    });
  }
  @AccountPolicy('privileged_read', 'entry')
  adminList(token: string, query: ModerationPageQuery) {
    return this.run(async (tx) => {
      const { accountId } = await this.session(token, tx);
      await this.admin(accountId, tx, 'privileged_read');
      return this.page(accountId, null, 'admin', query, tx, true);
    });
  }
  @AccountPolicy('privileged_read', 'entry')
  adminDetail(token: string, id: string) {
    return this.run(async (tx) => {
      const { accountId } = await this.session(token, tx);
      await this.admin(accountId, tx, 'privileged_read');
      return this.management(id, tx);
    });
  }
  @AccountPolicy('privileged_read', 'entry')
  adminHistory(token: string, id: string, query: ModerationPageQuery) {
    return this.run(async (tx) => {
      const { accountId } = await this.session(token, tx);
      await this.admin(accountId, tx, 'privileged_read');
      const row = (
        await tx.query<{ subject_id: string }>(
          'SELECT subject_id FROM whaleu_safety.account_punishments WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('SAFETY_MODERATION_NOT_FOUND');
      return this.page(
        accountId,
        row.subject_id,
        `history:${id}`,
        query,
        tx,
        false,
      );
    });
  }
  private async page(
    actor: string,
    subject: string | null,
    family: string,
    query: ModerationPageQuery,
    tx: PoolClient,
    management: boolean,
  ) {
    await retainEpoch(tx);
    const seek = moderationCursor(query.cursor, actor, family, query.limit);
    const rows = (
      await tx.query<{ id: string; at: string }>(
        `SELECT id,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at
      FROM whaleu_safety.account_punishments WHERE ($1::uuid IS NULL OR subject_id=$1)
      AND ($2::timestamptz IS NULL OR (recorded_at,id)<($2::timestamptz,$3::uuid)) ORDER BY recorded_at DESC,id DESC LIMIT $4`,
        [subject, seek?.at ?? null, seek?.id ?? null, query.limit + 1],
      )
    ).rows;
    const selected = rows.slice(0, query.limit),
      items: PunishmentView[] = [];
    for (const row of selected)
      items.push(
        management
          ? await this.management(row.id, tx)
          : await this.owner.view(row.id, tx),
      );
    const last = selected.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeModerationCursor(last, actor, family, query.limit)
          : null,
    };
  }
  @AccountPolicy('noncontent_management', 'owner_after_recovery')
  release(token: string, command: PunishmentReleaseCommand, cancel = false) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        actor = session.accountId;
      const hash = createHash('sha256')
        .update(
          'whaleu:account-punishment-release:v1\n' +
            canonicalJson({ actor, command }),
        )
        .digest('hex');
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:account-punishment-release:v1:'||$1||':'||$2,0))",
        [actor, command.clientRequestId],
      );
      const previous = (
        await tx.query<{ intent_hash: string; receipt: unknown }>(
          'SELECT intent_hash,receipt FROM whaleu_safety.account_punishment_release_commands WHERE actor_id=$1 AND request_id=$2',
          [actor, command.clientRequestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        return punishmentReleaseReceiptSchema.parse(previous.receipt);
      }
      let grantId: string | null = null;
      const base = {
        requestId: command.clientRequestId,
        action: command.action,
        punishment: command.punishment,
      };
      let receipt: PunishmentReleaseReceipt;
      if (cancel)
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'SAFETY_MODERATION_CANCELLED',
        };
      else {
        grantId = (await this.admin(actor, tx, 'noncontent_management')).id;
        const view = await this.owner.observe(
          command.punishment.punishmentId,
          tx,
        );
        if (view.state === 'active')
          registerTransactionExactDeadline(tx, view.endsAt, code);
        if (
          view.kind !== command.punishment.kind ||
          view.revision !== command.punishment.revision
        )
          throw new ApplicationError('SAFETY_MODERATION_NOT_FOUND');
        const row = (
          await tx.query<{ version: string; now: Date }>(
            "SELECT whaleu_safety.account_punishment_version($1) version,date_trunc('milliseconds',clock_timestamp()) now",
            [view.punishmentId],
          )
        ).rows[0]!;
        receipt =
          view.state === 'active' &&
          row.version === command.expectedStateVersion
            ? {
                ...base,
                outcome: 'applied',
                eventId: randomUUID(),
                recordedAt: row.now.toISOString(),
              }
            : { ...base, outcome: 'rejected', code: 'SAFETY_MODERATION_STALE' };
      }
      await tx.query(
        `INSERT INTO whaleu_safety.account_punishment_release_commands(actor_id,request_id,session_id,token_hash,grant_id,command,receipt,intent_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          actor,
          command.clientRequestId,
          session.sessionId,
          hashToken(token),
          grantId,
          command,
          receipt,
          hash,
        ],
      );
      if (receipt.outcome === 'applied')
        await this.owner.releaseExact(
          {
            actorId: actor,
            sessionId: session.sessionId,
            tokenHash: hashToken(token),
            grantId: grantId!,
            requestId: command.clientRequestId,
            causeId: command.clientRequestId,
          },
          command.punishment,
          command.reason,
          'manually_released',
          tx,
        );
      enableRequiredTransactionProof(tx, commandProof);
      registerRequiredTransactionFact(
        tx,
        commandProof,
        command.clientRequestId,
        { actor, requestId: command.clientRequestId },
      );
      return punishmentReleaseReceiptSchema.parse(receipt);
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  recovery(token: string, requestId: string) {
    return this.run(async (tx) => {
      const { accountId } = await this.session(token, tx);
      const row = (
        await tx.query<{ receipt: unknown }>(
          'SELECT receipt FROM whaleu_safety.account_punishment_release_commands WHERE actor_id=$1 AND request_id=$2',
          [accountId, requestId],
        )
      ).rows[0];
      return row
        ? {
            state: 'recorded' as const,
            receipt: punishmentReleaseReceiptSchema.parse(row.receipt),
          }
        : { state: 'not_recorded' as const };
    });
  }
}
