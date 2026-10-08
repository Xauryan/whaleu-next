import type { PoolClient } from 'pg';
import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_PROVIDER } from './contracts.js';
import type {
  IdentityProvider,
  SessionCredentials,
  SessionView,
} from './contracts.js';
import type {
  TitleMaintenanceCursor,
  TitleMaintenanceSweep,
} from './title-maintenance.contract.js';
import { IdentityRepository } from './identity.repository.js';
import { hashToken, mintToken, requireToken } from './tokens.js';

@Injectable()
export class IdentityService {
  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    @Inject(IdentityRepository) private readonly repository: IdentityRepository,
  ) {}
  activeAccount(accountId: string, tx: PoolClient): Promise<boolean> {
    return this.repository.activeAccount(accountId, tx);
  }
  beginTitleMaintenanceSweep(tx: PoolClient): Promise<TitleMaintenanceSweep> {
    return this.repository.beginTitleMaintenanceSweep(tx);
  }
  titleMaintenanceCandidateWindow(
    cursor: TitleMaintenanceCursor,
    tx: PoolClient,
  ): Promise<readonly string[]> {
    return this.repository.titleMaintenanceCandidateWindow(cursor, tx);
  }
  lockTitleMaintenanceAccount(
    accountId: string,
    tx: PoolClient,
  ): Promise<boolean> {
    return this.repository.lockTitleMaintenanceAccount(accountId, tx);
  }
  canonicalWechatTitleEligibility(
    accountId: string,
    tx: PoolClient,
  ): Promise<boolean> {
    return this.repository.canonicalWechatTitleEligibility(accountId, tx);
  }
  async login(code: string): Promise<SessionCredentials> {
    const identity = await this.provider.exchange(code);
    const accessToken = mintToken('access');
    const refreshToken = mintToken('refresh');
    const session = await this.repository.createSession(identity, {
      access: hashToken(accessToken),
      refresh: hashToken(refreshToken),
    });
    return { ...session, accessToken, refreshToken };
  }
  async refresh(token: string): Promise<SessionCredentials> {
    requireToken(token, 'refresh');
    const accessToken = mintToken('access');
    const refreshToken = mintToken('refresh');
    const session = await this.repository.rotate(hashToken(token), {
      access: hashToken(accessToken),
      refresh: hashToken(refreshToken),
    });
    return { ...session, accessToken, refreshToken };
  }
  session(token: string, transaction?: PoolClient): Promise<SessionView> {
    return this.repository.authenticate(
      hashToken(requireToken(token, 'access')),
      transaction,
    );
  }
  logout(token: string): Promise<void> {
    return this.repository.revoke(hashToken(requireToken(token, 'access')));
  }
}
