# Native Media foundation (S0 / S1 preparation)

This directory is an isolated single-image controller and transfer protocol. Nothing
here registers a production gateway, platform SDK, picker, page, storage provider,
content-review issuer or Community publication adapter. The default gateway fails
closed. Test-driver cases are specifications, not real-device evidence or completed
S1 acceptance.

`MediaSession.current()` checks the original account and login epoch and provides
the latest token revision. Every adapter must call it immediately before each
request and before preview side effects, honor cancellation, and avoid credential
or image persistence. `clearSession` synchronously discards only the supplied
session's SDK credentials, grant handles and preview list. The controller also
checks every promise and progress callback, removes late temporary outputs, stops
poll timers, and clears selected files and ready assets on account/epoch changes.

Local handles are adapter-owned immutable temporary snapshots. An adapter must
reject missing local bytes rather than silently re-pick or substitute a file.
Optional compression produces another handle; its actual declaration is inspected
again. Metadata is rechecked before uploads, but it is not trusted byte validation;
the server must seal and inspect actual bytes. A lost prepare response reuses the
frozen request/key; an existing intent is queried before retrying upload/finalize.
A new selection always uses a new key. Publication request IDs and receipts remain
outside this controller. Upload 100% is processing, never ready or published.

Prepare matches the API contract: UUID request/draft/space IDs, purpose
`community-post-image`, slot `images`, ordinal 0, and only MIME/bytes in the wire
declaration. Width, height and frames remain separate local inspection facts.
`select({ draftId, spaceId })` snapshots both target IDs for the selection.

Downloads accept the API's `kind: authenticated-media` binding descriptor with
the ordered thumb/display variant tuple, never URLs or cache keys. The requested
variant is a separate transfer parameter. All wire IDs are validated as UUIDs.
Descriptors require current server owner authorization on every request. No global
or persistent media cache is introduced. Preview cleanup is best effort; OS preview
or disk removal guarantees need separate platform and physical-device validation.
Explicit cancel sends a same-session intent cancellation; hide, replacement and
account changes only cancel local work. Server durable obligations and expiration
must clean abandoned intents without using a new account's authentication.

`decoders.ts` validates exact prepare/status/attachment wire shapes. The unwired
`HttpMediaGateway` uses the existing authenticated ApiClient for prepare/status/
finalize/cancel, binds requests to the supplied account/epoch, and rejects wrong
intent responses. Cancellation requires an empty 204. Grant remains explicitly
unavailable until an actual upload mode contract and provider adapter exist.
Normal runtime wiring is unchanged; these HTTP routes are not claimed live.

Community decoding now consumes the shared authenticated descriptor. Existing
Community feed/detail/thread/list/update and public-profile media grids explicitly
say images are unavailable, pending an authenticated transient-local-path UI
adapter. They no longer send legacy URLs or controlled endpoints to image tags.

Not delivered here: live HTTP routes, SDK upload plans, production
transfer adapter, compression implementation, list/detail page integration,
publication/receipt recovery, real bytes processing, full S1 end-to-end acceptance,
real providers, or real-device/production verification.
