/** Feature-only mandatory source decoder and optional lossless presentation. */
import { ClientError, isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import {
  canonicalSourceText,
  decodeTextSourceDescriptor,
  textSourceHash,
  sourceEligible,
  sourceTextAvailable,
  type SourceKind,
  type TextSourceDescriptor,
} from './text-source-contract';
function invalid(): never {
  throw new ClientError('protocol', 'Invalid immutable text source');
}
function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid();
}
interface SourceIdentity {
  readonly version: 1;
  readonly kind: SourceKind;
  readonly id: string;
  readonly postId: string;
  readonly rootCommentId: string | null;
  readonly text: string;
}
export type TextSourceRead = SourceIdentity &
  (
    | Readonly<{ classification: 'legacyPlain' }>
    | Readonly<{
        classification: 'reviewedSource';
        sourceRevision: 1;
        textSource: TextSourceDescriptor & { readonly sourceHash: string };
        readingFormattingEligible: boolean;
        presentationStatus: 'not_configured' | 'ineligible';
      }>
  );
export interface SourcePresentation {
  readonly version: 2;
  readonly source: TextSourceRead;
  readonly presentation:
    | Readonly<{ status: 'source' }>
    | Readonly<{ status: 'formatted'; plan: ReadingPlan }>;
}
export interface ReadingPlan {
  readonly version: 1;
  readonly formatter: 'plain-cjk-slices-v2';
  readonly offsetEncoding: 'utf16';
  readonly mode: 'unchanged' | 'grouped';
  readonly reason:
    | 'grouped'
    | 'no_safe_boundary'
    | 'structure_sensitive'
    | 'unsupported_unicode';
  readonly spans: readonly Readonly<{ start: number; end: number }>[];
}
export function decodeTextSourceRead(raw: unknown): TextSourceRead {
  if (!isRecord(raw)) invalid();
  const reviewed = raw.classification === 'reviewedSource';
  exact(raw, [
    'version',
    'classification',
    'kind',
    'id',
    'postId',
    'rootCommentId',
    'text',
    ...(reviewed
      ? [
          'sourceRevision',
          'textSource',
          'readingFormattingEligible',
          'presentationStatus',
        ]
      : []),
  ]);
  const canonicalId = (v: unknown): v is string =>
    isUuid(v) && v === v.toLowerCase();
  if (
    raw.version !== 1 ||
    !['post', 'comment', 'reply'].includes(String(raw.kind)) ||
    !canonicalId(raw.id) ||
    !canonicalId(raw.postId) ||
    !(raw.rootCommentId === null || canonicalId(raw.rootCommentId)) ||
    (!reviewed && raw.classification !== 'legacyPlain')
  )
    invalid();
  const kind = raw.kind as SourceKind;
  if (
    (kind === 'post' &&
      (raw.postId !== raw.id || raw.rootCommentId !== null)) ||
    (kind === 'comment' && raw.rootCommentId !== raw.id) ||
    (kind === 'reply' && raw.rootCommentId === null)
  )
    invalid();
  const text = canonicalSourceText(raw.text, kind);
  if (text !== raw.text) invalid();
  const identity: SourceIdentity = {
    version: 1,
    kind,
    id: raw.id,
    postId: raw.postId,
    rootCommentId: raw.rootCommentId,
    text,
  };
  if (!reviewed)
    return Object.freeze({ ...identity, classification: 'legacyPlain' });
  if (!isRecord(raw.textSource)) invalid();
  const { sourceHash, ...syntax } = raw.textSource;
  const descriptor = decodeTextSourceDescriptor(syntax);
  const eligible = sourceEligible(text, descriptor, kind);
  if (
    raw.sourceRevision !== 1 ||
    typeof sourceHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sourceHash) ||
    sourceHash !== textSourceHash(text, descriptor) ||
    !sourceTextAvailable(text, descriptor) ||
    raw.readingFormattingEligible !== eligible ||
    raw.presentationStatus !== (eligible ? 'not_configured' : 'ineligible')
  )
    invalid();
  return Object.freeze({
    ...identity,
    classification: 'reviewedSource',
    sourceRevision: 1,
    textSource: Object.freeze({ ...descriptor, sourceHash }),
    readingFormattingEligible: eligible,
    presentationStatus: eligible ? 'not_configured' : 'ineligible',
  });
}
function decodePlan(raw: unknown, source: TextSourceRead): ReadingPlan {
  exact(raw, [
    'version',
    'formatter',
    'offsetEncoding',
    'mode',
    'reason',
    'spans',
  ]);
  if (
    source.classification !== 'reviewedSource' ||
    !source.readingFormattingEligible ||
    raw.version !== 1 ||
    raw.formatter !== 'plain-cjk-slices-v2' ||
    raw.offsetEncoding !== 'utf16' ||
    !['unchanged', 'grouped'].includes(String(raw.mode)) ||
    ![
      'grouped',
      'no_safe_boundary',
      'structure_sensitive',
      'unsupported_unicode',
    ].includes(String(raw.reason)) ||
    !Array.isArray(raw.spans) ||
    raw.spans.length < 1 ||
    raw.spans.length > 26 ||
    JSON.stringify(raw).length > 8192
  )
    invalid();
  if (
    (raw.mode === 'grouped') !== (raw.reason === 'grouped') ||
    (raw.mode === 'unchanged' && raw.spans.length !== 1) ||
    (raw.mode === 'grouped' && raw.spans.length < 2)
  )
    invalid();
  let cursor = 0;
  const boundary = (i: number) =>
    !(
      i > 0 &&
      i < source.text.length &&
      /[\uD800-\uDBFF]/.test(source.text[i - 1]!) &&
      /[\uDC00-\uDFFF]/.test(source.text[i]!)
    );
  const spans = raw.spans.map((span: unknown) => {
    exact(span, ['start', 'end']);
    if (
      typeof span.start !== 'number' ||
      typeof span.end !== 'number' ||
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start !== cursor ||
      span.end <= span.start ||
      span.end > source.text.length ||
      !boundary(span.start) ||
      !boundary(span.end)
    )
      invalid();
    cursor = span.end;
    return Object.freeze({ start: span.start, end: span.end });
  });
  if (cursor !== source.text.length) invalid();
  return Object.freeze({
    version: 1,
    formatter: 'plain-cjk-slices-v2',
    offsetEncoding: 'utf16',
    mode: raw.mode as ReadingPlan['mode'],
    reason: raw.reason as ReadingPlan['reason'],
    spans: Object.freeze(spans),
  });
}
/** Only optional presentation may fall back, after strict mandatory source decoding.
 * HTTP/auth/source errors are never accepted here as cached-source permission. */
export function decodeSourcePresentation(raw: unknown): SourcePresentation {
  exact(raw, ['version', 'source', 'presentation']);
  if (raw.version !== 2) invalid();
  const source = decodeTextSourceRead(raw.source);
  try {
    if (!isRecord(raw.presentation)) invalid();
    if (raw.presentation.status === 'source') {
      exact(raw.presentation, ['status']);
      return Object.freeze<SourcePresentation>({
        version: 2,
        source,
        presentation: { status: 'source' },
      });
    }
    exact(raw.presentation, ['status', 'plan']);
    if (raw.presentation.status !== 'formatted') invalid();
    return Object.freeze<SourcePresentation>({
      version: 2,
      source,
      presentation: {
        status: 'formatted',
        plan: decodePlan(raw.presentation.plan, source),
      },
    });
  } catch {
    return Object.freeze<SourcePresentation>({
      version: 2,
      source,
      presentation: { status: 'source' },
    });
  }
}
