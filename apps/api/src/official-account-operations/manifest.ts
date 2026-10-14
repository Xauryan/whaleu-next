import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { OfficialSourceSelector } from './selection.js';
import type { OfficialSourcePort, OfficialSourceFact } from './source.js';
import type { OfficialAsset, OfficialMediaExport } from './media.js';
import type { OfficialAuthority } from './authority.js';
import { officialArticle } from './contracts.js';
import type { OfficialArticle, OfficialPreview } from './contracts.js';
import {
  OFFICIAL_PROFILE,
  boundedOfficialJson,
  escapeOfficialLiteral,
  officialCanonicalDigest as officialDigest,
  scalarExcerpt,
  scalarTitle,
} from './profile.js';
export interface OfficialManifest {
  profile: 'synthetic-official-v1';
  previewId: string;
  kind: 'daily_hot' | 'test' | 'manual_newest';
  programId: string;
  accountRef: string;
  destinationRef: string;
  accountRevision: string;
  programRevision: string;
  configRevision: string;
  selectionAt: string;
  expiresAt: string;
  sources: OfficialSourceFact[];
  assets: OfficialAsset[];
  article: OfficialArticle;
  rendered: string;
  renderedHash: string;
  manifestHash: string;
}
export interface OfficialConfig {
  program_id: string;
  revision: string;
  author: string;
  cover_appearance_id: string | null;
  title_appearance_id: string | null;
}
export function renderOfficialArticle(article: OfficialArticle): string {
  const safe = officialArticle.parse(article);
  const img = (id: string) => `<img src="synthetic:appearance:${id}" alt="" />`;
  const html = `<article>${safe.coverAppearanceId ? img(safe.coverAppearanceId) : ''}${safe.titleAppearanceId ? img(safe.titleAppearanceId) : ''}<h1>${escapeOfficialLiteral(safe.title)}</h1><p>${escapeOfficialLiteral(safe.author)}</p>${safe.items.map((item) => `<section><p>${escapeOfficialLiteral(item.excerpt)}</p>${item.mediaAppearanceRefs.map(img).join('')}<time>${escapeOfficialLiteral(item.publishedAt)}</time><p>赞 ${item.publicCounts.likes} · 评论 ${item.publicCounts.comments} · 收藏 ${item.publicCounts.subscriptions}</p></section>`).join('')}</article>`;
  if (Buffer.byteLength(html) > OFFICIAL_PROFILE.renderBytes)
    throw new ApplicationError('OFFICIAL_REQUEST_INVALID');
  return html;
}
export class OfficialManifestBuilder {
  private readonly selector: OfficialSourceSelector;
  constructor(
    private readonly source: OfficialSourcePort,
    private readonly media: OfficialMediaExport | null,
  ) {
    this.selector = new OfficialSourceSelector(source);
  }
  async build(
    authority: OfficialAuthority,
    config: OfficialConfig,
    kind: OfficialManifest['kind'],
    limit: number | undefined,
    tx: PoolClient,
  ): Promise<{ manifest: OfficialManifest; preview: OfficialPreview }> {
    const program = authority.program;
    const selected =
      kind === 'test'
        ? {
            selectionAt: (
              await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
            ).rows[0]!.now.toISOString(),
            facts: [] as OfficialSourceFact[],
            sourceState: 'complete' as const,
          }
        : await this.selector.select(
            {
              schoolSpaceId: program.school_space_id,
              citySpaceId: program.city_space_id,
              kind,
              ...(limit === undefined ? {} : { limit }),
            },
            tx,
          );
    const items: OfficialArticle['items'] = [],
      assets: OfficialAsset[] = [];
    for (const fact of selected.facts) {
      const projection = await this.source.project(fact.postId, tx);
      for (const appearance of projection.mediaAppearanceRefs) {
        if (!this.media)
          throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
        assets.push(
          await this.media.inspect(
            appearance,
            'inline',
            {
              ownerKind: 'community',
              resourceKind: 'post',
              resourceId: fact.postId,
              contentVersion: 1,
            },
            tx,
          ),
        );
      }
      items.push({
        excerpt: scalarExcerpt(projection.text),
        publishedAt: fact.publishedAt,
        publicCounts: projection.publicCounts,
        locator: projection.locator,
        mediaAppearanceRefs: projection.mediaAppearanceRefs,
      });
    }
    if (kind === 'test')
      items.push({
        excerpt: '这是内置合成测试内容，仅生成草稿，不会自动发布。',
        publishedAt: selected.selectionAt,
        publicCounts: { likes: '0', comments: '0', subscriptions: '0' },
        locator:
          'pages/community-detail/community-detail?postId=00000000-0000-4000-8000-000000000001',
        mediaAppearanceRefs: [],
      });
    for (const [purpose, id] of [
      ['cover', config.cover_appearance_id],
      ['title', config.title_appearance_id],
    ] as const)
      if (id) {
        if (!this.media)
          throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
        assets.push(
          await this.media.inspect(
            id,
            purpose,
            {
              ownerKind: 'official-account',
              resourceKind: 'artwork',
              resourceId: program.id,
              contentVersion: 1,
            },
            tx,
          ),
        );
      }
    this.media?.validateSet(assets);
    const article = officialArticle.parse({
      title: scalarTitle(
        items[0]?.excerpt ?? `校园精选 ${selected.selectionAt.slice(0, 10)}`,
        kind === 'test',
      ),
      author: config.author,
      items,
      coverAppearanceId: config.cover_appearance_id,
      titleAppearanceId: config.title_appearance_id,
    });
    const rendered = renderOfficialArticle(article),
      renderedHash = createHash('sha256').update(rendered).digest('hex'),
      previewId = randomUUID(),
      expiresAt = new Date(
        new Date(selected.selectionAt).getTime() + OFFICIAL_PROFILE.previewMs,
      ).toISOString();
    const base = {
      profile: OFFICIAL_PROFILE.name,
      previewId,
      kind,
      programId: program.id,
      accountRef: program.account_ref,
      destinationRef: program.destination_ref,
      accountRevision: program.account_revision,
      programRevision: program.revision,
      configRevision: config.revision,
      selectionAt: selected.selectionAt,
      expiresAt,
      sources: selected.facts,
      assets,
      article,
      rendered,
      renderedHash,
    };
    const manifest = { ...base, manifestHash: officialDigest(base) };
    boundedOfficialJson(manifest);
    return {
      manifest,
      preview: {
        previewId,
        programId: program.id,
        accountRef: program.account_ref,
        accountLabel: program.label,
        kind,
        selectionAt: selected.selectionAt,
        expiresAt,
        configRevision: config.revision,
        manifestHash: manifest.manifestHash,
        eligibleCount: items.length,
        mode: 'synthetic',
        article,
        actions: { createDraft: kind !== 'daily_hot' && items.length > 0 },
        sourceState: selected.sourceState,
      },
    };
  }
  async requireCurrent(
    manifest: OfficialManifest,
    authority: OfficialAuthority,
    config: OfficialConfig,
    tx: PoolClient,
    freshUntil = manifest.expiresAt,
  ): Promise<void> {
    if (
      manifest.programId !== authority.program.id ||
      manifest.accountRef !== authority.program.account_ref ||
      manifest.destinationRef !== authority.program.destination_ref ||
      manifest.accountRevision !== authority.program.account_revision ||
      manifest.programRevision !== authority.program.revision ||
      manifest.configRevision !== config.revision
    )
      throw new ApplicationError('OFFICIAL_CONFIG_STALE');
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]!.now.getTime();
    registerTransactionDeadline(
      tx,
      new Date(freshUntil).getTime(),
      'OFFICIAL_PREVIEW_STALE',
    );
    if (now >= new Date(freshUntil).getTime())
      throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
    for (const source of manifest.sources) {
      if (manifest.kind === 'daily_hot')
        registerTransactionDeadline(
          tx,
          new Date(source.publishedAt).getTime() +
            OFFICIAL_PROFILE.dailyWindowMs,
          'OFFICIAL_PREVIEW_STALE',
        );
      const current = await this.source.inspect(source.postId, false, tx);
      if (current?.decision === 'unknown')
        throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
      if (
        !current ||
        current.decision !== 'allow' ||
        current.revision !== source.revision ||
        current.eligibilityRevision !== source.eligibilityRevision ||
        current.spaceId !== source.spaceId ||
        current.publishedAt !== source.publishedAt
      )
        throw new ApplicationError('OFFICIAL_SOURCE_WITHDRAWN');
      if (
        manifest.kind === 'daily_hot' &&
        (new Date(source.publishedAt).getTime() <=
          now - OFFICIAL_PROFILE.dailyWindowMs ||
          new Date(source.publishedAt).getTime() > now)
      )
        throw new ApplicationError('OFFICIAL_PREVIEW_STALE');
    }
    for (const asset of manifest.assets) {
      if (!this.media)
        throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
      const post =
        asset.purpose === 'inline'
          ? manifest.sources.find((_, i) =>
              manifest.article.items[i]?.mediaAppearanceRefs.includes(
                asset.appearanceId,
              ),
            )
          : undefined;
      const current = await this.media.inspect(
        asset.appearanceId,
        asset.purpose,
        post
          ? {
              ownerKind: 'community',
              resourceKind: 'post',
              resourceId: post.postId,
              contentVersion: 1,
            }
          : {
              ownerKind: 'official-account',
              resourceKind: 'artwork',
              resourceId: manifest.programId,
              contentVersion: 1,
            },
        tx,
      );
      if (officialDigest(current) !== officialDigest(asset))
        throw new ApplicationError('OFFICIAL_SOURCE_WITHDRAWN');
    }
  }
}
