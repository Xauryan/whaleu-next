import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Catch,
  HttpException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type {
  ArgumentsHost,
  ExceptionFilter,
  INestApplication,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppLogger } from '../observability/logger.js';
import {
  ApplicationError,
  TitleMaintenanceContinuationConflict,
} from './application-error.js';
import { safeHttpErrorDescription } from './error-contracts.js';
import type {
  SafeErrorResponse,
  TitleMaintenanceContinuationError,
} from './error-contracts.js';

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    // Only framework exceptions determine HTTP status, never a random error.status field.
    const candidate =
      exception instanceof HttpException ? exception.getStatus() : 500;
    const status =
      Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
        ? candidate
        : 500;
    const description =
      exception instanceof ApplicationError
        ? { code: exception.code, message: exception.message }
        : safeHttpErrorDescription(status);
    const existingRequestId = response.getHeader('x-request-id');
    const requestId =
      typeof existingRequestId === 'string' ? existingRequestId : randomUUID();
    if (!response.headersSent) response.setHeader('x-request-id', requestId);
    if (status === 429 && !response.headersSent)
      response.setHeader('retry-after', '60');
    if (status >= 500) {
      this.logger.structured.error({ event: 'http_error', status, requestId });
    }
    // Typed construction, never a throw-prone decoder in the emergency filter.
    const body: SafeErrorResponse | TitleMaintenanceContinuationError =
      exception instanceof TitleMaintenanceContinuationConflict
        ? {
            error: {
              code: 'EXPERIENCE_MAINTENANCE_CONTINUATION_CONFLICT',
              message: exception.message,
              requestId,
              successorRequestId: exception.successorRequestId,
            },
          }
        : { error: { ...description, requestId } };
    if (!response.headersSent) response.status(status).json(body);
  }
}

export function configureHttp(app: INestApplication): void {
  const logger = app.get(AppLogger);
  app.useLogger(logger);
  app.use(helmet());
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = randomUUID();
    const started = performance.now();
    response.setHeader('x-request-id', requestId);
    response.setHeader(
      'cache-control',
      /^\/v1\/media(?:\/|$)/.test(request.path)
        ? 'private, no-store'
        : 'no-store',
    );
    // Announcement parser failures occur before guards; keep optional-auth
    // cache separation on these error responses too.
    if (
      /^\/v1\/(?:me\/)?(?:announcements|errands|errand-notices|errand-requests|ratings|media)(?:\/|$)/.test(
        request.path,
      ) ||
      /^\/v1\/admin\/errands(?:\/|$)/.test(request.path)
    )
      response.vary('Authorization');
    response.once('finish', () => {
      logger.structured.info({
        event: 'http_request',
        requestId,
        method: /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(
          request.method,
        )
          ? request.method
          : 'OTHER',
        status: response.statusCode,
        durationMs: Math.round(performance.now() - started),
      });
    });
    next();
  });
  const expressApp = app as NestExpressApplication;
  expressApp.useBodyParser('json', { limit: '64kb' });
  expressApp.useBodyParser('urlencoded', { extended: false, limit: '64kb' });
  // Body-parser exposes typed operational failures outside Nest's HttpException
  // hierarchy. Normalize only known parser types, never arbitrary error.status.
  app.use(
    (
      error: unknown,
      _request: Request,
      _response: Response,
      next: NextFunction,
    ) => {
      const type =
        error && typeof error === 'object' && 'type' in error
          ? error.type
          : undefined;
      if (type === 'entity.too.large')
        return next(new PayloadTooLargeException());
      if (type === 'charset.unsupported' || type === 'encoding.unsupported')
        return next(new UnsupportedMediaTypeException());
      if (
        type === 'entity.parse.failed' ||
        type === 'request.aborted' ||
        type === 'request.size.invalid'
      )
        return next(new BadRequestException());
      next(error);
    },
  );
  app.useGlobalFilters(new SafeExceptionFilter(logger));
}
