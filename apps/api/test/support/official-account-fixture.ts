import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { DatabaseService } from '../../src/database/database.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import { SafetyRepository } from '../../src/safety/repository.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { CommunitySerializer } from '../../src/community/community-serialization.js';
import { HotScoreRepository } from '../../src/community/hot-score/repository.js';
import { HotScoreStorage } from '../../src/community/hot-score/storage.js';
import { OfficialOperationAuthority } from '../../src/official-account-operations/authority.js';
import {
  CommunityOfficialSource,
  CommunityOfficialPublicProjection,
} from '../../src/official-account-operations/source.js';
import type { ImmutableMediaStorage } from '../../src/media/storage-port.js';
import { OfficialMediaExport } from '../../src/official-account-operations/media.js';
import { OfficialManifestBuilder } from '../../src/official-account-operations/manifest.js';
import { OfficialSyntheticPayloadStore } from '../../src/official-account-operations/payload.js';
import { FileSyntheticOfficialProvider } from '../../src/official-account-operations/provider.js';
import { OfficialAccountOperationsService } from '../../src/official-account-operations/service.js';
import type { OfficialRuntime } from '../../src/official-account-operations/service.js';
import { OfficialDraftCoverageMaintainer } from '../../src/official-account-operations/coverage.js';
import { OfficialOperationWorker } from '../../src/official-account-operations/worker.js';
import { hotFeedFixture } from './hot-feed-fixture.js';
export async function officialAccountFixture() {
  const f = await hotFeedFixture(),
    world = await f.world();
  const installed = await attachOfficialFixture(f, world);
  return {
    ...f,
    ...installed,
    world,
    publish: async (text = '官方草稿合成测试') => {
      const post = await world.ready({ text });
      await installed.eligibility(post.id);
      return post;
    },
  };
}
export async function attachOfficialFixture(
  f: Pick<Awaited<ReturnType<typeof hotFeedFixture>>, 'app' | 'pool' | 'close'>,
  world: {
    scope: Awaited<
      ReturnType<Awaited<ReturnType<typeof hotFeedFixture>>['world']>
    >['scope'];
    author: { accountId: string; accessToken: string };
  },
  storage: ImmutableMediaStorage | null = null,
) {
  const directory = await mkdtemp(join(tmpdir(), 'whaleu-official-'));
  const accountRef = randomUUID(),
    programId = randomUUID(),
    servicePrincipal = randomUUID(),
    revision = 'a'.repeat(64),
    fixtureEpoch = randomUUID();
  const { database, source, authority, runtime, service } =
    bindOfficialFixtureRuntime(f.app, directory, fixtureEpoch, storage);
  const regions = [
    world.scope.home.regionId,
    world.scope.related.regionId,
    world.scope.foreign.regionId,
  ];
  await database.transaction(
    async (tx) => {
      await tx.query(
        'INSERT INTO whaleu_official.fixture_epoch(singleton,epoch) VALUES(true,$1)',
        [fixtureEpoch],
      );
      await tx.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',NULL,$2,'synthetic official fixture') ON CONFLICT DO NOTHING",
        [randomUUID(), world.author.accountId],
      );
      await tx.query(
        "INSERT INTO whaleu_official.accounts(id,label,destination_ref,revision,profile) VALUES($1,'合成公众号',$2,$3,'synthetic-official-v1')",
        [accountRef, randomUUID(), revision],
      );
      await tx.query(
        'INSERT INTO whaleu_official.programs(id,account_ref,institution_id,school_space_id,region_ids,lineage_ref,revision) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          programId,
          accountRef,
          world.scope.institutionId,
          world.scope.home.spaceId,
          regions,
          randomUUID(),
          revision,
        ],
      );
      await tx.query(
        "INSERT INTO whaleu_official.configs(program_id,revision,author) VALUES($1,$2,'校园合成测试')",
        [programId, revision],
      );
      for (const action of [
        'manage',
        'preview',
        'test',
        'manual_create',
        'publish',
      ])
        await tx.query(
          "INSERT INTO whaleu_official.capabilities(id,account_ref,program_id,principal_kind,principal_ref,action,revision,region_ids,valid_from,expires_at) VALUES($1,$2,$3,'account',$4,$5,$6,$7,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '6 hours')",
          [
            randomUUID(),
            accountRef,
            programId,
            world.author.accountId,
            action,
            revision,
            regions,
          ],
        );
      await tx.query(
        "INSERT INTO whaleu_official.capabilities(id,account_ref,program_id,principal_kind,principal_ref,action,revision,region_ids,valid_from,expires_at) VALUES($1,$2,$3,'service',$4,'daily_draft',$5,$6,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '6 hours')",
        [
          randomUUID(),
          accountRef,
          programId,
          servicePrincipal,
          revision,
          regions,
        ],
      );
    },
    { isolationLevel: 'read committed' },
  );
  const eligibility = async (
    postId: string,
    decision: 'allow' | 'deny' | 'unknown' = 'allow',
  ) => {
    await f.pool.query(
      "INSERT INTO whaleu_official.export_eligibility(post_id,publication_xid,evidence_id,revision,decision,profile) SELECT id,local_creation_transaction,$2,$3,$4,'synthetic-official-v1' FROM whaleu_community.posts WHERE id=$1 ON CONFLICT(post_id) DO UPDATE SET revision=EXCLUDED.revision,decision=EXCLUDED.decision",
      [postId, randomUUID(), revision, decision],
    );
  };
  const maintain = new OfficialDraftCoverageMaintainer(database, source),
    worker = new OfficialOperationWorker(service);
  const ready = async (maximumCycles = 10000) => {
    let total = 0;
    for (let cycle = 0; cycle < maximumCycles; cycle++) {
      const result = await maintain.runCycle({ programId });
      assert.ok(result.examined <= 128);
      total += result.examined;
      if (result.state === 'ready')
        return { cycles: cycle + 1, examined: total };
      assert.notEqual(result.state, 'unavailable', JSON.stringify(result));
    }
    throw new Error('Coverage failed to converge');
  };
  return {
    ...f,
    database,
    world,
    directory,
    source,
    authority,
    runtime,
    service,
    maintain,
    worker,
    accountRef,
    programId,
    servicePrincipal,
    revision,
    eligibility,
    ready,
    close: async () => {
      await f.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Rebind a coherent restored test database and copied adapter directory. No
 * account, eligibility, effect, root or ready state is seeded here. */
export function bindOfficialFixtureRuntime(
  app: Awaited<ReturnType<typeof hotFeedFixture>>['app'],
  directory: string,
  fixtureEpoch: string,
  storage: ImmutableMediaStorage | null = null,
) {
  const database = app.get(DatabaseService),
    identity = app.get(IdentityService),
    posts = app.get(CommunityRepository),
    access = app.get(CommunityAccessService);
  const source = new CommunityOfficialSource(
    posts,
    access,
    new HotScoreRepository(),
    new HotScoreStorage(),
    new CommunityOfficialPublicProjection(
      posts,
      access,
      app.get(CommunitySerializer),
    ),
  );
  const authority = new OfficialOperationAuthority(
    identity,
    app.get(AuthorizationService),
    app.get(SafetyRepository),
  );
  const media = storage ? new OfficialMediaExport(storage, source) : null;
  const runtime: OfficialRuntime = {
    profile: 'synthetic-official-v1',
    source,
    authority,
    manifests: new OfficialManifestBuilder(source, media),
    payloads: new OfficialSyntheticPayloadStore(Buffer.alloc(32, 7)),
    provider: new FileSyntheticOfficialProvider(directory, fixtureEpoch),
    media,
    fixtureEpoch,
  };
  const service = app.get(OfficialAccountOperationsService);
  // Explicit isolated test DI. Ordinary AppModule remains null; no env activates it.
  Object.defineProperty(service, 'runtime', {
    value: runtime,
    writable: false,
  });
  return { database, source, authority, runtime, service };
}
