import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiTags,
  ApiResponse,
} from '@nestjs/swagger';
import { safeErrorResponseSchema } from '../../http/error-contracts.js';
import {
  studentApplicationSchema,
  studentReceiptSchema,
  studentOwnSchema,
  studentRecoverySchema,
  studentQueuePageSchema,
  studentCapabilitiesSchema,
  studentNoticePageSchema,
  studentNoticeTargetSchema,
} from './contracts.js';
import { UseGuards } from '@nestjs/common';
import { VerificationEvidenceMediaRequestGuard } from '../evidence/request-guard.js';
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { StudentVerificationService } from './service.js';
import {
  studentId,
  studentEmpty,
  reserveStudentSchema,
  submitStudentSchema,
  withdrawStudentSchema,
  decideStudentSchema,
  studentQueueSchema,
  cancelStudentRequestSchema,
} from './contracts.js';
import type {
  ReserveStudent,
  SubmitStudent,
  WithdrawStudent,
  DecideStudent,
} from './contracts.js';
const empty = new SchemaValidationPipe(studentEmpty),
  idPipe = new SchemaValidationPipe(studentId);
@ApiTags('Non-production student verification')
@ApiBearerAuth('accessToken')
@ApiResponse({ status: 400, standardSchema: safeErrorResponseSchema })
@ApiResponse({ status: 401, standardSchema: safeErrorResponseSchema })
@ApiResponse({ status: 403, standardSchema: safeErrorResponseSchema })
@ApiResponse({ status: 409, standardSchema: safeErrorResponseSchema })
@ApiResponse({ status: 503, standardSchema: safeErrorResponseSchema })
@UseGuards(VerificationEvidenceMediaRequestGuard)
@Controller('v1/me/student-verification')
export class OwnStudentVerificationController {
  constructor(
    @Inject(StudentVerificationService)
    readonly service: StudentVerificationService,
  ) {}
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Get('notices')
  @ApiOkResponse({ standardSchema: studentNoticePageSchema })
  notices(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: studentQueueSchema,
      pipes: [new SchemaValidationPipe(studentQueueSchema)],
    })
    q: { page: number },
    @Body(empty) _b: unknown,
  ) {
    return this.service.noticeList(bearerToken(auth), q.page);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Get('notices/:noticeId/target')
  @ApiOkResponse({ standardSchema: studentNoticeTargetSchema })
  noticeTarget(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', idPipe) id: string,
    @Query(empty) _q: unknown,
    @Body(empty) _b: unknown,
  ) {
    return this.service.noticeTarget(bearerToken(auth), id);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Post('notices/:noticeId/read')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: studentNoticeTargetSchema })
  noticeRead(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', idPipe) id: string,
    @Query(empty) _q: unknown,
    @Body(empty) _b: unknown,
  ) {
    return this.service.noticeTarget(bearerToken(auth), id, true);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Get()
  @ApiOkResponse({ standardSchema: studentOwnSchema })
  own(
    @Headers('authorization') auth: unknown,
    @Query(empty) _q: unknown,
    @Body(empty) _b: unknown,
  ) {
    return this.service.own(bearerToken(auth));
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Get('requests/:requestId')
  @ApiOkResponse({ standardSchema: studentRecoverySchema })
  recover(
    @Headers('authorization') auth: unknown,
    @Param('requestId', idPipe) key: string,
    @Query(empty) _q: unknown,
    @Body(empty) _b: unknown,
  ) {
    return this.service.recover(bearerToken(auth), key);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Post('requests/:requestId/cancel')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: studentRecoverySchema })
  cancelRequest(
    @Headers('authorization') auth: unknown,
    @Param('requestId', idPipe) key: string,
    @Body({
      schema: cancelStudentRequestSchema,
      pipes: [new SchemaValidationPipe(cancelStudentRequestSchema)],
    })
    input: { requestHash: string },
    @Query(empty) _q: unknown,
  ) {
    return this.service.cancelRequest(
      bearerToken(auth),
      key,
      input.requestHash,
    );
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Post('applications')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: studentReceiptSchema })
  reserve(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: reserveStudentSchema,
      pipes: [new SchemaValidationPipe(reserveStudentSchema)],
    })
    input: ReserveStudent,
    @Query(empty) _q: unknown,
  ) {
    return this.service.reserve(bearerToken(auth), input);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Get('applications/:applicationId')
  @ApiOkResponse({ standardSchema: studentApplicationSchema })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('applicationId', idPipe) id: string,
    @Query(empty) _q: unknown,
    @Body(empty) _b: unknown,
  ) {
    return this.service.detail(bearerToken(auth), id);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Post('applications/:applicationId/submit')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: studentReceiptSchema })
  submit(
    @Headers('authorization') auth: unknown,
    @Param('applicationId', idPipe) id: string,
    @Body({
      schema: submitStudentSchema,
      pipes: [new SchemaValidationPipe(submitStudentSchema)],
    })
    input: SubmitStudent,
    @Query(empty) _q: unknown,
  ) {
    return this.service.submit(bearerToken(auth), id, input);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Post('applications/:applicationId/withdraw')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: studentReceiptSchema })
  withdraw(
    @Headers('authorization') auth: unknown,
    @Param('applicationId', idPipe) id: string,
    @Body({
      schema: withdrawStudentSchema,
      pipes: [new SchemaValidationPipe(withdrawStudentSchema)],
    })
    input: WithdrawStudent,
    @Query(empty) _q: unknown,
  ) {
    return this.service.withdraw(bearerToken(auth), id, input);
  }
}
@ApiTags('Non-production student verification')
@ApiBearerAuth('accessToken')
@ApiResponse({ status: 400, standardSchema: safeErrorResponseSchema })
@ApiResponse({ status: 401, standardSchema: safeErrorResponseSchema })
@ApiResponse({ status: 403, standardSchema: safeErrorResponseSchema })
@ApiResponse({ status: 409, standardSchema: safeErrorResponseSchema })
@ApiResponse({ status: 503, standardSchema: safeErrorResponseSchema })
@UseGuards(VerificationEvidenceMediaRequestGuard)
@Controller('v1/student-verification-review')
export class StudentVerificationReviewController {
  constructor(
    @Inject(StudentVerificationService)
    readonly service: StudentVerificationService,
  ) {}
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Get('capabilities')
  @ApiOkResponse({ standardSchema: studentCapabilitiesSchema })
  capabilities(
    @Headers('authorization') auth: unknown,
    @Query(empty) _q: unknown,
    @Body(empty) _b: unknown,
  ) {
    return this.service.capabilities(bearerToken(auth));
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Get('regions/:regionId/applications')
  @ApiOkResponse({ standardSchema: studentQueuePageSchema })
  queue(
    @Headers('authorization') auth: unknown,
    @Param('regionId', idPipe) region: string,
    @Query({
      schema: studentQueueSchema,
      pipes: [new SchemaValidationPipe(studentQueueSchema)],
    })
    q: { page: number; cursor?: string },
    @Body(empty) _b: unknown,
  ) {
    return this.service.queue(bearerToken(auth), region, q.page, q.cursor);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Get('regions/:regionId/applications/:applicationId')
  @ApiOkResponse({ standardSchema: studentApplicationSchema })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('regionId', idPipe) region: string,
    @Param('applicationId', idPipe) id: string,
    @Query(empty) _q: unknown,
    @Body(empty) _b: unknown,
  ) {
    return this.service.detail(bearerToken(auth), id, region);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Post('regions/:regionId/applications/:applicationId/decision')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: studentReceiptSchema })
  decide(
    @Headers('authorization') auth: unknown,
    @Param('regionId', idPipe) region: string,
    @Param('applicationId', idPipe) id: string,
    @Body({
      schema: decideStudentSchema,
      pipes: [new SchemaValidationPipe(decideStudentSchema)],
    })
    input: DecideStudent,
    @Query(empty) _q: unknown,
  ) {
    return this.service.decide(bearerToken(auth), region, id, input);
  }
}
