import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import {
  base,
  uuid,
  decodeCapabilities,
  decodeConfig,
  decodePreview,
  decodeResult,
  decodeControl,
  decodeRecovery,
  decodeCommand,
  invalid,
} from './contracts';
import type {
  Capabilities,
  Config,
  Preview,
  Command,
  Operation,
  Result,
  Recovery,
  CancellationTombstone,
} from './contracts';
export interface OfficialGateway {
  capabilities(programId: string, cancel: Cancellation): Promise<Capabilities>;
  config(programId: string, cancel: Cancellation): Promise<Config>;
  preview(
    config: Config,
    kind: 'daily_hot' | 'test',
    cancel: Cancellation,
  ): Promise<Preview>;
  command(
    operation: Operation,
    intent: Command,
    cancel: Cancellation,
  ): Promise<Result>;
  recover(requestId: string, cancel: Cancellation): Promise<Recovery>;
  control(
    action: 'cancel' | 'resume',
    intent: Command,
    cancel: Cancellation,
  ): Promise<Result | CancellationTombstone>;
}
export class HttpOfficialGateway implements OfficialGateway {
  constructor(private readonly api: ApiClient) {}
  private get<T>(
    path: string,
    decode: (v: unknown) => T,
    cancellation: Cancellation,
    query: Record<string, string> = {},
  ) {
    return this.api.request(
      {
        path,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode,
      },
      { query, cancellation },
    );
  }
  private post<T>(
    path: string,
    body: unknown,
    decode: (v: unknown) => T,
    cancellation: Cancellation,
  ) {
    return this.api.request(
      {
        path,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        decode,
      },
      { body: body as Json, cancellation },
    );
  }
  async capabilities(programId: string, c: Cancellation) {
    uuid(programId);
    const result = await this.get(
      `${base}/capabilities`,
      decodeCapabilities,
      c,
      { programId },
    );
    if (result.programId !== programId) invalid();
    return result;
  }
  async config(programId: string, c: Cancellation) {
    const result = await this.get(
      `${base}/programs/${uuid(programId)}/config`,
      decodeConfig,
      c,
    );
    if (result.programId !== programId) invalid();
    return result;
  }
  async preview(config: Config, kind: 'daily_hot' | 'test', c: Cancellation) {
    const result = await this.post(
      `${base}/previews`,
      {
        programId: config.programId,
        kind,
        expectedConfigRevision: config.revision,
      },
      decodePreview,
      c,
    );
    if (
      result.kind !== kind ||
      result.programId !== config.programId ||
      result.accountRef !== config.accountRef ||
      result.configRevision !== config.revision
    )
      invalid();
    return result;
  }
  command(operation: Operation, intent: Command, c: Cancellation) {
    return this.post(
      `${base}/${operation === 'config_save' ? 'config-commands' : 'test-commands'}`,
      decodeCommand(intent, operation),
      decodeResult,
      c,
    );
  }
  recover(requestId: string, c: Cancellation) {
    return this.get(`${base}/requests/${uuid(requestId)}`, decodeRecovery, c);
  }
  control(action: 'cancel' | 'resume', intent: Command, c: Cancellation) {
    return this.post(
      `${base}/requests/${uuid(intent.requestId)}/${action}`,
      { intent },
      decodeControl,
      c,
    );
  }
}
