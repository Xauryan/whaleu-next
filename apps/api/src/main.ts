import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/config.js';
import { configureHttp } from './http/http.js';
import { AppLogger } from './observability/logger.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, { httpRuntime: true }),
    {
      bufferLogs: true,
      abortOnError: false,
    },
  );
  configureHttp(app);
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  await app.listen(config.PORT, config.HTTP_HOST);
  const server = app.getHttpServer() as import('node:http').Server;
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  app.get(AppLogger).structured.info({ event: 'listening', port: config.PORT });
}

bootstrap().catch(() => {
  // Startup failures must not print database URLs, credentials, or raw exception messages.
  process.stderr.write(
    'API startup failed; check configuration and service availability\n',
  );
  process.exitCode = 1;
});
