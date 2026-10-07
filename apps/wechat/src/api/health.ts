import type { Endpoint } from './client';
import { ClientError, isRecord } from './errors';

export interface Health {
  readonly status: 'ok';
}
function decodeHealth(value: unknown): Health {
  if (!isRecord(value) || value.status !== 'ok')
    throw new ClientError('protocol', 'The health response is invalid');
  return { status: 'ok' };
}

/** These are the only implemented backend routes; no auth or business route is invented here. */
export const healthLive: Endpoint<Health> = {
  path: '/health/live',
  method: 'GET',
  authentication: 'none',
  authReplay: 'never',
  decode: decodeHealth,
};
export const healthReady: Endpoint<Health> = {
  ...healthLive,
  path: '/health/ready',
};
