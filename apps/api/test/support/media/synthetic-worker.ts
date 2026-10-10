/** TEST ONLY. Actual fixture bytes and real decoder; never register in AppModule.
 * Recovery replays exact precommitted destinations, not "latest" objects. This
 * harness does not implement provider enumeration, hostile-input containment,
 * cross-process writer quiescence, or a production Review issuer/collector. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withCommunityScopeWriter } from '../community-scope-fixtures.js';
import {
  MEDIA_MAX_INPUT_BYTES,
  mediaDigestSchema,
} from '../../../src/media/contracts.js';
import type {
  ExactObject,
  MediaManifest,
} from '../../../src/media/contracts.js';
import { MediaLifecycleRepository } from '../../../src/media/lifecycle-repository.js';
import type { MediaJobLease } from '../../../src/media/lifecycle-repository.js';
import { RegisteredSyntheticSharpProcessor } from '../../../src/media/processing/isolated-sharp.js';
import { sealProcessedManifest } from '../../../src/media/processing/processed-manifest.js';
import { sha256 } from '../../../src/media/processing/protocol.js';
import { sealManifest } from '../../../src/media/manifest.js';
import { SyntheticMediaStorage } from './synthetic-storage.js';

export type SyntheticAssetVerdict = 'allow' | 'held' | 'revoked';
export interface RegisteredMediaFixture {
  readonly sha256: string;
  readonly verdict: SyntheticAssetVerdict;
}
export type SyntheticCrashPoint =
  'uploaded' | 'sealed' | 'thumb-written' | 'display-written';
interface AttemptRow {
  id: string;
  intent_id: string;
  generation: string;
  state: string;
  provider: string;
  environment: string;
  staging_bucket: string;
  staging_key: string;
  source_version: string;
  sealed_bucket: string;
  sealed_key: string;
  sealed_version: string;
}
interface DerivedRow {
  id: string;
  variant_name: 'thumb-v1' | 'display-v1';
  provider: string;
  environment: string;
  bucket: string;
  object_key: string;
  object_version: string;
}
const unavailable = () => new Error('SYNTHETIC_MEDIA_UNAVAILABLE');
function source(a: AttemptRow): ExactObject {
  return {
    provider: a.provider,
    environment: a.environment,
    bucket: a.staging_bucket,
    key: a.staging_key,
    version: a.source_version,
  };
}
function sealed(a: AttemptRow): ExactObject {
  return {
    provider: a.provider,
    environment: a.environment,
    bucket: a.sealed_bucket,
    key: a.sealed_key,
    version: a.sealed_version,
  };
}
function derived(d: DerivedRow): ExactObject {
  return {
    provider: d.provider,
    environment: d.environment,
    bucket: d.bucket,
    key: d.object_key,
    version: d.object_version,
  };
}
export class SyntheticMediaWorker {
  readonly lifecycle = new MediaLifecycleRepository();
  private readonly registry: ReadonlyMap<string, SyntheticAssetVerdict>;
  private readonly processor: RegisteredSyntheticSharpProcessor;
  constructor(
    private readonly pool: Pool,
    readonly storage: SyntheticMediaStorage,
    fixtures: readonly RegisteredMediaFixture[],
    private readonly afterEffect?: (
      point: SyntheticCrashPoint,
    ) => Promise<void>,
  ) {
    const registry = new Map<string, SyntheticAssetVerdict>();
    for (const fixture of fixtures) {
      const digest = mediaDigestSchema.parse(fixture.sha256);
      if (
        registry.has(digest) ||
        !['allow', 'held', 'revoked'].includes(fixture.verdict)
      )
        throw unavailable();
      registry.set(digest, fixture.verdict);
    }
    this.registry = registry;
    this.processor = new RegisteredSyntheticSharpProcessor([
      ...registry.keys(),
    ]);
  }
  private write<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
    return withCommunityScopeWriter(this.pool, operation);
  }
  /** Preparation/owner authorization belongs to the caller. The synthetic
   * harness accepts only bytes from its constructor's closed fixture registry. */
  async upload(
    actor: string,
    intentId: string,
    input: Uint8Array,
  ): Promise<void> {
    const bytes = Buffer.from(input);
    if (!this.registry.has(sha256(bytes))) throw unavailable();
    const attempt = await this.write(async (tx) => {
      const intent = (
        await tx.query<{
          generation: string;
          state: string;
          declared_bytes: string;
        }>(
          `SELECT * FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2
         AND expires_at>clock_timestamp() FOR UPDATE`,
          [intentId, actor],
        )
      ).rows[0];
      if (
        !intent ||
        intent.state !== 'prepared' ||
        Number(intent.declared_bytes) !== bytes.length
      )
        throw unavailable();
      const existing = (
        await tx.query<AttemptRow>(
          'SELECT * FROM whaleu_media.object_attempts WHERE intent_id=$1 AND generation=$2',
          [intentId, intent.generation],
        )
      ).rows[0];
      if (existing) return existing;
      const staging = this.storage.newObject(),
        destination = this.storage.newObject();
      return (
        await tx.query<AttemptRow>(
          `INSERT INTO whaleu_media.object_attempts
        (id,intent_id,generation,effect_key,provider,environment,staging_bucket,staging_key,source_version,sealed_bucket,sealed_key,sealed_version,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'planned') RETURNING *`,
          [
            randomUUID(),
            intentId,
            intent.generation,
            `upload:${intentId}:${intent.generation}`,
            staging.provider,
            staging.environment,
            staging.bucket,
            staging.key,
            staging.version,
            destination.bucket,
            destination.key,
            destination.version,
          ],
        )
      ).rows[0]!;
    });
    const measured = await this.storage.writePlanned(source(attempt), bytes);
    await this.afterEffect?.('uploaded');
    await this.write(async (tx) => {
      const intent = (
        await tx.query<{ state: string; generation: string }>(
          'SELECT state,generation FROM whaleu_media.upload_intents WHERE id=$1 FOR UPDATE',
          [intentId],
        )
      ).rows[0];
      if (
        intent?.state !== 'prepared' ||
        intent.generation !== attempt.generation
      )
        throw unavailable();
      await tx.query(
        "UPDATE whaleu_media.object_attempts SET state='observed' WHERE id=$1",
        [attempt.id],
      );
      await tx.query(
        'UPDATE whaleu_media.quota_reservations SET observed_bytes=$2 WHERE intent_id=$1',
        [intentId, measured.bytes],
      );
      await this.lifecycle.finalize(actor, intentId, tx);
    });
  }
  /** Claims commit BEFORE effects. An injected crash leaves its lease durable;
   * retry after expiry reuses identical locators and the exclusive storage write.
   * No catch converts incomplete effects into success or fakes decode results. */
  async runOne(kind: 'seal' | 'process' | 'review'): Promise<boolean> {
    const lease = await this.write((tx) => this.lifecycle.claimJob(kind, tx));
    if (!lease) return false;
    if (kind === 'review') await this.review(lease);
    else {
      const a = await this.write(
        async (tx) =>
          (
            await tx.query<AttemptRow>(
              'SELECT * FROM whaleu_media.object_attempts WHERE id=$1 AND intent_id=$2 AND generation=$3',
              [lease.objectAttemptId, lease.intentId, lease.generation],
            )
          ).rows[0],
      );
      if (!a) throw unavailable();
      if (kind === 'seal') {
        const measured = await this.storage.seal(source(a), sealed(a));
        if (!this.registry.has(measured.sha256)) throw unavailable();
        await this.afterEffect?.('sealed');
        await this.write(async (tx) => {
          await this.settle(lease, tx);
          await tx.query(
            "UPDATE whaleu_media.object_attempts SET state='sealed' WHERE id=$1",
            [a.id],
          );
          await tx.query(
            "UPDATE whaleu_media.upload_intents SET state='processing',updated_at=clock_timestamp() WHERE id=$1",
            [lease.intentId],
          );
          await this.enqueue('process', lease, tx);
        });
      } else await this.process(lease, a);
    }
    return true;
  }
  private async settle(lease: MediaJobLease, tx: PoolClient): Promise<void> {
    if (!(await this.lifecycle.settleJob(lease, 'succeeded', tx)))
      throw unavailable();
  }
  private async enqueue(
    kind: 'process' | 'review',
    lease: MediaJobLease,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_media.jobs(id,kind,effect_key,intent_id,object_attempt_id,expected_generation)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(effect_key) DO NOTHING`,
      [
        randomUUID(),
        kind,
        `${kind}:${lease.intentId}:${lease.generation}`,
        lease.intentId,
        lease.objectAttemptId,
        lease.generation,
      ],
    );
  }
  private async process(lease: MediaJobLease, a: AttemptRow): Promise<void> {
    const destinations = await this.write(async (tx) => {
      // Revalidate lease without settling it before committing destination plans.
      const live = await tx.query(
        `SELECT j.id FROM whaleu_media.upload_intents i JOIN whaleu_media.jobs j ON j.intent_id=i.id
        WHERE i.id=$1 AND i.generation=$2 AND i.state='processing' AND i.expires_at>clock_timestamp()
        AND j.id=$3 AND j.lease_token=$4 AND j.status='leased' AND j.lease_until>clock_timestamp() FOR UPDATE OF i,j`,
        [lease.intentId, lease.generation, lease.id, lease.token],
      );
      if (!live.rowCount) throw unavailable();
      for (const name of ['thumb-v1', 'display-v1']) {
        const object = this.storage.newObject();
        await tx.query(
          `INSERT INTO whaleu_media.derived_object_attempts
          (id,intent_id,generation,variant_name,effect_key,provider,environment,bucket,object_key,object_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(intent_id,generation,variant_name) DO NOTHING`,
          [
            randomUUID(),
            lease.intentId,
            lease.generation,
            name,
            `${name}:${lease.intentId}:${lease.generation}`,
            object.provider,
            object.environment,
            object.bucket,
            object.key,
            object.version,
          ],
        );
      }
      return (
        await tx.query<DerivedRow>(
          `SELECT * FROM whaleu_media.derived_object_attempts WHERE intent_id=$1 AND generation=$2
        ORDER BY CASE variant_name WHEN 'thumb-v1' THEN 0 ELSE 1 END`,
          [lease.intentId, lease.generation],
        )
      ).rows;
    });
    if (destinations.length !== 2) throw unavailable();
    const mime = await this.write(async (tx) => {
      const row = (
        await tx.query<{ declared_mime: string }>(
          'SELECT declared_mime FROM whaleu_media.upload_intents WHERE id=$1',
          [lease.intentId],
        )
      ).rows[0];
      if (!row) throw unavailable();
      return row.declared_mime;
    });
    const input = await this.storage.openExact(
      sealed(a),
      MEDIA_MAX_INPUT_BYTES,
    );
    const processed = await this.processor.process(input.stream, mime);
    for (let index = 0; index < 2; index++) {
      await this.storage.writePlanned(
        derived(destinations[index]!),
        processed.variants[index]!.data,
      );
      await this.afterEffect?.(
        index === 0 ? 'thumb-written' : 'display-written',
      );
    }
    const measurements = await Promise.all(
      destinations.map((d) => this.storage.measure(derived(d))),
    );
    const manifest = sealProcessedManifest(processed, sealed(a), [
      measurements[0]!,
      measurements[1]!,
    ]);
    await this.write(async (tx) => {
      await this.settle(lease, tx);
      for (let index = 0; index < 2; index++)
        await tx.query(
          "UPDATE whaleu_media.derived_object_attempts SET state='written',sha256=$2,bytes=$3 WHERE id=$1",
          [
            destinations[index]!.id,
            measurements[index]!.sha256,
            measurements[index]!.bytes,
          ],
        );
      const assetId = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_media.assets(id,intent_id,actor_id,object_attempt_id,purpose,audience,owner_kind,resource_kind,
        target_kind,resource_id,content_version,scope_revision,slot,ordinal,policy_revision,manifest_version,manifest_digest,manifest)
        SELECT $2,id,actor_id,$3,purpose,audience,owner_kind,resource_kind,target_kind,resource_id,content_version,
        scope_revision,slot,ordinal,policy_revision,1,$4,$5::jsonb FROM whaleu_media.upload_intents WHERE id=$1`,
        [
          lease.intentId,
          assetId,
          a.id,
          manifest.digest,
          JSON.stringify(manifest.manifest),
        ],
      );
      for (const v of manifest.manifest.variants)
        await tx.query(
          `INSERT INTO whaleu_media.variants
        (asset_id,variant_name,provider,environment,bucket,object_key,object_version,sha256,actual_mime,width,height,bytes,transform_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            assetId,
            v.name,
            v.object.provider,
            v.object.environment,
            v.object.bucket,
            v.object.key,
            v.object.version,
            v.sha256,
            v.mime,
            v.width,
            v.height,
            v.bytes,
            manifest.manifest.transformVersion,
          ],
        );
      await tx.query(
        "UPDATE whaleu_media.upload_intents SET state='awaiting_review',updated_at=clock_timestamp() WHERE id=$1",
        [lease.intentId],
      );
      await this.enqueue('review', lease, tx);
    });
  }
  private async review(lease: MediaJobLease): Promise<void> {
    await this.write(async (tx) => {
      await this.settle(lease, tx);
      const asset = (
        await tx.query<{
          id: string;
          manifest: MediaManifest;
          manifest_digest: string;
          policy_revision: string;
        }>('SELECT * FROM whaleu_media.assets WHERE intent_id=$1 FOR UPDATE', [
          lease.intentId,
        ])
      ).rows[0];
      if (!asset) throw unavailable();
      const canonical = sealManifest(asset.manifest);
      const verdict = this.registry.get(canonical.manifest.original.sha256);
      if (!verdict || canonical.digest !== asset.manifest_digest)
        throw unavailable();
      const event = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_media.asset_safety_events
        (id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
        VALUES($1,$2,1,$3,$4,$5,'registered-synthetic-media',$6,$7::jsonb,clock_timestamp(),clock_timestamp()+interval '30 minutes')`,
        [
          event,
          asset.id,
          verdict,
          canonical.digest,
          asset.policy_revision,
          `fixture:${asset.id}:1`,
          JSON.stringify({
            fixtureDigest: canonical.manifest.original.sha256,
            exactManifestDigest: canonical.digest,
            testOnly: true,
          }),
        ],
      );
      await tx.query(
        'INSERT INTO whaleu_media.asset_safety_heads(asset_id,revision,event_id) VALUES($1,1,$2)',
        [asset.id, event],
      );
      if (verdict !== 'held')
        await tx.query(
          'UPDATE whaleu_media.upload_intents SET state=$2,updated_at=clock_timestamp() WHERE id=$1',
          [lease.intentId, verdict === 'allow' ? 'ready' : 'rejected'],
        );
    });
  }
}
