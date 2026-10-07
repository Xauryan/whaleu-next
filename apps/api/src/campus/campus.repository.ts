import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import type { Campus, CampusPage, CampusQuery } from './contracts.js';

const projection = `c.id, c.institution_id AS "institutionId", i.name AS "institutionName",
 c.full_name AS "fullName", c.short_name AS "shortName", c.district, c.is_active AS "isActive"`;

@Injectable()
export class CampusRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async list(query: CampusQuery): Promise<CampusPage> {
    // One statement keeps page and total on the same MVCC snapshot, even for empty pages.
    // strpos treats user %, _ and backslashes literally, never as LIKE wildcards.
    const result = await this.database.query<{
      items: Campus[];
      total: number;
    }>(
      `WITH filtered AS (
        SELECT ${projection}, c.sort_order FROM whaleu_campus.campuses c
        JOIN whaleu_campus.institutions i ON i.id = c.institution_id
        WHERE ($1::text IS NULL OR c.district = $1)
          AND ($2::text = '' OR strpos(lower(c.full_name), lower($2)) > 0
            OR strpos(lower(coalesce(c.short_name, '')), lower($2)) > 0
            OR strpos(lower(i.name), lower($2)) > 0)
      ), page AS (
        SELECT * FROM filtered ORDER BY "isActive" DESC, sort_order DESC, id
        LIMIT $3 OFFSET $4
      )
      SELECT coalesce((SELECT jsonb_agg(to_jsonb(p) - 'sort_order' ORDER BY "isActive" DESC, sort_order DESC, id) FROM page p), '[]'::jsonb) AS items,
        (SELECT count(*)::integer FROM filtered) AS total`,
      [
        query.district ?? null,
        query.q ?? '',
        query.pageSize,
        (query.page - 1) * query.pageSize,
      ],
    );
    return { ...result.rows[0]!, page: query.page, pageSize: query.pageSize };
  }

  async find(id: string, transaction?: PoolClient): Promise<Campus | null> {
    const sql = `SELECT ${projection} FROM whaleu_campus.campuses c
       JOIN whaleu_campus.institutions i ON i.id = c.institution_id WHERE c.id = $1
       ${transaction ? 'FOR SHARE OF c, i' : ''}`;
    const result = transaction
      ? await transaction.query<Campus>(sql, [id])
      : await this.database.query<Campus>(sql, [id]);
    return result.rows[0] ?? null;
  }
}
