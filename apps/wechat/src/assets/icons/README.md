# WhaleU native icon system

Original vectors authored for WhaleU, using a 24 × 24 grid, round caps and joins, and an optically consistent 1.7-point stroke. These assets are not extracted, traced, or redistributed from SF Symbols. The four filled navigation variants use intentional silhouettes rather than heavier outline strokes.

`source/*.svg` is the editable source of truth. Native Mini Program rendering uses local 72 × 72 transparent PNGs: 3× assets at the default 24px display size. The light/dark neutral tones are #1d1d1f / #f5f5f7; accent is #007aff. The `default` tone automatically follows the OS theme. Semantic color variants are available for tinted feature tiles.

Register `wu-icon` as `/components/icon/icon`, then use `<wu-icon name="home" tone="default" size="24" />`. Omit `tone` and `size` to use defaults. Available tones: default, inverse, accent, blue, orange, purple, green, pink, white, muted. Selected tabs use the `home-filled`, `campus-filled`, `message-filled`, or `person-filled` name with tone="accent". The image is decorative; put the accessible action label on its parent button.

All names and color values are in `manifest.json`. Rebuild checked-in native assets from the project root with:

    node apps/wechat/src/assets/icons/generate.mjs

The generator uses Sharp already available in the workspace; rendering does not depend on Sharp or SVG support. A PNG contact sheet is saved in `source/contact-sheet.png` for visual review.
