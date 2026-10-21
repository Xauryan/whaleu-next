import type { PoolClient } from 'pg';
import { sha } from './preflight.js';
export async function eraseTimetable(
  tx: PoolClient,
  account: string,
  request: string,
  at: Date,
): Promise<string | null> {
  await tx.query('SELECT whaleu_timetable.owner_lock($1)', [account]);
  await tx.query(
    `UPDATE whaleu_timetable.entries SET name=NULL,teacher=NULL,location=NULL,note=NULL,day_of_week=NULL,start_minute=NULL,end_minute=NULL,weeks=NULL,color=NULL,deleted_at=$2 WHERE (account_id,entry_id) IN(SELECT account_id,entry_id FROM whaleu_timetable.entries WHERE account_id=$1 AND deleted_at IS NULL ORDER BY entry_id LIMIT 100)`,
    [account, at],
  );
  if (
    (
      await tx.query(
        'SELECT 1 FROM whaleu_timetable.entries WHERE account_id=$1 AND deleted_at IS NULL LIMIT 1',
        [account],
      )
    ).rowCount
  )
    return null;
  await tx.query(
    `UPDATE whaleu_timetable.terms SET name=NULL,week_one_monday=NULL,week_count=NULL,time_zone=NULL,deleted_at=$2,revision=revision+1 WHERE account_id=$1 AND deleted_at IS NULL`,
    [account, at],
  );
  return sha(['timetable-erasure-v1', request, account]);
}
