import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { bearerToken } from '../../identity/tokens.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import { idSchema } from '../contracts.js';
import { FeedbackService } from './service.js';
@ApiTags('Public feedback')
@Controller('v1/community/feedback')
export class FeedbackController {
  constructor(
    @Inject(FeedbackService) private readonly service: FeedbackService,
  ) {}
  @Get('topic')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'feedbackTopic',
    description:
      'The explicitly bound public global feedback topic; no browsing campus is required.',
  })
  topic() {
    return this.service.topic();
  }
  @Get('posts/:postId/contacts')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiBearerAuth('accessToken')
  @ApiOperation({
    operationId: 'feedbackContacts',
    description:
      'Explicitly supplied, exactly reviewed contact fields. Current authenticated post access is rechecked; no contacts appear in public list projections.',
  })
  contacts(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) postId: string,
  ) {
    return this.service.contacts(bearerToken(auth), postId);
  }
}
