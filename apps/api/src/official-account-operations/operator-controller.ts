import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  officialOperatorShell,
  officialOperatorScript,
  officialOperatorStyle,
  officialOperatorHeaders,
} from './operator/assets.js';
@ApiExcludeController()
@Controller('operator/official-articles')
export class OfficialArticleOperatorController {
  @Get() shell(@Res() res: Response) {
    return res
      .set(officialOperatorHeaders)
      .type('text/html')
      .send(officialOperatorShell);
  }
  @Get('app.js') script(@Res() res: Response) {
    return res
      .set(officialOperatorHeaders)
      .type('application/javascript')
      .send(officialOperatorScript);
  }
  @Get('app.css') style(@Res() res: Response) {
    return res
      .set(officialOperatorHeaders)
      .type('text/css')
      .send(officialOperatorStyle);
  }
}
