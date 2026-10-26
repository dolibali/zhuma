# Native explicit result seam

Refs #35, #30. This is a Host-only text/link producer. It does not submit an
artifact, approve a review, or change a node/Run to completed.

## Composition and ownership

`describeNativeResultTool()` is the exact `complete_work` declaration at
`zhuma-native-result-intent@1`. New Run composition must freeze it in the
independent `resultIntentTool` slot. Its source JSON SHA-256 (two-space
`JSON.stringify` serialization plus a final LF) is
`241bae9b4e21db3acbf9f4a4743d10e0934e1abc473ef1c259304f6518215931`;
the composition canonical-payload digest is
`fe37b46ba16dc45e7dc24060a69d339e856efd982522df1efb1420e91798b386`.
An existing Run without that slot cannot acquire the tool or a result reference.

After the original `ExecutionService.installRunHost()`, create one
`createNativeFixedResultIssuer(ctx, sessions, runtime, originalAuthorities,
execution)`. The sessions/runtime must be the same original native owner. The
fifth parameter reads the original frozen Run composition; it is not a second
configuration store. Register `registerNativeResultTool(agentCtx, binding,
originalGrant)` during that Agent's normal composition. Actual Agent identity,
registry membership, original issuer, full scope and configuration remain
required at dispatch and finalization. Public exports and Host assembly belong
to A; this module does not replace the default Agent factory or Agent Loop.

## Declaration and durable result

The strict input is `{ text?: string, links: readonly string[] }`. Text permits
100000 JavaScript characters and links permits 20 safe HTTP(S) URLs without
userinfo. At least one nonempty part is required. Files, paths, hashes and scope
claims are rejected. Text and links use the existing artifact validation rules.

The actual tool checks its own SDK `tool/call`, records versioned intent metadata
through the existing native binding/send queue, and calls `exec.concludeTurn()`.
Its acknowledgement says `declared`; it never says the task was delivered. It
does not await its own idle or writer drain. The original dispatch token fixes
the acknowledgement and stable failure code through final policy handling.

The declaration gate rejects new followup/steer/queue input before a receipt is
reserved. Existing acknowledged retries are reconciled read-only without
waking the writer. Pending previously acknowledged input prevents declaration.
Further tools after declaration are denied; an actual later tool call or
internal inbox insertion also prevents fixed-result qualification.

Outside the tool stack, `prepareFixedResult(grant, signal)` waits for original
input sources to physically drain, reads the actual native log/projection,
requires the exact linked call/result/completed-turn chain, and retires the
writer using the original flushed-and-closed barrier. It reads and qualifies
again after close, then seals the exact call/result/turn-end/as-of cut. Source
scope, native IDs, configuration, intent/call IDs, content digest and cut must
agree. Ordinary assistant replies, idle status and CLI exit are not result
evidence. Stop, revoked authority, changed sources, a policy replacement or
pending/later work cannot produce a ready reference.

The returned reference is an original in-memory object registered in that
owner's WeakMap. JSON, matching fields, an old owner or a cloned grant/ref do not
confer authority. `readFixedResult()` rereads the official SDK cut and returns a
lease with `source`, `content`, `digest`, `provenanceFingerprint`, `signal`,
`check()` and `release()`. A consumer must recheck the original reference and
lease immediately before its own durable submission. The fingerprint covers
the complete source and digest, so a new reference after restart identifies the
same fixed content without treating the old object as live authority.

The C preparation/read path does not enter an ExecutionService mutation queue:
the fifth parameter reads its frozen composition synchronously. Preparation
uses the native send queue only for binding metadata, and waits for native
input cleanup outside that queue. D should obtain the prepared reference and
lease before entering its own submission queue, then recheck both inside its
original authorized submission path. C's original `send` grant is not an expert
submission grant. Review acceptance and downstream release remain D's facts.

```ts
const prepared = await results.prepareFixedResult(originalRunGrant, signal);
if (prepared.status === 'ready') {
  const lease = await results.readFixedResult(originalRunGrant, prepared.ref, signal);
  try {
    results.assertFixedResult(originalRunGrant, prepared.ref);
    lease.check();
    // Pass the original ref/lease to D's existing authorized submission path.
    // Inside its queue, recheck both and the original submit authority before
    // committing lease.content and its full source/fingerprint idempotently.
  } finally {
    lease.release();
  }
}
```

## Persistence, bounds and recovery

Only optional versioned `resultIntent` metadata and its sealed cut are added to
the existing native binding. There is no artifact-body cache, chat database or
parallel execution state. Bindings without the field preserve their old bytes;
the actual pre-change strict binding validator rejects records with new result
metadata. New migration bindings start without an old completion gate.

Cold recovery uses fresh real member/Run authority, reads the original native
SDK history, requalifies and reissues a new reference. It neither creates an
Agent nor calls a model. Failed/incomplete facts stay unavailable or pending;
recovery does not infer an intent from a final message.

Result preparation and leases each have at most 8 outstanding readers; the
shared runtime reader also retains its physical slot until SDK close settles.
The private scan is bounded to 8 MiB / 10000 events and the existing SDK read
deadline. A caller waits at most 5 seconds for preparation, then receives
pending while the owner still tracks actual cleanup. Cancellation is not a
physical drain. Bodies are never truncated to fit a public frame.

The 100000-character Chinese SDK proof contains a 300000-byte text body. This
exceeds the existing public raw-history frame limit of 262144 bytes. The private
fixed-result reader deliberately does not use that public frame path; public
projection/transport size handling remains A's separate integration boundary.

## Verification boundary

`native-work-session-result.test.mjs` validates schemas, exact legacy refusal and
source contracts. `native-work-session-result.spec.ts` runs against the fixed
patched SDK source graph, original Cookie/ExecutionService/issuer and JSON
persistence; only model choices/responses are scripted. It covers actual
completion, long text, queued/internal/later work, policy replacement, Stop,
logout, reader capacity, held physical input reads and independent-process cold
recovery. These are mechanism proofs, not a paid-model quality, formal Host
resource isolation, Client/GUI or end-to-end business-delivery acceptance.
