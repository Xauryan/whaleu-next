import type { PoolClient } from 'pg';
import { MediaCurrentDenied } from '../media/asset-repository.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { boundHotTransaction } from '../community/hot-score/transaction.js';
import { OfficialAccountOperationsService } from './service.js';
import { captureOfficialRoots } from './coverage.js';
import { officialUuid } from './profile.js';
/** Internal explicit synthetic projection. Never reads article bodies, calls the
 * provider, claims remote deletion, or changes an accepted operation identity. */
export class OfficialWithdrawalMaintainer {
  constructor(private readonly service: OfficialAccountOperationsService) {}
  async runCycle(commandRefs: readonly string[]) {
    if (
      commandRefs.length > 10 ||
      new Set(commandRefs).size !== commandRefs.length
    )
      throw new ApplicationError('OFFICIAL_REQUEST_INVALID');
    for (const id of commandRefs) officialUuid.parse(id);
    const deadline = performance.now() + 20000;
    let examined = 0,
      withdrawn = 0,
      unavailable = 0;
    for (const id of commandRefs) {
      if (deadline - performance.now() < 5000) break;
      try {
        const changed = await this.service.database.transaction(
          async (tx) => {
            await boundHotTransaction(tx);
            return this.inspect(id, tx);
          },
          { isolationLevel: 'read committed' },
        );
        examined++;
        if (changed) withdrawn++;
      } catch {
        examined++;
        unavailable++;
      }
    }
    return {
      examined,
      withdrawn,
      unavailable,
      more: examined < commandRefs.length,
    };
  }
  private async inspect(commandId: string, tx: PoolClient): Promise<boolean> {
    const runtime = this.service.requireRuntime();
    const row = (
      await tx.query<{ withdrawal: string }>(
        'SELECT withdrawal FROM whaleu_official.command_states WHERE command_id=$1 FOR UPDATE',
        [commandId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
    if (row.withdrawal !== 'none') return false;
    const sources = (
      await tx.query<{ post_id: string; space_id: string }>(
        'SELECT post_id,space_id FROM whaleu_official.command_sources WHERE command_id=$1 ORDER BY post_id LIMIT 33',
        [commandId],
      )
    ).rows;
    if (sources.length > 32)
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    if (sources.length)
      await captureOfficialRoots(
        [...new Set(sources.map((x) => x.space_id))],
        tx,
        false,
      );
    let denied =
      (
        await tx.query(
          `SELECT e.post_id FROM whaleu_official.export_eligibility e JOIN whaleu_community.posts p ON p.id=e.post_id AND p.local_creation_transaction=e.publication_xid WHERE p.id=ANY($1::uuid[]) AND e.revoked_at IS NOT NULL LIMIT 1 FOR SHARE OF e,p`,
          [sources.map((x) => x.post_id)],
        )
      ).rows.length > 0;
    const assets = (
      await tx.query<{
        appearance_id: string;
        purpose: 'inline' | 'cover' | 'title';
        post_id: string;
        detached_at: Date | null;
        artwork_revoked: Date | null;
        program_id: string;
      }>(
        `SELECT a.appearance_id,a.purpose,a.post_id,b.detached_at,w.revoked_at artwork_revoked,c.program_id FROM whaleu_official.command_assets a JOIN whaleu_official.commands c ON c.id=a.command_id JOIN whaleu_media.bindings b ON b.id=a.binding_id LEFT JOIN whaleu_official.artwork w ON w.id=a.appearance_id AND a.purpose<>'inline' WHERE a.command_id=$1 ORDER BY a.appearance_id,a.purpose LIMIT 33 FOR SHARE OF b`,
        [commandId],
      )
    ).rows;
    const expectedAssets = (
      await tx.query(
        'SELECT appearance_id,purpose FROM whaleu_official.command_assets WHERE command_id=$1 LIMIT 33',
        [commandId],
      )
    ).rows;
    if (assets.length !== expectedAssets.length || assets.length > 32)
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    const artwork = (
      await tx.query<{ id: string; revoked_at: Date | null }>(
        'SELECT id,revoked_at FROM whaleu_official.artwork WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [
          assets
            .filter((x) => x.purpose !== 'inline')
            .map((x) => x.appearance_id),
        ],
      )
    ).rows;
    for (const asset of assets) {
      if (asset.purpose !== 'inline') {
        const current = artwork.find((x) => x.id === asset.appearance_id);
        if (!current) throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
        asset.artwork_revoked = current.revoked_at;
      }
      if (asset.detached_at || asset.artwork_revoked) denied = true;
    }
    // One exact current veto is sufficient to withdraw the whole local snapshot.
    // It does not turn any other unknown owner into a denial or a publish fact.
    if (!denied)
      for (const asset of assets) {
        if (!runtime.media)
          throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
        const checkpoint = checkpointTransactionDeadlines(tx);
        await tx.query('SAVEPOINT official_withdrawal_asset');
        try {
          await runtime.media.inspect(
            asset.appearance_id,
            asset.purpose,
            asset.purpose === 'inline'
              ? {
                  ownerKind: 'community',
                  resourceKind: 'post',
                  resourceId: asset.post_id,
                  contentVersion: 1,
                }
              : {
                  ownerKind: 'official-account',
                  resourceKind: 'article',
                  resourceId: asset.program_id,
                  contentVersion: 1,
                },
            tx,
          );
        } catch (error) {
          await tx.query('ROLLBACK TO SAVEPOINT official_withdrawal_asset');
          restoreTransactionDeadlines(tx, checkpoint);
          if (error instanceof MediaCurrentDenied) denied = true;
          else throw error;
        }
        await tx.query('RELEASE SAVEPOINT official_withdrawal_asset');
        if (denied) break;
      }
    if (!denied)
      for (const source of sources) {
        const current = await runtime.source.inspect(source.post_id, false, tx);
        if (current?.decision === 'unknown')
          throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
        if (!current || current.decision === 'deny') {
          denied = true;
          break;
        }
      }
    if (!denied) return false;
    const published =
      (
        await tx.query(
          "SELECT 1 FROM whaleu_official.effects e JOIN whaleu_official.effect_states s ON s.effect_id=e.id WHERE e.command_id=$1 AND e.stage='publish_submit' AND s.state='published_confirmed' LIMIT 1",
          [commandId],
        )
      ).rowCount !== 0;
    await tx.query(
      'UPDATE whaleu_official.command_states SET withdrawal=$2,updated_at=clock_timestamp() WHERE command_id=$1',
      [
        commandId,
        published ? 'retraction_needed' : 'local_withdrawn_remote_unverified',
      ],
    );
    await tx.query(
      "UPDATE whaleu_official.effect_states s SET state='suppressed_unsent',lease_until=NULL,execution_blocked=false,updated_at=clock_timestamp() FROM whaleu_official.effects e WHERE e.id=s.effect_id AND e.command_id=$1 AND s.state IN('pending','retry_wait','preparing')",
      [commandId],
    );
    await this.service.ledger.syncState(commandId, tx);
    // Immediate local payload erasure; immutable receipts and unknown evidence survive.
    await tx.query(
      'UPDATE whaleu_official.payloads SET ciphertext=NULL,nonce=NULL,tag=NULL,purged_at=clock_timestamp() WHERE command_id=$1 AND purged_at IS NULL',
      [commandId],
    );
    return true;
  }
}
