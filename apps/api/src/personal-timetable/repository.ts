import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  TIMETABLE_ENTRY_LIMIT,
  TIMETABLE_TERM_LIMIT,
  TIMETABLE_REVISION_MAX,
  timetableTermSchema,
  timetableEntrySchema,
  timetableReceiptSchema,
  timetableIntentHash,
  timetableReceipt,
} from './contracts.js';
import type {
  TimetableCommand,
  TimetableTerm,
  TimetableEntry,
  TimetableReceipt,
  TimetableRejectionCode,
} from './contracts.js';
const termFields = `term_id AS "termId",name,week_one_monday::text AS "weekOneMonday",week_count AS "weekCount",time_zone AS "timeZone",revision`;
const entryFields = `entry_id AS "entryId",term_id AS "termId",name,teacher,location,note,day_of_week AS "dayOfWeek",start_minute AS "startMinute",end_minute AS "endMinute",weeks,color`;
@Injectable()
export class PersonalTimetableRepository {
  async lock(account: string, tx: PoolClient) {
    // Reads and all mutations share one account serialization boundary, including
    // absent targets, quota counts, terminal requests and cancellation fences.
    await tx.query('SELECT whaleu_timetable.owner_lock($1)', [account]);
  }
  async terms(account: string, tx: PoolClient): Promise<TimetableTerm[]> {
    const rows = (
      await tx.query(
        `SELECT ${termFields} FROM whaleu_timetable.terms WHERE account_id=$1 AND deleted_at IS NULL ORDER BY week_one_monday DESC,term_id LIMIT $2`,
        [account, TIMETABLE_TERM_LIMIT + 1],
      )
    ).rows;
    if (rows.length > TIMETABLE_TERM_LIMIT)
      throw new ApplicationError('TIMETABLE_UNAVAILABLE');
    return rows.map((row) => timetableTermSchema.parse(row));
  }
  async term(
    account: string,
    id: string,
    tx: PoolClient,
  ): Promise<TimetableTerm | null> {
    const row = (
      await tx.query(
        `SELECT ${termFields} FROM whaleu_timetable.terms WHERE account_id=$1 AND term_id=$2 AND deleted_at IS NULL`,
        [account, id],
      )
    ).rows[0];
    return row ? timetableTermSchema.parse(row) : null;
  }
  async entries(
    account: string,
    term: string,
    tx: PoolClient,
  ): Promise<TimetableEntry[]> {
    const rows = (
      await tx.query(
        `SELECT ${entryFields} FROM whaleu_timetable.entries WHERE account_id=$1 AND term_id=$2 AND deleted_at IS NULL ORDER BY day_of_week,start_minute,entry_id LIMIT $3`,
        [account, term, TIMETABLE_ENTRY_LIMIT + 1],
      )
    ).rows;
    if (rows.length > TIMETABLE_ENTRY_LIMIT)
      throw new ApplicationError('TIMETABLE_UNAVAILABLE');
    return rows.map((row) => timetableEntrySchema.parse(row));
  }
  async recover(
    account: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<TimetableReceipt | null> {
    const row = (
      await tx.query<{ intent_hash: string; receipt: unknown }>(
        `SELECT intent_hash,receipt FROM whaleu_timetable.commands WHERE account_id=$1 AND request_id=$2`,
        [account, requestId],
      )
    ).rows[0];
    if (!row) return null;
    const receipt = timetableReceiptSchema.parse(row.receipt);
    if (
      receipt.intentHash !== row.intent_hash ||
      receipt.requestId !== requestId
    )
      throw new ApplicationError('TIMETABLE_UNAVAILABLE');
    return receipt;
  }
  async previous(
    account: string,
    command: TimetableCommand,
    tx: PoolClient,
  ): Promise<TimetableReceipt | null> {
    const receipt = await this.recover(account, command.requestId, tx);
    if (receipt && receipt.intentHash !== timetableIntentHash(command))
      throw new ApplicationError('TIMETABLE_REQUEST_CONFLICT');
    return receipt;
  }
  async save(
    account: string,
    receipt: TimetableReceipt,
    tx: PoolClient,
  ): Promise<TimetableReceipt> {
    const parsed = timetableReceiptSchema.parse(receipt);
    await tx.query(
      'INSERT INTO whaleu_timetable.commands(account_id,request_id,intent_hash,receipt) VALUES($1,$2,$3,$4::jsonb)',
      [account, parsed.requestId, parsed.intentHash, JSON.stringify(parsed)],
    );
    return parsed;
  }
  async apply(
    account: string,
    command: TimetableCommand,
    tx: PoolClient,
  ): Promise<TimetableReceipt> {
    const term = await this.term(account, command.termId, tx);
    const reject = (code: TimetableRejectionCode) =>
      timetableReceipt(command, 'rejected', term?.revision ?? null, code);
    if (command.operation === 'term.create') {
      const used = (
        await tx.query(
          'SELECT 1 FROM whaleu_timetable.terms WHERE account_id=$1 AND term_id=$2',
          [account, command.termId],
        )
      ).rowCount;
      if (used) return reject('TIMETABLE_ID_REUSED');
      if ((await this.terms(account, tx)).length >= TIMETABLE_TERM_LIMIT)
        return reject('TIMETABLE_TERM_LIMIT');
      const p = command.payload;
      await tx.query(
        'INSERT INTO whaleu_timetable.terms(account_id,term_id,revision,name,week_one_monday,week_count,time_zone) VALUES($1,$2,1,$3,$4::date,$5,$6)',
        [
          account,
          command.termId,
          p.name,
          p.weekOneMonday,
          p.weekCount,
          p.timeZone,
        ],
      );
      return timetableReceipt(command, 'applied', 1);
    }
    if (!term) return reject('TIMETABLE_NOT_FOUND');
    if (
      term.revision !== command.expectedRevision ||
      term.revision === TIMETABLE_REVISION_MAX
    )
      return reject('TIMETABLE_REVISION_CONFLICT');
    const next = term.revision + 1;
    if (command.operation === 'term.update') {
      const p = command.payload;
      const entries = await this.entries(account, term.termId, tx);
      if (entries.some((e) => e.weeks.some((w) => w > p.weekCount)))
        return reject('TIMETABLE_WEEKS_OUT_OF_RANGE');
      await tx.query(
        'UPDATE whaleu_timetable.terms SET revision=$3,name=$4,week_one_monday=$5::date,week_count=$6,time_zone=$7 WHERE account_id=$1 AND term_id=$2',
        [
          account,
          term.termId,
          next,
          p.name,
          p.weekOneMonday,
          p.weekCount,
          p.timeZone,
        ],
      );
    } else if (command.operation === 'term.delete') {
      await tx.query(
        `UPDATE whaleu_timetable.entries SET name=NULL,teacher=NULL,location=NULL,note=NULL,day_of_week=NULL,start_minute=NULL,end_minute=NULL,weeks=NULL,color=NULL,deleted_at=clock_timestamp() WHERE account_id=$1 AND term_id=$2 AND deleted_at IS NULL`,
        [account, term.termId],
      );
      await tx.query(
        `UPDATE whaleu_timetable.terms SET revision=$3,name=NULL,week_one_monday=NULL,week_count=NULL,time_zone=NULL,deleted_at=clock_timestamp() WHERE account_id=$1 AND term_id=$2`,
        [account, term.termId, next],
      );
    } else {
      const existing = (
        await tx.query<{ term_id: string; deleted_at: Date | null }>(
          'SELECT term_id,deleted_at FROM whaleu_timetable.entries WHERE account_id=$1 AND entry_id=$2',
          [account, command.entryId],
        )
      ).rows[0];
      if (command.operation === 'entry.create') {
        if (existing) return reject('TIMETABLE_ID_REUSED');
        if (
          (await this.entries(account, term.termId, tx)).length >=
          TIMETABLE_ENTRY_LIMIT
        )
          return reject('TIMETABLE_ENTRY_LIMIT');
      } else if (
        !existing ||
        existing.term_id !== term.termId ||
        existing.deleted_at !== null
      )
        return reject('TIMETABLE_NOT_FOUND');
      if (command.operation === 'entry.delete') {
        await tx.query(
          'UPDATE whaleu_timetable.entries SET name=NULL,teacher=NULL,location=NULL,note=NULL,day_of_week=NULL,start_minute=NULL,end_minute=NULL,weeks=NULL,color=NULL,deleted_at=clock_timestamp() WHERE account_id=$1 AND term_id=$2 AND entry_id=$3',
          [account, term.termId, command.entryId],
        );
      } else {
        const p = command.payload;
        if (p.weeks.some((w) => w > term.weekCount))
          return reject('TIMETABLE_WEEKS_OUT_OF_RANGE');
        const values = [
          account,
          term.termId,
          command.entryId,
          p.name,
          p.teacher,
          p.location,
          p.note,
          p.dayOfWeek,
          p.startMinute,
          p.endMinute,
          p.weeks,
          p.color,
        ];
        if (command.operation === 'entry.create')
          await tx.query(
            'INSERT INTO whaleu_timetable.entries(account_id,term_id,entry_id,name,teacher,location,note,day_of_week,start_minute,end_minute,weeks,color) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::smallint[],$12)',
            values,
          );
        else
          await tx.query(
            'UPDATE whaleu_timetable.entries SET name=$4,teacher=$5,location=$6,note=$7,day_of_week=$8,start_minute=$9,end_minute=$10,weeks=$11::smallint[],color=$12 WHERE account_id=$1 AND term_id=$2 AND entry_id=$3',
            values,
          );
      }
      await tx.query(
        'UPDATE whaleu_timetable.terms SET revision=$3 WHERE account_id=$1 AND term_id=$2',
        [account, term.termId, next],
      );
    }
    return timetableReceipt(command, 'applied', next);
  }
}
