import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { IdentityService } from '../src/identity/identity.service.js';
import type { IdentityRepository } from '../src/identity/identity.repository.js';
import type {
  IdentityProvider,
  SessionView,
} from '../src/identity/contracts.js';
import { mintToken } from '../src/identity/tokens.js';
import { sessionPolicyContext } from '../src/http/session-policy-context.js';
import { ApplicationError } from '../src/http/application-error.js';

test('Identity session preserves synchronous token-purpose rejection and observes only authenticated async results', async () => {
  const tx = {} as PoolClient;
  const session = { accountId: 'synthetic-session-owner' } as SessionView;
  let authentications = 0,
    observations = 0;
  let authenticationError: Error | undefined,
    observationError: Error | undefined;
  const service = new IdentityService(
    {} as IdentityProvider,
    {
      authenticate: async (_hash: string, client?: PoolClient) => {
        authentications++;
        assert.equal(client, tx);
        if (authenticationError) throw authenticationError;
        return session;
      },
    } as unknown as IdentityRepository,
  );
  await sessionPolicyContext.run(
    {
      observe: async (observed, client) => {
        observations++;
        assert.equal(observed, session);
        assert.equal(client, tx);
        if (observationError) throw observationError;
      },
    },
    async () => {
      assert.throws(
        () => service.session(mintToken('refresh'), tx),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.code === 'AUTHENTICATION_REQUIRED',
      );
      assert.equal(authentications, 0);
      assert.equal(observations, 0);
      assert.equal(await service.session(mintToken('access'), tx), session);
      assert.equal(authentications, 1);
      assert.equal(observations, 1);
      authenticationError = new ApplicationError('ACCESS_TOKEN_EXPIRED');
      await assert.rejects(
        service.session(mintToken('access'), tx),
        (error) => error === authenticationError,
      );
      assert.equal(observations, 1);
      authenticationError = undefined;
      observationError = new ApplicationError('SAFETY_ACCESS_SUSPENDED');
      await assert.rejects(
        service.session(mintToken('access'), tx),
        (error) => error === observationError,
      );
      assert.equal(observations, 2);
    },
  );
});
