import type { SessionTicket } from '../auth/session';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import type { Cancellation } from '../platform/contracts';
import type {
  AvatarDeclaration,
  AvatarGrant,
  AvatarUploadObserved,
} from './avatar-contract';
export interface AvatarInspected extends AvatarDeclaration {
  readonly width: number;
  readonly height: number;
}
export interface AvatarUploadHandle {
  readonly handle: string;
}
export interface AvatarUploadTransfer {
  readonly pickerState: 'ready' | 'waiting-native' | 'unavailable';
  subscribePicker(listener: () => void): () => void;
  pick(session: MediaSession, cancel: Cancellation): Promise<LocalMediaFile>;
  inspect(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarInspected>;
  preview(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<string>;
  register(grant: AvatarGrant, session: MediaSession): AvatarUploadHandle;
  upload(
    handle: AvatarUploadHandle,
    file: LocalMediaFile,
    progress: (percent: number) => void,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarUploadObserved>;
  clearSession(ticket: SessionTicket): void;
  remove(file: LocalMediaFile): Promise<void>;
}
