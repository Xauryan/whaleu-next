import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../../src/app.module.js';
import { DatabaseService } from '../../../src/database/database.js';
import { ratingScopedFixture } from '../../support/rating-scoped-fixture.js';
import { ratingCategoryManagementFixture } from '../../support/rating-category-management-fixture.js';
import {
  RATING_GROUP_PROMOTION_RUNTIME,
  deterministicCopy,
  digest,
  nativeLocator,
  payloadHash,
  type RatingGroupPromotionRuntime,
  type FrozenPayload,
} from '../../../src/ratings/group-promotion/contracts.js';
import { RatingPromotionSource } from '../../../src/ratings/group-promotion/source.js';
import { RatingPromotionAuthority } from '../../../src/ratings/group-promotion/authority.js';
import { RatingPromotionQualification } from '../../../src/ratings/group-promotion/qualification.js';
import {
  RatingPromotionEnrollment,
  type AcceptedReceiver,
} from '../../../src/ratings/group-promotion/enrollment.js';
import { RATING_GROUP_OPERATOR_RENDERER } from '../../../src/ratings/group-promotion/controller.js';
import { RatingGroupWorker } from '../../../src/notifications/rating-group/worker.js';
import { DurableSyntheticRatingGroupPort } from '../../../src/notifications/rating-group/synthetic.js';

export async function createPromotionFixture(
  options: {
    emittedOperator?: boolean;
    receivers?: number;
    type?: 'course' | 'canteen';
    disabled?: boolean;
    auxiliaryReceivers?: boolean;
    allowTestExport?: boolean;
    regionalCatalog?: boolean;
    opaqueCatalog?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'rating-group-promotion-')),
    domainId = randomUUID(),
    secret = randomBytes(32);
  const sender = new DurableSyntheticRatingGroupPort(
    join(directory, 'sender.json'),
    domainId,
    secret,
    true,
  );
  const generation = new DurableSyntheticRatingGroupPort(
    join(directory, 'generation.json'),
    domainId,
    secret,
    true,
  );
  const shortlinks = new DurableSyntheticRatingGroupPort(
    join(directory, 'shortlinks.json'),
    domainId,
    secret,
    true,
  );
  let app: INestApplication;
  let fixture: Awaited<ReturnType<typeof ratingScopedFixture>> | undefined;
  const runtime: RatingGroupPromotionRuntime = {
    mode: 'synthetic-only',
    domainId,
    ticketSecret: secret,
    sender,
    generation,
    shortlinks,
    source: {
      current: (...args) => app.get(RatingPromotionSource).current(...args),
    },
    authority: {
      current: (...args) => app.get(RatingPromotionAuthority).current(...args),
      service: (...args) => app.get(RatingPromotionAuthority).service(...args),
      receiver: (...args) =>
        app.get(RatingPromotionAuthority).receiver(...args),
    },
    qualification: {
      current: (...args) =>
        app.get(RatingPromotionQualification).current(...args),
    },
  };
  try {
    const appOptions: NonNullable<Parameters<typeof ratingScopedFixture>[1]> = {
      createApp: async (config, configurePolicy) => {
        const builder = Test.createTestingModule({
          imports: [AppModule.register(config)],
        });
        await configurePolicy(builder);
        if (!options.disabled)
          builder
            .overrideProvider(RATING_GROUP_PROMOTION_RUNTIME)
            .useValue(runtime);
        if (options.emittedOperator) {
          const emitted = (await import(
            new URL(
              '../../../dist/ratings/group-promotion/operator.js',
              import.meta.url,
            ).href
          )) as typeof import('../../../src/ratings/group-promotion/operator.js');
          builder.overrideProvider(RATING_GROUP_OPERATOR_RENDERER).useValue({
            shell: emitted.renderRatingGroupPromotionOperatorShell,
            script: emitted.ratingGroupPromotionOperatorModuleSource,
          });
        }
        app = (await builder.compile()).createNestApplication({
          logger: false,
        });
        return app;
      },
    };
    const type = options.type ?? 'course';
    let f: Awaited<ReturnType<typeof ratingScopedFixture>>;
    let categoryId: string;
    if (options.opaqueCatalog) {
      f = await ratingScopedFixture(undefined, appOptions);
      fixture = f;
      categoryId = (
        await f.catalog(f.creator, { count: 0, rootSystemKey: type })
      ).categoryId;
    } else {
      const managed = await ratingCategoryManagementFixture({
        systemKeys: [type],
        equalViews: options.regionalCatalog === true,
        appOptions,
      });
      f = managed;
      fixture = f;
      const context = await managed.managementContext(
        managed.admin,
        options.regionalCatalog
          ? { kind: 'campus', campusId: managed.campusA }
          : { kind: 'global' },
      );
      const created = await managed.executeManagement(
        managed.admin,
        managed.managementIntent(context, 'create_system_category_scoped', {
          systemKey: type,
          name: type === 'course' ? 'Synthetic courses' : 'Synthetic canteens',
          description: 'Accepted synthetic promotion category',
          placement: options.regionalCatalog
            ? {
                kind: 'campuses',
                campusIds: [managed.campusA, managed.campusB].sort(),
              }
            : { kind: 'global' },
          levelCount: 1,
        }),
      );
      categoryId = created.receipt.result.categoryIds[0]!;
    }
    const row = (
      await f.pool.query<{ id: string; revision: string; name: string }>(
        `SELECT c.id,c.revision,c.name FROM whaleu_ratings.catalog_heads h JOIN whaleu_ratings.categories c ON c.catalog_id=h.catalog_id WHERE h.scope_key=$2 AND c.id=$1`,
        [categoryId, options.regionalCatalog ? f.regionId : 'global'],
      )
    ).rows[0];
    if (!row)
      throw Error(
        'Synthetic source must materialize a canonical native category',
      );
    const programId = randomUUID(),
      programRevision = randomUUID(),
      accountLineage = randomUUID(),
      policyId = randomUUID(),
      policyRevision = randomUUID();
    const binding = {
      categoryId: row.id,
      categoryRevision: row.revision,
      catalogContext: { regionId: options.regionalCatalog ? f.regionId : null },
      systemKey: type,
      locatorMappingId: randomUUID(),
      locatorMappingRevision: randomUUID(),
      exportPolicyId: policyId,
      exportPolicyRevision: policyRevision,
    };
    const sourceHash = digest(binding),
      actor = f.creator,
      db = f.app.get(DatabaseService);
    await db.transaction(
      async (tx) => {
        await tx.query(
          `INSERT INTO whaleu_ratings.promotion_programs(id,lineage,revision,type,source_binding,source_hash,scope_ids,include_default,account_lineage,profile_id,enabled,coverage,provenance,evidence_ref,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$9,$8,'synthetic:rating-group-v1',true,'complete','accepted','synthetic:program',clock_timestamp()+interval '1 day')`,
          [
            programId,
            randomUUID(),
            programRevision,
            type,
            binding,
            sourceHash,
            [f.regionId],
            accountLineage,
            !options.regionalCatalog,
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.promotion_policy_revisions VALUES($1,$2,$3,'rating_group_promotion',$4,$5,true,$6,true,'synthetic:export',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 day')`,
          [
            policyId,
            policyRevision,
            programId,
            sourceHash,
            [f.regionId],
            options.allowTestExport ?? true,
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.promotion_source_bindings VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 day',true)`,
          [
            binding.locatorMappingId,
            programId,
            sourceHash,
            binding,
            policyId,
            policyRevision,
            binding.locatorMappingRevision,
            row.name,
            {
              categoryId: row.id,
              categoryRevision: row.revision,
              owner: options.opaqueCatalog
                ? 'opaque-negative-fixture'
                : 'ratings-category-management',
            },
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.promotion_grants(id,program_id,principal_lineage,kind,revision,actions,scope_ids,allow_default,allow_test,evidence_ref,active,valid_until) VALUES($1,$2,$3,'operator',$4,$5,$6,true,true,'synthetic:grant',true,clock_timestamp()+interval '1 day')`,
          [
            randomUUID(),
            programId,
            actor.accountId,
            randomUUID(),
            ['preview', 'send', 'test', 'inspect'],
            [f.regionId],
          ],
        );
      },
      { isolationLevel: 'read committed' },
    );
    const stores = await Promise.all([
      sender.storageIdentity(),
      generation.storageIdentity(),
      shortlinks.storageIdentity(),
    ]);
    const restore = (
      await f.pool.query<{ ledger_instance_id: string; restore_epoch: string }>(
        `INSERT INTO whaleu_notifications.rating_group_restore_binding(singleton,domain_id,sender_store_id,generation_store_id,shortlink_store_id) VALUES(true,$1,$2,$3,$4) RETURNING ledger_instance_id,restore_epoch`,
        [domainId, ...stores.map((s) => s.storeId)],
      )
    ).rows[0]!;
    await Promise.all(
      [sender, generation, shortlinks].map((p) =>
        p.bindLedger(restore.ledger_instance_id, restore.restore_epoch),
      ),
    );
    for (const stage of ['generation', 'shortlink'])
      await f.pool.query(
        `INSERT INTO whaleu_ratings.promotion_effect_profiles(program_id,stage,revision,profile_id,purpose,input_fields,template_ref,tokenizer_ref,enabled,valid_until,evidence_ref) VALUES($1,$2,$3,'synthetic:rating-group-v1','rating_push',$4,'synthetic:fixed-v1','synthetic:scalar-upper-bound-v1',true,clock_timestamp()+interval '1 day','synthetic:explicit-profile')`,
        [
          programId,
          stage,
          randomUUID(),
          stage === 'generation'
            ? ['label', 'date', 'type']
            : ['nativeLocator'],
        ],
      );
    const qualify = async (
      copy = deterministicCopy(type),
      locator = nativeLocator(binding),
    ) => {
      const payload: FrozenPayload = {
        profileVersion: 'rating-group-v1',
        type,
        copy,
        locator,
        nativeLocatorHash: digest(nativeLocator(binding)),
        sourceBindingHash: sourceHash,
      };
      await f.pool.query(
        `INSERT INTO whaleu_ratings.promotion_payload_qualifications VALUES($1,$2,$3,$4,true,'synthetic:exact-payload-review',clock_timestamp()+interval '1 day') ON CONFLICT(program_id,payload_hash) DO NOTHING`,
        [programId, payloadHash(payload), policyRevision, sourceHash],
      );
      return payload;
    };
    await qualify();
    const enroll = async (
      start: number,
      count: number,
      kind: 'school_treehole' | 'default_treehole' | 'test' = 'school_treehole',
    ) => {
      const ids: string[] = [];
      for (let at = 0; at < count; at += 128) {
        const entries: AcceptedReceiver[] = Array.from(
          { length: Math.min(128, count - at) },
          (_, i) => ({
            accountLineage,
            canonicalReceiver: `synthetic:${kind}:${start + at + i}`,
            opaqueRef: `synthetic:${kind}:${start + at + i}`,
            kind,
            schoolScopeId: kind === 'school_treehole' ? f.regionId : null,
            label: `Synthetic ${kind} ${start + at + i}`,
            ownerEvidenceRef: 'synthetic:accepted-owner',
            purposeGrantId: policyId,
            consentPolicyRevision: policyRevision,
            validUntil: new Date(Date.now() + 86400000),
          }),
        );
        ids.push(
          ...(await db.transaction(
            (tx) =>
              f.app
                .get(RatingPromotionEnrollment)
                .enroll(programId, entries, tx),
            { isolationLevel: 'read committed' },
          )),
        );
      }
      return ids;
    };
    const destinationIds = await enroll(0, options.receivers ?? 1);
    const defaultIds =
      options.auxiliaryReceivers === false || options.regionalCatalog
        ? []
        : await enroll(0, 1, 'default_treehole');
    const testIds =
      options.auxiliaryReceivers === false ? [] : await enroll(0, 1, 'test');
    return {
      ...f,
      app: f.app,
      db,
      token: actor.accessToken,
      actorId: actor.accountId,
      programId,
      programRevision,
      testDestinationId: testIds[0]!,
      destinationIds: [...destinationIds, ...defaultIds],
      binding,
      accountLineage,
      runtime,
      sender,
      generation,
      shortlinks,
      directory,
      qualify,
      enroll,
      worker: f.app.get(RatingGroupWorker),
      close: async () => {
        try {
          await f.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await fixture?.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function admitPromotion(
  f: Awaited<ReturnType<typeof createPromotionFixture>>,
  options: {
    mode?: 'normal' | 'test';
    copyMode?: 'deterministic' | 'assisted';
    linkMode?: 'native' | 'shortlink_optional' | 'shortlink_required';
  } = {},
) {
  const { default: request } = await import('supertest');
  const base = `/v1/rating-group-promotion/programs/${f.programId}`;
  const post = (path: string, body: object) =>
    request(f.app.getHttpServer())
      .post(base + path)
      .set('Authorization', `Bearer ${f.token}`)
      .send(body);
  const preview = await post('/previews', {
    type: f.binding.systemKey,
    mode: options.mode ?? 'normal',
    expectedProgramRevision: f.programRevision,
    ...(options.mode === 'test'
      ? { testDestinationId: f.testDestinationId }
      : {}),
  });
  if (preview.status !== 200)
    throw Error(
      `Preview failed: ${preview.status} ${JSON.stringify(preview.body)}`,
    );
  const intent = await post('/intents', {
    previewId: preview.body.previewId,
    copyMode: options.copyMode ?? 'deterministic',
    linkMode: options.linkMode ?? 'native',
  });
  if (intent.status !== 200)
    throw Error(
      `Intent failed: ${intent.status} ${JSON.stringify(intent.body)}`,
    );
  const body = {
    requestId: intent.body.requestId as string,
    intentTicket: intent.body.intentTicket as string,
    requestHash: intent.body.requestHash as string,
  };
  const campaign = await post('/campaigns', body);
  if (campaign.status !== 202)
    throw Error(
      `Admission failed: ${campaign.status} ${JSON.stringify(campaign.body)}`,
    );
  return {
    preview: preview.body as Record<string, unknown>,
    body,
    status: campaign.body as {
      campaignId: string;
      requestId: string;
      requestHash: string;
    },
  };
}
