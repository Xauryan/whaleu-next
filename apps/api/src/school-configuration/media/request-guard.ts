import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { SchoolConfigurationRequestGuard } from '../request-guard.js';
/** Same account/guest family throttle. Only the dedicated multipart handler
 * delegates whole-wire body admission to Media's established interceptor. */
@Injectable()
export class SchoolQrRequestGuard extends SchoolConfigurationRequestGuard {
  override async canActivate(context: ExecutionContext) {
    return context.getHandler().name === 'upload'
      ? this.throttle(context)
      : super.canActivate(context);
  }
}
