# Native execution Run: first consumable modules

Work item: #113, related #35/#30/#33/#104. These modules are Host-internal. They add no route,
domain, queue, native factory, transcript database, model call, or owner/member fallback.
B retains the one `ExecutionService`/`zhuma_execution` owner. A owns transport/exports/Host;
C owns native binding/turns/tools/drain; B supplies the real member and workspace facts.

This first slice implements strict state, durable-before-effect orchestration, capability
consumption, lifetime cleanup and a storage compatibility barrier. It does **not** certify
B's lease issuer, a native binding handoff, fixed expert submission,
actual workspace tools, normal Host/GUI, model quality or installation. Missing source ports
refuse; the tests' supplied identities/availability/native facts are explicitly contracts.

## Existing ExecutionService integration

`ExecutionService` now owns Run admission, stop and native-event commits in its existing
`enqueue`. Its constructor parameters are unchanged. `ExecutionStorage.readGlobal/writeGlobal`
are optional for old non-Run consumers; the product plugin supplies closures over its same
`zhuma_execution` domain. Startup validates the current global and all present native wrappers.
The plugin schema retains the whole node and rejects malformed/future native metadata.

A receives this **same instance** through optional
`ExecutionPluginConfig.publishRunService(service)`. The S1 option type mirrors that one
Host-only field; it does not put a service object into a Client DTO. No Run HTTP routes are
installed by this slice. A retains public exports and actual Host/transport assembly.

- `installRunHost(ExecutionRunHostPorts)` installs once and returns the existing
  `ExecutionRunAuthorities`. The member lease producer must use the same Host bundle's
  `openExecutionMemberLease(ctx, originalRequest)`; a `MemberResolution` is not accepted.
  The Host must also provide current `assertProjectSpace`, exact frozen configuration and
  expert/input composition checks, workspace access, source lifetime and change notifications.
  Missing producers refuse. The service independently rechecks the live workbench task,
  human membership, controller, and recorded plan. Source replacement must invalidate the
  old publication; neither a remembered mapping nor a text-only label proves authorization.
  The three Host assertion ports return exactly synchronous `undefined`, not TypeScript
  `void`. Runtime producers returning a Promise/thenable or any other value refuse both
  admission and ongoing authority; rejected thenables are observed without awaiting them
  or treating a future resolution as permission.
- `enableRunWriter()` is an explicit operation in that queue. Installing the Host, mounting
  the plugin, reading or reopening never enables the marker. A failed marker write permits
  no begin. All old node writes pass the native-aware guard before admission is enabled.
- `beginRun(originalRequest, BeginRunRequest)` and `stopRun(originalRequest, StopRunRequest)`
  derive the actor from a fresh real member lease. The locator includes task/plan/revision/node;
  the space is checked against current facts. The Host supplies new IDs and verified frozen
  configuration/input facts, rather than forwarding a browser's complete command unchecked.
- `recordRunEvent(locator,event,{grant}|{cleanup})` accepts only capabilities minted by this
  instance's authority manager. A read/history grant cannot emit native events. Independent
  cleanup authority permits only failed/stop-pending/stopped/cleanup, including after member
  revocation; it cannot complete or submit an artifact. Stale/cross-scope capabilities refuse.
- These three operations return `ExecutionResult<ExecutionRunDecision>` after at most one
  whole-node put. A must await success before handling an effect, outside the queue, using
  actual C operations. Replay returns read-only reconciliation, not another dispatch.
- `readRunNode` and `readRunGlobal` are copied Host-only current facts. `fenceRuns()` stops
  new driving/admission while allowing existing cleanup. The publication's async disposer
  drains actual native work and commits cleanup; the plugin then calls `closeRuns()` to drain
  its queue/authority issuers before its existing domain closes.

Cordis executes independent effect disposers concurrently. Consequently the plugin registers
one cached close job immediately after opening the domain, before constructing the service.
That job aborts request lifetime and fences Run driving, then awaits publication/native cleanup,
then service/authority close, and only then domain close. Constructor, reconcile and publication
failures still have this registered owner for the opened domain. Every release is attempted
even when a preceding one fails; the original error or all failures in an aggregate remain
observable. A failed drain/close never writes a cancelled or resource-settled Run receipt.

Old human submit and draft writes refuse while a Run holds resources; old start/recovery
and downstream writers cannot drop or replace native state. Quiescent later submission still
uses the original artifact/review/downstream path and retains the complete native history.
A native completion alone restores the entry obligation and never accepts a product.

`execution-service-run.test.mjs` mounts the actual product plugin/service in a real Cordis
plugin/fiber on published DSH JSON storage. It covers durable marker/write failures, one put for concurrent same-key
admission, effects outside the queue, whole-row draft/artifact/review retention, active writer
guards, event/stop/retry fencing, copied reads, same-root exclusion and a separate OS-process
read-only reopen with byte-for-byte unchanged disk. Identity/workspace/configuration/native
event producers remain **contract fixtures**, not proof of real Host, native/model, file-byte
or GUI integration. Those boundaries are not closed by these tests.
Lifecycle tests hold the actual fiber's unpublish disposer while performing trusted cleanup
writes, and cover startup failures plus drain/authority/domain-close faults. They do not
emulate effect cleanup with a reverse sequential stack.

## Persistent ownership and compatibility

`ExecutionRunNode = ExecutionNodeRecord & { nativeExecution?: ExecutionRunState }`. The
optional extension has schemaVersion=1, a monotonic native version, currentRunId, at most
64 attempts and 256 command receipts. Attempts are never silently evicted. Each wrapper
contains the existing `ExecutionAttempt` plus actor/space/segment, exact native selection,
workspace reference, dispatch state, resource state and last trusted event cursor/hash.
No prompt body, cookie, filesystem root path or provider error is stored here.

Missing extension is legacy. A present malformed, future, inconsistent, duplicate or
partly missing state refuses. Current generation/attempt must be monotonic; only the last
attempt may be nonterminal or hold resources. All core attempt reconstruction stays inside
`wrapper.attempt`, so it cannot drop Host metadata. Existing node fields are spread whole.
Reads and JSON reload never add a Run or produce a dispatch effect.

`executionRunGlobalSchema` preserves the existing global `{schemaVersion:1}` and adds
optional `nativeExecutionWriter:1`. B must run `assertExecutionRunStoreCompatibility`
at startup: native rows without a barrier refuse rather than being adopted. After every
old write path has the native-aware queue/guards, B explicitly persists
`prepareExecutionRunWriter(domain.global.get())` **before** first native admission.
`enableExecutionRunWriter(readGlobal,writeGlobal,nodes)` is the explicit same-queue helper:
failed/stale persistence cannot enable a begin, and an already durable marker is zero-write.
Native begin and authority issuance require the **current persisted** global via
`requireExecutionRunWriter`/`source.writerState`, not a Client-provided protocol flag.

An old Host's actual strict `{schemaVersion:1}` global schema rejects the extra field.
The barrier therefore fences old reopening without a second domain, direct JSON edit or
backend format migration. A crash after the marker but before first Run is conservative:
modern Host reads all old nodes/plans; old Host refuses. The marker must never be removed
to “fix” a downgrade. `compatibleVersions` does not fix single-layout version migration
in the pinned DSH JSON backend. This is a **single Host writer** contract; it does not
claim a lock against two independent processes already holding the same backend.

## Exact B command hooks

All state functions are synchronous pure RMW decisions. Their actor/space, availability,
peer rows, selection and workspace are **Host facts**, not public request DTOs. B must
construct them after real authentication/resource authorization. Existing `scanActorField`
rules still apply to untrusted bodies. A must not forward a complete `BeginExecutionRun`
object from a browser.

| Operation                                                             | Input and result                                                                                                                                                                                                                                                                                                                                                                                                                            | Ordering / refusal                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `beginExecutionRun(record,input,peers,availability)`                  | input: requestId, actorId/spaceId, expectedNodeVersion/expectedRunVersion, begin/retry/restart, Host-generated newRunId/newSegmentId, input SHA256, selection/provider/model/reasoning/maxTokens/configurationId, expertVersionId, contextRefs, text-only or authorized local workspace ref. availability: current writerState, real expertEnabled/executorConnected. Result: disposition, whole record, wrapper, dispatch/reconcile effect | In existing **global** ExecutionService.enqueue only. Compare exact versions, current controller, same actor/space, active attempts and all same-root writers. One node put saves Run/claim/receipt. Same body/key replays read reconciliation; altered body mismatches. Retry/restart keep the old attempt and its entry obligation |
| `requestExecutionRunStop(record,input)`                               | requestId/actorId, exact Run/generation/segment, expected node/native versions → whole record + stop effect                                                                                                                                                                                                                                                                                                                                 | Persist requested before calling C outside queue. New sends/queue refuse. Replayed active stop may recheck/repeat cancellation, never send model input. pending does not release                                                                                                                                                     |
| `recordExecutionRunEvent(record,event)`                               | exact Run/generation/segment + positive per-Run trusted sequence + one event below → whole record                                                                                                                                                                                                                                                                                                                                           | Native/cleanup **internal** port only. Never an HTTP payload/model statement. Exact last-event duplicate replays, changed same cursor mismatches; older attempt/cursor is ignored. No event auto-dispatches                                                                                                                          |
| `readExecutionRunState` / `currentExecutionRun` / `executionRunScope` | current B node → validated clone/selected wrapper/immutable full scope                                                                                                                                                                                                                                                                                                                                                                      | Sync, read-only; no C attach/resume or storage writes                                                                                                                                                                                                                                                                                |
| `assertExecutionRunQuiescent(record)`                                 | whole current node → void or run-active/state-invalid                                                                                                                                                                                                                                                                                                                                                                                       | Before old human submit, reassignment, recovery or any operation that could overwrite/retire an active writer. Draft/comments can coexist if they preserve the complete row in the same queue                                                                                                                                        |
| `afterExecutionRunCommit(commit,driver)`                              | B durable callback → decision; dispatch/reconcile/stop driver → optional native result                                                                                                                                                                                                                                                                                                                                                      | Await commit first, then native effect outside queue. Rejected write produces zero native calls. Reconcile is explicitly read-only, never dispatch/resume. Native errors become run-effect-unknown, with the already durable claim retained                                                                                          |

There is no D-owned queue. A second service reading a row then putting the full row can
lose a B draft even if the new service serializes itself. Adding table.update to just one
new path is insufficient while old paths still read+put. B's existing queue must encompass
**all** RMW operations, including native events; it must recheck real authority immediately
before the persistence slot. Once a write is admitted to durability, later revocation is
not a claimed rollback. Subsequent effects/frames/results still refuse.

Driver callbacks must acquire real capabilities. `effect.scope` is a locator, never a
capability. Dispatch effects for a new attempt also contain `previousScope`: a complete
old/new pair for C's **explicit** binding handoff after the old resources are settled.
Each new attempt requires a distinct nativeSessionId/segment; same-Run turns keep theirs.
C retains the old DSH history and binding metadata, without replaying its pending input.
It is not permission to replace another actor/space's native history. This first slice
refuses controller/space changes; reassign/transfer requires a separately authorized
handoff. A native idle/read refresh does not create a new pair or advance a segment.

## Native events and Run/turn behavior

An attempt can contain many native turns. C's inbox/model history remains in DSH.

| Event            | Additional fields                              | Effect                                                                                                                                      |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| received         | nativeSessionId                                | Record durable admission; Run stays requested until actual execution acknowledgement                                                        |
| accepted         | nativeSessionId/executorRunId                  | Core acknowledge; node becomes running once; repeated acceptance must identify the same session                                             |
| dispatch-unknown | none                                           | Hold resources; explicit same-key reconciliation, no blind resend                                                                           |
| idle             | none                                           | Advance native cursor only; same Run, generation, segment and claim survive between turns                                                   |
| waiting          | none                                           | Core waiting + node input-required                                                                                                          |
| resumed          | none                                           | Core resume + node input-supplied; disallowed while stopping                                                                                |
| stop-pending     | none                                           | Persist receipt-rejected; keep node and claim                                                                                               |
| stopped          | idle=true, flushed=true, resourcesSettled=true | Requires prior stop request; cancel Run, update acknowledged node, release resources                                                        |
| completed        | same three stable native facts                 | Explicit authorized Run finalization, not idle/received or model text. Return to recorded entry; no artifact, approval or downstream effect |
| failed           | resourcesSettled boolean                       | End the attempt. A held native/tool resource remains claimed until separate cleanup; pre-accept failure does not fake running/failed node   |
| cleanup          | all three stable native facts                  | Only a terminal exact attempt; release resources after actual drain. Never grants submission or model execution                             |

The bridge must supply stable, persisted native event ordering/correlation; a per-process
counter reset is not sufficient after recovery. The schema's stable flags are asserted
only by B/C's real idle/flush/resource receipts. They are **not** client-authorized booleans.
The state module validates facts and transitions; it cannot make a fake receipt genuine.
Unknown admission, pending stop and crashed native setup remain visible, explicitly
reconciled states. Original message bodies which never reached DSH must be resupplied
under the same fingerprint; B does not invent a second chat store to recover them.

## Authority source and lifetime

`ExecutionRunAuthorities(source)` requires all source ports; no permissive defaults exist.

- `writerState()` reads B's current durable global.
- `memberLease(original MemberRequest)` is implemented by B's real resolver source, with
  memberId/expiresAt/signal/assertCurrent(spaceId)/release. Recheck actual Host/Origin,
  session/source instance, expiry and live space membership. A MemberResolution snapshot
  or static participant list cannot stand in for it.
- `readNode(locator)` is the same B instance's synchronous reader.
- `assertNodeAccess` checks live task/controller/read permissions. Its send check is the
  controller permission, **not** the native stop phase (the manager owns that check).
- `assertWorkspace` receives configurationId and checks the actual frozen tool composition
  and Host-selected capability. A text-only label without that real proof must refuse. Text-only forbids file
  tools; local refs contain deviceId/rootId/grantId/generation/access, not an absolute path.
- `onChange` rechecks actual facts after domain/changed and on resolver/directory replacement
  or unmount; events are hints, not a permission cache. Source signal closes issuance.

`open(request,locator,'drive'|'read')` returns `{grant,cleanup?,dispose}`. Full scope comes
from the stored wrapper; a different authorized history reader is not impersonated as
its controller. Every check reads current state/permissions/config/workspace. Read grants
cannot send/queue/stop. Drive grants require current nonterminal attempt and controller;
stop request blocks send/queue while retaining the stop wait. Source/lease abort, expiry,
terminal transition and invalid state abort/dispose authority. UI stream cancellation
is a different signal and does not enter this authority lifetime.

B can call `cleanupAfterCommit(locator)` before awaiting member/native setup. It rereads
the already durable current held Run and creates an identity-checked internal token.
This handles member expiry between reservation and authority attachment. Cleanup tokens
survive member/drive revocation and allow only failed/stop-pending/stopped/cleanup facts;
they cannot produce a model, history, completed result, expert identity or submission.
`assertGrant` and `assertCleanup` reject serialized or copied token objects.

Teardown: fence new issuance/driving → C actual idle/flush/tool drain → B trusted cleanup
commits → await authorities.close() → close B execution storage. close is awaitable,
idempotent and reentrant; it drains admitted asynchronous lease resolution and releases late
leases. It does not itself certify native drain. Limit: 256 active/pending authority handles.

Stable state errors are `EXECUTION_RUN_ERRORS` plus `run-${OpenRunCode|SettleFailure}`;
writer errors are run-writer-unavailable/incompatible. Both classes have constant messages.
A/B map codes to public errors and never serialize arbitrary cause/stack/provider text.

## Explicit new-attempt migration capability

`openMigration(original MemberRequest,newRunLocator)` returns `{grant,dispose}`. Its exact
shape matches C's final frozen `NativeRunMigrationGrant`:
`{requestId,inputFingerprint,previousScope,scope,selection,signal,assertCurrent(phase)}`,
where phase is **only** `prepare` or `migrate`. The caller supplies no scope pair, selection,
input hash or new migration key. All come from one current durable-backed B node read;
requestId is the new attempt's persisted begin key and receipt, inputFingerprint its stored
payloadHash. Old must be C's actual origin and terminal/resource-settled; new must be current/requested,
unacknowledged, have no admitted nativeSessionId, retain its claim and not be stopping.
Actor/space/task/node/plan stay the same. Every intervening B attempt must be terminal and
settled, have no acknowledgement/session/executor/discarded-session evidence and dispatch
strictly reserved. Received/unknown cannot be skipped. B retains every attempt. Both phases
recheck actual member lease, controller/task rights, the complete old-to-new history and
new begin receipt, immutable input/resource/config refs and real workspace composition.

`source.migrationOrigin({requestId,inputFingerprint,scope,selection}) -> {scope,selection}`
is an optional Host-internal port to the same C owner. Input scope/selection are the new
Run; output scope/selection describe the actual old binding. Missing port refuses migration
issuance, without changing drive/read/cleanup behavior. Before looking at C, D authenticates
the original member lease (including abort/expiry) and checks current B controller, space,
task and workspace/config access. The C locator is metadata, never permission or readiness.

C reads only its bounded mapping/current and migration receipts. A same-key committed
receipt must recover the original previous scope using the exact target scope, selection
and input hash, rather than mistaking current=new for the old origin. C refuses missing,
malformed, unknown, inflight, foreign-owner or failed-close facts; origin errors are never
translated to undefined. This query performs no native open/stat/flush/cleanup/restore or
model call. Its producer must stay bound to the same C instance/lifetime.

D matches the complete returned scope and old selection to the same current B node history,
checks every skipped attempt, then pins the B-derived origin, entire old-to-new wrapper
vector and begin receipt. A changed target during the lookup refuses. Only this one origin
lookup occurs at issuance: phase checks reread B and verify the pinned producer identity,
without reentering the C migration's own metadata slot. C independently rechecks its actual
current or exact same-key replay inside its existing queue before writing. No new queue,
store, internal binding-reservation permission or fake intermediate segment is introduced.

Issuance validates only `prepare`, without consulting or inventing a C readiness proof.
This phase authorizes C solely to stop/flush/drain/retire the old scope. Cold C may perform
the controlled existing-native-log write-open/flush/close barrier; it cannot create/resume
an Agent, replay tools/queued input, allocate a new ID or write the new mapping. Missing
logs are never replaced because a D string says they should exist: C must distinguish its
never-materialized reserved mapping from missing/corrupt admitted history. An old Run still
holding resources must first use its existing internal cleanup path; no new pair is begun.

After actual C preparation, `assertCurrent('migrate')` queries the synchronous read-only
`source.migrationDrain(previousScope)` for `{signal,assertCurrent():void}`. It must be C's
actual resource epoch, not a B settled flag, drive grant or snapshot. Missing port/proof
refuses only mapping advancement with unavailable/pending and retains preparation rights.
On readiness the manager binds its source identity and epoch signal; every subsequent
migrate assertion rechecks both the fresh source and bound closure. Once bound, lost or
replaced ownership aborts the capability rather than silently adopting a new epoch.

C owns the real stop/flush/source drain, handle retirement, epoch invalidation and its
serialized v2 mapping write. Its own same-request/same-capability prepared migration ticket
must not be mistaken for an unrelated active C writer when it queries readiness from inside
the slot; other send/queue/source/connecting/dispose activity still refuses. Completed
barriers are C-owned and must not disappear merely because the caller disposes a completed
prepare handle. Genuine new native I/O, foreign ownership, producer/service replacement or
close invalidate them. C's actual component tests establish this, not D's state flags.

`assertMigration(grant,phase)` checks manager-issued object identity and the live closure.
Drive/read/cleanup, copies, JSON and labels do not qualify. C must call the method on the
exact issued grant; copied objects or detached functions cannot reuse the bound closure.
The grant rejects every other
action, zero arguments and extra arguments, so structural assignability in JS cannot turn
it into a native send/open grant. Member/expiry/unmount/pair/config/workspace changes revoke
both phases. After epoch binding, its abort immediately interrupts a waiting migration.
Unauthorized members are denied before any native readiness query.

Issuance and preparation assertions do not write mappings, reserve native IDs or run an
Agent. C reserves a fresh native ID only after the migrate assertion and its actual checks;
reservation is not native admission. Previous binding metadata and original DSH history
remain bounded/retained, without replaying the old inbox. Same-Run turns keep their IDs.
Unknown cross-domain outcomes compare the durable pair/key and actual C mapping and never
blindly allocate or resend. D's tests use contract member/drain sources; formal C/B
component and authenticated cross-domain recovery proof remain separately required.

## Remaining owner changes and evidence gates

B must replace the execution global schema with `executionRunGlobalSchema`, validate the
inventory and persist the marker after its guards are installed, provide true member leases,
delegate the four existing write paths and new Run methods through one queue, check current
resource/config facts, and project trusted native/cleanup events. A supplies explicit local
workspace selection and bounded actual tool composition; C supplies old/new binding handoff,
real event correlation, native drain receipts and tool path enforcement. Human assistance
retains explicit human submit. Expert fixed native output needs B's internal Run capability
into the existing immutable artifact/review chain; no owner/member impersonation is added.

The real DSH JSON protocol tests verify marker persistence, byte-preserving old strict-schema
refusal, retained nodes/plans, and a separate-process read reopening without writes or native
execution. Other tests are contracts for state/concurrency/effect ordering and source leases.
They do not replace the formal Cookie+Run+native+workspace+fixed submission vertical proof.
