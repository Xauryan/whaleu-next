import { PrivateMessageResponses, dmResponseHeaders } from './http.js';
import {
  Body,
  Controller,
  Get,
  Post,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { SchemaValidationPipe } from '../http/validation.js';
import { bearerToken } from '../identity/tokens.js';
import { MessagingReadService } from './read.service.js';
import { MessagingMutationService } from './mutation.service.js';
import { MessagingRequests } from './requests.js';
import { MessagingRequestGuard } from './request.guard.js';
import * as c from './contracts.js';
const emptyBody = z.union([z.undefined(), c.dmEmptySchema]);
@PrivateMessageResponses()
@ApiTags('Private messages')
@ApiBearerAuth('accessToken')
@UseGuards(MessagingRequestGuard)
@Controller('v1/private-messages')
export class MessagingController {
  constructor(
    @Inject(MessagingReadService) private readonly reads: MessagingReadService,
    @Inject(MessagingMutationService)
    private readonly writes: MessagingMutationService,
    @Inject(MessagingRequests) private readonly requests: MessagingRequests,
  ) {}
  @Get('conversations')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageList',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmListSchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: c.dmPageQuery,
      pipes: [new SchemaValidationPipe(c.dmPageQuery)],
    })
    query: z.infer<typeof c.dmPageQuery>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.reads.list(bearerToken(auth), {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }
  @Get('unread')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageUnread',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmUnreadSchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  unread(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: c.dmEmptySchema,
      pipes: [new SchemaValidationPipe(c.dmEmptySchema)],
    })
    query: z.infer<typeof c.dmEmptySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.reads.unread(bearerToken(auth));
  }
  @Get('conversations/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageConversation',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmConversationSchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  conversation(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(c.dmId)) id: string,
    @Query({
      schema: c.dmEmptySchema,
      pipes: [new SchemaValidationPipe(c.dmEmptySchema)],
    })
    query: z.infer<typeof c.dmEmptySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.reads.conversation(bearerToken(auth), id);
  }
  @Get('conversations/:id/messages')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageHistory',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmHistorySchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  history(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(c.dmId)) id: string,
    @Query({
      schema: c.dmPageQuery,
      pipes: [new SchemaValidationPipe(c.dmPageQuery)],
    })
    query: z.infer<typeof c.dmPageQuery>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.reads.history(bearerToken(auth), id, {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }
  @Get('conversations/:id/events')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageEvents',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmEventsSchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  events(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(c.dmId)) id: string,
    @Query({
      schema: c.dmPageQuery,
      pipes: [new SchemaValidationPipe(c.dmPageQuery)],
    })
    query: z.infer<typeof c.dmPageQuery>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.reads.events(bearerToken(auth), id, {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }
  @Get('requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageReceipt',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmReceiptSchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(c.dmId)) requestId: string,
    @Query({
      schema: c.dmEmptySchema,
      pipes: [new SchemaValidationPipe(c.dmEmptySchema)],
    })
    query: z.infer<typeof c.dmEmptySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.requests.receipt(bearerToken(auth), requestId);
  }
  @Post('conversations')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageOpen',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmReceiptSchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  open(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: c.dmEmptySchema,
      pipes: [new SchemaValidationPipe(c.dmEmptySchema)],
    })
    query: z.infer<typeof c.dmEmptySchema>,
    @Body({
      schema: c.dmOpenSchema,
      pipes: [new SchemaValidationPipe(c.dmOpenSchema)],
    })
    body: z.infer<typeof c.dmOpenSchema>,
  ) {
    void query;
    return this.writes.open(bearerToken(auth), body);
  }
  @Post('conversations/:id/messages')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageSend',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmReceiptSchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  send(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(c.dmId)) id: string,
    @Query({
      schema: c.dmEmptySchema,
      pipes: [new SchemaValidationPipe(c.dmEmptySchema)],
    })
    query: z.infer<typeof c.dmEmptySchema>,
    @Body({
      schema: c.dmSendSchema,
      pipes: [new SchemaValidationPipe(c.dmSendSchema)],
    })
    body: z.infer<typeof c.dmSendSchema>,
  ) {
    void query;
    return this.writes.send(bearerToken(auth), id, body);
  }
  @Post('conversations/:id/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageRead',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmReceiptSchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  read(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(c.dmId)) id: string,
    @Query({
      schema: c.dmEmptySchema,
      pipes: [new SchemaValidationPipe(c.dmEmptySchema)],
    })
    query: z.infer<typeof c.dmEmptySchema>,
    @Body({
      schema: c.dmReadSchema,
      pipes: [new SchemaValidationPipe(c.dmReadSchema)],
    })
    body: z.infer<typeof c.dmReadSchema>,
  ) {
    void query;
    return this.writes.read(
      bearerToken(auth),
      id,
      body.clientRequestId,
      body.observationId,
    );
  }
  @Post('conversations/:id/hide')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageHide',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmReceiptSchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  hide(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(c.dmId)) id: string,
    @Query({
      schema: c.dmEmptySchema,
      pipes: [new SchemaValidationPipe(c.dmEmptySchema)],
    })
    query: z.infer<typeof c.dmEmptySchema>,
    @Body({
      schema: c.dmCommandSchema,
      pipes: [new SchemaValidationPipe(c.dmCommandSchema)],
    })
    body: z.infer<typeof c.dmCommandSchema>,
  ) {
    void query;
    return this.writes.visibility(
      bearerToken(auth),
      id,
      body.clientRequestId,
      'hide',
    );
  }
  @Post('conversations/:id/reopen')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageReopen',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmReceiptSchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  reopen(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(c.dmId)) id: string,
    @Query({
      schema: c.dmEmptySchema,
      pipes: [new SchemaValidationPipe(c.dmEmptySchema)],
    })
    query: z.infer<typeof c.dmEmptySchema>,
    @Body({
      schema: c.dmCommandSchema,
      pipes: [new SchemaValidationPipe(c.dmCommandSchema)],
    })
    body: z.infer<typeof c.dmCommandSchema>,
  ) {
    void query;
    return this.writes.visibility(
      bearerToken(auth),
      id,
      body.clientRequestId,
      'reopen',
    );
  }
  @Post('conversations/:id/block')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageBlock',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmReceiptSchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  block(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(c.dmId)) id: string,
    @Query({
      schema: c.dmEmptySchema,
      pipes: [new SchemaValidationPipe(c.dmEmptySchema)],
    })
    query: z.infer<typeof c.dmEmptySchema>,
    @Body({
      schema: c.dmCommandSchema,
      pipes: [new SchemaValidationPipe(c.dmCommandSchema)],
    })
    body: z.infer<typeof c.dmCommandSchema>,
  ) {
    void query;
    return this.writes.block(bearerToken(auth), id, body.clientRequestId);
  }
  @Post('conversations/:id/messages/:messageId/recall')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageRecall',
    description:
      'Private owner-scoped local text contract. Missing authority fails closed; no production delivery claim.',
  })
  @ApiOkResponse({
    standardSchema: c.dmReceiptSchema,
    description: 'Strict private-message response',
    headers: dmResponseHeaders,
  })
  recall(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(c.dmId)) id: string,
    @Param('messageId', new SchemaValidationPipe(c.dmId)) messageId: string,
    @Query({
      schema: c.dmEmptySchema,
      pipes: [new SchemaValidationPipe(c.dmEmptySchema)],
    })
    query: z.infer<typeof c.dmEmptySchema>,
    @Body({
      schema: c.dmCommandSchema,
      pipes: [new SchemaValidationPipe(c.dmCommandSchema)],
    })
    body: z.infer<typeof c.dmCommandSchema>,
  ) {
    void query;
    return this.writes.recall(
      bearerToken(auth),
      id,
      messageId,
      body.clientRequestId,
    );
  }
  @Post('requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'privateMessageCancel',
    description:
      'Closes the original account/request/operation/hash identity without body. Already committed receipt wins; a late original send cannot bypass cancellation.',
  })
  @ApiOkResponse({
    standardSchema: c.dmCancellationResultSchema,
    description:
      'Explicit cancellation result with immutable original command receipt',
    headers: dmResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param(
      'requestId',
      new SchemaValidationPipe(c.dmCommandSchema.shape.clientRequestId),
    )
    requestId: string,
    @Query({
      schema: c.dmEmptySchema,
      pipes: [new SchemaValidationPipe(c.dmEmptySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: c.dmCancelSchema,
      pipes: [new SchemaValidationPipe(c.dmCancelSchema)],
    })
    body: z.infer<typeof c.dmCancelSchema>,
  ) {
    void query;
    return this.requests.cancel(
      bearerToken(auth),
      requestId,
      body.operation,
      body.intentHash,
    );
  }
}
