import type { Storage } from '../platform/contracts';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import {
  decodeOrganizationCommand,
  organizationCommandHash,
  organizationUuid,
  invalidOrganization,
} from './contract';
import type { OrganizationCommand, OrganizationReceipt } from './contract';
export interface PendingOrganizationCommand {
  version: 1;
  actorId: string;
  organizationId: string;
  regionId: string;
  requestHash: string;
  command: OrganizationCommand;
}
/** One unresolved original command per account/environment, not a resend queue. */
export class OrganizationCommandJournal {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(actor: string) {
    return `whaleu.organization-command.v1:${this.namespace}:${organizationUuid(actor)}`;
  }
  read(actor: string): PendingOrganizationCommand | null {
    try {
      const raw = this.storage.get(this.key(actor));
      if (raw === undefined || raw === null || raw === '') return null;
      exact(raw, [
        'version',
        'actorId',
        'organizationId',
        'regionId',
        'requestHash',
        'command',
      ]);
      if (raw.version !== 1 || raw.actorId !== actor) invalidOrganization();
      const organizationId = organizationUuid(raw.organizationId),
        regionId = organizationUuid(raw.regionId),
        command = decodeOrganizationCommand(raw.command),
        requestHash = organizationCommandHash(actor, organizationId, command);
      if (requestHash !== raw.requestHash) invalidOrganization();
      return {
        version: 1,
        actorId: actor,
        organizationId,
        regionId,
        requestHash,
        command,
      };
    } catch {
      throw new ClientError('storage', '组织操作恢复记录不可用，请保留原记录');
    }
  }
  write(actor: string, id: string, region: string, raw: OrganizationCommand) {
    const command = decodeOrganizationCommand(raw),
      requestHash = organizationCommandHash(actor, id, command),
      previous = this.read(actor);
    if (previous && previous.requestHash !== requestHash)
      throw new ClientError('storage', '请先恢复或取消原操作');
    const value: PendingOrganizationCommand = {
      version: 1,
      actorId: actor,
      organizationId: organizationUuid(id),
      regionId: organizationUuid(region),
      requestHash,
      command,
    };
    try {
      this.storage.set(this.key(actor), JSON.parse(JSON.stringify(value)));
      if (this.read(actor)?.requestHash !== requestHash)
        throw new Error('Mismatch');
      return value;
    } catch {
      throw new ClientError('storage', '无法保存组织操作，未发送请求');
    }
  }
  settle(p: PendingOrganizationCommand, r: OrganizationReceipt) {
    const expectedRevision =
        p.command.action === 'create'
          ? 1
          : p.command.expectedRevision +
            (['save', 'submit'].includes(p.command.action) ? 1 : 0),
      expectedAuthority =
        p.command.action === 'create'
          ? 1
          : p.command.expectedAuthorityVersion +
            ([
              'approve',
              'reject',
              'add_admin',
              'remove_admin',
              'transfer_owner',
            ].includes(p.command.action)
              ? 1
              : 0);
    if (
      r.requestId !== p.command.clientRequestId ||
      r.requestHash !== p.requestHash ||
      r.organizationId !== p.organizationId ||
      r.revision !== expectedRevision ||
      r.authorityVersion !== expectedAuthority
    )
      invalidOrganization();
    this.discard(p);
  }
  discard(p: PendingOrganizationCommand) {
    if (this.read(p.actorId)?.requestHash !== p.requestHash)
      throw new ClientError('storage', '组织操作恢复记录已变化');
    try {
      this.storage.remove(this.key(p.actorId));
      if (this.read(p.actorId) !== null) throw new Error('Mismatch');
    } catch {
      throw new ClientError('storage', '操作记录仍保留，请恢复原请求');
    }
  }
}
