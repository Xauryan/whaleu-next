import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { boundedOfficialJson, OFFICIAL_PROFILE } from './profile.js';
/** Fixed public test-only key is supplied by explicit DI, never from env or a DTO. */
export class OfficialSyntheticPayloadStore {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Synthetic payload key length');
  }
  async put(
    value: unknown,
    reference: {
      previewId: string | null;
      commandId: string | null;
      expiresAt: string;
      confirmationId?: string;
    },
    tx: PoolClient,
  ): Promise<string> {
    const text = boundedOfficialJson(value),
      nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const ciphertext = Buffer.concat([
        cipher.update(text, 'utf8'),
        cipher.final(),
      ]),
      id = randomUUID();
    await tx.query(
      'INSERT INTO whaleu_official.payloads(id,preview_id,command_id,ciphertext,nonce,tag,expires_at,confirmation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        reference.previewId,
        reference.commandId,
        ciphertext,
        nonce,
        cipher.getAuthTag(),
        reference.expiresAt,
        reference.confirmationId ?? null,
      ],
    );
    return id;
  }
  async getByPreview(id: string, tx: PoolClient): Promise<unknown> {
    return this.read('preview_id', id, tx);
  }
  async getByConfirmation(id: string, tx: PoolClient): Promise<unknown> {
    return this.read('confirmation_id', id, tx);
  }
  async getByCommand(id: string, tx: PoolClient): Promise<unknown> {
    return this.read('command_id', id, tx);
  }
  private async read(
    column: 'preview_id' | 'command_id' | 'confirmation_id',
    id: string,
    tx: PoolClient,
  ): Promise<unknown> {
    const row = (
      await tx.query<{ ciphertext: Buffer; nonce: Buffer; tag: Buffer }>(
        `SELECT ciphertext,nonce,tag FROM whaleu_official.payloads WHERE ${column}=$1 AND purged_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
        [id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
    const decipher = createDecipheriv('aes-256-gcm', this.key, row.nonce);
    decipher.setAuthTag(row.tag);
    return JSON.parse(
      Buffer.concat([
        decipher.update(row.ciphertext),
        decipher.final(),
      ]).toString('utf8'),
    ) as unknown;
  }
  async purge(tx: PoolClient): Promise<number> {
    const result = await tx.query(
      `WITH due AS (SELECT p.id FROM whaleu_official.payloads p LEFT JOIN whaleu_official.command_states s ON s.command_id=p.command_id WHERE p.purged_at IS NULL AND (p.expires_at<=clock_timestamp() OR s.cancel_requested OR s.withdrawal<>'none' OR s.state IN('draft_confirmed','published_confirmed','rejected','suppressed','expired','cancelled')) ORDER BY p.expires_at,p.id LIMIT $1 FOR UPDATE OF p SKIP LOCKED) UPDATE whaleu_official.payloads p SET ciphertext=NULL,nonce=NULL,tag=NULL,purged_at=clock_timestamp() FROM due WHERE p.id=due.id RETURNING p.id`,
      [OFFICIAL_PROFILE.purgeBatch],
    );
    return result.rowCount ?? 0;
  }
}
