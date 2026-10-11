/** Real simultaneous HTTP commits against the original all-of publication owner. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryIconManagementFixture } from '../support/category-icon-management-fixtures.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  ratingCategoryIconReceiptSchema,
  type RatingCategoryIconIntent,
} from '../../src/ratings/category-management/icon-contracts.js';

test(
  'Category icon concurrent base, override, text and scope writers preserve one exact atomic winner',
  { timeout: 360000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    const f = await categoryIconManagementFixture(
      [{ sha256: sha256(bytes), verdict: 'allow' }],
      { iconGlobal: false },
    );
    t.after(() => f.close());
    const a = { kind: 'campus', campusId: f.campusA } as const;
    const b = { kind: 'campus', campusId: f.campusB } as const;
    let create = f.intent(await f.context(a), 'create_categories_scoped', {
      parentId: null,
      placement: { kind: 'campuses', campusIds: [f.campusA, f.campusB].sort() },
      nodes: [
        {
          key: 'root',
          parentKey: null,
          name: 'Concurrent Category',
          description: 'Original body',
          icon: { mode: 'clear' },
        },
      ],
    });
    create = (await f.ready(create, { kind: 'new', key: 'root' }, bytes)).input;
    const first = await f.execute(create);
    const id = first.receipt.result.categoryIds[0]!;
    const edit = async (name: string) =>
      f.intent(await f.context(a), 'edit_category_base_scoped', {
        categoryId: id,
        name,
        description: 'Concurrent body',
        icon: { mode: 'keep' },
      });
    const image = async (input: RatingCategoryIconIntent) =>
      (await f.ready(input, { kind: 'base', categoryId: id }, bytes)).input;
    const counts = async () =>
      (
        await f.pool.query(
          `SELECT
    (SELECT count(*)::int FROM whaleu_ratings.scoped_releases) releases,
    (SELECT count(*)::int FROM whaleu_ratings.category_icon_release_manifests) manifests,
    (SELECT count(*)::int FROM whaleu_ratings.scoped_command_outcomes WHERE operation=ANY($1::text[]) AND outcome='applied') applied`,
          [
            [
              'edit_category_base_scoped',
              'set_category_override_scoped',
              'set_category_scope_scoped',
            ],
          ],
        )
      ).rows[0]!;
    const race = async (
      left: RatingCategoryIconIntent,
      right: RatingCategoryIconIntent,
    ) => {
      const lp = await f.prepare(left),
        rp = await f.prepare(right);
      await f.approveText(left);
      await f.approveIcons(left);
      await f.approveText(right);
      await f.approveIcons(right);
      const before = await counts();
      const responses = await Promise.all([
        f.commit(left, lp.contextRevision),
        f.commit(right, rp.contextRevision),
      ]);
      const successes = responses.flatMap((r, index) => {
        if (r.status !== 200) return [];
        const receipt = ratingCategoryIconReceiptSchema.parse(r.body);
        return receipt.outcome === 'applied' ? [{ receipt, index }] : [];
      });
      assert.equal(
        successes.length,
        1,
        JSON.stringify(responses.map((r) => r.body)),
      );
      const winner = successes[0]!;
      const after = await counts();
      assert.equal(after.releases, before.releases + 1);
      assert.equal(after.manifests, before.manifests + 1);
      assert.equal(after.applied, before.applied + 1);
      const loser = winner.index === 0 ? right : left;
      const loserPreparation = winner.index === 0 ? rp : lp;
      const repeated = await f.commit(loser, loserPreparation.contextRevision);
      assert.notEqual(
        repeated.body.outcome,
        'applied',
        'CAS remains ahead of any later semantic no-op',
      );
      assert.deepEqual(await counts(), after);
      const winnerInput = winner.index === 0 ? left : right;
      const repeatedWinner = await f.commit(
        winnerInput,
        winner.index === 0 ? lp.contextRevision : rp.contextRevision,
      );
      assert.deepEqual(
        repeatedWinner.body,
        winner.receipt,
        'Original receipt wins before stale context',
      );
      return winner;
    };
    await t.test(
      'two image replacements never bind the losing ready upload',
      async () => {
        const left = await image(await edit('Two image race left'));
        const right = await image(await edit('Two image race right'));
        const winner = await race(left, right);
        const loser = winner.index === 0 ? right : left;
        assert.equal(loser.operation, 'edit_category_base_scoped');
        if (
          loser.operation !== 'edit_category_base_scoped' ||
          loser.payload.icon.mode !== 'replace'
        )
          assert.fail();
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
              [loser.payload.icon.assetId],
            )
          ).rowCount,
          0,
        );
      },
    );
    await t.test(
      'source-only text keep and image replacement share one original CAS',
      async () => {
        await race(
          await edit('Text winner candidate'),
          await image(await edit('Image winner candidate')),
        );
      },
    );
    await t.test(
      'base replacement and exact-campus null override cannot partially publish',
      async () => {
        const base = await image(await edit('Base versus campus'));
        const override = f.intent(
          await f.context(b),
          'set_category_override_scoped',
          {
            categoryId: id,
            name: { mode: 'inherit' },
            description: { mode: 'inherit' },
            icon: { mode: 'set', value: null },
          },
        );
        await race(base, override);
      },
    );
    await t.test(
      'scope shrink competes with an already-ready image using the complete original domain',
      async () => {
        const replacement = await image(await edit('Ready before shrink'));
        const shrink = f.intent(
          await f.context(a),
          'set_category_scope_scoped',
          {
            categoryId: id,
            placement: { kind: 'campuses', campusIds: [f.campusA] },
            propagation: 'self',
          },
        );
        await race(replacement, shrink);
      },
    );
  },
);
