import { admitToolMedia } from './media/admission.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { toolId, toolMediaSlots } from './contracts.js';
import { validateToolManifest } from './validation.js';
import type { CampusToolsRuntime } from './runtime.js';
import {
  lockToolCatalog,
  requireToolCurrent,
  requireToolRuntime,
} from './current-proof.js';
import { registerTransactionExactDeadline } from '../database/transaction-deadlines.js';
export interface ToolAdmissionReceipt {
  admissionId: string;
  campusId: string;
  catalogId: string;
  previousHead: string | null;
  digest: string;
  authorityReference: string;
  entries: number;
  media: number;
}
/** No HTTP publishing surface. CLI/tests and future operational adapters invoke
 * the same owner transaction with an explicitly configured trusted authority. */
export class CampusToolsAdmission {
  constructor(
    private readonly database: DatabaseService,
    private readonly runtime: CampusToolsRuntime | null,
  ) {}
  async apply(
    source: string,
    requestKey: string,
  ): Promise<ToolAdmissionReceipt> {
    toolId.parse(requestKey);
    const validated = validateToolManifest(source);
    const { catalog, digest, canonical } = validated;
    if (!this.runtime) throw new ApplicationError('CAMPUS_TOOLS_UNAVAILABLE');
    const prior = await this.database.transaction(
      async (tx) => {
        const row = (
          await tx.query<{
            input_digest: string;
            receipt: ToolAdmissionReceipt;
          }>(
            'SELECT input_digest,receipt FROM whaleu_campus_tools.admissions WHERE campus_id=$1 AND request_key=$2',
            [catalog.campusId, requestKey],
          )
        ).rows[0];
        if (row && row.input_digest !== digest)
          throw new ApplicationError('CAMPUS_TOOLS_ADMISSION_CONFLICT');
        return row?.receipt;
      },
      { isolationLevel: 'read committed' },
    );
    if (prior) return prior;
    if (validated.report.state !== 'candidate')
      throw new ApplicationError('CAMPUS_TOOLS_UNAVAILABLE');
    const runtime = this.runtime;
    const acceptance = z
      .strictObject({
        reference: z.string().min(1).max(300),
        proof: z.string().min(1).max(4096),
      })
      .parse(await runtime.authority.accept(catalog, digest));
    if (!runtime.authority.verify(catalog, digest, acceptance))
      throw new ApplicationError('CAMPUS_TOOLS_UNAVAILABLE');
    const slots = toolMediaSlots(catalog);
    const media = new Map<string, Awaited<ReturnType<typeof admitToolMedia>>>();
    for (const { slot } of slots)
      media.set(
        slot.bindingId,
        await admitToolMedia(
          this.database,
          runtime,
          catalog,
          digest,
          acceptance,
          slot,
        ),
      );
    return this.database.transaction(
      async (tx) => {
        await tx.query("SET LOCAL lock_timeout='500ms'");
        await lockToolCatalog(catalog.campusId, tx, true);
        const old = (
          await tx.query<{
            input_digest: string;
            receipt: ToolAdmissionReceipt;
          }>(
            'SELECT input_digest,receipt FROM whaleu_campus_tools.admissions WHERE campus_id=$1 AND request_key=$2',
            [catalog.campusId, requestKey],
          )
        ).rows[0];
        if (old) {
          if (old.input_digest !== digest)
            throw new ApplicationError('CAMPUS_TOOLS_ADMISSION_CONFLICT');
          return old.receipt;
        }
        const campus = (
          await tx.query<{ is_active: boolean }>(
            'SELECT is_active FROM whaleu_campus.campuses WHERE id=$1 FOR SHARE',
            [catalog.campusId],
          )
        ).rows[0];
        if (!campus?.is_active)
          throw new ApplicationError('CAMPUS_UNAVAILABLE');
        const head =
          (
            await tx.query<{ catalog_id: string }>(
              'SELECT catalog_id FROM whaleu_campus_tools.heads WHERE campus_id=$1 FOR UPDATE',
              [catalog.campusId],
            )
          ).rows[0]?.catalog_id ?? null;
        if (head !== catalog.expectedHead)
          throw new ApplicationError('CAMPUS_TOOLS_ADMISSION_CONFLICT');
        if (!runtime.authority.verify(catalog, digest, acceptance))
          throw new ApplicationError('CAMPUS_TOOLS_UNAVAILABLE');
        const expiry =
          catalog.validity.kind === 'finite'
            ? catalog.validity.expiresAt
            : null;
        const valid = (
          await tx.query<{ valid: boolean }>(
            'SELECT $1::timestamptz<=clock_timestamp() AND ($2::timestamptz IS NULL OR $2::timestamptz>clock_timestamp()) valid',
            [catalog.validity.effectiveAt, expiry],
          )
        ).rows[0]?.valid;
        if (!valid) throw new ApplicationError('CAMPUS_TOOLS_UNAVAILABLE');
        const receipt: ToolAdmissionReceipt = {
          admissionId: randomUUID(),
          campusId: catalog.campusId,
          catalogId: catalog.id,
          previousHead: head,
          digest,
          authorityReference: acceptance.reference,
          entries: catalog.entries.length,
          media: slots.length,
        };
        await tx.query(
          'INSERT INTO whaleu_campus_tools.admissions(id,campus_id,request_key,catalog_id,input_digest,authority_reference,authority_proof,previous_head,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
          [
            receipt.admissionId,
            catalog.campusId,
            requestKey,
            catalog.id,
            digest,
            acceptance.reference,
            acceptance.proof,
            head,
            JSON.stringify(receipt),
          ],
        );
        await tx.query(
          'INSERT INTO whaleu_campus_tools.catalogs(id,campus_id,admission_id,digest,canonical,content,effective_at,expires_at,exemption_reference) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8::timestamptz,$9)',
          [
            catalog.id,
            catalog.campusId,
            receipt.admissionId,
            digest,
            canonical,
            JSON.stringify(catalog),
            catalog.validity.effectiveAt,
            expiry,
            catalog.validity.kind === 'policy_exempt'
              ? catalog.validity.exemptionReference
              : null,
          ],
        );
        for (const { entry, groupId, slot } of slots)
          await tx.query(
            'INSERT INTO whaleu_campus_tools.media_bindings(id,attempt_id,campus_id,catalog_id,entry_id,entry_revision,group_id,slot_id,asset_id,manifest_digest,manifest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)',
            [
              slot.bindingId,
              media.get(slot.bindingId)!.attemptId,
              catalog.campusId,
              catalog.id,
              entry.id,
              entry.revision,
              groupId,
              slot.id,
              slot.assetId,
              slot.manifestDigest,
              JSON.stringify(media.get(slot.bindingId)!.manifest),
            ],
          );
        if (head === null)
          await tx.query(
            'INSERT INTO whaleu_campus_tools.heads(campus_id,catalog_id) VALUES($1,$2)',
            [catalog.campusId, catalog.id],
          );
        else {
          const result = await tx.query(
            'UPDATE whaleu_campus_tools.heads SET catalog_id=$2 WHERE campus_id=$1 AND catalog_id=$3',
            [catalog.campusId, catalog.id, head],
          );
          if (result.rowCount !== 1)
            throw new ApplicationError('CAMPUS_TOOLS_ADMISSION_CONFLICT');
        }
        requireToolRuntime(
          `admission:${digest}`,
          () => runtime.authority.verify(catalog, digest, acceptance),
          tx,
        );
        await requireToolCurrent(catalog.campusId, tx);
        registerTransactionExactDeadline(
          tx,
          expiry,
          'CAMPUS_TOOLS_UNAVAILABLE',
        );
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
