import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CampusToolsService } from '../service.js';
import { toolMediaSlots } from '../contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { CampusToolMediaProofRegistry } from '../../media/campus-tools-owner-proof.js';
import type {
  CampusToolMediaRequest,
  CampusToolMediaAuthority,
} from '../../media/campus-tools-owner-proof.js';
import {
  campusToolMediaTargetSchema,
  campusToolMediaDescriptorSchema,
} from '../../media/contracts-campus-tools.js';
import type { CampusToolMediaTarget } from '../../media/contracts-campus-tools.js';
import type { MediaVariantName } from '../../media/contracts.js';
import { mediaVariantSchema } from '../../media/contracts.js';
import { sealManifest } from '../../media/manifest.js';
import { ExactMediaDeliveryService } from '../../media/delivery.js';
import { MediaDeliveryBudgetPool } from '../../media/delivery-budget.js';
@Injectable()
export class CampusToolsMediaService {
  readonly registry: CampusToolMediaProofRegistry;
  private readonly delivery: ExactMediaDeliveryService | null;
  constructor(
    @Inject(CampusToolsService) readonly tools: CampusToolsService,
    @Inject(MediaDeliveryBudgetPool) budget: MediaDeliveryBudgetPool,
  ) {
    this.registry = new CampusToolMediaProofRegistry({
      authorizeCurrent: (token, request, tx) =>
        this.authorizeCurrent(token, request, tx),
    });
    this.delivery = tools.runtime
      ? new ExactMediaDeliveryService(
          tools.database,
          tools.runtime.storage,
          budget,
        )
      : null;
  }
  private async authorizeCurrent(
    token: string | null,
    request: CampusToolMediaRequest,
    tx: PoolClient,
  ): Promise<CampusToolMediaAuthority> {
    const target = request.target;
    const current = await this.tools.current(token, target.campusId, tx);
    if (
      current.state !== 'current' ||
      current.catalog.id !== target.catalogId ||
      current.catalog.applicability !== 'applicable'
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const match = toolMediaSlots(current.catalog).find(
      ({ entry, slot }) =>
        entry.id === target.entryId &&
        entry.state === 'enabled' &&
        slot.bindingId === target.bindingId,
    );
    if (!match) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const { slot, entry } = match;
    return {
      reference: {
        ...target,
        entryRevision: entry.revision,
        assetId: slot.assetId,
        manifestDigest: slot.manifestDigest,
      },
      catalogDigest: current.digest,
      principal: {
        kind: 'campus-tools-public',
        accountId: current.session?.accountId ?? null,
        sessionId: current.session?.sessionId ?? null,
        requestId: request.requestId,
      },
    };
  }
  private async manifest(
    token: string | null,
    request: CampusToolMediaRequest,
    tx: PoolClient,
  ) {
    const proof = await this.registry.authorize(token, request, tx),
      authority = this.registry.require(proof, request, tx),
      ref = authority.reference;
    const row = (
      await tx.query<{ manifest: unknown; manifest_digest: string }>(
        `SELECT manifest,manifest_digest FROM whaleu_campus_tools.media_bindings WHERE id=$1 AND campus_id=$2 AND catalog_id=$3 AND entry_id=$4 AND entry_revision=$5 AND asset_id=$6`,
        [
          ref.bindingId,
          ref.campusId,
          ref.catalogId,
          ref.entryId,
          ref.entryRevision,
          ref.assetId,
        ],
      )
    ).rows[0];
    if (!row || row.manifest_digest !== ref.manifestDigest)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const sealed = sealManifest(row.manifest);
    if (sealed.digest !== ref.manifestDigest)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    this.registry.require(proof, request, tx);
    return { authority, manifest: sealed.manifest };
  }
  @AccountPolicy('browse', 'entry')
  descriptor(token: string | null, target: CampusToolMediaTarget) {
    const request = {
      target: campusToolMediaTargetSchema.parse(target),
      requestId: randomUUID(),
    };
    return this.tools.transaction(async (tx) => {
      const { authority, manifest } = await this.manifest(token, request, tx);
      if (!this.delivery) throw new ApplicationError('MEDIA_UNAVAILABLE');
      const display = manifest.variants[1];
      return campusToolMediaDescriptorSchema.parse({
        ...authority.reference,
        protocol: 'campus-tools-media-v1',
        kind: 'campus-tool',
        width: display.width,
        height: display.height,
        variants: ['thumb-v1', 'display-v1'],
      });
    });
  }
  @AccountPolicy('browse', 'entry')
  async open(
    token: string | null,
    target: CampusToolMediaTarget,
    variant: MediaVariantName,
    connectionKey: string,
    range?: string,
  ) {
    const request = {
      target: campusToolMediaTargetSchema.parse(target),
      requestId: randomUUID(),
    };
    mediaVariantSchema.parse(variant);
    if (!this.delivery) {
      // Authenticate supplied credentials before reporting unavailable provider.
      await this.tools.transaction((tx) =>
        this.tools.current(token, target.campusId, tx),
      );
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    }
    return this.delivery.open(
      async (tx) => {
        const { authority, manifest } = await this.manifest(token, request, tx);
        const image = manifest.variants.find((v) => v.name === variant);
        if (!image) throw new ApplicationError('MEDIA_UNAVAILABLE');
        return {
          object: image.object,
          sha256: image.sha256,
          bytes: image.bytes,
          mime: image.mime,
          attachmentSetRevision: authority.catalogDigest,
          accountId: authority.principal.accountId,
        };
      },
      (plan) =>
        plan.accountId === null
          ? `campus-tools-guest:${connectionKey}`
          : `campus-tools-account:${plan.accountId}`,
      range,
    );
  }
}
