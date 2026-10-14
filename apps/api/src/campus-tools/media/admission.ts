import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import {
  exactObjectSchema,
  mediaDigestSchema,
  mediaMimeSchema,
  MEDIA_MAX_INPUT_BYTES,
} from '../../media/contracts.js';
import { sealProcessedManifest } from '../../media/processing/processed-manifest.js';
import { sealManifest } from '../../media/manifest.js';
import { sha256 } from '../../media/processing/protocol.js';
import { ownerFingerprint } from '../../database/required-owner-proof.js';
import { lockToolCatalog, requireToolRuntime } from '../current-proof.js';
import type { ToolCatalog } from '../contracts.js';
import type { CampusToolsRuntime, ToolAcceptance } from '../runtime.js';
const stagingSchema = z.strictObject({
  original: exactObjectSchema,
  mime: mediaMimeSchema,
  sha256: mediaDigestSchema,
  bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
  destinations: z.tuple([exactObjectSchema, exactObjectSchema]),
});
/** A retry adopts only the exact durable source/destinations; neither a fresh
 * locator nor a successful write callback can silently replace its attempt. */
export async function admitToolMedia(
  database: DatabaseService,
  runtime: CampusToolsRuntime,
  catalog: ToolCatalog,
  digest: string,
  acceptance: ToolAcceptance,
  slot: { bindingId: string; assetId: string; manifestDigest: string },
) {
  const staging = stagingSchema.parse(
    await runtime.admission.staging(digest, slot.assetId),
  );
  if (
    new Set([staging.original, ...staging.destinations].map(ownerFingerprint))
      .size !== 3
  )
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  if (
    [staging.original, ...staging.destinations].some(
      (object) =>
        object.provider !== runtime.storage.provider ||
        object.environment !== runtime.storage.environment,
    )
  )
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  const attemptId = await database.transaction(
    async (tx) => {
      await tx.query("SET LOCAL lock_timeout='500ms'");
      await lockToolCatalog(catalog.campusId, tx, true);
      requireToolRuntime(
        `staging:${digest}`,
        () => runtime.authority.verify(catalog, digest, acceptance),
        tx,
      );
      const old = (
        await tx.query<{
          id: string;
          asset_id: string;
          manifest_digest: string;
          staging: unknown;
          authority_reference: string;
          authority_proof: string;
        }>(
          'SELECT id,asset_id,manifest_digest,staging,authority_reference,authority_proof FROM whaleu_campus_tools.media_attempts WHERE campus_id=$1 AND input_digest=$2 AND binding_id=$3',
          [catalog.campusId, digest, slot.bindingId],
        )
      ).rows[0];
      if (old) {
        if (
          old.asset_id !== slot.assetId ||
          old.manifest_digest !== slot.manifestDigest ||
          ownerFingerprint(stagingSchema.parse(old.staging)) !==
            ownerFingerprint(staging) ||
          old.authority_reference !== acceptance.reference ||
          old.authority_proof !== acceptance.proof
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        return old.id;
      }
      const id = randomUUID();
      await tx.query(
        'INSERT INTO whaleu_campus_tools.media_attempts(id,campus_id,input_digest,binding_id,asset_id,manifest_digest,authority_reference,authority_proof,staging) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
        [
          id,
          catalog.campusId,
          digest,
          slot.bindingId,
          slot.assetId,
          slot.manifestDigest,
          acceptance.reference,
          acceptance.proof,
          JSON.stringify(staging),
        ],
      );
      return id;
    },
    { isolationLevel: 'read committed' },
  );
  const prior = await database.query<{
    manifest: unknown;
    manifest_digest: string;
  }>(
    'SELECT manifest,manifest_digest FROM whaleu_campus_tools.media_results WHERE attempt_id=$1',
    [attemptId],
  );
  if (prior.rows[0]) {
    const sealed = sealManifest(prior.rows[0].manifest);
    if (
      sealed.digest !== slot.manifestDigest ||
      prior.rows[0].manifest_digest !== slot.manifestDigest
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return { attemptId, manifest: sealed.manifest };
  }
  const opened = await runtime.storage.openExact(
    staging.original,
    staging.bytes,
  );
  if (opened.bytes !== staging.bytes) {
    opened.stream.destroy();
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  }
  const processed = await runtime.admission.process(
    opened.stream,
    staging.mime,
  );
  if (
    processed.original.sha256 !== staging.sha256 ||
    processed.original.bytes !== staging.bytes ||
    processed.original.mime !== staging.mime ||
    processed.variants.some((v) => sha256(v.data) !== v.sha256)
  )
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  const thumb = await runtime.admission.put(
    processed.variants[0].data,
    staging.destinations[0],
  );
  const display = await runtime.admission.put(
    processed.variants[1].data,
    staging.destinations[1],
  );
  if (
    ownerFingerprint(exactObjectSchema.parse(thumb.object)) !==
      ownerFingerprint(staging.destinations[0]) ||
    ownerFingerprint(exactObjectSchema.parse(display.object)) !==
      ownerFingerprint(staging.destinations[1])
  )
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  const sealed = sealProcessedManifest(processed, staging.original, [
    thumb,
    display,
  ]);
  if (sealed.digest !== slot.manifestDigest)
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  await database.transaction(
    async (tx) => {
      await tx.query("SET LOCAL lock_timeout='500ms'");
      await lockToolCatalog(catalog.campusId, tx, true);
      requireToolRuntime(
        `processed:${digest}`,
        () => runtime.authority.verify(catalog, digest, acceptance),
        tx,
      );
      const old = (
        await tx.query<{ manifest_digest: string; canonical: string }>(
          'SELECT manifest_digest,canonical FROM whaleu_campus_tools.media_results WHERE attempt_id=$1',
          [attemptId],
        )
      ).rows[0];
      if (old) {
        if (
          old.manifest_digest !== sealed.digest ||
          old.canonical !== sealed.canonical
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        return;
      }
      await tx.query(
        'INSERT INTO whaleu_campus_tools.media_results(attempt_id,manifest_digest,canonical,manifest) VALUES($1,$2,$3,$4::jsonb)',
        [
          attemptId,
          sealed.digest,
          sealed.canonical,
          JSON.stringify(sealed.manifest),
        ],
      );
    },
    { isolationLevel: 'read committed' },
  );
  return { attemptId, manifest: sealed.manifest };
}
