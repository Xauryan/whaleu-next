import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { z } from 'zod';

const positiveInteger = (fallback: number, max: number) =>
  z.coerce.number().int().positive().max(max).default(fallback);

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  PORT: positiveInteger(3000, 65535),
  DATABASE_URL: z.string().min(1),
  PG_SSL_MODE: z.enum(['verify-full', 'disable']).default('verify-full'),
  PG_POOL_MAX: positiveInteger(10, 100),
  PG_CONNECTION_TIMEOUT_MS: positiveInteger(5000, 60000),
  PG_STATEMENT_TIMEOUT_MS: positiveInteger(10000, 300000),
  WECHAT_APP_ID: z
    .string()
    .regex(/^wx[a-f0-9]{16}$/)
    .optional(),
  WECHAT_APP_SECRET: z
    .string()
    .min(32)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  AUTH_RATE_LIMIT_KEY: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  COMMUNITY_UPDATES_PROCESSING: z
    .enum(['disabled', 'manual_only', 'automatic'])
    .default('manual_only'),
  COMMUNITY_UPDATES_INTERVAL_MS: positiveInteger(5000, 60000),
  COMMUNITY_UPDATES_BATCH_SIZE: positiveInteger(20, 50),
  EXPERIENCE_PROCESSING: z
    .enum(['disabled', 'manual_only', 'automatic'])
    .default('manual_only'),
  EXPERIENCE_INTERVAL_MS: positiveInteger(5000, 60000),
  EXPERIENCE_BATCH_SIZE: positiveInteger(20, 50),
  SUBSCRIPTION_COMPONENT_PROCESSING: z
    .enum(['disabled', 'manual_only', 'automatic'])
    .default('manual_only'),
  COMMENT_COMPONENT_PROCESSING: z
    .enum(['disabled', 'manual_only', 'automatic'])
    .default('manual_only'),
  LIKE_COMPONENT_PROCESSING: z
    .enum(['disabled', 'manual_only', 'automatic'])
    .default('manual_only'),
  HOT_FEED_PROCESSING: z
    .enum(['disabled', 'manual_only', 'automatic'])
    .default('disabled'),
  HOT_SCORE_COMPUTATION: z
    .enum(['disabled', 'manual_only'])
    .default('disabled'),
  // Automatic retention is mounted only in the explicit HTTP runtime.
  VIEW_REPORTING_RETENTION_PROCESSING: z
    .enum(['disabled', 'manual_only', 'automatic'])
    .default('automatic'),
  SAFETY_JURY_PROCESSING: z
    .enum(['disabled', 'manual_only', 'automatic'])
    .default('disabled'),
  SAFETY_JURY_INTERVAL_MS: positiveInteger(5000, 60000),
  SAFETY_JURY_BATCH_SIZE: positiveInteger(20, 50),
  SAFETY_REPORTS_PER_MINUTE: positiveInteger(30, 1000),
  SAFETY_VOTES_PER_MINUTE: positiveInteger(30, 1000),
  SAFETY_REPORT_READS_PER_MINUTE: positiveInteger(120, 10000),
  SAFETY_TARGET_REQUESTS_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(16)
    .max(10000)
    .default(120),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error', 'silent'])
    .default('info'),
});

export type RuntimeConfig = Readonly<z.infer<typeof schema>>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const keys = [
      ...new Set(result.error.issues.map((issue) => issue.path[0])),
    ];
    // Report only field names, never the values or Zod's received-input diagnostics.
    throw new Error(`Invalid configuration fields: ${keys.join(', ')}`);
  }
  const config = result.data;
  if (
    config.HOT_FEED_PROCESSING === 'automatic' &&
    [
      config.SUBSCRIPTION_COMPONENT_PROCESSING,
      config.LIKE_COMPONENT_PROCESSING,
      config.COMMENT_COMPONENT_PROCESSING,
    ].some((mode) => mode !== 'automatic')
  )
    throw new Error(
      'Automatic hot feed requires automatic subscription, like and comment components',
    );
  const authFields = [
    config.WECHAT_APP_ID,
    config.WECHAT_APP_SECRET,
    config.AUTH_RATE_LIMIT_KEY,
  ];
  if (authFields.some(Boolean) && !authFields.every(Boolean))
    throw new Error(
      'WECHAT_APP_ID, WECHAT_APP_SECRET and AUTH_RATE_LIMIT_KEY must be configured together',
    );
  let url: URL;
  try {
    url = new URL(config.DATABASE_URL);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    url.pathname.length < 2 ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'DATABASE_URL must name a database and have no query or fragment',
    );
  }
  if (
    config.PG_SSL_MODE === 'disable' &&
    !['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(url.hostname)
  ) {
    throw new Error(
      'Unencrypted PostgreSQL connections are limited to local development',
    );
  }
  if (config.NODE_ENV === 'production' && config.PG_SSL_MODE === 'disable') {
    throw new Error('Production requires verified PostgreSQL TLS');
  }
  return Object.freeze(config);
}

@Global()
@Module({})
export class ConfigurationModule {
  static register(config: RuntimeConfig): DynamicModule {
    return {
      module: ConfigurationModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
