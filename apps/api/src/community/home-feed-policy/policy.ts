import { legacyHomePlainText } from './legacy-plain-text.js';
import { trimLegacyHomeText } from './php-text.js';
export { trimLegacyHomeText } from './php-text.js';

/** Pure rebuilt policy, not runtime authority or a legacy-to-native mapping.
 * Source: WhaleUCampus/WhaleU@4494e36b9451e3a92874ccf85f574a36e28e3d48
 * HomeFeedPolicy.php blob 77c7c5d10ee93a30974b3cf0d0d05d5439c12c8e.
 * The caller must prove canonical source, original category mapping, actual
 * accessories and audit authority before using a result. No identity is input
 * or output. This module does not alter source text, hashes or detail access. */
export const LEGACY_HOME_POLICY_COMMIT =
  '4494e36b9451e3a92874ccf85f574a36e28e3d48' as const;

/** This is explicitly an OLD source-domain number, not a new Category ordinal.
 * Construction does not establish an accepted operator mapping. */
export interface OriginalLegacyHomeCategory {
  readonly sourceCommit: typeof LEGACY_HOME_POLICY_COMMIT;
  readonly choose: number;
}
export interface HomePolicyInput {
  readonly originalCategory: OriginalLegacyHomeCategory | null;
  readonly text: string;
  readonly format: 'plain' | 'markdown';
  readonly hasImages: boolean;
  readonly hasPoll: boolean;
  readonly hasGroup: boolean;
  readonly hasLink: boolean;
  readonly auditExempt: boolean;
}
export interface LegacyHomeRestriction {
  readonly reason: 'short_text' | 'reference_only';
  /** Old effect only. A caller must separately map it to a supported taxonomy. */
  readonly legacyWaterChoose: 9;
  readonly homeAudience: 'author_only';
  readonly officialPushEligible: false;
  readonly groupPushEligible: false;
  readonly syncToRelatedCampuses: false;
}
export type HomePolicyDecision =
  | Readonly<{
      status: 'resolved';
      restriction: Readonly<LegacyHomeRestriction> | null;
    }>
  | Readonly<{
      status: 'unavailable';
      reason: 'invalid_normalized_input' | 'original_category_mapping_required';
    }>;

/** Source-reference token boundary copied from ContentReferenceTextService.
 * This is lexical navigation syntax, never referenced-content authorization. */
const token = /(?<![A-Za-z0-9_/#\\])#[1-9][0-9]{6,8}(?![A-Za-z0-9_])/gu;
const fullReferences =
  /^[\t\n\v\f\r\u0085\u180e\p{Z}]*(?:#[1-9][0-9]{6,8}[\t\n\v\f\r\u0085\u180e\p{Z}]*)+$/u;
const explicitUrl =
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\t\n\v\f\r\u0085\u180e\p{Z}<>"，。！？；、（）【】]+/gu;

/** Source-order lexical port of DeepSeaReferencePolicy::codes. This does not
 * claim to replace ContentPlainTextService::convert or a Markdown renderer. */
export function legacyHomeReferenceCodes(
  content: string,
  format: 'plain' | 'markdown',
): readonly string[] {
  let text = content;
  if (format === 'markdown') {
    const lines = text.split(/\r\n|[\n\v\f\r\u0085\u2028\u2029]/u);
    const body: string[] = [];
    let fence: { character: string; length: number } | null = null;
    for (const line of lines) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (match) {
        const spelling = match[1]!;
        if (fence === null)
          fence = { character: spelling[0]!, length: spelling.length };
        else if (
          spelling[0] === fence.character &&
          spelling.length >= fence.length &&
          trimLegacyHomeText(match[2]!) === ''
        )
          fence = null;
        continue;
      }
      if (fence === null && !/^ {0,3}\[[^\]]+\]:/u.test(line)) body.push(line);
    }
    text = body.join('\n');
    text = text.replace(/(`+).*?\1/gsu, '');
    text = text.replace(
      /!?\[[^\]]*\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\])/gu,
      '',
    );
  }
  text = text.replace(explicitUrl, '');
  return Object.freeze([
    ...new Set([...text.matchAll(token)].map((match) => match[0].slice(1))),
  ]);
}

function onlyPlainReferences(text: string, codes: readonly string[]): boolean {
  const complete = fullReferences.exec(text);
  if (!complete || complete[0].length !== text.length) return false;
  const recognized = new Set(codes);
  // The PHP source compares value sets, not offsets. Adjacent identical tokens
  // can pass even when the second token lacks an independent lexical boundary.
  // Preserve that fixed-source behavior rather than silently tightening it.
  return [...text.matchAll(/#([1-9][0-9]{6,8})/gu)].every((match) =>
    recognized.has(match[1]!),
  );
}

function invalidInput(input: HomePolicyInput): boolean {
  if (
    !input ||
    typeof input.text !== 'string' ||
    (input.format !== 'plain' && input.format !== 'markdown') ||
    [
      input.hasImages,
      input.hasPoll,
      input.hasGroup,
      input.hasLink,
      input.auditExempt,
    ].some((value) => typeof value !== 'boolean')
  )
    return true;
  // This pure boundary receives the already-normalized maximum-2500 source.
  // Unpaired UTF-16 has no corresponding valid legacy UTF-8 source character.
  if (input.text.length > 5000) return true;
  let count = 0;
  for (const character of input.text) {
    const codepoint = character.codePointAt(0)!;
    if ((codepoint >= 0xd800 && codepoint <= 0xdfff) || ++count > 2500)
      return true;
  }
  return false;
}

const noRestriction = Object.freeze({
  status: 'resolved',
  restriction: null,
} as const);
function restrict(reason: LegacyHomeRestriction['reason']): HomePolicyDecision {
  return Object.freeze({
    status: 'resolved',
    restriction: Object.freeze({
      reason,
      legacyWaterChoose: 9,
      homeAudience: 'author_only',
      officialPushEligible: false,
      groupPushEligible: false,
      syncToRelatedCampuses: false,
    }),
  });
}

export function evaluateLegacyHomePolicy(
  input: HomePolicyInput,
): HomePolicyDecision {
  if (invalidInput(input))
    return { status: 'unavailable', reason: 'invalid_normalized_input' };
  const category = input.originalCategory;
  if (
    category === null ||
    !category ||
    category.sourceCommit !== LEGACY_HOME_POLICY_COMMIT ||
    !Number.isSafeInteger(category.choose)
  )
    return {
      status: 'unavailable',
      reason: 'original_category_mapping_required',
    };
  if (
    category.choose <= 0 ||
    category.choose > 100 ||
    category.choose === 3 ||
    input.auditExempt ||
    input.hasImages ||
    input.hasPoll ||
    input.hasGroup ||
    input.hasLink
  )
    return noRestriction;
  const content = trimLegacyHomeText(input.text);
  if ([...content].length <= 3) return restrict('short_text');
  const codes = legacyHomeReferenceCodes(content, input.format);
  if (!codes.length) return noRestriction;
  if (input.format === 'markdown') {
    if (/`|!\[|(?:^|\n) {0,3}~{3,}/u.test(content)) return noRestriction;
  }
  return onlyPlainReferences(legacyHomePlainText(content, input.format), codes)
    ? restrict('reference_only')
    : noRestriction;
}
