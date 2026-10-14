import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { OfficialSourcePort, OfficialSourceFact } from './source.js';
import type { OfficialMediaExport, OfficialAsset } from './media.js';
import type { OfficialConfig, OfficialManifest } from './manifest.js';
import { renderOfficialArticle } from './manifest.js';
import { officialArticle } from './contracts.js';
import type { OfficialAuthority } from './authority.js';
import {
  OFFICIAL_PROFILE,
  scalarExcerpt,
  scalarTitle,
  officialCanonicalDigest as officialDigest,
} from './profile.js';
export interface OfficialReconstruction {
  profile: 'synthetic-official-v1';
  kind: OfficialManifest['kind'];
  sources: OfficialSourceFact[];
  assets: Pick<
    OfficialAsset,
    'appearanceId' | 'revision' | 'variantHash' | 'purpose'
  >[];
  counts: {
    publicCounts: { likes: string; comments: string; subscriptions: string };
    publishedAt: string;
  }[];
  renderedHash: string;
  manifestHash: string;
}
/** Rebuild only still-readable immutable source revisions; frozen public counters
 * survive without retaining literal source text. A changed render is a veto. */
export async function reconstructOfficialManifest(
  preview: {
    id: string;
    kind: OfficialManifest['kind'];
    selection_at: Date;
    expires_at: Date;
    reconstruction: OfficialReconstruction;
  },
  authority: OfficialAuthority,
  config: OfficialConfig,
  source: OfficialSourcePort,
  media: OfficialMediaExport | null,
  tx: PoolClient,
): Promise<OfficialManifest> {
  const reconstruction = preview.reconstruction;
  if (
    preview.kind !== 'manual_newest' ||
    reconstruction.kind !== 'manual_newest'
  )
    throw new ApplicationError('OFFICIAL_REFERENCE_NOT_FOUND');
  const items = [],
    assets: OfficialAsset[] = [];
  for (const [index, old] of reconstruction.sources.entries()) {
    const current = await source.inspect(old.postId, false, tx);
    if (
      !current ||
      current.decision !== 'allow' ||
      current.revision !== old.revision ||
      current.eligibilityRevision !== old.eligibilityRevision ||
      current.spaceId !== old.spaceId ||
      current.publishedAt !== old.publishedAt
    )
      throw new ApplicationError('OFFICIAL_SOURCE_WITHDRAWN');
    const projection = await source.project(old.postId, tx),
      counts = reconstruction.counts[index];
    if (!counts) throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    items.push({
      excerpt: scalarExcerpt(projection.text),
      publishedAt: counts.publishedAt,
      publicCounts: counts.publicCounts,
      locator: projection.locator,
      mediaAppearanceRefs: projection.mediaAppearanceRefs,
    });
    for (const id of projection.mediaAppearanceRefs) {
      if (!media) throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
      assets.push(
        await media.inspect(
          id,
          'inline',
          {
            ownerKind: 'community',
            resourceKind: 'post',
            resourceId: old.postId,
            contentVersion: 1,
          },
          tx,
        ),
      );
    }
  }
  for (const [purpose, id] of [
    ['cover', config.cover_appearance_id],
    ['title', config.title_appearance_id],
  ] as const)
    if (id) {
      if (!media) throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
      assets.push(
        await media.inspect(
          id,
          purpose,
          {
            ownerKind: 'official-account',
            resourceKind: 'artwork',
            resourceId: authority.program.id,
            contentVersion: 1,
          },
          tx,
        ),
      );
    }
  if (
    officialDigest(
      assets.map(({ appearanceId, revision, variantHash, purpose }) => ({
        appearanceId,
        revision,
        variantHash,
        purpose,
      })),
    ) !== officialDigest(reconstruction.assets)
  )
    throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
  media?.validateSet(assets);
  const article = officialArticle.parse({
      title: scalarTitle(
        items[0]?.excerpt ??
          `校园精选 ${preview.selection_at.toISOString().slice(0, 10)}`,
      ),
      author: config.author,
      items,
      coverAppearanceId: config.cover_appearance_id,
      titleAppearanceId: config.title_appearance_id,
    }),
    rendered = renderOfficialArticle(article),
    renderedHash = createHash('sha256').update(rendered).digest('hex');
  if (renderedHash !== reconstruction.renderedHash)
    throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
  const p = authority.program,
    base = {
      profile: OFFICIAL_PROFILE.name,
      previewId: preview.id,
      kind: preview.kind,
      programId: p.id,
      accountRef: p.account_ref,
      destinationRef: p.destination_ref,
      accountRevision: p.account_revision,
      programRevision: p.revision,
      configRevision: config.revision,
      selectionAt: preview.selection_at.toISOString(),
      expiresAt: preview.expires_at.toISOString(),
      sources: reconstruction.sources,
      assets,
      article,
      rendered,
      renderedHash,
    };
  if (officialDigest(base) !== reconstruction.manifestHash)
    throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
  return { ...base, manifestHash: reconstruction.manifestHash };
}
