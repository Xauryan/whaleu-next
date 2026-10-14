# Purpose-specific rating assistance

This owner is intentionally synthetic-only and disabled in the normal application.
`ASSISTANCE_RUNTIME` is registered as `null`; no environment variable, endpoint,
credential lookup, model selector, startup worker, or external fee is introduced.
The existing semantic-search runtime does not authorize this generation owner.

## User journeys

- Category creation/system category creation can request one root description.
  The response is private preview material. A fresh result read and explicit
  adoption precede editing and the existing category Review/prepare/commit flow.
- An accepted generic course/canteen target can be attached as one typed card to
  a text-only regional discussion. The question label is separate from post text.
  Manual fallback and editing remain usable when generation is unavailable.
  The exact final body, label and target binding require the new Community v5
  Review path. Generation itself never approves or publishes content.

Generation/adoption/preparation require exact current revisions. After publication,
ordinary accepted same-target name/description edits preserve original post body,
label, Review and receipt. Current display name is independently qualified by
Ratings. Actual target denial or unknown proof closes linked roots/descendants;
no historical label or name is a fallback authorization.

## Private request protocol

The four `/v2/ratings/assistance/requests` routes admit, inspect metadata, read a
currently qualified result and cancel an original request. Status/result reads
never dispatch a provider. All branches use `no-store` and authorization variance.
Request, input and result hashes use separate v1 domains. The maximum complete
request is 65,536 bytes and retains the existing complete 1,000-campus placement.
Only a proposed category name plus `rating_category`, or a currently qualified
target name plus `course`/`canteen`, reaches the synthetic generation boundary.
Provider keys are opaque hashes, not account/session identifiers.

The ledger separates immutable claims/outcomes, expiring private payloads,
leased jobs, append-only attempts and usage settlements. Admission is atomic
under database quota locks. A result requires matching original intent, input,
profile, current source/destination proofs, exact attempt/fence and actual final
SQL deadlines. Cancellation has an independent durable visibility latch: an
already generated original receipt stays intact while future plaintext reads
close. Expiry/cancellation never deletes original keys or accounting.

## Complete card proof limits

Card counts accept at most 256 candidate posts, at most 768 ancestry occurrences,
and a shared 4 MiB complete snapshot budget. These are simultaneous upper bounds,
not a guarantee that every maximum-cardinality vector fits. The budget includes
Community definitions, current scope/source facts, category ancestry, target
placement and Review evidence. A complex catalog can exhaust the byte budget
before the ancestry query executes; its result is `unknown`, never an invented
zero or an authorization allow. Current source facts are not omitted to make a
batch fit, and the existing proof deadlines remain unchanged.

Acceptance distinguishes a measured, within-budget multi-card vector whose
results must all allow from a complete 256-card fixture whose fail-closed result
must be attributed to an observed byte charge exceeding the actual remaining
ledger. Persisted ancestry cardinality is reported separately from executed
ancestry query rows. An independent oversized Review proof also exercises the
SQL byte sentinel and recovery after a valid successor. Source-only cost
estimates are not capacity measurements.

## Bounded synthetic operation

`RatingAssistanceService.process` requires the original current session for a
new dispatch. It records unknown-before-effect, commits all current owner proofs,
and only then consumes a synchronous one-use synthetic permit. A lost response
never authorizes blind resend. `reconcilePending` is status-only, at most eight
original attempts per invocation; three status checks are followed by conservative
reserved usage settlement if acceptance remains unresolved. It also works after
cancellation or private payload cleanup. Neither method is scheduled at startup.
`cleanup` removes at most 100 expired request/result payload pairs per invocation.

Every attempt reserves 512 input and 64 output tokens with monetary cost exactly
zero. Provider usage must remain within those fixed bounds. A real adapter is
not supported by this runtime contract.

## Activation and acceptance

External activation is a separate decision covering provider/legal entity,
model/profile/protocol, exact permitted data, retention/training terms, endpoints,
account ownership, credentials/persistent access, currency budgets, reconciliation,
quality/safety evaluation, deployment/egress and physical-device acceptance.
Synthetic results prove none of those external conditions.

The implementation requires focused source, normal HTTP/AppModule, actual
PostgreSQL causal/race, emitted-native, historical in-flight v1–v4 compatibility,
full repository and exact hosted artifact acceptance. Passing contract tests
alone is not an end-to-end acceptance result. Test fixtures use disposable local
owner facts and injected synthetic transports only.
