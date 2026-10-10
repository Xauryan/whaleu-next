import { ClientError } from '../api/errors';
import type { MediaGateway } from './contracts';

/** Default-closed foundation. Not registered into the normal runtime or a test provider. */
export const unavailableMediaGateway: MediaGateway = Object.freeze({
  prepare: unavailable,
  status: unavailable,
  grant: unavailable,
  finalize: unavailable,
  cancel: unavailable,
});
async function unavailable(): Promise<never> {
  throw new ClientError('configuration', 'Media transfer is unavailable');
}
