import { ClientError } from '../api/errors';
function invalidRating(): never {
  throw new ClientError('protocol', 'Invalid rating data');
}
export function canonicalRatingText(
  value: unknown,
  maximum = 500,
  required = true,
): string {
  if (typeof value !== 'string' || value.length > maximum * 2 + 100)
    invalidRating();
  const text = value.replace(/\r\n/g, '\n').trim();
  if (
    (required && text.length === 0) ||
    [...text].length > maximum ||
    [...text].some((c) => {
      const n = c.codePointAt(0)!;
      return !(
        n === 9 ||
        n === 10 ||
        (n >= 32 && !(n >= 127 && n <= 159) && !(n >= 0xd800 && n <= 0xdfff))
      );
    })
  )
    invalidRating();
  return text;
}
export function outputText(
  value: unknown,
  maximum: number,
  required = true,
): string {
  const text = canonicalRatingText(value, maximum, required);
  if (text !== value) invalidRating();
  return text;
}
