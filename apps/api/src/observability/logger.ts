import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import pino from 'pino';
import type { DestinationStream, Logger } from 'pino';
import { APP_CONFIG } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';

export function createLogger(
  level: RuntimeConfig['LOG_LEVEL'],
  stream?: DestinationStream,
): Logger {
  const options = {
    level,
    base: { service: 'whaleu-api' },
    redact: {
      paths: [
        'password',
        'token',
        'refresh_token',
        'access_token',
        'authorization',
        'cookie',
        'databaseUrl',
        'DATABASE_URL',
        '*.password',
        '*.token',
        '*.access_token',
        '*.refresh_token',
        '*.authorization',
        '*.cookie',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.token',
        'req.headers.refresh_token',
      ],
      censor: '[REDACTED]',
    },
  };
  return stream ? pino(options, stream) : pino(options);
}

@Injectable()
export class AppLogger implements LoggerService {
  readonly structured: Logger;

  constructor(@Inject(APP_CONFIG) config: RuntimeConfig) {
    this.structured = createLogger(config.LOG_LEVEL);
  }

  // Framework log payloads may contain exception messages or credential-bearing URLs.
  // Keep only fixed lifecycle events; application code uses structured, allowlisted fields.
  log(_message: unknown): void {
    this.structured.info({ event: 'framework_info' });
  }
  error(_message: unknown): void {
    this.structured.error({ event: 'framework_error' });
  }
  warn(_message: unknown): void {
    this.structured.warn({ event: 'framework_warning' });
  }
  debug(_message: unknown): void {
    this.structured.debug({ event: 'framework_debug' });
  }
  verbose(_message: unknown): void {
    this.structured.debug({ event: 'framework_verbose' });
  }
}

@Global()
@Module({ providers: [AppLogger], exports: [AppLogger] })
export class ObservabilityModule {}
