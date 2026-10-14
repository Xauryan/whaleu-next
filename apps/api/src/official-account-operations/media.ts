import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ImmutableMediaStorage } from '../media/storage-port.js';
import type { OfficialSourcePort } from './source.js';
import type { ExactObject } from '../media/contracts.js';
import { MediaAssetRepository } from '../media/asset-repository.js';
import { MediaOwnerProofRegistry } from '../media/owner-proof.js';
import { ApplicationError } from '../http/application-error.js';
import { OFFICIAL_PROFILE, officialDigest } from './profile.js';
export interface OfficialAsset {
  appearanceId: string;
  revision: string;
  variantHash: string;
  bytes: number;
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  object: ExactObject;
  purpose: 'inline' | 'cover' | 'title';
}
/** Only server-resolved exact existing bindings; never accepts a URL or locator from a DTO. */
export class OfficialMediaExport {
  private readonly assets = new MediaAssetRepository(
    new MediaOwnerProofRegistry([]),
  );
  constructor(
    private readonly storage: ImmutableMediaStorage,
    private readonly source: OfficialSourcePort,
  ) {}
  async inspect(
    appearanceId: string,
    purpose: OfficialAsset['purpose'],
    parent: {
      ownerKind: string;
      resourceKind: string;
      resourceId: string;
      contentVersion: number;
    },
    tx: PoolClient,
  ): Promise<OfficialAsset> {
    let bindingId = appearanceId;
    let artworkRevision: string | null = null;
    if (parent.ownerKind === 'official-account') {
      const artwork = (
        await tx.query<{
          post_id: string;
          binding_id: string;
          revision: string;
        }>(
          `SELECT a.post_id,a.binding_id,a.revision FROM whaleu_official.artwork a JOIN whaleu_official.programs p ON p.id=a.program_id JOIN whaleu_community.posts post ON post.id=a.post_id WHERE a.id=$1 AND a.program_id=$2 AND a.purpose=$3 AND a.profile='synthetic-official-v1' AND a.revoked_at IS NULL AND post.space_id=p.school_space_id FOR SHARE OF a`,
          [appearanceId, parent.resourceId, purpose],
        )
      ).rows[0];
      if (
        !artwork ||
        (await this.source.inspect(artwork.post_id, false, tx))?.decision !==
          'allow'
      )
        throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
      bindingId = artwork.binding_id;
      artworkRevision = artwork.revision;
      parent = {
        ownerKind: 'community',
        resourceKind: 'post',
        resourceId: artwork.post_id,
        contentVersion: 1,
      };
    }
    if (
      parent.ownerKind !== 'community' ||
      parent.resourceKind !== 'post' ||
      parent.contentVersion !== 1
    )
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    const mediaParent = {
      ownerKind: 'community' as const,
      resourceKind: 'post' as const,
      resourceId: parent.resourceId,
      contentVersion: 1 as const,
    };
    const expected = (
      await tx.query<{ assetId: string; digest: string }>(
        `SELECT asset_id "assetId",manifest_digest digest FROM whaleu_media.bindings WHERE owner_kind=$1 AND resource_kind=$2 AND resource_id=$3 AND content_version=$4 ORDER BY ordinal`,
        [
          parent.ownerKind,
          parent.resourceKind,
          parent.resourceId,
          parent.contentVersion,
        ],
      )
    ).rows;
    await this.assets.verifyContentBindings(mediaParent, expected, tx);
    const row = (
      await tx.query<{
        manifest_digest: string;
        sha256: string;
        bytes: string;
        actual_mime: 'image/jpeg' | 'image/png';
        width: number;
        height: number;
        provider: string;
        environment: string;
        bucket: string;
        object_key: string;
        object_version: string;
      }>(
        `SELECT b.manifest_digest,v.sha256,v.bytes::text,v.actual_mime,v.width,v.height,v.provider,v.environment,v.bucket,v.object_key,v.object_version FROM whaleu_media.bindings b JOIN whaleu_media.variants v ON v.asset_id=b.asset_id AND v.variant_name='display-v1' WHERE b.id=$1 AND b.owner_kind=$2 AND b.resource_kind=$3 AND b.resource_id=$4 AND b.content_version=$5 AND b.detached_at IS NULL`,
        [
          bindingId,
          parent.ownerKind,
          parent.resourceKind,
          parent.resourceId,
          parent.contentVersion,
        ],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    const bytes = Number(row.bytes);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > OFFICIAL_PROFILE.assetBytes ||
      row.width > OFFICIAL_PROFILE.edge ||
      row.height > OFFICIAL_PROFILE.edge ||
      row.width * row.height > OFFICIAL_PROFILE.pixels
    )
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    const object = {
      provider: row.provider,
      environment: row.environment,
      bucket: row.bucket,
      key: row.object_key,
      version: row.object_version,
    };
    return {
      appearanceId,
      revision: officialDigest([row.manifest_digest, object, artworkRevision]),
      variantHash: row.sha256,
      bytes,
      mime: row.actual_mime,
      width: row.width,
      height: row.height,
      object,
      purpose,
    };
  }
  async prepare(asset: OfficialAsset): Promise<Buffer> {
    const opened = await this.storage.openExact(
      asset.object,
      OFFICIAL_PROFILE.assetBytes,
    );
    if (opened.bytes !== asset.bytes) {
      opened.stream.destroy();
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    }
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of opened.stream) {
      const part = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      bytes += part.length;
      if (bytes > asset.bytes || bytes > OFFICIAL_PROFILE.assetBytes) {
        opened.stream.destroy();
        throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
      }
      parts.push(part);
    }
    const body = Buffer.concat(parts);
    if (
      bytes !== asset.bytes ||
      createHash('sha256').update(body).digest('hex') !== asset.variantHash
    )
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    return body;
  }
  validateSet(assets: readonly OfficialAsset[]) {
    if (
      assets.length > 32 ||
      new Set(assets.map((a) => `${a.appearanceId}:${a.purpose}`)).size !==
        assets.length ||
      assets.reduce((sum, a) => sum + a.bytes, 0) >
        OFFICIAL_PROFILE.aggregateBytes
    )
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
  }
}
