import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { AccountPolicyInterceptor } from './interceptor.js';
@Module({
  imports: [DatabaseModule, IdentityModule],
  providers: [
    AccountPolicyInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: AccountPolicyInterceptor },
  ],
  exports: [AccountPolicyInterceptor],
})
export class AccountPolicyModule {}
