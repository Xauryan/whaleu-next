import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { retainRequestSchema } from './request-qualification.js';
import type { ReauthenticationScope } from './reauthentication.js';

/** Explicit unavailable production owner, not a caller-controlled readiness port.
 * No production owner is implemented by0182: native shape alone is insufficient.
 * A successor MUST replace this with a fixed implementation that qualifies and
 * produces real owner/cutover facts; neither configuration nor a changed trigger
 * body is permission. Tests may install a separately labelled local owner, but
 * no test adapter is imported by this module or recognized as production. */
@Injectable()
export class RealRequestAdmission {
  async inspect(tx: PoolClient): Promise<void> {
    await retainRequestSchema(tx);
    throw new ApplicationError('REAL_DELETION_UNAVAILABLE');
  }
  async admit(tx: PoolClient, _scope: ReauthenticationScope): Promise<void> {
    await this.inspect(tx);
    throw new ApplicationError('REAL_DELETION_UNAVAILABLE');
  }
}
