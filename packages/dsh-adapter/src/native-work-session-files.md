# Run accepted-file reader

Refs #33 and #35. This is a Host-only consumer of the existing execution/file
domains and upstream attachment store. It does not add an HTTP route, chat
database, artifact submission path or Agent factory.

## Authority and fixed source

`ExecutionService.createRunAcceptedFiles(originalIssuer, resources)` captures the
same installed Run issuer, attachment producer and file ledger. `resources`
provides a lifetime signal and synchronous producer-identity check; it grants no
member/file authority. The original issuer checks its issued grant object on
every operation and before exposing a result.

The full scope contains actor, space, task, plan/revision, node, Run, generation
and segment. The actor is the actual authenticated controlling member. The expert
executor stays in the frozen composition; it is never impersonated as a member.
The Run must explicitly freeze `read_accepted_file`. Old compositions do not gain
this capability when the new reader is installed.

`inputRef` selects exactly one frozen context input. It must still match the
current downstream handoff, the upstream accepted artifact/version and the
complete file-ledger/source tuple. A hash, path, owner claim or latest-version
lookup is not authority. Human `fileContent` authorization remains unchanged.

## Owned results

- `list(grant, { inputRef }, signal)` returns copied scope/provenance and file
  metadata plus a Host-only synchronous `check()`. Listing does not read bytes.
- `read(grant, { inputRef, fileId, offset, length }, signal)` verifies the complete
  SDK object before returning a copied selected byte range, provenance,
  classification, signal, `check()` and idempotent `release()`.
- The original member/Run, accepted source and file ledger are checked before
  opening the SDK stream, during reads, after full verification and on final
  publication. Stop, revocation, source replacement and producer closure reject
  outstanding results.

The physical read shares the existing 20 MiB/file, 60-second verification and
eight-read/space quota. Cancellation does not release an SDK resource before its
actual iterator drains. The native tool may report its five-second logical
deadline while that owned work still drains.

## Native tool and assembly

`describeNativeAcceptedFileTool()` and `registerNativeAcceptedFileTool()` use the
same copied definition, `read_accepted_file` / `zhuma-accepted-files@2`.
The flat object parameter description and disjoint `oneOf` result use the fixed
SDK's supported subset; module initialization validates both with its public
schema helpers. Conditional fields and all identifier/numeric/string bounds
still pass through the strict runtime parser. The rejected initial v1 Zod JSON
description is not silently replaced in a saved configuration.
`part: files` lists metadata. `part: file` reads a selected range, default offset
zero and length 4096, at most 8192 bytes. UTF-8 decoding is fatal and preserves a
BOM; a split character, binary object, PDF or image never becomes guessed text.
There is no URL fetch, automatic whole-file prompt or rendering capability.

The original native Agent object, registry entry, binding and grant are checked
at execution and finalization. Only whitelisted JSON is sent to the model;
grants, functions, Cookies and local provider paths are never serialized.
Finalization checks the source again and rejects policy-replaced content.

All file/list calls share `reserveInputRead` / `finishInputRead` with the existing
text/links tool: 16 attempts, 64 KiB total output and at most 24 KiB per page.
Abandoned physical work retains that same reservation until drain. Whole-object
verification can therefore total at most 320 MiB for a Run's 16 input attempts.

D owns frozen descriptor/configuration and compatibility validation. A owns
public exports, official Host assembly and normal Client/transport/verification
registration. Assembly passes the existing opened grant and same original
issuer/reader into the original native Agent scope; it must not create another
issuer, append a second catalog or widen an old snapshot. Real model, GUI and
automatic expert submission remain separate acceptance boundaries.

## Verification surfaces

`native-work-session-files.test.mjs` uses original member Cookies, Run issuance,
execution/file domains, SDK attachment bytes and JSON storage. Only model/tool
configuration selection is a fixture. It covers fixed V2 reads, original-issuer
identity, old source/file denial, current source/ledger checks, real logout/Stop,
missing/corrupt provider objects and fresh-owner storage reopening.

`native-work-session-files.spec.ts` runs against the pinned patched source SDK
with the default Agent factory. Scripted model output requests actual scoped
tools; it does not prove model reasoning or quality. It covers exact UTF-8/BOM
bytes, one shared attempts/bytes ledger, last-mile source/value guards, a
same-ID Agent proxy, binary metadata and a held SDK iterator which must drain
before its original reservation becomes idle. The held iterator is explicit
fault injection around the real SDK source, not a claim about an operating
system hang.

The same spec has independent-process write/read phases controlled by
`ZHUMA_NATIVE_FILE_REOPEN_ROOT` and `ZHUMA_NATIVE_FILE_REOPEN_MODE`. The writer
uses the native file tool, then closes the owner. The reader logs in again,
obtains a fresh original issuer grant and reads the same accepted V2 bytes from
storage without constructing an Agent or calling a model. These are component
proofs; official Host/Client/GUI and paid-model validation stay with their own
integration and acceptance evidence.
