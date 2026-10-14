import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApplicationError } from '../http/application-error.js';
@Injectable()
export class OfficialRequestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const name = context.getHandler().name;
    if (name !== 'capabilities' && Object.keys(request.query).length)
      throw new ApplicationError('OFFICIAL_REQUEST_INVALID');
    if (
      request.method === 'GET' &&
      request.body !== undefined &&
      (!Buffer.isBuffer(request.body) || request.body.byteLength !== 0)
    )
      throw new ApplicationError('OFFICIAL_REQUEST_INVALID');
    if (
      request.method === 'POST' &&
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
        request.get('content-type') ?? '',
      )
    )
      throw new ApplicationError('OFFICIAL_REQUEST_INVALID');
    return true;
  }
}
