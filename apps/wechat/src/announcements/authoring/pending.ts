import type { Storage } from '../../platform/contracts';
import { ClientError } from '../../api/errors';
import { exact } from '../../community/contract';
import { id, commandHash, decodeCommand } from './contract';
import type { Command, Receipt } from './contract';
export interface PendingCommand {
  version: 1;
  actorId: string;
  announcementId: string;
  requestHash: string;
  command: Command;
}
/** Per-account/environment, original frozen command only. No replay queue. */
export class AnnouncementPublicationJournal {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(actor: string) {
    return `whaleu.announcement-publication.v1:${this.namespace}:${id(actor)}`;
  }
  draftId(actor: string): string | null {
    const raw = this.storage.get(this.key(actor) + ':draft');
    if (raw === null || raw === undefined || raw === '') return null;
    try {
      return id(raw);
    } catch {
      throw new ClientError('storage', '已保存草稿入口不可用，请保留原记录');
    }
  }
  rememberDraft(actor: string, target: string | null) {
    const key = this.key(actor) + ':draft';
    if (target === null) this.storage.remove(key);
    else this.storage.set(key, id(target));
    if (this.draftId(actor) !== target)
      throw new ClientError('storage', '草稿入口保存未确认');
  }
  read(actor: string): PendingCommand | null {
    try {
      const raw = this.storage.get(this.key(actor));
      if (raw === undefined || raw === null || raw === '') return null;
      exact(raw, [
        'version',
        'actorId',
        'announcementId',
        'requestHash',
        'command',
      ]);
      if (raw.version !== 1 || raw.actorId !== actor) throw Error();
      const target = id(raw.announcementId),
        command = decodeCommand(raw.command),
        hash = commandHash(actor, target, command);
      if (raw.requestHash !== hash) throw Error();
      return {
        version: 1,
        actorId: actor,
        announcementId: target,
        requestHash: hash,
        command,
      };
    } catch {
      throw new ClientError('storage', '原公告操作记录不可用，请保留原记录');
    }
  }
  write(actor: string, target: string, input: Command) {
    const command = decodeCommand(input),
      requestHash = commandHash(actor, target, command),
      prior = this.read(actor);
    if (prior && prior.requestHash !== requestHash)
      throw new ClientError('storage', '请先恢复或取消原公告操作');
    const p: PendingCommand = {
      version: 1,
      actorId: actor,
      announcementId: id(target),
      requestHash,
      command,
    };
    try {
      this.storage.set(this.key(actor), JSON.parse(JSON.stringify(p)));
      if (this.read(actor)?.requestHash !== requestHash) throw Error();
      return p;
    } catch {
      throw new ClientError('storage', '未能保存公告原请求，尚未发送');
    }
  }
  settle(p: PendingCommand, r: Receipt) {
    if (
      r.requestId !== p.command.clientRequestId ||
      r.requestHash !== p.requestHash ||
      r.announcementId !== p.announcementId ||
      r.revision !== p.command.expectedRevision + 1 ||
      r.outcome !== p.command.action
    )
      throw new ClientError('protocol', '原公告回执不匹配');
    this.rememberDraft(
      p.actorId,
      !['create', 'save'].includes(r.outcome) ? null : r.announcementId,
    );
    this.discard(p);
  }
  discard(p: PendingCommand) {
    if (this.read(p.actorId)?.requestHash !== p.requestHash)
      throw new ClientError('storage', '原公告请求已经变化');
    this.storage.remove(this.key(p.actorId));
    if (this.read(p.actorId) !== null)
      throw new ClientError('storage', '原公告记录仍需恢复');
  }
}
