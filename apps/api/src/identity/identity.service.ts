import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_PROVIDER } from './contracts.js';
import type {
  IdentityProvider,
  SessionCredentials,
  SessionView,
} from './contracts.js';
import { IdentityRepository } from './identity.repository.js';
import { hashToken, mintToken, requireToken } from './tokens.js';

@Injectable()
export class IdentityService {
  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    @Inject(IdentityRepository) private readonly repository: IdentityRepository,
  ) {}
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
  session(token: string): Promise<SessionView> {
    return this.repository.authenticate(
      hashToken(requireToken(token, 'access')),
    );
  }
  logout(token: string): Promise<void> {
    return this.repository.revoke(hashToken(requireToken(token, 'access')));
  }
}
