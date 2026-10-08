import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module.js';
import { loadConfig } from '../../config/config.js';
import { manualProcessingConfig } from '../../config/manual-processing.js';
import {
  CommentComponentWorker,
  assertLocalCommentWorker,
  parseCommentCommand,
} from './worker.js';
async function main() {
  const options = parseCommentCommand(process.argv.slice(2)),
    config = loadConfig(process.env);
  assertLocalCommentWorker(config);
  const app = await NestFactory.createApplicationContext(
    AppModule.register(manualProcessingConfig(config, 'comments')),
    { logger: false },
  );
  try {
    process.stdout.write(
      `${JSON.stringify({ command: 'local-comment-component', ...(await app.get(CommentComponentWorker).run(options)) })}\n`,
    );
  } finally {
    await app.close();
  }
}
main().catch(() => {
  process.stderr.write(
    'Local comment processing failed; check explicit selection and local database configuration\n',
  );
  process.exitCode = 1;
});
