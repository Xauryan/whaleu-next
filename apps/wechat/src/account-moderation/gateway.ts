import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { uuid4 } from '../community/contract';
import {
  cursor,
  decodeStatus,
  decodePunishment,
  decodePunishmentManagement,
  decodeAppeal,
  decodeAppealManagement,
  decodePage,
  decodeCommand,
  decodeReceipt,
  decodeRecovery,
  matchReceipt,
  invalid,
  type Command,
  type Receipt,
  type Recovery,
  type PunishmentStatus,
  type PunishmentView,
  type PunishmentManagement,
  type AppealView,
  type AppealManagement,
  type PageResult,
} from './contract';
export interface ModerationGateway {
  status(cancel: Cancellation): Promise<PunishmentStatus>;
  ownPunishment(id: string, cancel: Cancellation): Promise<PunishmentView>;
  history(
    cancel: Cancellation,
    after?: string,
  ): Promise<PageResult<PunishmentView>>;
  punishments(
    cancel: Cancellation,
    after?: string,
  ): Promise<PageResult<PunishmentManagement>>;
  punishment(id: string, cancel: Cancellation): Promise<PunishmentManagement>;
  punishmentHistory(
    id: string,
    cancel: Cancellation,
    after?: string,
  ): Promise<PageResult<PunishmentView>>;
  appeals(
    cancel: Cancellation,
    after?: string,
  ): Promise<PageResult<AppealView>>;
  appeal(id: string, cancel: Cancellation): Promise<AppealView>;
  appealQueue(
    cancel: Cancellation,
    after?: string,
  ): Promise<PageResult<AppealManagement>>;
  appealManagement(id: string, cancel: Cancellation): Promise<AppealManagement>;
  submit(
    command: Command,
    cancel: Cancellation,
    cancelling?: boolean,
  ): Promise<Receipt>;
  receipt(command: Command, cancel: Cancellation): Promise<Recovery>;
}
const own = '/v1/me/safety';
const releaseBase = '/v1/safety/punishment-management';
const decisionBase = '/v1/safety/appeal-management';
export class HttpModerationGateway implements ModerationGateway {
  constructor(private readonly api: ApiClient) {}
  private get<T>(
    path: string,
    decode: (raw: unknown) => T,
    cancellation: Cancellation,
    after?: string,
  ): Promise<T> {
    if (after !== undefined && !cursor(after)) invalid();
    return this.api.request(
      {
        path,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode,
      },
      { cancellation, ...(after ? { query: { cursor: after } } : {}) },
    );
  }
  status(cancel: Cancellation) {
    return this.get(`${own}/status`, decodeStatus, cancel);
  }
  async ownPunishment(id: string, cancel: Cancellation) {
    if (!isUuid(id)) invalid();
    const result = await this.get(
      `${own}/punishments/${id}`,
      decodePunishment,
      cancel,
    );
    if (result.punishmentId !== id) invalid();
    return result;
  }
  history(cancel: Cancellation, after?: string) {
    return this.get(
      `${own}/punishments`,
      (v) => decodePage(v, decodePunishment),
      cancel,
      after,
    );
  }
  punishments(cancel: Cancellation, after?: string) {
    return this.get(
      `${releaseBase}/punishments`,
      (v) => decodePage(v, decodePunishmentManagement),
      cancel,
      after,
    );
  }
  async punishment(id: string, cancel: Cancellation) {
    if (!isUuid(id)) invalid();
    const result = await this.get(
      `${releaseBase}/punishments/${id}`,
      decodePunishmentManagement,
      cancel,
    );
    if (result.punishmentId !== id) invalid();
    return result;
  }
  punishmentHistory(id: string, cancel: Cancellation, after?: string) {
    if (!isUuid(id)) invalid();
    return this.get(
      `${releaseBase}/punishments/${id}/history`,
      (v) => decodePage(v, decodePunishment),
      cancel,
      after,
    );
  }
  appeals(cancel: Cancellation, after?: string) {
    return this.get(
      `${own}/appeals`,
      (v) => decodePage(v, decodeAppeal),
      cancel,
      after,
    );
  }
  async appeal(id: string, cancel: Cancellation) {
    if (!isUuid(id)) invalid();
    const result = await this.get(`${own}/appeals/${id}`, decodeAppeal, cancel);
    if (result.appealId !== id) invalid();
    return result;
  }
  appealQueue(cancel: Cancellation, after?: string) {
    return this.get(
      `${decisionBase}/appeals`,
      (v) => decodePage(v, decodeAppealManagement),
      cancel,
      after,
    );
  }
  async appealManagement(id: string, cancel: Cancellation) {
    if (!isUuid(id)) invalid();
    const result = await this.get(
      `${decisionBase}/appeals/${id}`,
      decodeAppealManagement,
      cancel,
    );
    if (result.appealId !== id) invalid();
    return result;
  }
  private route(command: Command): { commands: string; requests: string } {
    return command.action === 'submit_appeal'
      ? {
          commands: `${own}/appeal-commands`,
          requests: `${own}/appeal-requests`,
        }
      : {
          commands: `${command.action === 'release' ? releaseBase : decisionBase}/commands`,
          requests: `${command.action === 'release' ? releaseBase : decisionBase}/requests`,
        };
  }
  async submit(
    raw: Command,
    cancellation: Cancellation,
    cancelling = false,
  ): Promise<Receipt> {
    const command = decodeCommand(raw);
    const result = await this.api.request(
      {
        path: `${this.route(command).commands}${cancelling ? '/cancel' : ''}`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeReceipt,
      },
      { cancellation, body: command as unknown as Json },
    );
    matchReceipt(command, result);
    return result;
  }
  async receipt(command: Command, cancel: Cancellation): Promise<Recovery> {
    if (!uuid4(command.clientRequestId)) invalid();
    const result = await this.get(
      `${this.route(command).requests}/${command.clientRequestId}`,
      decodeRecovery,
      cancel,
    );
    if (result.state === 'recorded') matchReceipt(command, result.receipt);
    return result;
  }
}
