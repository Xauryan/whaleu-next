import type { SessionTicket } from '../auth/session';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import type { Cancellation } from '../platform/contracts';
import type {
  CoverDeclaration,
  CoverGrant,
  CoverUploadObserved,
} from './cover-contract';
export interface CoverInspected extends CoverDeclaration {
  readonly width: number;
  readonly height: number;
}
export interface CoverUploadHandle {
  readonly handle: string;
}
export interface CoverUploadTransfer {
  readonly pickerState: 'ready' | 'waiting-native' | 'unavailable';
  subscribePicker(listener: () => void): () => void;
  pick(session: MediaSession, cancel: Cancellation): Promise<LocalMediaFile>;
  inspect(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverInspected>;
  preview(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<string>;
  register(grant: CoverGrant, session: MediaSession): CoverUploadHandle;
  upload(
    handle: CoverUploadHandle,
    file: LocalMediaFile,
    progress: (percent: number) => void,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverUploadObserved>;
  clearSession(ticket: SessionTicket): void;
  remove(file: LocalMediaFile): Promise<void>;
}
