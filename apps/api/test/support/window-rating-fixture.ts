import { extendLiveFixture } from './live-fixture.js';
/** Explicit synthetic source/topology acceptance, independent empty history. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import { directoryRuntimeFixture } from './directory-runtime-fixture.js';
export interface SyntheticWindow {
  id: string;
  revision: string;
  name: string;
  canteenId: string;
  canteenRevision: string;
  canteenName: string;
  floorId: string;
  floorKey: string;
  floorLabel: string;
  campusId: string;
  active: boolean;
  parentActive: boolean;
  floorActive: boolean;
  history: 'accepted_empty' | 'unknown';
}
export async function windowHistory(
  pool: Pool,
  id: string,
  coverage: 'accepted_empty' | 'unknown',
  until: Date | string = new Date(Date.now() + 3600000),
  from?: Date | string,
) {
  return inTransaction(pool, (tx) =>
    writeHistory(tx, id, coverage, until, from),
  );
}
async function writeHistory(
  tx: PoolClient,
  id: string,
  coverage: 'accepted_empty' | 'unknown',
  until: Date | string,
  from?: Date | string,
) {
  const assertion = randomUUID();
  await tx.query(
    "INSERT INTO whaleu_ratings.window_history_assertions(id,window_id,coverage,source_reference,policy_reference,accepted_at,valid_until) VALUES($1,$2,$3,'synthetic:separate-window-history-audit','synthetic:no-prior-window-score-population',coalesce($5::timestamptz,clock_timestamp()),$4)",
    [assertion, id, coverage, until, from ?? null],
  );
  await tx.query(
    'INSERT INTO whaleu_ratings.window_history_heads(window_id,assertion_id) VALUES($1,$2) ON CONFLICT(window_id) DO UPDATE SET assertion_id=EXCLUDED.assertion_id',
    [id, assertion],
  );
  return assertion;
}
export async function windowRatingFixture(
  base?: Awaited<ReturnType<typeof directoryRuntimeFixture>>,
) {
  const f = base ?? (await directoryRuntimeFixture()),
    windows: SyntheticWindow[] = [],
    canteenId = randomUUID(),
    canteenRevision = randomUUID(),
    floorId = randomUUID();
  const add = (patch: Partial<SyntheticWindow> = {}): SyntheticWindow => ({
    id: randomUUID(),
    revision: randomUUID(),
    name: 'Synthetic Window ' + randomUUID().slice(0, 8),
    canteenId,
    canteenRevision,
    canteenName: 'Synthetic Canteen',
    floorId,
    floorKey: 'B1-mezzanine',
    floorLabel: 'Synthetic B1 Mezzanine',
    campusId: f.scope.home.campusId,
    active: true,
    parentActive: true,
    floorActive: true,
    history: 'accepted_empty',
    ...patch,
  });
  const accept = async (
    rows: SyntheticWindow[],
    options: {
      coverage?: 'complete' | 'unknown';
      validUntil?: Date | string;
    } = {},
  ) =>
    inTransaction(f.pool, async (tx) => {
      const catalog = randomUUID();
      await tx.query(
        "INSERT INTO whaleu_ratings.window_catalogs(id,source_namespace,source_reference,source_revision,coverage,scope_policy,policy_reference,valid_until) VALUES($1,'synthetic:window-fixture','synthetic:accepted-window-directory',$2,$3,'authenticated_phone','synthetic:current-phone-authenticated-actors',$4)",
        [
          catalog,
          randomUUID(),
          options.coverage ?? 'complete',
          options.validUntil ?? new Date(Date.now() + 3600000),
        ],
      );
      const parents = new Set<string>(),
        floors = new Set<string>();
      for (const w of rows) {
        if (!parents.has(w.canteenId)) {
          await tx.query(
            "INSERT INTO whaleu_ratings.canteen_identities(id,source_namespace,source_canteen_key) VALUES($1,'synthetic:window-fixture',$2) ON CONFLICT DO NOTHING",
            [w.canteenId, 'synthetic:' + w.canteenId],
          );
          await tx.query(
            "INSERT INTO whaleu_ratings.canteen_entries(catalog_id,canteen_id,revision,name,is_active,campus_id,source_campus_key,campus_label,campus_mapping_reference) VALUES($1,$2,$3,$4,$5,$6,'synthetic:source-campus','Synthetic Campus','synthetic:independently-accepted-crosswalk')",
            [
              catalog,
              w.canteenId,
              w.canteenRevision,
              w.canteenName,
              w.parentActive,
              w.campusId,
            ],
          );
          parents.add(w.canteenId);
        }
        if (!floors.has(w.floorId)) {
          await tx.query(
            'INSERT INTO whaleu_ratings.window_floor_identities(id,canteen_id,source_floor_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [w.floorId, w.canteenId, w.floorKey],
          );
          await tx.query(
            'INSERT INTO whaleu_ratings.window_floor_entries(catalog_id,canteen_id,floor_id,label,is_active) VALUES($1,$2,$3,$4,$5)',
            [catalog, w.canteenId, w.floorId, w.floorLabel, w.floorActive],
          );
          floors.add(w.floorId);
        }
        await tx.query(
          "INSERT INTO whaleu_ratings.window_identities(id,source_namespace,source_window_key) VALUES($1,'synthetic:window-fixture',$2) ON CONFLICT DO NOTHING",
          [w.id, 'synthetic:' + w.id],
        );
        await tx.query(
          'INSERT INTO whaleu_ratings.window_entries(catalog_id,window_id,revision,canteen_id,floor_id,name,is_active) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [catalog, w.id, w.revision, w.canteenId, w.floorId, w.name, w.active],
        );
        if (
          !(
            await tx.query(
              'SELECT 1 FROM whaleu_ratings.window_history_heads WHERE window_id=$1',
              [w.id],
            )
          ).rowCount
        )
          await writeHistory(
            tx,
            w.id,
            w.history,
            new Date(Date.now() + 3600000),
          );
      }
      await tx.query(
        'INSERT INTO whaleu_ratings.window_catalog_acceptances(catalog_id) VALUES($1)',
        [catalog],
      );
      await tx.query(
        "INSERT INTO whaleu_ratings.window_catalog_head(singleton,catalog_id,state) VALUES(true,$1,'accepted') ON CONFLICT(singleton) DO UPDATE SET catalog_id=EXCLUDED.catalog_id,state='accepted'",
        [catalog],
      );
      windows.splice(0, windows.length, ...rows);
      return catalog;
    });
  const command = (
    catalog: string,
    window: SyntheticWindow,
    patch: Record<string, unknown> = {},
  ) => ({
    clientRequestId: randomUUID(),
    expectedCatalogRevision: catalog,
    expectedWindowRevision: window.revision,
    expectedOwnScoreRevision: null as string | null,
    score: -10,
    ...patch,
  });
  return extendLiveFixture(f, { windows, add, accept, command });
}
