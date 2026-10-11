import type { Storage } from '../../platform/contracts';
import { ClientError } from '../../api/errors';
import { exact } from '../../community/contract';
import {
  activityId,
  activityCommandHash,
  decodeActivityCommand,
} from './contract';
import type { ActivityCommand, ActivityReceipt } from './contract';
export interface PendingActivityCommand {
  version: 1;
  actorId: string;
  activityId: string;
  requestHash: string;
  command: ActivityCommand;
}
/** Per-account/environment, original frozen command only. No replay queue. */
export class ActivityPublicationJournal {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(actor: string) {
    return `whaleu.activity-publication.v1:${this.namespace}:${activityId(actor)}`;
  }
  draftId(actor: string): string | null {
    const raw = this.storage.get(this.key(actor) + ':draft');
    if (raw === null || raw === undefined || raw === '') return null;
    try {
      return activityId(raw);
    } catch {
      throw new ClientError('storage', '已保存草稿入口不可用，请保留原记录');
    }
  }
  rememberDraft(actor: string, id: string | null) {
    const key = this.key(actor) + ':draft';
    if (id === null) this.storage.remove(key);
    else this.storage.set(key, activityId(id));
    if (this.draftId(actor) !== id)
      throw new ClientError('storage', '草稿入口保存未确认');
  }
  read(actor: string): PendingActivityCommand | null {
    try {
      const raw = this.storage.get(this.key(actor));
      if (raw === undefined || raw === null || raw === '') return null;
      exact(raw, [
        'version',
        'actorId',
        'activityId',
        'requestHash',
        'command',
      ]);
      if (raw.version !== 1 || raw.actorId !== actor) throw Error();
      const id = activityId(raw.activityId),
        command = decodeActivityCommand(raw.command),
        hash = activityCommandHash(actor, id, command);
      if (raw.requestHash !== hash) throw Error();
      return {
        version: 1,
        actorId: actor,
        activityId: id,
        requestHash: hash,
        command,
      };
    } catch {
      throw new ClientError('storage', '原活动操作记录不可用，请保留原记录');
    }
  }
  write(actor: string, id: string, input: ActivityCommand) {
    const command = decodeActivityCommand(input),
      requestHash = activityCommandHash(actor, id, command),
      prior = this.read(actor);
    if (prior && prior.requestHash !== requestHash)
      throw new ClientError('storage', '请先恢复或取消原活动操作');
    const p: PendingActivityCommand = {
      version: 1,
      actorId: actor,
      activityId: activityId(id),
      requestHash,
      command,
    };
    try {
      this.storage.set(this.key(actor), JSON.parse(JSON.stringify(p)));
      if (this.read(actor)?.requestHash !== requestHash) throw Error();
      return p;
    } catch {
      throw new ClientError('storage', '未能保存活动原请求，尚未发送');
    }
  }
  settle(p: PendingActivityCommand, r: ActivityReceipt) {
    if (
      r.requestId !== p.command.clientRequestId ||
      r.requestHash !== p.requestHash ||
      r.activityId !== p.activityId ||
      r.revision !==
        (p.command.action === 'create'
          ? 1
          : p.command.expectedRevision +
            (p.command.action === 'save' ? 1 : 0)) ||
      r.outcome !==
        (p.command.action === 'create'
          ? 'created'
          : p.command.action === 'save'
            ? 'saved'
            : p.command.action === 'publish'
              ? 'published'
              : 'draft_cancelled')
    )
      throw new ClientError('protocol', '原活动回执不匹配');
    this.rememberDraft(
      p.actorId,
      ['published', 'draft_cancelled'].includes(r.outcome)
        ? null
        : r.activityId,
    );
    this.discard(p);
  }
  discard(p: PendingActivityCommand) {
    if (this.read(p.actorId)?.requestHash !== p.requestHash)
      throw new ClientError('storage', '原活动请求已经变化');
    this.storage.remove(this.key(p.actorId));
    if (this.read(p.actorId) !== null)
      throw new ClientError('storage', '原活动记录仍需恢复');
  }
}
