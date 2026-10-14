import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { ApplicationError } from '../http/application-error.js';
import { AccountPolicy } from '../safety/account-policy/decorator.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { boundHotTransaction } from '../community/hot-score/transaction.js';
import {
  officialDigest,
  OFFICIAL_PROFILE,
  boundedOfficialJson,
  boundedOfficialRead,
  officialUuid,
} from './profile.js';
import {
  officialConfigCommand,
  officialPreviewRequest,
  officialManualPreview,
  officialDraftCommand,
  officialPublishCommand,
  officialOriginalCommand,
  parseOfficial,
} from './contracts.js';
import type { OfficialReceipt } from './contracts.js';
import type { OfficialOperationAuthority } from './authority.js';
import type {
  OfficialManifestBuilder,
  OfficialManifest,
  OfficialConfig,
} from './manifest.js';
import { OfficialOperationLedger } from './ledger.js';
import type { OfficialStoredCommand } from './ledger.js';
import type { OfficialSyntheticPayloadStore } from './payload.js';
import type { OfficialSyntheticProvider } from './provider.js';
import { reconstructOfficialManifest } from './reconstruction.js';
import type { OfficialReconstruction } from './reconstruction.js';
import type { OfficialSourcePort } from './source.js';
import type { OfficialEffectIdentity } from './provider.js';
import type { OfficialMediaExport } from './media.js';
export interface OfficialRuntime {
  readonly profile: 'synthetic-official-v1';
  readonly authority: OfficialOperationAuthority;
  readonly manifests: OfficialManifestBuilder;
  readonly payloads: OfficialSyntheticPayloadStore;
  readonly provider: OfficialSyntheticProvider;
  readonly media: OfficialMediaExport | null;
  readonly fixtureEpoch: string;
  readonly source: OfficialSourcePort;
}
export const officialEffectProjection = `e.id "effectId",e.command_id "commandId",e.account_ref "accountRef",e.destination_ref "destinationRef",e.stage,e.purpose,e.manifest_hash "manifestHash",e.rendered_hash "renderedHash",e.asset_appearance_id "assetAppearanceId",e.asset_revision "assetRevision",e.variant_hash "variantHash",e.logical_key "logicalKey"`;
export class OfficialAccountOperationsService {
  readonly ledger = new OfficialOperationLedger();
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly runtime: OfficialRuntime | null,
  ) {}
  requireRuntime(): OfficialRuntime {
    if (!this.runtime || this.runtime.profile !== 'synthetic-official-v1')
      throw new ApplicationError('OFFICIAL_RUNTIME_DISABLED');
    return this.runtime;
  }
  async configRow(programId: string, tx: PoolClient): Promise<OfficialConfig> {
    const row = (
      await tx.query<OfficialConfig>(
        'SELECT * FROM whaleu_official.configs WHERE program_id=$1 FOR SHARE',
        [programId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('OFFICIAL_ACCOUNT_UNAVAILABLE');
    return row;
  }
  @AccountPolicy('privileged_read', 'entry')
  capabilities(token: string, programId: string) {
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const session = await this.identity.session(token, tx);
        officialUuid.parse(programId);
        const disabled = {
          mode: 'disabled' as const,
          programId,
          canManage: false,
          canPreview: false,
          canTest: false,
          canManualCreate: false,
          canPublish: false,
          reason: 'disabled' as const,
        };
        if (!this.runtime) return disabled;
        const runtime = this.requireRuntime();
        const result = {
          ...disabled,
          mode: 'synthetic' as const,
          reason: 'ready' as
            'ready' | 'authority_required' | 'scope_unavailable',
        };
        for (const [action, key] of [
          ['manage', 'canManage'],
          ['preview', 'canPreview'],
          ['test', 'canTest'],
          ['manual_create', 'canManualCreate'],
          ['publish', 'canPublish'],
        ] as const) {
          const checkpoint = checkpointTransactionDeadlines(tx);
          await tx.query('SAVEPOINT official_capability');
          try {
            await runtime.authority.requireManual(
              session,
              programId,
              action,
              tx,
            );
            result[key] = true;
          } catch {
            await tx.query('ROLLBACK TO SAVEPOINT official_capability');
            restoreTransactionDeadlines(tx, checkpoint);
            result.reason = 'authority_required';
          }
          await tx.query('RELEASE SAVEPOINT official_capability');
        }
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('privileged_read', 'entry')
  config(token: string, programId: string) {
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const session = await this.identity.session(token, tx),
          runtime = this.requireRuntime(),
          authority = await runtime.authority.requireManual(
            session,
            officialUuid.parse(programId),
            'manage',
            tx,
          ),
          config = await this.configRow(programId, tx);
        return {
          programId,
          accountRef: authority.program.account_ref,
          accountLabel: authority.program.label,
          revision: config.revision,
          author: config.author,
          coverAppearanceId: config.cover_appearance_id,
          titleAppearanceId: config.title_appearance_id,
          readiness: 'synthetic_ready',
          schedule: { zone: 'Etc/UTC', slotTime: '00:00:00', automatic: false },
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('noncontent_management', 'owner_after_recovery')
  save(token: string, input: unknown) {
    const intent = parseOfficial(officialConfigCommand, input);
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const session = await this.identity.session(token, tx),
          existing = await this.ledger.replay(
            session.accountId,
            intent,
            'config_save',
            tx,
          );
        if (existing)
          return {
            replay: true,
            receipt: existing.receipt,
            status: await this.ledger.status(existing.id, tx),
          };
        const runtime = this.requireRuntime(),
          authority = await runtime.authority.requireManual(
            session,
            intent.programId,
            'manage',
            tx,
          ),
          old = await this.configRow(intent.programId, tx);
        if (old.revision !== intent.expectedRevision)
          throw new ApplicationError('OFFICIAL_CONFIG_STALE');
        await this.ledger.capacity(authority.program.account_ref, true, tx);
        const artwork = (
          change: typeof intent.cover,
          previous: string | null,
        ) =>
          change.action === 'keep'
            ? previous
            : change.action === 'clear'
              ? null
              : change.appearanceId;
        const cover = artwork(intent.cover, old.cover_appearance_id),
          title = artwork(intent.title, old.title_appearance_id);
        for (const [purpose, id] of [
          ['cover', cover],
          ['title', title],
        ] as const)
          if (id) {
            if (!runtime.media)
              throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
            await runtime.media.inspect(
              id,
              purpose,
              {
                ownerKind: 'official-account',
                resourceKind: 'artwork',
                resourceId: intent.programId,
                contentVersion: 1,
              },
              tx,
            );
          }
        const revision = officialDigest([old.revision, intent]),
          id = randomUUID(),
          now = (
            await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
          ).rows[0]!.now.toISOString();
        const receipt: OfficialReceipt = {
          requestId: intent.requestId,
          intentHash: officialDigest(intent),
          operation: 'config_save',
          programId: intent.programId,
          accountRef: authority.program.account_ref,
          acceptedAt: now,
          outcome: 'config_applied',
          configRevision: revision,
        };
        await tx.query(
          'UPDATE whaleu_official.configs SET revision=$2,author=$3,cover_appearance_id=$4,title_appearance_id=$5 WHERE program_id=$1 AND revision=$6',
          [
            intent.programId,
            revision,
            intent.author,
            cover,
            title,
            old.revision,
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_official.commands(id,actor_ref,request_id,account_ref,program_id,operation,intent_hash,intent,accepted_at,fresh_until,receipt) VALUES($1,$2,$3,$4,$5,'config_save',$6,$7,$8,$8,$9)`,
          [
            id,
            session.accountId,
            intent.requestId,
            authority.program.account_ref,
            intent.programId,
            receipt.intentHash,
            JSON.stringify(intent),
            now,
            JSON.stringify(receipt),
          ],
        );
        await tx.query(
          "INSERT INTO whaleu_official.command_states(command_id,state) VALUES($1,'config_applied')",
          [id],
        );
        return {
          replay: false,
          receipt,
          status: await this.ledger.status(id, tx),
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('privileged_read', 'entry')
  preview(token: string, input: unknown, manual = false) {
    const request = manual
      ? parseOfficial(officialManualPreview, input)
      : parseOfficial(officialPreviewRequest, input);
    const kind = manual
      ? 'manual_newest'
      : 'kind' in request
        ? request.kind
        : 'daily_hot';
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const session = await this.identity.session(token, tx),
          runtime = this.requireRuntime(),
          authority = await runtime.authority.requireManual(
            session,
            request.programId,
            manual ? 'manual_create' : kind === 'test' ? 'test' : 'preview',
            tx,
          ),
          config = await this.configRow(request.programId, tx);
        if (config.revision !== request.expectedConfigRevision)
          throw new ApplicationError('OFFICIAL_CONFIG_STALE');
        const { manifest, preview } = await runtime.manifests.build(
          authority,
          config,
          kind,
          'limit' in request ? request.limit : undefined,
          tx,
        );
        const reconstruction = {
          profile: manifest.profile,
          kind: manifest.kind,
          sources: manifest.sources,
          assets: manifest.assets.map(
            ({ appearanceId, revision, variantHash, purpose }) => ({
              appearanceId,
              revision,
              variantHash,
              purpose,
            }),
          ),
          counts: manifest.article.items.map((i) => ({
            publicCounts: i.publicCounts,
            publishedAt: i.publishedAt,
          })),
          renderedHash: manifest.renderedHash,
          manifestHash: manifest.manifestHash,
        };
        boundedOfficialJson(
          reconstruction,
          OFFICIAL_PROFILE.reconstructionBytes,
        );
        await tx.query(
          'INSERT INTO whaleu_official.previews(id,actor_ref,program_id,kind,manifest_hash,rendered_hash,config_revision,selection_at,expires_at,reconstruction) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            manifest.previewId,
            session.accountId,
            manifest.programId,
            kind,
            manifest.manifestHash,
            manifest.renderedHash,
            manifest.configRevision,
            manifest.selectionAt,
            manifest.expiresAt,
            JSON.stringify(reconstruction),
          ],
        );
        await runtime.payloads.put(
          manifest,
          {
            previewId: manifest.previewId,
            commandId: null,
            expiresAt: manifest.expiresAt,
          },
          tx,
        );
        return preview;
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
  createDraft(token: string, input: unknown, manual = false) {
    const intent = parseOfficial(officialDraftCommand, input),
      operation = manual ? 'manual_draft' : 'test_draft';
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const session = await this.identity.session(token, tx),
          existing = await this.ledger.replay(
            session.accountId,
            intent,
            operation,
            tx,
          );
        if (existing)
          return {
            replay: true,
            receipt: existing.receipt,
            status: await this.ledger.status(existing.id, tx),
          };
        const runtime = this.requireRuntime(),
          authority = await runtime.authority.requireManual(
            session,
            intent.programId,
            manual ? 'manual_create' : 'test',
            tx,
          );
        const preview = (
          await tx.query<{
            kind: string;
            manifest_hash: string;
            config_revision: string;
          }>(
            `SELECT kind,manifest_hash,config_revision FROM whaleu_official.previews WHERE id=$1 AND actor_ref=$2 AND program_id=$3 AND expires_at>clock_timestamp() FOR SHARE`,
            [intent.previewId, session.accountId, intent.programId],
          )
        ).rows[0];
        if (!preview)
          throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
        if (
          preview.kind !== (manual ? 'manual_newest' : 'test') ||
          preview.manifest_hash !== intent.manifestHash ||
          preview.config_revision !== intent.expectedConfigRevision
        )
          throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
        const manifest = (await runtime.payloads.getByPreview(
          intent.previewId,
          tx,
        )) as OfficialManifest;
        if (!manifest.article.items.length)
          throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
        await runtime.manifests.requireCurrent(
          manifest,
          authority,
          await this.configRow(intent.programId, tx),
          tx,
        );
        const command = await this.ledger.admit(
          session.accountId,
          session.sessionId,
          intent,
          operation,
          manifest,
          tx,
        );
        await runtime.payloads.put(
          manifest,
          {
            previewId: null,
            commandId: command.id,
            expiresAt: manifest.expiresAt,
          },
          tx,
        );
        return {
          replay: false,
          receipt: command.receipt,
          status: await this.ledger.status(command.id, tx),
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  status(token: string, requestId: string) {
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const session = await this.identity.session(token, tx);
        await this.ledger.lockOriginal(
          session.accountId,
          officialUuid.parse(requestId),
          tx,
        );
        const command = await this.ledger.find(
          session.accountId,
          officialUuid.parse(requestId),
          tx,
        );
        const tombstone = command
          ? null
          : (
              await tx.query<{ intent_hash: string }>(
                'SELECT intent_hash FROM whaleu_official.cancel_fences WHERE actor_ref=$1 AND request_id=$2',
                [session.accountId, requestId],
              )
            ).rows[0];
        return command
          ? {
              state: 'recorded' as const,
              receipt: command.receipt,
              status: await this.ledger.status(command.id, tx),
            }
          : tombstone
            ? {
                state: 'cancelled_before_admission' as const,
                requestId,
                intentHash: tombstone.intent_hash,
              }
            : { state: 'not_recorded' as const };
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancel(token: string, requestId: string, input: unknown) {
    const { intent } = parseOfficial(
      z.strictObject({ intent: officialOriginalCommand }),
      input,
    );
    if (intent.requestId !== requestId)
      throw new ApplicationError('OFFICIAL_REQUEST_CONFLICT');
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const session = await this.identity.session(token, tx);
        const old = await this.ledger.find(session.accountId, requestId, tx);
        const originalPreview =
          'previewId' in intent
            ? (
                await tx.query<{ kind: string }>(
                  'SELECT kind FROM whaleu_official.previews WHERE id=$1 AND actor_ref=$2',
                  [intent.previewId, session.accountId],
                )
              ).rows[0]
            : undefined;
        const operation =
          old?.operation ??
          ('draftRef' in intent
            ? 'manual_publish'
            : 'author' in intent
              ? 'config_save'
              : originalPreview?.kind === 'manual_newest'
                ? 'manual_draft'
                : 'test_draft');
        // The durable cancellation identity is the strict DTO hash, independent of route
        // kind. Missing/expired preview cannot erase the pre-admission cancel fence.
        // operation here only labels owned historical metadata; never grants an action.
        const command = await this.ledger.cancel(
          session.accountId,
          intent,
          operation,
          tx,
        );
        return command
          ? {
              receipt: command.receipt,
              status: await this.ledger.status(command.id, tx),
            }
          : {
              state: 'cancelled_before_admission',
              requestId,
              intentHash: officialDigest(intent),
            };
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
  resume(token: string, requestId: string, input: unknown) {
    const { intent } = parseOfficial(
      z.strictObject({ intent: officialOriginalCommand }),
      input,
    );
    if (intent.requestId !== requestId)
      throw new ApplicationError('OFFICIAL_REQUEST_CONFLICT');
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const session = await this.identity.session(token, tx),
          command = await this.ledger.find(session.accountId, requestId, tx);
        if (!command)
          throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
        if (command.intent_hash !== officialDigest(intent))
          throw new ApplicationError('OFFICIAL_REQUEST_CONFLICT');
        const status = await this.ledger.status(command.id, tx);
        if (status.state !== 'pending' || status.cancelRequested)
          throw new ApplicationError('OFFICIAL_EFFECT_NOT_RESUMABLE');
        await this.requireRuntime().authority.requireManual(
          session,
          command.program_id,
          command.operation === 'manual_draft'
            ? 'manual_create'
            : command.operation === 'manual_publish'
              ? 'publish'
              : 'test',
          tx,
        );
        await tx.query(
          'INSERT INTO whaleu_official.execution_sessions(id,command_id,session_ref) VALUES($1,$2,$3)',
          [randomUUID(), command.id, session.sessionId],
        );
        await tx.query(
          "UPDATE whaleu_official.effect_states s SET execution_blocked=false,next_attempt_at=clock_timestamp() FROM whaleu_official.effects e WHERE e.id=s.effect_id AND e.command_id=$1 AND s.state='pending'",
          [command.id],
        );
        return { receipt: command.receipt, status };
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('privileged_read', 'entry')
  slot(token: string, programId: string, slotId: string) {
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const session = await this.identity.session(token, tx);
        await this.requireRuntime().authority.requireManual(
          session,
          programId,
          'manage',
          tx,
        );
        const row = (
          await tx.query(
            `SELECT s.id "slotId",s.program_id "programId",s.state,c.id "commandRef",s.recorded_at "recordedAt" FROM whaleu_official.slots s LEFT JOIN whaleu_official.commands c ON c.slot_id=s.id WHERE s.id=$1 AND s.program_id=$2`,
            [officialUuid.parse(slotId), officialUuid.parse(programId)],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
        return row;
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('privileged_read', 'entry')
  async publishPreview(token: string, input: unknown) {
    const { draftRef } = parseOfficial(
      z.strictObject({ draftRef: officialUuid }),
      input,
    );
    const prepared = await this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const session = await this.identity.session(token, tx),
          runtime = this.requireRuntime();
        const original = (
          await tx.query<OfficialStoredCommand>(
            `SELECT c.* FROM whaleu_official.commands c JOIN whaleu_official.command_states s ON s.command_id=c.id WHERE s.draft_ref=$1 AND c.actor_ref=$2 AND c.operation='manual_draft'`,
            [draftRef, session.accountId],
          )
        ).rows[0];
        if (!original)
          throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
        const status = await this.ledger.status(original.id, tx);
        if (status.state !== 'draft_confirmed' || status.withdrawal !== 'none')
          throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
        const authority = await runtime.authority.requireManual(
            session,
            original.program_id,
            'publish',
            tx,
          ),
          config = await this.configRow(original.program_id, tx);
        const preview = (
          await tx.query<{
            id: string;
            kind: 'manual_newest';
            selection_at: Date;
            expires_at: Date;
            reconstruction: OfficialReconstruction;
          }>(
            `SELECT p.* FROM whaleu_official.previews p WHERE p.id=$1 AND p.actor_ref=$2`,
            [
              'previewId' in original.intent ? original.intent.previewId : null,
              session.accountId,
            ],
          )
        ).rows[0];
        if (!preview) throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
        const manifest = await reconstructOfficialManifest(
          preview,
          authority,
          config,
          runtime.source,
          runtime.media,
          tx,
        );
        const effect = (
          await tx.query<OfficialEffectIdentity>(
            `SELECT ${officialEffectProjection} FROM whaleu_official.effects e WHERE e.command_id=$1 AND e.stage='draft_create'`,
            [original.id],
          )
        ).rows[0];
        if (!effect) throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
        return {
          session,
          manifest,
          effect,
          accountLabel: authority.program.label,
        };
      },
      { isolationLevel: 'read committed' },
    );
    const runtime = this.requireRuntime();
    const hash = await boundedOfficialRead(
      runtime.provider.contentHash(prepared.effect),
    );
    if (hash !== prepared.manifest.renderedHash)
      throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const session = await this.identity.session(token, tx);
        if (session.accountId !== prepared.session.accountId)
          throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
        const authority = await runtime.authority.requireManual(
            session,
            prepared.manifest.programId,
            'publish',
            tx,
          ),
          config = await this.configRow(prepared.manifest.programId, tx);
        const now = (
            await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
          ).rows[0]!.now.getTime(),
          expiresAt = new Date(now + 300000).toISOString();
        await runtime.manifests.requireCurrent(
          prepared.manifest,
          authority,
          config,
          tx,
          expiresAt,
        );
        const confirmationId = randomUUID(),
          revision = officialDigest([
            draftRef,
            prepared.manifest.manifestHash,
            authority.digest,
            hash,
            expiresAt,
          ]);
        await tx.query(
          'INSERT INTO whaleu_official.publish_confirmations(id,actor_ref,draft_ref,revision,manifest_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
          [
            confirmationId,
            session.accountId,
            draftRef,
            revision,
            prepared.manifest.manifestHash,
            expiresAt,
          ],
        );
        await runtime.payloads.put(
          prepared.manifest,
          { previewId: null, commandId: null, confirmationId, expiresAt },
          tx,
        );
        return {
          confirmationId,
          revision,
          draftRef,
          programId: prepared.manifest.programId,
          accountRef: prepared.manifest.accountRef,
          accountLabel: authority.program.label,
          manifestHash: prepared.manifest.manifestHash,
          title: prepared.manifest.article.title,
          postCount: prepared.manifest.article.items.length,
          mode: 'synthetic',
          expiresAt,
          action: 'publish_exact_synthetic_article',
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
  publish(token: string, input: unknown) {
    const intent = parseOfficial(officialPublishCommand, input);
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        const session = await this.identity.session(token, tx),
          existing = await this.ledger.replay(
            session.accountId,
            intent,
            'manual_publish',
            tx,
          );
        if (existing)
          return {
            replay: true,
            receipt: existing.receipt,
            status: await this.ledger.status(existing.id, tx),
          };
        const runtime = this.requireRuntime(),
          confirmation = (
            await tx.query<{
              revision: string;
              manifest_hash: string;
              expires_at: Date;
              consumed_request_id: string | null;
            }>(
              `SELECT revision,manifest_hash,expires_at,consumed_request_id FROM whaleu_official.publish_confirmations WHERE id=$1 AND actor_ref=$2 AND draft_ref=$3 AND expires_at>clock_timestamp() FOR UPDATE`,
              [intent.confirmationId, session.accountId, intent.draftRef],
            )
          ).rows[0];
        if (!confirmation)
          throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
        if (
          confirmation.revision !== intent.confirmationRevision ||
          confirmation.manifest_hash !== intent.manifestHash ||
          (confirmation.consumed_request_id &&
            confirmation.consumed_request_id !== intent.requestId)
        )
          throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
        const manifest = (await runtime.payloads.getByConfirmation(
          intent.confirmationId,
          tx,
        )) as OfficialManifest;
        const original = (
          await tx.query(
            `SELECT c.id FROM whaleu_official.commands c JOIN whaleu_official.command_states s ON s.command_id=c.id WHERE s.draft_ref=$1 AND c.actor_ref=$2 AND c.operation='manual_draft' AND c.manifest_hash=$3 AND s.state='draft_confirmed' AND s.withdrawal='none'`,
            [intent.draftRef, session.accountId, intent.manifestHash],
          )
        ).rows[0];
        if (!original)
          throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
        const authority = await runtime.authority.requireManual(
          session,
          manifest.programId,
          'publish',
          tx,
        );
        await runtime.manifests.requireCurrent(
          manifest,
          authority,
          await this.configRow(manifest.programId, tx),
          tx,
          confirmation.expires_at.toISOString(),
        );
        const command = await this.ledger.admit(
          session.accountId,
          session.sessionId,
          intent,
          'manual_publish',
          manifest,
          tx,
          confirmation.expires_at.toISOString(),
        );
        await tx.query(
          'UPDATE whaleu_official.publish_confirmations SET consumed_request_id=$2 WHERE id=$1',
          [intent.confirmationId, intent.requestId],
        );
        await runtime.payloads.put(
          manifest,
          {
            previewId: null,
            commandId: command.id,
            expiresAt: confirmation.expires_at.toISOString(),
          },
          tx,
        );
        return {
          replay: false,
          receipt: command.receipt,
          status: await this.ledger.status(command.id, tx),
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
}
