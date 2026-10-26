# Native Run output-file publisher

Refs #33 and #35. This Host-only seam publishes an existing file into the
original attachment store and `zhuma_files` table. Publication is an immutable
file receipt; it does not submit an artifact, complete a Run, approve a review,
or release downstream work.

## Assembly and authority

After installing the original Run Host, construct one
`createNativeOutputFileIssuer(ctx, sessions, originalAuthorities, execution,
resolveBytes)` for those same native sessions. Register its
`registerNativeOutputFileTool(agentCtx, binding, originalGrant)` during normal
Agent composition. The default Agent factory and SDK history remain unchanged.
A owns public exports and formal Host/Client assembly.

The resolver must return a `NativeOutputFileByteProducer` built from the original
`NativeRunLocalToolProducer`, its Host-issued workspace capability and a separate
`NativeOutputPublicationAuthority`. This publication authority pins the full
member/space/task/plan/revision/node/Run/generation/segment scope, configuration,
lifetime and allowed relative file/directory ranges. Workspace read access alone
never grants publication. Assertions are synchronous and return only
`undefined`; a promise does not authorize work. There is no default workspace,
fallback root, browser-provided permission, or model-inferred grant.

The frozen Run must explicitly contain the exact
`describeNativeOutputFileTool()` descriptor and `publish_output_file` allowlist
entry. Old absent snapshots retain their prior behavior. The publisher getter
is `zhuma-native-output-file@1`; it does not alter `complete_work@1`.

## Byte adoption and shared limits

Model arguments are strictly `{ path, name? }`. Paths are relative and cannot
contain traversal, absolute/drive paths, URI syntax, backslashes or symlink
components. The Host resolves through the original filesystem, checks canonical
containment and a regular file, and verifies target/version/length before and
after a bounded raw binary read. SHA-256 covers those actual bytes. This is
adoption of a verified read, not an operating-system filesystem snapshot.

`ExecutionService.createRunOutputFiles(originalAuthorities, resources)` uses the
existing command queue, attachment store, file ledger and pending-upload map.
Native and human uploads share eight slots per space, 20 MiB per file, 100 MiB
per node and the existing space-file quota. A Run can publish at most 20 files.
The original EOS, byte count, attachment digest/name and current authority are
checked before the completed receipt is written. The real controlling member
is `uploadedBy`; expert/native-call provenance lives in `producer`.

Each request explicitly selects `mode: 'lookup'` or `mode: 'reserve'`. Lookup
permits no `maximumBytes`: matching completed source/call/selector/name returns
the same receipt, and absence returns `not-found`. It performs no filesystem
read/stat, slot reservation, ledger write or node mutation. Reserve requires a
bounded `maximumBytes`; conflicting in-flight or changed selectors cannot
create another publication. The service source is Host-issued, not model input.

The reservation exposes `signal`, `check()`, `publish()`, `releaseAfter()` and
`drain`. Release is idempotent and prevents further publication. Its shared slot
is retained until both the external filesystem drain and actual SDK upload
drain settle. Logical cancellation does not prove physical cleanup. Original
Agent-scope disposal joins these owned operations.

## Receipts and compatibility

The tool acknowledgement contains only immutable file metadata and native Run
provenance, never byte content or a Host path. The ledger stores only a selector
fingerprint. A successful tool finalization enables an opaque original-owner
`NativePublishedFileRef`. `publishedFile(grant, publicationId)` and
`readPublishedFile(grant, genuineRef)` expose a guarded copied metadata lease;
cloned grants/refs, changed projections and revoked authority fail. Reading
already-published metadata after writer retirement needs no new filesystem or
publication permission. A future completion consumer must independently verify
the original durable publish-call/success-ACK chain and fixed manifest; this
publisher alone does not certify that chain or submit files.

Human records remain byte-compatible in the same version-1 table. Native records
add strict optional `producer: { kind: 'native-run-output', version: 1, ... }`.
The prior strict record reader rejects these new records; this is not a
two-way downgrade or a whole-domain version migration. Ordinary human `put`
cannot mint native provenance.

## Verification boundary

The source and ledger `.test.mjs` cases use the actual official local filesystem
and JSON store with contract-issued path/Run permissions. The `.spec.ts` suite
uses original member Cookies, Run issuance, native Agent/tools/history, binary
filesystem and attachment bytes against the pinned patched SDK, with a scripted
model and explicit fixture-issued workspace/publication grants. It covers byte
identity and bounds, fixed metadata lookup, independent publication permission,
revocation, corrupt receipts, real logout, shared human/native quotas and held
physical I/O during cancellation. It does not certify formal Host permission
injection, model reasoning, normal Client previews, packaging or GUI acceptance.
