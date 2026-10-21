# Independent profile cover media

The profile cover is a separate owner from the avatar. It has its own revision,
current pointer, immutable definitions, upload edits, command receipts, review
approvals and proof domain. Changing it does not update `profiles.revision`,
avatar state, nickname, profile details, or a post's attachments.

## Contract

- Protocol: `profile-cover-v1`; media protocol/fence namespace: `18`.
- Authenticated `GET /v1/me/profile/cover-capabilities` reports configured trusted
  upload transport, not authorization or review approval.
- Authenticated `GET /v1/me/profile/cover` returns the independent current revision.
- `POST /v1/me/profile/cover-edits` prepares a bounded JPEG/PNG declaration with
  a client request UUID, expected cover revision and `slot: cover`.
- Edit requests support exact recovery/cancellation; edits support status, grant,
  bounded multipart observation and finalization, using the same lifecycle as
  existing owner-image uploads but with separate cover authority.
- `POST /v1/me/profile/cover-commands` accepts `clear` or an exact owned custom
  edit/asset selection. The durable receipt operation is `select_cover`.
- Command recovery/cancellation use `/cover-command-requests/:id` and `/cancel`.
- Public projection: `GET /v1/profiles/:id/cover`.
- Exact first-party bytes: `GET /v1/profiles/:id/cover/:appearanceId/:variant`.
- No catalog, arbitrary URL, external provider locator or caller-supplied review
  approval is accepted. See `docs/openapi/profile-cover.json` for exact codecs.

## Security and operation

The production runtime token defaults to null. This does not configure storage,
an isolated image processor, content review issuers or any provider. Upload
capability therefore remains unavailable until a separately verified deployment
supplies these dependencies. There is no in-process decoder fallback or synthetic
approval in application code.

Shared infrastructure retains bounded ingress, exact digest declarations,
immutable storage, isolated image processing, safety review, expiry and cleanup.
Selection additionally requires an independent exact cover review envelope;
an allowed avatar review or sanitized image is not sufficient. Reads and byte
delivery revalidate active accounts, session authority, profile blocks in either
direction, current pointer/revision, review revocation and exact media ownership.
Delivery is budgeted and private/no-store. Invalid credentials never become guests.

Replacement detaches old bindings atomically. Same-key retry returns historical
receipts without restoring old content. Unknown outcomes require journal recovery;
changing accounts is not permission to reuse a pending request. Clear can retire
an existing cover without an active upload runtime, but still requires the exact
selection review and current authorization. A committed clear projects as none.

## Validation status

Focused codec, owner-proof, route-inventory, cross-purpose and SQL-preservation
unit tests run locally. The disposable PostgreSQL suite
`apps/api/test/integration/profile-cover-media.test.ts` exercises real synthetic
prepare/upload/process/review, selection, replacement, clear, retry, cross-account
rejection, block visibility and review revocation. It must run with the repository's
integration database setup. No PostgreSQL runtime is available in the current
workspace, so migrations 0162/0163 and that suite have not been executed here.
This is not operational upload or production acceptance evidence.
