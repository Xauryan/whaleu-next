# Related-campus publication identifiers

The related-campus API describes one canonical post and its inherited discussion.
The generated contracts are `openapi/related-campus-sync.json` and
`openapi/usable-text-workflow.json`. The rules below apply both to publication
and to its corresponding Review-submission route.

## New v4 intents

- `POST /v1/community/posts` and `POST /v1/community/reviews/posts`: when
  `syncToRelatedCampuses` is exactly `true`, `spaceId` and every
  `imageAssetIds` entry must be canonical lowercase UUIDs. The generated request
  schema expresses the conditional rule without replacing the legacy schema.
- `POST /v1/community/posts/{postId}/comments` and
  `POST /v1/community/reviews/posts/{id}/comments`: the raw post path identifier
  and every `imageAssetIds` entry must be canonical lowercase UUIDs only when
  the server-resolved canonical root is a related-sync v4 post. Children do not
  accept their own sync flag. Because the condition depends on stored root
  state, OpenAPI keeps the existing input shape and records the conditional
  constraint in the operation description and
  `x-related-canonical-identifiers` extension.
- Reply publication and Review routes retain their existing UUID
  canonicalization: the root-comment path identifier, optional `targetReplyId`
  and image identifiers become lowercase before the inherited envelope is
  constructed. This is not a new uppercase-input rejection for replies.

A well-formed UUID containing uppercase letters in a v4-only constrained field
returns HTTP 422 with `error.code = RELATED_CONTENT_CANONICAL_ID_REQUIRED`.
The error uses the existing strict `error: { code, message, requestId }` envelope.
The check runs after recovery of an existing original-key receipt and before
new Review submission or approval issuance. Ordinary malformed input retains
its existing validation behavior.

## Legacy and recovery compatibility

An omitted or `false` root sync flag retains existing none-publication UUID
handling, input schemas and hash bytes. Comments on a none root retain their
existing UUID handling. The new rule does not lowercase old none request bytes,
change existing request keys, or rewrite stored receipts.

Recover or cancel a pending historical command using its original frozen
request. Do not rewrite its identifiers or allocate a replacement key merely
because a newer v4 admission rule exists. For a fresh v4 publication, submit the
server-provided canonical identifiers before freezing its original request.

This document describes the contract. It does not claim production activation,
Review acceptance, or completed PostgreSQL or physical-device validation.
