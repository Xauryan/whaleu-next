/** Fixed safe palette. Wire data supplies IDs only; caller CSS is never interpreted. */
const backgrounds = Object.freeze([
  '#CED5E9',
  '#e57373',
  '#98E9E3',
  '#ff8a65',
  '#E6C9F6',
  '#7986cb',
  '#64b5f6',
  '#81c784',
  'linear-gradient(to right, #7AA1D2, #f5c3c3, #CC95C0)',
  'linear-gradient(to right, #ffc0cb, #800080)',
  'linear-gradient(to left, #f64f59, #c471ed, #12c2e9)',
  'linear-gradient(to right, #2ebf91, #8360c3)',
  'linear-gradient(to right, #4BC0C8, #C779D0, #FEAC5E)',
  'linear-gradient(to right, #8E54E9, #4776E6)',
  'linear-gradient(to right, #89253e, #3a6186)',
  'linear-gradient(to right, #ff6a00, #ee0979)',
  'linear-gradient(to left, #45B649, #DCE35B)',
  'linear-gradient(to left, #414345, #232526)',
  'conic-gradient(from 0deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4, #feca57, #ff9ff3, #ff6b6b)',
  'linear-gradient(to left, #89fffd, #ef32d9)',
  'linear-gradient(to left, #ffc3a0, #FFAFBD)',
  'linear-gradient(to right, #db36a4, #f7ff00)',
  'linear-gradient(to left, #FDB99B, #CF8BF3, #A770EF)',
  '#fd79a8',
  'linear-gradient(to left, #91EAE4, #86A8E7, #7F7FD5)',
  'linear-gradient(to left, #FFD200, #F7971E)',
]);
export function experienceColorStyle(id: number | null): string {
  return id !== null &&
    Number.isInteger(id) &&
    id >= 0 &&
    id < backgrounds.length
    ? `background: ${backgrounds[id]};`
    : '';
}
