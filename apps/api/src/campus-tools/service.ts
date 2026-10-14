import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ZodError } from 'zod';
import { DatabaseService } from '../database/database.js';
import { CampusService } from '../campus/campus.service.js';
import { IdentityService } from '../identity/identity.service.js';
import { SafetyRepository } from '../safety/repository.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { AccountPolicy } from '../safety/account-policy/decorator.js';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionExactDeadline } from '../database/transaction-deadlines.js';
import { canonicalToolLink, sealToolCatalog, toolId } from './contracts.js';
import type { ToolCatalog, ToolEntry } from './contracts.js';
import {
  CAMPUS_TOOLS_RUNTIME,
  acceptedToolSource,
  acceptedToolWebview,
} from './runtime.js';
import type { CampusToolsRuntime } from './runtime.js';
import {
  lockToolCatalog,
  requireToolCurrent,
  requireToolRuntime,
} from './current-proof.js';
import {
  toolsHubSchema,
  toolDetailSchema,
  toolLinkSchema,
  publicToolEntrySchema,
} from './public-contracts.js';
interface CatalogRow {
  content: unknown;
  canonical: string;
  digest: string;
  authority_reference: string;
  authority_proof: string;
  previous_head: string | null;
  effective: boolean;
  expired: boolean;
  expires_at: string | null;
}
@Injectable()
export class CampusToolsService {
  constructor(
    @Inject(DatabaseService) readonly database: DatabaseService,
    @Inject(CampusService) private readonly campuses: CampusService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(SafetyRepository) private readonly safety: SafetyRepository,
    @Inject(CAMPUS_TOOLS_RUNTIME) readonly runtime: CampusToolsRuntime | null,
  ) {}
  async transaction<T>(run: (tx: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(
        async (tx) => {
          await tx.query("SET LOCAL lock_timeout='500ms'");
          return run(tx);
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (
        error instanceof ZodError ||
        (typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['57014', '55P03'].includes(String(error.code)))
      )
        throw new ApplicationError('CAMPUS_TOOLS_UNAVAILABLE');
      throw error;
    }
  }
  /** Same owner path for public DTO, link action and dedicated Media delivery. */
  async current(token: string | null, campusId: string, tx: PoolClient) {
    toolId.parse(campusId);
    await lockToolCatalog(campusId, tx);
    // Capture original scope/head/media facts before authentication and other waits.
    await requireToolCurrent(campusId, tx);
    await lockSafetyPolicy(tx);
    const session =
      token === null ? null : await this.identity.session(token, tx);
    if (session) await this.safety.restriction(session.accountId, tx);
    await this.campuses.requireSelectable(campusId, tx);
    const region = (
      await tx.query<{ is_active: boolean }>(
        'SELECT r.is_active FROM whaleu_campus.campus_region_assignments a JOIN whaleu_campus.operating_regions r ON r.id=a.operating_region_id WHERE a.campus_id=$1 FOR SHARE OF a,r',
        [campusId],
      )
    ).rows[0];
    if (region && !region.is_active)
      throw new ApplicationError('CAMPUS_UNAVAILABLE');
    const row = (
      await tx.query<CatalogRow>(
        `SELECT c.content,c.canonical,c.digest,a.authority_reference,a.authority_proof,a.previous_head,c.effective_at<=clock_timestamp() effective,c.expires_at<=clock_timestamp() expired,c.expires_at::text FROM whaleu_campus_tools.heads h JOIN whaleu_campus_tools.catalogs c ON c.id=h.catalog_id AND c.campus_id=h.campus_id JOIN whaleu_campus_tools.admissions a ON a.id=c.admission_id AND a.catalog_id=c.id AND a.campus_id=c.campus_id AND a.input_digest=c.digest WHERE h.campus_id=$1`,
        [campusId],
      )
    ).rows[0];
    if (!row)
      return {
        state: 'unknown' as const,
        reason: 'NO_ACCEPTED_CATALOG',
        session,
      };
    const sealed = sealToolCatalog(row.content),
      catalog = sealed.catalog;
    if (
      sealed.digest !== row.digest ||
      sealed.canonical !== row.canonical ||
      catalog.campusId !== campusId ||
      catalog.expectedHead !== row.previous_head ||
      !acceptedToolSource(this.runtime, catalog, sealed.digest, {
        reference: row.authority_reference,
        proof: row.authority_proof,
      })
    )
      return {
        state: 'unavailable' as const,
        reason: 'SOURCE_AUTHORITY_UNAVAILABLE',
        session,
      };
    requireToolRuntime(
      `source:${sealed.digest}`,
      () =>
        acceptedToolSource(this.runtime, catalog, sealed.digest, {
          reference: row.authority_reference,
          proof: row.authority_proof,
        }) === true,
      tx,
    );
    if (catalog.coverage !== 'complete' || !row.effective)
      return {
        state: 'unknown' as const,
        reason: 'SOURCE_NOT_CURRENT',
        session,
      };
    if (row.expired)
      return { state: 'expired' as const, reason: 'CATALOG_EXPIRED', session };
    if (catalog.status === 'withdrawn')
      return {
        state: 'unavailable' as const,
        reason: 'CATALOG_WITHDRAWN',
        session,
      };
    registerTransactionExactDeadline(
      tx,
      row.expires_at,
      'CAMPUS_TOOLS_UNAVAILABLE',
    );
    return {
      state: 'current' as const,
      catalog,
      digest: sealed.digest,
      session,
    };
  }
  private context(catalog: ToolCatalog, digest: string) {
    const { maintainer, attribution, observedAt, publishedAt } = catalog.source;
    return {
      campusId: catalog.campusId,
      catalogId: catalog.id,
      digest,
      version: catalog.version,
      provenance: {
        maintainer,
        attribution,
        observedAt,
        publishedAt,
        validity: catalog.validity,
      },
    };
  }
  private entry(catalog: ToolCatalog, entry: ToolEntry) {
    if (entry.state !== 'enabled') {
      const { id, sourceId, ordinal, revision, title, state, kind } = entry;
      return publicToolEntrySchema.parse({
        id,
        sourceId,
        ordinal,
        revision,
        title,
        state,
        kind,
      });
    }
    if (entry.kind === 'research')
      return publicToolEntrySchema.parse({
        ...entry,
        link: entry.link ? { action: 'copy', state: 'available' } : null,
      });
    if (entry.kind === 'web-link')
      return publicToolEntrySchema.parse({
        ...entry,
        link: {
          action: 'webview',
          state: acceptedToolWebview(this.runtime, catalog, entry.id)
            ? 'available'
            : 'webview_unconfigured',
        },
      });
    return publicToolEntrySchema.parse(entry);
  }
  @AccountPolicy('browse', 'entry')
  hub(token: string | null, campusId: string) {
    return this.transaction(async (tx) => {
      const current = await this.current(token, campusId, tx);
      if (current.state !== 'current')
        return toolsHubSchema.parse({
          state: current.state,
          campusId,
          reason: current.reason,
        });
      const { catalog, digest } = current,
        context = this.context(catalog, digest);
      if (catalog.applicability === 'not_applicable')
        return toolsHubSchema.parse({
          ...context,
          state: 'not_applicable',
          entries: [],
        });
      const entries = catalog.entries.map((entry) =>
        this.entry(catalog, entry),
      );
      return toolsHubSchema.parse({
        ...context,
        state: entries.length ? 'ready' : 'known_empty',
        entries,
      });
    });
  }
  @AccountPolicy('browse', 'entry')
  detail(
    token: string | null,
    campusId: string,
    entryId: string,
    catalogId: string,
  ) {
    toolId.parse(entryId);
    toolId.parse(catalogId);
    return this.transaction(async (tx) => {
      const current = await this.current(token, campusId, tx);
      if (current.state !== 'current')
        return toolDetailSchema.parse({
          state: current.state,
          campusId,
          reason: current.reason,
        });
      if (current.catalog.id !== catalogId)
        throw new ApplicationError('CAMPUS_TOOLS_STALE');
      const entry = current.catalog.entries.find((e) => e.id === entryId);
      if (current.catalog.applicability !== 'applicable' || !entry)
        throw new ApplicationError('CAMPUS_TOOLS_NOT_FOUND');
      return toolDetailSchema.parse({
        ...this.context(current.catalog, current.digest),
        state: 'ready',
        entry: this.entry(current.catalog, entry),
      });
    });
  }
  @AccountPolicy('browse', 'entry')
  link(
    token: string | null,
    campusId: string,
    entryId: string,
    catalogId: string,
    action: 'copy' | 'webview',
  ) {
    toolId.parse(entryId);
    toolId.parse(catalogId);
    return this.transaction(async (tx) => {
      const current = await this.current(token, campusId, tx);
      if (current.state !== 'current')
        return toolLinkSchema.parse({
          state: 'unavailable',
          campusId,
          reason: current.reason,
        });
      const { catalog, digest } = current;
      if (catalog.id !== catalogId)
        throw new ApplicationError('CAMPUS_TOOLS_STALE');
      const entry = catalog.entries.find((e) => e.id === entryId);
      if (
        catalog.applicability !== 'applicable' ||
        !entry ||
        entry.state !== 'enabled' ||
        !('link' in entry) ||
        !entry.link ||
        entry.link.action !== action
      )
        throw new ApplicationError('CAMPUS_TOOLS_NOT_FOUND');
      const url = canonicalToolLink(entry.link.url, action, catalog.linkPolicy);
      if (
        !url ||
        (action === 'webview' &&
          !acceptedToolWebview(this.runtime, catalog, entryId))
      )
        return toolLinkSchema.parse({
          state: 'unavailable',
          campusId,
          reason: 'WEBVIEW_UNCONFIGURED',
        });
      if (action === 'webview')
        requireToolRuntime(
          `webview:${catalog.id}:${entryId}`,
          () => acceptedToolWebview(this.runtime, catalog, entryId) === true,
          tx,
        );
      return toolLinkSchema.parse({
        state: 'ready',
        campusId,
        catalogId,
        digest,
        entryId,
        entryRevision: entry.revision,
        action,
        url,
        policy: catalog.linkPolicy,
      });
    });
  }
}
