import type { SessionTicket } from '../auth/session';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import type { Cancellation } from '../platform/contracts';
import type { UploadDeclaration } from '../media/upload-contracts';
import type {
  RatingCoverGrant,
  RatingCoverUploadObserved,
} from './target-cover-media-contract';
export interface RatingCoverInspected extends UploadDeclaration {
  readonly width: number;
  readonly height: number;
}
export interface RatingCoverUploadHandle {
  readonly handle: string;
}
export interface RatingCoverUploadTransfer {
  readonly pickerState: 'ready' | 'waiting-native' | 'unavailable';
  subscribePicker(listener: () => void): () => void;
  pick(session: MediaSession, cancel: Cancellation): Promise<LocalMediaFile>;
  inspect(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverInspected>;
  preview(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<string>;
  register(
    grant: RatingCoverGrant,
    session: MediaSession,
  ): RatingCoverUploadHandle;
  upload(
    handle: RatingCoverUploadHandle,
    file: LocalMediaFile,
    progress: (percent: number) => void,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverUploadObserved>;
  clearSession(ticket: SessionTicket): void;
  remove(file: LocalMediaFile): Promise<void>;
}
