import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { officialDigest, OFFICIAL_PROFILE } from './profile.js';
import type {
  OfficialOperation,
  OfficialReceipt,
  OfficialStatus,
  OriginalCommand,
} from './contracts.js';
import type { OfficialManifest } from './manifest.js';
import type {
  OfficialEffectIdentity,
  OfficialProviderEvidence,
  OfficialSyntheticProvider,
} from './provider.js';
export interface OfficialStoredCommand {
  id: string;
  actor_ref: string | null;
  service_principal_ref: string | null;
  service_authority_digest: string | null;
  request_id: string | null;
  account_ref: string;
  program_id: string;
  operation: OfficialOperation;
  intent_hash: string;
  intent: OriginalCommand;
  manifest_hash: string | null;
  rendered_hash: string | null;
  fresh_until: Date;
  receipt: OfficialReceipt;
  accepted_at: Date;
}
export function officialEffectKey(
  commandId: string,
  stage: OfficialEffectIdentity['stage'],
  purpose: string,
  manifest: OfficialManifest,
  asset: OfficialManifest['assets'][number] | null,
): string {
  return officialDigest([
    OFFICIAL_PROFILE.name,
    commandId,
    stage,
    purpose,
    manifest.accountRef,
    manifest.destinationRef,
    manifest.manifestHash,
    asset?.appearanceId ?? null,
    asset?.revision ?? null,
    asset?.variantHash ?? null,
  ]);
}
export class OfficialOperationLedger {
  async lockOriginal(actor: string, requestId: string, tx: PoolClient) {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('official:original:'||$1||':'||$2,0))",
      [actor, requestId],
    );
  }
  async find(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<OfficialStoredCommand | null> {
    return (
      (
        await tx.query<OfficialStoredCommand>(
          'SELECT * FROM whaleu_official.commands WHERE actor_ref=$1 AND request_id=$2',
          [actor, requestId],
        )
      ).rows[0] ?? null
    );
  }
  async replay(
    actor: string,
    intent: OriginalCommand,
    operation: OfficialOperation,
    tx: PoolClient,
  ): Promise<OfficialStoredCommand | null> {
    await this.lockOriginal(actor, intent.requestId, tx);
    const existing = await this.find(actor, intent.requestId, tx);
    if (
      existing &&
      (existing.operation !== operation ||
        existing.intent_hash !== officialDigest(intent))
    )
      throw new ApplicationError('OFFICIAL_REQUEST_CONFLICT');
    const cancelled = (
      await tx.query<{ intent_hash: string }>(
        'SELECT intent_hash FROM whaleu_official.cancel_fences WHERE actor_ref=$1 AND request_id=$2',
        [actor, intent.requestId],
      )
    ).rows[0];
    if (cancelled && cancelled.intent_hash !== officialDigest(intent))
      throw new ApplicationError('OFFICIAL_REQUEST_CONFLICT');
    if (cancelled && !existing)
      throw new ApplicationError('OFFICIAL_EFFECT_NOT_RESUMABLE');
    return existing;
  }
  async capacity(accountRef: string, config: boolean, tx: PoolClient) {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('official:intake:'||$1,0))",
      [accountRef],
    );
    const pending = (
      await tx.query(
        `SELECT c.id FROM whaleu_official.commands c JOIN whaleu_official.command_states s ON s.command_id=c.id WHERE c.account_ref=$1 AND s.state IN('pending','preparing','dispatch_unknown','parked_unknown','publish_submitted') LIMIT 20`,
        [accountRef],
      )
    ).rows;
    const recent = (
      await tx.query(
        `SELECT id FROM whaleu_official.commands WHERE account_ref=$1 AND accepted_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND ${config ? "operation='config_save'" : "operation NOT IN('config_save','daily_draft')"} LIMIT 100`,
        [accountRef],
      )
    ).rows;
    if ((!config && pending.length >= 20) || recent.length >= 100)
      throw new ApplicationError('OFFICIAL_CAPACITY');
  }
  async admit(
    actor: string,
    sessionId: string,
    intent: OriginalCommand,
    operation: Exclude<OfficialOperation, 'daily_draft'>,
    manifest: OfficialManifest,
    tx: PoolClient,
    freshUntil = manifest.expiresAt,
  ): Promise<OfficialStoredCommand> {
    await this.capacity(manifest.accountRef, false, tx);
    const id = randomUUID(),
      now = (
        await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
      ).rows[0]!.now.toISOString();
    const receipt: OfficialReceipt = {
      requestId: intent.requestId,
      intentHash: officialDigest(intent),
      operation,
      programId: manifest.programId,
      accountRef: manifest.accountRef,
      acceptedAt: now,
      outcome: 'admitted',
      configRevision: manifest.configRevision,
    };
    const row = (
      await tx.query<OfficialStoredCommand>(
        `INSERT INTO whaleu_official.commands(id,actor_ref,request_id,account_ref,program_id,operation,intent_hash,intent,manifest_hash,rendered_hash,accepted_at,fresh_until,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          id,
          actor,
          intent.requestId,
          manifest.accountRef,
          manifest.programId,
          operation,
          receipt.intentHash,
          JSON.stringify(intent),
          manifest.manifestHash,
          manifest.renderedHash,
          now,
          freshUntil,
          JSON.stringify(receipt),
        ],
      )
    ).rows[0]!;
    await tx.query(
      'INSERT INTO whaleu_official.command_states(command_id) VALUES($1)',
      [id],
    );
    await tx.query(
      'INSERT INTO whaleu_official.execution_sessions(id,command_id,session_ref) VALUES($1,$2,$3)',
      [randomUUID(), id, sessionId],
    );
    await this.effects(row, manifest, tx);
    return row;
  }
  async effects(
    command: OfficialStoredCommand,
    manifest: OfficialManifest,
    tx: PoolClient,
  ) {
    for (const source of manifest.sources)
      await tx.query(
        'INSERT INTO whaleu_official.command_sources(command_id,post_id,space_id) VALUES($1,$2,$3)',
        [command.id, source.postId, source.spaceId],
      );
    for (const asset of manifest.assets) {
      const binding = (
        await tx.query<{ id: string; resource_id: string; space_id: string }>(
          `SELECT b.id,b.resource_id,p.space_id FROM whaleu_media.bindings b JOIN whaleu_community.posts p ON p.id=b.resource_id WHERE b.owner_kind='community' AND b.resource_kind='post' AND b.id=CASE WHEN $2='inline' THEN $1::uuid ELSE (SELECT binding_id FROM whaleu_official.artwork WHERE id=$1) END`,
          [asset.appearanceId, asset.purpose],
        )
      ).rows[0];
      if (!binding) throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
      await tx.query(
        'INSERT INTO whaleu_official.command_assets(command_id,appearance_id,purpose,binding_id,post_id) VALUES($1,$2,$3,$4,$5)',
        [
          command.id,
          asset.appearanceId,
          asset.purpose,
          binding.id,
          binding.resource_id,
        ],
      );
      await tx.query(
        'INSERT INTO whaleu_official.command_sources(command_id,post_id,space_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [command.id, binding.resource_id, binding.space_id],
      );
    }
    const values: {
      stage: OfficialEffectIdentity['stage'];
      purpose: string;
      asset: OfficialManifest['assets'][number] | null;
    }[] =
      command.operation === 'manual_publish'
        ? [{ stage: 'publish_submit', purpose: 'manual_publish', asset: null }]
        : [
            ...manifest.assets.map((asset) => ({
              stage: 'material' as const,
              purpose: asset.purpose,
              asset,
            })),
            {
              stage: 'draft_create' as const,
              purpose: command.operation,
              asset: null,
            },
          ];
    for (const value of values) {
      const id = randomUUID(),
        key = officialEffectKey(
          command.id,
          value.stage,
          value.purpose,
          manifest,
          value.asset,
        );
      await tx.query(
        `INSERT INTO whaleu_official.effects(id,command_id,account_ref,destination_ref,stage,purpose,manifest_hash,rendered_hash,asset_appearance_id,asset_revision,variant_hash,logical_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          command.id,
          manifest.accountRef,
          manifest.destinationRef,
          value.stage,
          value.purpose,
          manifest.manifestHash,
          manifest.renderedHash,
          value.asset?.appearanceId ?? null,
          value.asset?.revision ?? null,
          value.asset?.variantHash ?? null,
          key,
        ],
      );
      await tx.query(
        'INSERT INTO whaleu_official.effect_states(effect_id) VALUES($1)',
        [id],
      );
    }
  }
  async syncState(id: string, tx: PoolClient): Promise<void> {
    const status = await this.status(id, tx);
    await tx.query(
      'UPDATE whaleu_official.command_states SET state=$2,updated_at=clock_timestamp() WHERE command_id=$1 AND state<>$2',
      [id, status.state],
    );
  }
  async status(id: string, tx: PoolClient): Promise<OfficialStatus> {
    const state = (
      await tx.query<{
        state: OfficialStatus['state'];
        cancel_requested: boolean;
        withdrawal: OfficialStatus['withdrawal'];
        draft_ref: string | null;
        updated_at: Date;
      }>('SELECT * FROM whaleu_official.command_states WHERE command_id=$1', [
        id,
      ])
    ).rows[0];
    if (!state) throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
    const effects = (
      await tx.query<{ state: string; stage: string }>(
        `SELECT s.state,e.stage FROM whaleu_official.effects e JOIN whaleu_official.effect_states s ON s.effect_id=e.id WHERE e.command_id=$1`,
        [id],
      )
    ).rows;
    let current = state.state;
    if (effects.some((e) => e.state === 'publish_submitted'))
      current = 'publish_submitted';
    else if (effects.some((e) => e.state === 'dispatch_unknown'))
      current = 'dispatch_unknown';
    else if (effects.some((e) => e.state === 'parked_unknown'))
      current = 'parked_unknown';
    else if (effects.some((e) => e.state === 'published_confirmed'))
      current = 'published_confirmed';
    else if (effects.some((e) => e.state === 'draft_confirmed'))
      current = 'draft_confirmed';
    else if (effects.some((e) => e.state === 'publication_rejected'))
      current = 'rejected';
    else if (
      effects.length &&
      effects.every(
        (e) =>
          e.state === 'suppressed_unsent' || e.state === 'material_confirmed',
      )
    )
      current = state.cancel_requested ? 'cancelled' : 'suppressed';
    return {
      state: current,
      cancelRequested: state.cancel_requested,
      acceptedMaterialCount: effects.filter(
        (e) => e.state === 'material_confirmed',
      ).length,
      draftRef: state.draft_ref,
      withdrawal: state.withdrawal,
      nextAction: [
        'dispatch_unknown',
        'parked_unknown',
        'publish_submitted',
      ].includes(current)
        ? 'recover_same_key'
        : current === 'pending'
          ? 'resume_same_key'
          : ['suppressed', 'expired', 'cancelled', 'rejected'].includes(current)
            ? 'new_preview'
            : [
                  'config_applied',
                  'draft_confirmed',
                  'published_confirmed',
                ].includes(current)
              ? 'none'
              : 'wait',
      updatedAt: state.updated_at.toISOString(),
    };
  }
  async cancel(
    actor: string,
    intent: OriginalCommand,
    _operation: OfficialOperation,
    tx: PoolClient,
  ) {
    await this.lockOriginal(actor, intent.requestId, tx);
    const existing = await this.find(actor, intent.requestId, tx),
      hash = officialDigest(intent);
    const previousFence = (
      await tx.query<{ intent_hash: string }>(
        'SELECT intent_hash FROM whaleu_official.cancel_fences WHERE actor_ref=$1 AND request_id=$2',
        [actor, intent.requestId],
      )
    ).rows[0];
    if (
      (existing && existing.intent_hash !== hash) ||
      (previousFence && previousFence.intent_hash !== hash)
    )
      throw new ApplicationError('OFFICIAL_REQUEST_CONFLICT');
    await tx.query(
      'INSERT INTO whaleu_official.cancel_fences(actor_ref,request_id,intent_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [actor, intent.requestId, hash],
    );
    if (existing) {
      await tx.query(
        `UPDATE whaleu_official.command_states SET cancel_requested=true,updated_at=clock_timestamp() WHERE command_id=$1`,
        [existing.id],
      );
      await tx.query(
        `UPDATE whaleu_official.effect_states s SET state='suppressed_unsent',lease_until=NULL,execution_blocked=false,updated_at=clock_timestamp() FROM whaleu_official.effects e WHERE s.effect_id=e.id AND e.command_id=$1 AND s.state IN('pending','retry_wait','preparing')`,
        [existing.id],
      );
    }
    if (existing) {
      const status = await this.status(existing.id, tx);
      await tx.query(
        'UPDATE whaleu_official.command_states SET state=$2 WHERE command_id=$1',
        [existing.id, status.state],
      );
    }
    return existing;
  }
  async settle(
    evidence: OfficialProviderEvidence,
    fence: string,
    provider: OfficialSyntheticProvider,
    tx: PoolClient,
  ): Promise<boolean> {
    if (!provider.verify(evidence))
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    const canonical = (
      await tx.query<OfficialEffectIdentity>(
        `SELECT e.id "effectId",e.command_id "commandId",e.account_ref "accountRef",e.destination_ref "destinationRef",e.stage,e.purpose,e.manifest_hash "manifestHash",e.rendered_hash "renderedHash",e.asset_appearance_id "assetAppearanceId",e.asset_revision "assetRevision",e.variant_hash "variantHash",e.logical_key "logicalKey" FROM whaleu_official.effects e WHERE e.id=$1`,
        [evidence.effect.effectId],
      )
    ).rows[0];
    if (
      !canonical ||
      Object.keys(canonical).some(
        (key) =>
          canonical[key as keyof OfficialEffectIdentity] !==
          evidence.effect[key as keyof OfficialEffectIdentity],
      ) ||
      Object.keys(evidence.effect).length !== Object.keys(canonical).length
    )
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    const locked = (
      await tx.query<{ state: string; attempts: number }>(
        `SELECT state,attempts FROM whaleu_official.effect_states WHERE effect_id=$1 AND fence=$2 AND lease_until>clock_timestamp() FOR UPDATE`,
        [evidence.effect.effectId, fence],
      )
    ).rows[0];
    if (!locked) return false;
    if (
      locked.state === 'publish_submitted' &&
      ![
        'publish_submitted',
        'published',
        'publication_rejected',
        'unknown',
      ].includes(evidence.kind)
    )
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    const id = randomUUID(),
      e = canonical;
    await tx.query(
      `INSERT INTO whaleu_official.evidence(id,effect_id,attempt_id,logical_key,account_ref,destination_ref,stage,manifest_hash,rendered_hash,asset_appearance_id,asset_revision,variant_hash,kind,provider_receipt_ref,accepted_at,verifier_profile,proof_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'synthetic-official-v1',$16) ON CONFLICT(account_ref,provider_receipt_ref,kind) DO NOTHING`,
      [
        id,
        e.effectId,
        evidence.attemptId,
        e.logicalKey,
        e.accountRef,
        e.destinationRef,
        e.stage,
        e.manifestHash,
        e.renderedHash,
        e.assetAppearanceId,
        e.assetRevision,
        e.variantHash,
        evidence.kind,
        evidence.receiptRef,
        evidence.acceptedAt,
        evidence.proofHash,
      ],
    );
    if (evidence.receiptRef) {
      const existing = (
        await tx.query<{ effect_id: string }>(
          'SELECT effect_id FROM whaleu_official.evidence WHERE account_ref=$1 AND provider_receipt_ref=$2 AND kind=$3',
          [e.accountRef, evidence.receiptRef, evidence.kind],
        )
      ).rows[0];
      if (existing?.effect_id !== e.effectId)
        throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    }
    const target = {
      material_accepted: 'material_confirmed',
      draft_created: 'draft_confirmed',
      publish_submitted: 'publish_submitted',
      published: 'published_confirmed',
      publication_rejected: 'publication_rejected',
      not_sent: 'retry_wait',
      not_accepted: 'retry_wait',
      unknown: 'dispatch_unknown',
    }[evidence.kind];
    const state =
      locked.state === 'publish_submitted' && evidence.kind === 'unknown'
        ? 'publish_submitted'
        : target === 'retry_wait' && locked.attempts >= 3
          ? 'suppressed_unsent'
          : target;
    await tx.query(
      `UPDATE whaleu_official.effect_states SET state=$2,lease_until=NULL,next_attempt_at=clock_timestamp()+CASE WHEN attempts=1 THEN interval '1 second' ELSE interval '5 seconds' END,updated_at=clock_timestamp() WHERE effect_id=$1`,
      [e.effectId, state],
    );
    await tx.query(
      `UPDATE whaleu_official.command_states SET withdrawal=CASE WHEN $2='published_confirmed' AND withdrawal<>'none' THEN 'retraction_needed' ELSE withdrawal END,state=CASE WHEN $2='draft_confirmed' THEN 'draft_confirmed' WHEN $2='publish_submitted' THEN 'publish_submitted' WHEN $2='published_confirmed' THEN 'published_confirmed' ELSE state END,draft_ref=CASE WHEN $2='draft_confirmed' THEN COALESCE(draft_ref,$3) ELSE draft_ref END,updated_at=clock_timestamp() WHERE command_id=$1`,
      [e.commandId, state, randomUUID()],
    );
    await this.syncState(e.commandId, tx);
    return true;
  }
}
