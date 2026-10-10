import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { mediaManifestSchema } from '../../media/contracts.js';
import type { MediaManifest } from '../../media/contracts.js';
import { sealManifest } from '../../media/manifest.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { PROFILE_MEDIA_PROTOCOL } from './contracts.js';
export interface AvatarCatalogItem {
  catalog_version: string;
  item_id: string;
  label: string;
  content_hash: string;
  manifest: MediaManifest;
  available: boolean;
}
interface Fact {
  version: string;
  item: string | null;
  fingerprint: string;
}
async function listed(version: string, tx: PoolClient) {
  return (
    await tx.query<{ item_id: string }>(
      'SELECT item_id FROM whaleu_profile.avatar_catalog_items WHERE catalog_version=$1 AND available ORDER BY item_id LIMIT 92',
      [version],
    )
  ).rows;
}
async function row(
  version: string,
  item: string,
  tx: PoolClient,
): Promise<AvatarCatalogItem | null> {
  return (
    (
      await tx.query<AvatarCatalogItem>(
        'SELECT c.*,xmin::text state_version FROM whaleu_profile.avatar_catalog_items c WHERE catalog_version=$1 AND item_id=$2',
        [version, item],
      )
    ).rows[0] ?? null
  );
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 128,
  failureCode: 'MEDIA_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'MEDIA_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_profile.avatar_catalog_items IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if (
          ownerFingerprint(
            fact.item === null
              ? await listed(fact.version, read)
              : await row(fact.version, fact.item, read),
          ) !== fact.fingerprint
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
    }),
};
/** Constructor-only catalog activation. No environment flag or synthetic default. */
export class ProfileAvatarCatalog {
  constructor(readonly version: string) {}
  async require(
    version: string,
    item: string,
    tx: PoolClient,
  ): Promise<AvatarCatalogItem> {
    enableRequiredTransactionProof(tx, proof);
    const found = await row(version, item, tx);
    if (version !== this.version || !found?.available)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const parsed = mediaManifestSchema.safeParse(found.manifest);
    if (!parsed.success) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const manifest = parsed.data;
    if (sealManifest(manifest).digest !== found.content_hash)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    registerRequiredTransactionFact(
      tx,
      proof,
      `${version}:${item}:${ownerFingerprint(found)}`,
      Object.freeze({ version, item, fingerprint: ownerFingerprint(found) }),
    );
    return { ...found, manifest };
  }
  async list(tx: PoolClient) {
    const items = await listed(this.version, tx);
    if (!items.length || items.length > 91)
      return {
        protocol: PROFILE_MEDIA_PROTOCOL,
        availability: 'unavailable' as const,
        catalogVersion: null,
        items: [],
      };
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(
      tx,
      proof,
      `catalog-list:${this.version}:${ownerFingerprint(items)}`,
      Object.freeze({
        version: this.version,
        item: null,
        fingerprint: ownerFingerprint(items),
      }),
    );
    const output = [];
    for (const { item_id } of items) {
      const value = await this.require(this.version, item_id, tx);
      output.push({
        itemId: item_id,
        label: value.label,
        contentHash: value.content_hash,
      });
    }
    return {
      protocol: PROFILE_MEDIA_PROTOCOL,
      availability: 'available' as const,
      catalogVersion: this.version,
      items: output,
    };
  }
}
