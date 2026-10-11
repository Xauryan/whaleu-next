import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodePostingPolicyCommand,
  decodePostingPolicyReceipt,
  postingPolicyCommandHash,
  postingPolicyUuid,
  invalidPostingPolicy,
} from './contract';
import type { PostingPolicyCommand, PostingPolicyReceipt } from './contract';
export interface PendingPostingPolicyCommand {
  readonly version: 1;
  readonly actorId: string;
  readonly regionId: string;
  readonly command: PostingPolicyCommand;
  readonly requestHash: string;
}
/** One immutable unresolved operation per actor/API origin. Never a write queue. */
export class PostingPolicyJournal {
  private readonly origin: string;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.origin = normalizeOrigin(origin);
  }
  private key(actorId: string) {
    return `whaleu.school-posting-policy.v1:${this.origin}:${postingPolicyUuid(actorId)}`;
  }
  read(actorId: string): PendingPostingPolicyCommand | null {
    try {
      const raw = this.storage.get(this.key(actorId));
      if (raw === null || raw === undefined || raw === '') return null;
      exact(raw, ['version', 'actorId', 'regionId', 'command', 'requestHash']);
      if (raw.version !== 1 || raw.actorId !== actorId) invalidPostingPolicy();
      const regionId = postingPolicyUuid(raw.regionId),
        command = decodePostingPolicyCommand(raw.command),
        requestHash = postingPolicyCommandHash(actorId, regionId, command);
      if (raw.requestHash !== requestHash) invalidPostingPolicy();
      return Object.freeze({
        version: 1,
        actorId,
        regionId,
        command,
        requestHash,
      });
    } catch {
      throw new ClientError(
        'storage',
        'Pending posting policy cannot be recovered safely',
      );
    }
  }
  write(
    actorId: string,
    regionId: string,
    command: PostingPolicyCommand,
  ): PendingPostingPolicyCommand {
    const checked = decodePostingPolicyCommand(command),
      requestHash = postingPolicyCommandHash(actorId, regionId, checked),
      previous = this.read(actorId);
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new ClientError(
          'storage',
          'Resolve the existing posting policy request first',
        );
      return previous;
    }
    const next: PendingPostingPolicyCommand = Object.freeze({
      version: 1,
      actorId,
      regionId,
      command: checked,
      requestHash,
    });
    try {
      this.storage.set(this.key(actorId), next);
      const saved = this.read(actorId);
      if (saved?.requestHash !== requestHash)
        throw new Error('Storage mismatch');
      return saved;
    } catch {
      throw new ClientError(
        'storage',
        'Posting policy request was not durably stored',
      );
    }
  }
  settle(pending: PendingPostingPolicyCommand, raw: PostingPolicyReceipt) {
    const receipt = decodePostingPolicyReceipt(raw);
    if (
      receipt.requestHash !== pending.requestHash ||
      receipt.requestId !== pending.command.clientRequestId ||
      receipt.regionId !== pending.regionId ||
      receipt.revision !== pending.command.expectedRevision + 1
    )
      invalidPostingPolicy();
    this.remove(pending);
  }
  cancel(
    pending: PendingPostingPolicyCommand,
    requestId: string,
    requestHash: string,
  ) {
    if (
      requestId !== pending.command.clientRequestId ||
      requestHash !== pending.requestHash
    )
      invalidPostingPolicy();
    this.remove(pending);
  }
  private remove(pending: PendingPostingPolicyCommand) {
    if (this.read(pending.actorId)?.requestHash !== pending.requestHash)
      throw new ClientError(
        'storage',
        'Pending posting policy request changed',
      );
    try {
      this.storage.remove(this.key(pending.actorId));
      if (this.read(pending.actorId) !== null)
        throw new Error('Storage mismatch');
    } catch {
      throw new ClientError(
        'storage',
        'Posting policy request is retained for recovery',
      );
    }
  }
}
