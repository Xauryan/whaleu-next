import type { Endpoint } from './client';
import { decodeSessionInfo, type SessionInfo } from '../auth/session-contract';

/** Read-only, authenticated before execution, and safe for one auth-expiry replay. */
export const currentSession: Endpoint<SessionInfo> = {
  path: '/v1/auth/session',
  method: 'GET',
  authentication: 'required',
  authReplay: 'once',
  decode: decodeSessionInfo,
};
