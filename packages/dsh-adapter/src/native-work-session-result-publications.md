# Fixed native publication results

Refs #33 and #35. `complete_work@2` selects published files for the original
fixed-result lifecycle. A declaration, a fixed result, a business submission,
review acceptance and downstream release remain separate facts.

## One owner, two explicit protocols

Create `createNativeFixedResultPublicationsIssuer(ctx, sessions, runtime,
originalAuthorities, execution, originalOutputFileIssuer)` once for the same
original native services, runtime, Run manager and publication issuer. The
publication owner is checked by original object identity. Do not create a
second legacy result owner on those sessions.

The returned issuer exposes a readonly `v1Issuer: NativeFixedResultIssuer` view.
Both views share the original registration, preparation, assertion, notification
and close functions and one owner/cache/queue/lifecycle. Register the completion
tool once per native Agent and subscribe to `onReady` once. Each Run's exact
frozen descriptor selects its protocol; installing publication support does not
upgrade an existing v1 or absent snapshot. Typed v1 and v2 reads reject the
other protocol's result instead of returning an incompatible lease.

The existing `createNativeFixedResultIssuer` remains a v1-only entry. Its exact
getter, parser, text/link digest and lease shape stay unchanged. D selects its
installed result port from the stored composition's `sourceVersion`; no Client
flag, claimed digest or guessed lease fields select a protocol. Public exports,
formal Host assembly and normal Client adoption belong to A; business delivery
and protocol-2 Run records belong to D.

## Declaration and fixed manifest

The new exact getter is `describeNativeResultPublicationsTool()`, source version
`zhuma-native-result-intent@2`, with the same SDK tool name `complete_work`.
Strict model arguments are `{ text?, links, publications: [{ publicationId }] }`:
at most 100000 text characters, 20 safe HTTP(S) links and 20 unique publication
selectors. Paths, file bytes, hashes, scope and file metadata are rejected.

For every selected ID, the original private SDK snapshot must contain an
unambiguous linked `publish_output_file` call and successful ACK before the
completion call. Call/result source sequences, turn/step, original call ID,
relative-path selector fingerprint and ACK metadata must match. Inherited,
foreign, late or fabricated evidence cannot qualify. The full member, task
space, node/plan/revision, Run/generation/segment, native IDs, configuration and
expert version must match the original binding and completed file ledger.

The original output issuer's `readCompletedPublication` consumes the original
factory's `readCompleted(grant, { source, publicationId }, signal)`. That seam
requires genuine history/open authority and returns copied completed records
with `signal` and synchronous `check()`. It does no FS/stat/read/save, slot
reservation, node mutation or JSON write, and needs no current publication or
send permission. It does not itself authenticate a completion cut.

After materializing actual file references, `validateDeliveryContent` applies
the existing core semantics before the declared ACK. Publishing a zero-byte
file is valid; zero-byte attachments alone cannot declare nonempty work, while
valid text/links may accompany them. The same validation runs when qualifying
or reopening the fixed result.

Only then is version-2 intent metadata stored through the original send queue
and the original native turn concluded. Outside that tool stack, the owner
requires the exact completion call/ACK/completed-turn chain, joins original
input reads and writer retirement, requalifies after the flushed-and-closed
barrier and seals the original SDK cut. No new conversation or file fact store
is introduced. Capacity, cancellation and physical-drain gates remain shared.

## Trusted result lease

`readFixedResult` on the v2 view returns:

- `source`: the original scope, native IDs, configuration, intent/call IDs and
  cut, with tool version 2, `expertVersionId` and `manifestDigest`.
- `content`: a real `ArtifactDraft`; `files` comes exclusively from the matched
  completed records.
- `manifest`: an ordered array of `{ evidence, record }`. Evidence contains
  publication ID, original source, publish call/result sequences, selector
  fingerprint and fixed metadata. `record` is the complete trusted ledger row.
- `manifestDigest`, `digest`, `provenanceFingerprint`, `signal`, `check()` and
  `release()`.

`manifestDigest` hashes `{ version: 1, publications: manifest }`. The result
digest hashes `{ protocolVersion: 2, text: text ?? null, links, publications,
manifestDigest }`; selectors retain their declared order. The provenance
fingerprint retains `hash({ source, digest })`, which now binds the full
manifest digest, expert identity and completed native cut. No manifest entry
contains a Host path or file body. V2 source/content/manifest data and the lease
wrapper are frozen; checks revalidate the original grant, owner, SDK snapshot,
retirement proof and current immutable ledger records. Copies of refs or grants
cannot authenticate a result.

D still verifies the actual attachment bytes outside its command queue,
rechecks original authority immediately before its single business write, and
uses its existing fixed artifacts, review rounds and downstream rules. A valid
C lease is not evidence that bytes remain available or that D submitted them.

## Compatibility and evidence boundary

Binding metadata retains its existing shape for absent/v1 intent. A strict
discriminated intent union adds v2 metadata and its manifest digest; old strict
v1 readers refuse v2 instead of dropping fields. SDK history remains the source
of content and publication selections. Fresh-owner recovery reconstructs a new
genuine reference from the original log and completed ledger, never from a
serialized capability or a source-file reread.

The contract tests use synthetic event/metadata shapes and grant no authority.
The SDK spec uses original member Cookies, Run issuance, native Agent/tool/log
objects, filesystem/attachment/JSON bytes and explicit fixture Host grants with
a scripted model. It covers fixed files, fresh-owner reopening, wrong sources,
Stop/logout, cancelled retirement, dual protocols on one owner, original v1
Service submission and real zero-byte publication semantics. Fresh-owner
reopening in this component spec is in one OS process. It does not certify
normal Host/Client wiring, a new OS process, real provider reasoning, packaging
or GUI behavior; those integrations require their own actual evidence.

## Process exit after the native cut, before business submission

The separate `native-work-session-result-process.spec.ts` and its private
`native-work-session-result-process-driver.mjs` exercise two actual OS processes.
The driver takes an isolated original SDK checkout, its source-alias test config
with the original `thread-safe` project, and its Vitest CLI as three explicit
arguments. It does not alter the SDK or add a product Host entry.

The producer uses original member login, Run issuance, native tools, JSONL and
upload/attachment storage. After the completed native cut is durable and a fixed
lease has been checked, the driver kills the producer's dedicated process group
with `SIGKILL`, without normal shutdown or business submission, and deletes the
original output source. The atomic evidence marker and exit signal prove this
boundary; the killed producer is not reported as a successful CLI test.

The second process logs in fresh members, obtains genuine history-only metadata
authority and the original drive authority required by the fixed-result protocol,
and reconstructs the same source, cut, content, files, full manifest and digests.
It verifies the original attachment bytes without a model call, Agent creation,
workspace-file stat/read, republishing or business artifact. A wrong actual member
is refused without any additional fact write. Binding, Run, file and workbench
JSON bytes and mtimes, JSONL events, attachment bytes and the file set are checked.

Requalifying an already identical sealed cut keeps the original source and
authority checks but skips the redundant binding write. The SDK's genuine
exclusive retirement barrier still touches its existing empty lock file; the
test records that operational lock activity separately. Fresh member login's
identity-session write is likewise recorded before the recovery baseline. Neither
is presented as a business fact or event write. This component proof does not
certify a normal compiled Host/Client, real provider, review/downstream or package.
