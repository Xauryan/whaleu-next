import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApplicationError } from '../../http/application-error.js';
export function validatePromotionRequestBody(value: unknown): void {
  if (value === undefined) return;
  if (Buffer.byteLength(JSON.stringify(value)) > 8192)
    throw new ApplicationError('PROMOTION_TOO_LARGE');
  const depth = (v: unknown, n: number): void => {
    if (n > 5) throw new ApplicationError('PROMOTION_TOO_LARGE');
    if (v && typeof v === 'object')
      for (const next of Object.values(v)) depth(next, n + 1);
  };
  depth(value, 0);
}
@Injectable()
export class PromotionRequestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    validatePromotionRequestBody(
      context.switchToHttp().getRequest<Request>().body,
    );
    return true;
  }
}
