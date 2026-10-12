import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import type { ProfileAvatarReviewFacade } from '../src/community/content-review/profile-avatar-review.facade.js';
import type { DatabaseService } from '../src/database/database.js';
import {
  checkTransactionDeadlines,
  clearTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import { MediaDeliveryBudgetPool } from '../src/media/delivery-budget.js';
import {
  avatarCommandHash,
  avatarModerationClearDigest,
  avatarModerationClearEnvelopeSchema,
  avatarReviewDigest,
  avatarReviewEnvelopeSchema,
} from '../src/profile/avatar/contracts.js';
import type {
  AvatarModerationClearEnvelope,
  AvatarReviewEnvelope,
} from '../src/profile/avatar/contracts.js';
import { ProfileAvatarDelivery } from '../src/profile/avatar/delivery.js';
import {
  avatarAppearanceId,
  avatarModerationClearAppearanceId,
  ProfileAvatarRepository,
} from '../src/profile/avatar/repository.js';
import type {
  AvatarDefinition,
  ScopedModerationClearAvatarDefinition,
} from '../src/profile/avatar/repository.js';
import { ProfileAvatarService } from '../src/profile/avatar/service.js';
import type { ProfileAvatarRuntime } from '../src/profile/avatar/service.js';
import type { ProfileRepository } from '../src/profile/profile.repository.js';
import { initialProfile } from '../src/profile/profile.repository.js';
import type { ProfileAvatarSafetyFacade } from '../src/safety/profile-avatar.facade.js';
import type { ProfileVisibilityFacade } from '../src/safety/profile-visibility.facade.js';

function systemClear(): ScopedModerationClearAvatarDefinition {
  const actor = randomUUID(),
    moderator = randomUUID(),
    request = randomUUID();
  const envelope: AvatarModerationClearEnvelope = {
    version: 1,
    purpose: 'moderate_profile_avatar_clear',
    accountId: actor,
    moderatorAccountId: moderator,
    clientRequestId: request,
    eventId: randomUUID(),
    target: { kind: 'reply', id: randomUUID() },
    originalRegionId: randomUUID(),
    expectedRevision: 3,
    appearanceId: avatarModerationClearAppearanceId(moderator, request, actor),
    previousAppearanceId: randomUUID(),
    slot: 'avatar',
    source: { kind: 'clear' },
  };
  return {
    authority: 'scoped_moderation_clear',
    id: envelope.appearanceId,
    actor_id: actor,
    source: { kind: 'clear' },
    envelope,
    digest: avatarModerationClearDigest(envelope),
    binding_id: null,
  };
}

test('system-clear has a strict dual-identity envelope and separate hash and appearance domains', () => {
  const definition = systemClear(),
    envelope = definition.envelope;
  assert.deepEqual(
    avatarModerationClearEnvelopeSchema.parse(envelope),
    envelope,
  );
  assert.equal(
    definition.digest,
    createHash('sha256')
      .update(`whaleu-profile-avatar-moderation:v1\n${canonicalJson(envelope)}`)
      .digest('hex'),
  );
  for (const changed of [
    { accountId: randomUUID() },
    { moderatorAccountId: randomUUID() },
    { clientRequestId: randomUUID() },
    { eventId: randomUUID() },
    { target: { ...envelope.target, id: randomUUID() } },
    { target: { ...envelope.target, kind: 'post' } },
    { originalRegionId: randomUUID() },
    { expectedRevision: 4 },
    { appearanceId: randomUUID() },
    { previousAppearanceId: randomUUID() },
  ])
    assert.notEqual(
      avatarModerationClearDigest({ ...envelope, ...changed }),
      definition.digest,
    );
  for (const invalid of [
    { purpose: 'select_profile_avatar' },
    { previousAppearanceId: null },
    { moderatorAccountId: undefined },
    { eventId: undefined },
    { target: { ...envelope.target, accountId: definition.actor_id } },
    { target: { ...envelope.target, kind: 'account' } },
    { source: { kind: 'catalog', itemId: 'default', catalogVersion: 'v1' } },
    { source: { kind: 'clear', approved: true } },
    { reviewId: randomUUID() },
  ])
    assert.equal(
      avatarModerationClearEnvelopeSchema.safeParse({ ...envelope, ...invalid })
        .success,
      false,
    );
  assert.equal(avatarReviewEnvelopeSchema.safeParse(envelope).success, false);
  assert.notEqual(
    definition.id,
    avatarAppearanceId(definition.actor_id, envelope.clientRequestId),
  );
  assert.equal(
    definition.id,
    avatarModerationClearAppearanceId(
      envelope.moderatorAccountId,
      envelope.clientRequestId,
      definition.actor_id,
    ),
  );
  for (const parts of [
    [randomUUID(), envelope.clientRequestId, definition.actor_id],
    [envelope.moderatorAccountId, randomUUID(), definition.actor_id],
    [envelope.moderatorAccountId, envelope.clientRequestId, randomUUID()],
  ] as const)
    assert.notEqual(
      definition.id,
      avatarModerationClearAppearanceId(parts[0]!, parts[1]!, parts[2]!),
    );
});

test('repository decodes only exact event-authorized clear definitions as system authority', async () => {
  const valid = systemClear();
  let row: unknown = valid,
    authorized: unknown = true;
  const calls: string[] = [];
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      return {
        rows: sql.includes('definition_authorized') ? [{ authorized }] : [row],
      };
    },
  } as unknown as PoolClient;
  const repository = new ProfileAvatarRepository();
  assert.deepEqual(await repository.current(valid.actor_id, tx), valid);
  assert.ok(calls.some((sql) => sql.includes('definition_authorized')));
  for (const invalid of [
    { authority: 'unknown' },
    { authority: undefined },
    { authority: 'self_selection' },
    {
      source: {
        kind: 'custom',
        editId: randomUUID(),
        assetId: randomUUID(),
        manifestDigest: 'a'.repeat(64),
      },
    },
    { source: { kind: 'clear', extra: true } },
    { binding_id: randomUUID() },
    { id: randomUUID() },
    { actor_id: randomUUID() },
    { digest: '0'.repeat(64) },
    { envelope: { ...valid.envelope, source: { kind: 'catalog' } } },
    { envelope: { ...valid.envelope, purpose: 'select_profile_avatar' } },
  ]) {
    row = { ...valid, ...invalid };
    await assert.rejects(repository.current(valid.actor_id, tx), {
      code: 'MEDIA_UNAVAILABLE',
    });
  }
  row = valid;
  for (authorized of [false, null, undefined, 1])
    await assert.rejects(repository.current(valid.actor_id, tx), {
      code: 'MEDIA_UNAVAILABLE',
    });
});

/** Unit owner harness: no provider, grants, content rows or synthetic SQL graph.
 * Production event legality is exercised independently by PG integration tests. */
function fixture(enabled: boolean) {
  const initial = systemClear(),
    profileId = randomUUID(),
    calls: string[] = [],
    reviewed: AvatarReviewEnvelope[] = [];
  const state = {
    definition: initial as AvatarDefinition,
    revision: 4,
    profileVersion: 1,
    pointerVersion: 1,
    active: true,
    visible: true,
    authorized: true,
    matchesCurrent: true,
    opened: 0,
    beforeProof: () => {},
  };
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('SELECT d.*')) return { rows: [state.definition] };
      if (sql.includes('definition_authorized'))
        return { rows: [{ authorized: state.authorized }] };
      if (
        sql.startsWith(
          'SELECT EXISTS(SELECT 1 FROM whaleu_profile.avatar_current',
        )
      )
        return { rows: [{ current: state.matchesCurrent }] };
      if (sql.startsWith('SELECT revision,public_id'))
        return { rows: [{ revision: state.revision, profileId }] };
      if (sql.includes('FROM whaleu_profile.profiles p'))
        return {
          rows: [
            {
              row: { revision: state.revision, public_id: profileId },
              version: String(state.profileVersion),
            },
          ],
        };
      if (sql.includes('FROM whaleu_profile.avatar_current p'))
        return {
          rows: [
            {
              row: { appearance_id: state.definition.id },
              version: String(state.pointerVersion),
              definition: state.definition,
              definition_version: '1',
            },
          ],
        };
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '10s',
              lock_timeout: '1s',
            },
          ],
        };
      if (sql.includes('pg_try_advisory_xact_lock_shared'))
        return { rows: [{ locked: true }] };
      if (sql.includes('clock_timestamp()'))
        return { rows: [{ now: new Date() }] };
      if (
        sql.includes('pg_advisory_xact_lock') ||
        sql.includes('set_config') ||
        sql === 'SET CONSTRAINTS ALL IMMEDIATE'
      )
        return { rows: [] };
      throw new Error(`Unexpected SQL in unit fixture: ${sql}`);
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(run: (tx: PoolClient) => Promise<T>): Promise<T> => {
      startTransactionDeadlines(tx);
      try {
        const value = await run(tx);
        state.beforeProof();
        await checkTransactionDeadlines(tx);
        return value;
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as DatabaseService;
  const runtime = enabled
    ? ({
        planning: {
          writerInstanceId: randomUUID(),
          plan: () => {
            throw new Error('Unit read never plans an upload');
          },
          scratch: () => {
            throw new Error('Unit read never allocates scratch');
          },
          requireStopped: () => {
            throw new Error('Unit read never proves upload retirement');
          },
        },
        ingressStorage: {},
        catalog: null,
        storage: {
          openExact: async () => {
            state.opened++;
            throw new Error('No bytes are authorized');
          },
        },
      } as unknown as ProfileAvatarRuntime)
    : null;
  const owner = new ProfileAvatarService(
    database,
    {
      session: async () => ({
        accountId: initial.actor_id,
        sessionId: randomUUID(),
      }),
      activeAccount: async () => state.active,
    } as unknown as IdentityService,
    {
      avatarPublicTarget: async (id: string) =>
        id === profileId ? { accountId: initial.actor_id } : null,
    } as unknown as ProfileRepository,
    {
      read: async () => ({
        status: state.visible ? 'available' : 'unavailable',
      }),
    } as unknown as ProfileVisibilityFacade,
    { requireAllowed: async () => {} } as unknown as ProfileAvatarSafetyFacade,
    runtime,
    {
      current: async (envelope: AvatarReviewEnvelope) => {
        reviewed.push(envelope);
        return 'review-revision';
      },
    } as unknown as ProfileAvatarReviewFacade,
  );
  return { owner, state, initial, profileId, calls, reviewed };
}

test('own and public system-clear are none before runtime with immutable-event proof and no self Review', async () => {
  for (const enabled of [false, true]) {
    const { owner, state, initial, profileId, calls, reviewed } =
      fixture(enabled);
    const expected = {
      protocol: 'profile-media-v1',
      profileId,
      revision: 4,
      avatar: { state: 'none' },
    };
    assert.deepEqual(await owner.ownCurrent('session'), expected);
    assert.deepEqual(await owner.publicCurrent(null, profileId), expected);
    assert.deepEqual(await owner.publicCurrent('session', profileId), expected);
    assert.equal(reviewed.length, 0);
    assert.equal(state.opened, 0);
    assert.ok(calls.some((sql) => sql.includes('definition_authorized')));
    assert.ok(
      calls.some((sql) => sql.includes('pg_try_advisory_xact_lock_shared')),
    );
    assert.ok(calls.some((sql) => sql.includes('definition_version')));
    state.authorized = false;
    await assert.rejects(owner.ownCurrent('session'), {
      code: 'MEDIA_UNAVAILABLE',
    });
    assert.equal(state.definition.id, initial.id);
  }
});

test('system-clear retains subject visibility and final Profile/pointer proof failures', async () => {
  for (const field of ['profileVersion', 'pointerVersion'] as const) {
    const { owner, state } = fixture(false);
    state.beforeProof = () => {
      state[field]++;
    };
    await assert.rejects(owner.ownCurrent('session'), {
      code: 'MEDIA_UNAVAILABLE',
    });
  }
  for (const field of ['active', 'visible'] as const) {
    const { owner, state, profileId } = fixture(false);
    state[field] = false;
    await assert.rejects(owner.publicCurrent(null, profileId), {
      code: 'MEDIA_UNAVAILABLE',
    });
  }
  const { owner, state } = fixture(false);
  state.matchesCurrent = false;
  await assert.rejects(owner.ownCurrent('session'), {
    code: 'MEDIA_UNAVAILABLE',
  });
});

test('system-clear never authorizes custom or catalog bytes or reaches self Review', async () => {
  for (const enabled of [false, true]) {
    const { owner, state, profileId, reviewed } = fixture(enabled);
    const request = {
      profileId,
      appearanceId: state.definition.id,
      purpose: 'download' as const,
      requestId: randomUUID(),
    };
    await assert.rejects(
      owner.database.transaction(
        (tx) => owner.authorizeCurrent(null, request, tx),
        { isolationLevel: 'read committed' },
      ),
      { code: 'MEDIA_UNAVAILABLE' },
    );
    const delivery = new ProfileAvatarDelivery(
      owner,
      new MediaDeliveryBudgetPool(),
    );
    for (const token of [null, 'session'])
      for (const variant of ['thumb-v1', 'display-v1'] as const)
        await assert.rejects(
          delivery.open(
            token,
            profileId,
            state.definition.id,
            variant,
            new Socket(),
          ),
          { code: 'MEDIA_UNAVAILABLE' },
        );
    assert.equal(reviewed.length, 0);
    assert.equal(state.opened, 0);
  }
});

test('historical self-clear still requires runtime and exact self Review with unchanged envelope/hash', async () => {
  for (const enabled of [false, true]) {
    const { owner, state, profileId, calls, reviewed } = fixture(enabled);
    const envelope: AvatarReviewEnvelope = {
      version: 1,
      purpose: 'select_profile_avatar',
      accountId: state.definition.actor_id,
      clientRequestId: randomUUID(),
      expectedRevision: 3,
      appearanceId: state.definition.id,
      previousAppearanceId: null,
      slot: 'avatar',
      source: { kind: 'clear' },
    };
    state.definition = {
      ...state.definition,
      authority: 'self_selection',
      envelope,
      digest: avatarReviewDigest(envelope),
    };
    assert.equal(
      avatarModerationClearEnvelopeSchema.safeParse(envelope).success,
      false,
    );
    assert.equal(
      state.definition.digest,
      createHash('sha256')
        .update(`whaleu-profile-avatar-review:v1\n${canonicalJson(envelope)}`)
        .digest('hex'),
    );
    assert.deepEqual(await owner.ownCurrent('session'), {
      protocol: 'profile-media-v1',
      profileId,
      revision: 4,
      avatar: { state: enabled ? 'none' : 'unavailable' },
    });
    assert.deepEqual(reviewed, enabled ? [envelope] : []);
    assert.equal(
      calls.some((sql) => sql.includes('definition_authorized')),
      false,
    );
  }
});

test('normal self-selection after system-clear uses new shared revision and previous appearance through exact Review', async () => {
  const { owner, state, initial } = fixture(true);
  const accepted: AvatarReviewEnvelope[] = [];
  owner.repository.receipt = async () => null;
  owner.repository.cancellation = async () => null;
  owner.repository.reserveCommand = async () => {};
  owner.profiles.updateInTransaction = async (
    _actor,
    expectedRevision,
    patch,
    tx,
  ) => {
    assert.equal(expectedRevision, 4);
    await patch(
      { ...initialProfile(initial.actor_id), revision: state.revision },
      tx,
    );
    state.revision++;
    return { revision: state.revision } as Awaited<
      ReturnType<ProfileRepository['updateInTransaction']>
    >;
  };
  owner.assets.prepareProfileReplacement = async (actor, old, asset) => {
    assert.equal(actor, initial.actor_id);
    assert.equal(old, null);
    assert.equal(asset, null);
    return {} as Awaited<
      ReturnType<typeof owner.assets.prepareProfileReplacement>
    >;
  };
  owner.assets.finishProfileReplacement = async () => {};
  owner.reviews.accepted = async (envelope) => {
    accepted.push(envelope);
    return {} as Awaited<ReturnType<typeof owner.reviews.accepted>>;
  };
  owner.reviews.bind = async () => {};
  owner.repository.replace = async (definition) => {
    state.definition = definition;
  };
  owner.repository.commitReceipt = async (
    actor,
    command,
    _appearance,
    revision,
  ) => ({
    protocol: 'profile-media-v1',
    clientRequestId: command.clientRequestId,
    requestHash: avatarCommandHash(actor, command),
    resultingRevision: revision,
    operation: 'select_avatar',
  });
  const command = {
    protocol: 'profile-media-v1',
    clientRequestId: randomUUID(),
    expectedRevision: 4,
    source: { kind: 'clear' },
  };
  const result = await owner.command('session', command);
  assert.equal(result.resultingRevision, 5);
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0], {
    version: 1,
    purpose: 'select_profile_avatar',
    accountId: initial.actor_id,
    clientRequestId: command.clientRequestId,
    expectedRevision: 4,
    appearanceId: avatarAppearanceId(initial.actor_id, command.clientRequestId),
    previousAppearanceId: initial.id,
    slot: 'avatar',
    source: { kind: 'clear' },
  });
  assert.equal(state.definition.authority, 'self_selection');
  assert.equal(state.definition.digest, avatarReviewDigest(accepted[0]));
});
