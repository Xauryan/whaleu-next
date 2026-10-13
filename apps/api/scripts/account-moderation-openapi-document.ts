import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  OwnAccountModerationController,
  AccountPunishmentManagementController,
} from '../src/safety/account-moderation/controller.js';
import {
  AccountAppealsController,
  AccountAppealManagementController,
} from '../src/safety/account-appeals/controller.js';
import { AccountModerationService } from '../src/safety/account-moderation/service.js';
import { AccountAppealsService } from '../src/safety/account-appeals/service.js';
export async function createAccountModerationOpenApiDocument(): Promise<OpenAPIObject> {
  const controllers = [
    OwnAccountModerationController,
    AccountPunishmentManagementController,
    AccountAppealsController,
    AccountAppealManagementController,
  ];
  for (const controller of controllers)
    for (const method of Object.getOwnPropertyNames(
      controller.prototype,
    ).filter((name) => name !== 'constructor'))
      if (
        !Reflect.hasMetadata(PARAMTYPES_METADATA, controller.prototype, method)
      )
        throw new Error(
          'OpenAPI requires emitted TypeScript decorator metadata',
        );
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers,
    providers: [
      {
        provide: AccountModerationService,
        useValue: {
          status: fail,
          ownList: fail,
          ownDetail: fail,
          adminList: fail,
          adminDetail: fail,
          adminHistory: fail,
          release: fail,
          recovery: fail,
        },
      },
      {
        provide: AccountAppealsService,
        useValue: { list: fail, detail: fail, command: fail, recovery: fail },
      },
    ],
  }).compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU recoverable account moderation and private appeals')
        .setDescription(
          'Separate Safety mute and access suspension. Mute only limits interaction and content management; suspension retains current authenticated own status, local notices and private appeals. Issuance remains a compound content-removal command in its source owner. Global super administrators review private cases and release exact punishment references. Original-key recovery and cancellation remain session-owned; no provider delivery or administrator notification is implied.',
        )
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current opaque WhaleU access token. Private records require exact owner authentication. Management requires current global super-admin authority; original-key recovery and cancellation belong to the original actor.',
        })
        .build(),
      {
        deepScanRoutes: false,
        autoTagControllers: false,
        excludeDynamicDefaults: true,
      },
    );
  } finally {
    await app.close();
  }
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  return value;
}
export async function renderAccountModerationOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createAccountModerationOpenApiDocument()),
      null,
      2,
    ),
    {
      parser: 'json',
      printWidth: 80,
      tabWidth: 2,
      useTabs: false,
      endOfLine: 'lf',
    },
  );
}
export async function writeAccountModerationOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/account-moderation.json',
      import.meta.url,
    ),
    rendered = await renderAccountModerationOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Account moderation OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Account moderation OpenAPI artifact is current.'
      : 'Generated docs/openapi/account-moderation.json.',
  );
}
