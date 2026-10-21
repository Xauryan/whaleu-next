import { Injectable, Module } from '@nestjs/common';
import type { PoolClient } from 'pg';
/** Independent notification work, committed with the source transition. */
@Injectable()
export class SocialUpdatesIngress {
  async enqueue(
    id: string,
    recipient: string,
    kind: 'like' | 'save' | 'follow',
    automatic: boolean,
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_notifications.social_work(source_id,recipient_account_id,kind,automatic_eligible) VALUES($1,$2,$3,$4)',
      [id, recipient, kind, automatic],
    );
  }
}
@Module({ providers: [SocialUpdatesIngress], exports: [SocialUpdatesIngress] })
export class SocialUpdatesIngressModule {}
