import type { SessionTicket } from '../auth/session';
import type { Cancellation } from '../platform/contracts';

/** Preparatory single-image protocol. No SDK, provider credentials or URL are UI state. */
export interface LocalMediaFile {
  readonly localId: string;
}
export interface MediaDeclaration {
  readonly bytes: number;
  readonly mime: 'image/jpeg' | 'image/png';
  readonly width: number;
  readonly height: number;
  readonly frames: 1;
}
export interface MediaTarget {
  readonly draftId: string;
  readonly spaceId: string;
}
export interface MediaPrepare {
  readonly clientRequestId: string;
  readonly purpose: 'community-post-image';
  readonly draftId: string;
  readonly spaceId: string;
  readonly slot: 'images';
  readonly ordinal: 0;
  readonly declaration: Readonly<Pick<MediaDeclaration, 'mime' | 'bytes'>>;
}
export type MediaIntentStatus =
  | {
      readonly intentId: string;
      readonly expiresAt: number;
      readonly status: 'prepared' | 'uploading' | 'processing';
    }
  | {
      readonly intentId: string;
      readonly expiresAt: number;
      readonly status: 'ready';
      readonly assetId: string;
    }
  | {
      readonly intentId: string;
      readonly expiresAt: number;
      readonly status: 'rejected' | 'expired' | 'cancelled' | 'unavailable';
    };

/** Handle resolved only inside a transfer adapter; never a caller-supplied remote URL. */
export interface MediaUploadPlan {
  readonly intentId: string;
  readonly generation: number;
  readonly expiresAt: number;
  readonly handle: string;
}
export type MediaVariant = 'thumb-v1' | 'display-v1';
export interface MediaAttachment {
  readonly version: 1;
  readonly kind: 'authenticated-media';
  readonly assetId: string;
  readonly bindingId: string;
  readonly variants: readonly ['thumb-v1', 'display-v1'];
  readonly width: number;
  readonly height: number;
}
/** Adapters must call current() immediately before authenticated requests and preview side effects.
 * It checks epoch + account and returns the latest token revision. Never persist this context. */
export interface MediaSession {
  current(): SessionTicket;
}
export interface MediaGateway {
  prepare(
    input: MediaPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MediaIntentStatus>;
  status(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MediaIntentStatus>;
  grant(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MediaUploadPlan>;
  finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MediaIntentStatus>;
  cancel(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<void>;
}
export interface MediaTransfer {
  pick(session: MediaSession, cancel: Cancellation): Promise<LocalMediaFile>;
  inspectLocal(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MediaDeclaration>;
  optionalCompress?(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<LocalMediaFile>;
  upload(
    plan: MediaUploadPlan,
    file: LocalMediaFile,
    progress: (percent: number) => void,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<void>;
  downloadAuthenticated(
    attachment: MediaAttachment,
    variant: MediaVariant,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<LocalMediaFile>;
  previewTemporary(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<void>;
  removeTemporary(file: LocalMediaFile): Promise<void>;
  /** Synchronously drop this ticket's grants, SDK credentials and preview list; never another epoch's. */
  clearSession(ticket: SessionTicket): void;
}
