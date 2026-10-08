import { CommentComponentRuntime } from './runtime.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { CommunityCommentEnrollment } from './enrollment.js';
import { CommentComponentRepository } from './repository.js';
import { CommentComponentSettlement } from './settlement.js';
import { CommentComponentWorker } from './worker.js';
@Module({
  imports: [DatabaseModule],
  providers: [
    CommentComponentRuntime,
    CommunityCommentEnrollment,
    CommentComponentRepository,
    CommentComponentSettlement,
    CommentComponentWorker,
  ],
  exports: [
    CommentComponentRuntime,
    CommunityCommentEnrollment,
    CommentComponentRepository,
    CommentComponentSettlement,
    CommentComponentWorker,
  ],
})
export class CommunityCommentComponentModule {}
