import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseService } from '../../src/database/database.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import {
  canonicalCallbackBody,
  syntheticCallbackSignature,
} from '../../src/official-account-operations/callback-auth.js';
import {
  OfficialCallbackBoundary,
  OfficialCallbackProjectionWorker,
  createSyntheticCallbackRuntimeForTest,
  registerSyntheticCallbackFixture,
} from '../../src/official-account-operations/callback-ledger.js';
import {
  OfficialCallbackMappingOwner,
  createSyntheticIdentityProofIssuerForTest,
  syntheticOfficialAssertionHash,
  SyntheticOfficialNotificationDestinationPort,
  SyntheticOfficialNotificationConsumer,
} from '../../src/official-account-operations/callback-mapping.js';
import type {
  SyntheticOfficialIdentityProof,
  SyntheticIdentityResolutionRequest,
  OfficialNotificationDestinationCapability,
} from '../../src/official-account-operations/callback-mapping.js';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
test(
  'trusted mini mapping and final synthetic notification consumer boundary',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    try {
      const db = f.app.get(DatabaseService),
        runtime = createSyntheticCallbackRuntimeForTest(),
        boundary = new OfficialCallbackBoundary(db, runtime),
        worker = new OfficialCallbackProjectionWorker(db, runtime);
      const port = new SyntheticOfficialNotificationDestinationPort(runtime),
        consumer = new SyntheticOfficialNotificationConsumer(db, port);
      async function fixture() {
        const now = Date.now(),
          registry = {
            accountRef: randomUUID(),
            registrationId: randomUUID(),
            miniAppRef: randomUUID(),
            unionNamespace: randomUUID(),
            revision: 'b'.repeat(64),
            epochs: [
              {
                epoch: 1 as const,
                validFrom: now - 10000,
                expiresAt: now + 300000,
              },
            ],
          };
        await registerSyntheticCallbackFixture(db, runtime, registry);
        const officialSubject = `synthetic:official:${randomUUID()}`,
          miniSubject = `synthetic:mini:${randomUUID()}`,
          unionSubject = `synthetic:union:${randomUUID()}`,
          assertionRef = randomUUID();
        // Actual Identity owner accepts the mini binding via its ordinary synthetic provider login.
        const identity = new IdentityService(
          {
            exchange: async () => ({
              provider: 'wechat',
              appId: registry.miniAppRef,
              subject: miniSubject,
              unionSubject,
            }),
          },
          new IdentityRepository(db),
        );
        const local = (await identity.login('synthetic-mini-binding'))
          .accountId;
        await f.pool.query(
          `INSERT INTO whaleu_official_callbacks.mini_assertions(assertion_ref,mini_app_ref,mini_subject,local_account_ref,union_namespace,union_subject,identity_binding_version) SELECT $1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::text,xmin::text FROM whaleu_identity.provider_identities WHERE provider='wechat' AND app_id=$2::text AND subject=$3 AND account_id=$4`,
          [
            assertionRef,
            registry.miniAppRef,
            miniSubject,
            local,
            registry.unionNamespace,
            unionSubject,
          ],
        );
        const notify = {
          localAccountRef: local,
          notificationAccountRef: registry.accountRef,
          purpose: 'synthetic-notification-v1' as const,
        };
        const callback = async (
          kind: 'subscribe' | 'unsubscribe',
          sequence: number,
          subject = officialSubject,
        ) => {
          const event = {
              profile: 'synthetic-official-v1' as const,
              accountRef: registry.accountRef,
              keyEpoch: 1,
              eventId: randomUUID(),
              officialSubject: subject,
              kind,
              sequence,
              occurredAt: Date.now() - 100,
              issuedAt: Date.now(),
            },
            rawBody = canonicalCallbackBody(event);
          assert.equal(
            (
              await boundary.receive(registry.registrationId, {
                rawBody,
                contentType: 'application/json',
                signature: syntheticCallbackSignature(
                  'POST',
                  registry.registrationId,
                  rawBody,
                  1,
                ),
              })
            ).status,
            200,
          );
        };
        const proof = (
          request: SyntheticIdentityResolutionRequest,
        ): SyntheticOfficialIdentityProof => ({
          issuer: 'synthetic-identity-v1',
          proofId: randomUUID(),
          accountRef: registry.accountRef,
          officialSubject: request.officialSubject,
          unionNamespace: registry.unionNamespace,
          unionSubject,
          miniAppRef: registry.miniAppRef,
          miniSubject,
          localAccountRef: local,
          officialAssertionHash: syntheticOfficialAssertionHash(request),
          miniIdentityAssertionRef: assertionRef,
          registryRevision: registry.revision,
          issuedAt: Date.now() - 1000,
          expiresAt: Date.now() + 60000,
        });
        const owner = (
          resolve: (
            r: SyntheticIdentityResolutionRequest,
          ) => Promise<SyntheticOfficialIdentityProof | 'unknown'> = async (
            r,
          ) => proof(r),
        ) =>
          new OfficialCallbackMappingOwner(
            db,
            runtime,
            createSyntheticIdentityProofIssuerForTest(runtime, resolve),
          );
        await callback('subscribe', 1);
        await worker.runOnce();
        return {
          registry,
          officialSubject,
          miniSubject,
          unionSubject,
          local,
          assertionRef,
          notify,
          callback,
          proof,
          owner,
        };
      }
      await t.test(
        'follow alone never links; exact trusted proof plus actual mini binding yields synthetic-only acceptance',
        async () => {
          const x = await fixture();
          assert.equal(await consumer.send(x.notify), false);
          assert.equal(
            await x.owner().resolve(x.registry.accountRef, x.officialSubject),
            'accepted',
          );
          assert.equal(await consumer.send(x.notify), true);
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_official_callbacks.synthetic_acceptances WHERE account_ref=$1',
                [x.registry.accountRef],
              )
            ).rows[0]!.n,
            1,
          );
          assert.equal(
            await consumer.send({
              ...x.notify,
              notificationAccountRef: randomUUID(),
            }),
            false,
          );
          assert.equal(
            await new SyntheticOfficialNotificationConsumer(
              db,
              new SyntheticOfficialNotificationDestinationPort(),
            ).send(x.notify),
            false,
          );
        },
      );
      await t.test(
        'consumer paused in preparation sees committed unsubscribe, even before projection worker',
        async () => {
          const x = await fixture();
          assert.equal(
            await x.owner().resolve(x.registry.accountRef, x.officialSubject),
            'accepted',
          );
          const entered = gate(),
            resume = gate(),
            pending = consumer.send(x.notify, async () => {
              entered.release();
              await resume.wait;
            });
          await entered.wait;
          await x.callback('unsubscribe', 2);
          resume.release();
          assert.equal(await pending, false);
          await worker.runOnce();
          assert.equal(await consumer.send(x.notify), false);
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_official_callbacks.synthetic_acceptances WHERE account_ref=$1',
                [x.registry.accountRef],
              )
            ).rows[0]!.n,
            0,
          );
        },
      );
      await t.test(
        'unsubscribe then subscribe while resolver awaits discards old generation',
        async () => {
          const x = await fixture(),
            entered = gate(),
            resume = gate();
          const owner = x.owner(async (r) => {
            const proof = x.proof(r);
            entered.release();
            await resume.wait;
            return proof;
          });
          const result = owner.resolve(
            x.registry.accountRef,
            x.officialSubject,
          );
          await entered.wait;
          await x.callback('unsubscribe', 2);
          await worker.runOnce();
          await x.callback('subscribe', 3);
          await worker.runOnce();
          resume.release();
          assert.equal(await result, 'unknown');
          assert.equal(await consumer.send(x.notify), false);
        },
      );
      await t.test(
        'mapping revocation and account deletion discard pending proof completion',
        async () => {
          for (const kind of ['revoke', 'delete'] as const) {
            const x = await fixture(),
              entered = gate(),
              resume = gate(),
              owner = x.owner(async (r) => {
                entered.release();
                await resume.wait;
                return x.proof(r);
              });
            const pending = owner.resolve(
              x.registry.accountRef,
              x.officialSubject,
            );
            await entered.wait;
            if (kind === 'revoke')
              await owner.revoke(x.registry.accountRef, x.officialSubject);
            else await owner.deleteAccount(x.registry.accountRef);
            resume.release();
            assert.equal(await pending, 'unknown');
            assert.equal(await consumer.send(x.notify), false);
          }
        },
      );
      await t.test(
        'wrong namespace/app/account/mini assertion/union and untrusted structural proofs stay unavailable',
        async () => {
          const x = await fixture();
          for (const override of [
            { unionNamespace: randomUUID() },
            { miniAppRef: randomUUID() },
            { accountRef: randomUUID() },
            { miniIdentityAssertionRef: randomUUID() },
            { unionSubject: `synthetic:union:${randomUUID()}` },
            { localAccountRef: randomUUID() },
            { expiresAt: Date.now() - 1 },
            { officialAssertionHash: '0'.repeat(64) },
          ]) {
            assert.equal(
              await x
                .owner(async (r) => ({ ...x.proof(r), ...override }))
                .resolve(x.registry.accountRef, x.officialSubject),
              'unknown',
            );
          }
          const untrusted = new OfficialCallbackMappingOwner(db, runtime, {
            resolve: async (r) => x.proof(r),
          });
          assert.equal(
            await untrusted.resolve(x.registry.accountRef, x.officialSubject),
            'unknown',
          );
          assert.equal(await consumer.send(x.notify), false);
        },
      );
      await t.test(
        'one mini identity mapping to two official subjects quarantines both',
        async () => {
          const x = await fixture(),
            other = `synthetic:official:${randomUUID()}`;
          assert.equal(
            await x.owner().resolve(x.registry.accountRef, x.officialSubject),
            'accepted',
          );
          await x.callback('subscribe', 1, other);
          await worker.runOnce();
          assert.equal(
            await x.owner().resolve(x.registry.accountRef, other),
            'quarantined',
          );
          assert.equal(await consumer.send(x.notify), false);
          const rows = await f.pool.query(
            'SELECT mapping_state FROM whaleu_official_callbacks.follow WHERE account_ref=$1',
            [x.registry.accountRef],
          );
          assert.equal(rows.rows.length, 2);
          assert.ok(rows.rows.every((r) => r.mapping_state === 'quarantined'));
        },
      );
      await t.test(
        'actual mini identity withdrawal and assertion revocation veto previously accepted mapping',
        async () => {
          for (const change of ['mini', 'assertion'] as const) {
            const x = await fixture();
            assert.equal(
              await x.owner().resolve(x.registry.accountRef, x.officialSubject),
              'accepted',
            );
            if (change === 'mini')
              await f.pool.query(
                'DELETE FROM whaleu_identity.provider_identities WHERE account_id=$1',
                [x.local],
              );
            else
              await f.pool.query(
                'UPDATE whaleu_official_callbacks.mini_assertions SET revoked=true WHERE assertion_ref=$1',
                [x.assertionRef],
              );
            assert.equal(await consumer.send(x.notify), false);
          }
        },
      );
      await t.test(
        'transaction-bound destination cannot be serialized, reused or transferred to a later transaction',
        async () => {
          const x = await fixture();
          assert.equal(
            await x.owner().resolve(x.registry.accountRef, x.officialSubject),
            'accepted',
          );
          let saved: OfficialNotificationDestinationCapability | null = null;
          await db.transaction(async (tx) => {
            saved = await port.current(x.notify, tx);
            assert.ok(saved);
            assert.deepEqual(JSON.parse(JSON.stringify(saved)), {});
          });
          const replay = new SyntheticOfficialNotificationConsumer(db, {
            current: async () => saved,
          });
          assert.equal(await replay.send(x.notify), false);
        },
      );
    } finally {
      await f.close();
    }
  },
);
