# Frozen execution composition

Work items: #35 / #113. This Host-only module creates content, not authority. A owns
Host publication, exports and transport; C owns native sessions/tools; B owns files.
No model, browser, package installation, file-body read, new store or execution owner
is introduced here.

## Producers and consumers

`freezeExecutionRunComposition(ExecutionRunCompositionInput)` takes the real Workbench,
the current B node, a complete intended NativeWorkScope, explicit provider/model/optional
effort/maxTokens, an explicit builtin or plan-expert choice, an actor/space/locator echo
with B's normal authorized input projection, and explicit tools. It returns copied,
recursively frozen, serializable content. Source values must come from actual Host/B
producers; neither this input nor its hash authorizes a member, workspace or tool.

The exact AppliedPlan is loaded through `createExecutionHandoff` and mapped with
`createNodeHandoffs`. Its ref.version is still AppliedPlan.id, never an invented asset
release. The runtime B handoff must match that mapped node, except for B's resolved
fixed inputRefs. Every declared dependency must have a fixed accepted ref and matching
visible, nonblocking version metadata. Missing, hidden, pending/replaced, duplicate,
wrong-echo or changed versions refuse. An empty mapper-generated inputRefs array does
not erase dependencies. All current handoff refs are required in this first format.

The explicit product-owned `BASIC_TASK_EXECUTOR` has a stable ID, definition version
1.0.0, actual short instructions and content digest. It is not a personal/global expert
or a claim that a DSH standard/minimal preset was adopted. An explicit plan-expert must
resolve its complete definition from that exact plan and participant list; an assigned
expert cannot silently become the builtin. Missing/disabled/empty definitions refuse.
Future builtin definition revisions must retain or explicitly migrate older versions;
they must not overwrite a stored configuration with current text.

`text-only` produces an empty tool allowlist and requires no upstream input. The reader
mode requires nonempty fixed inputs and an actual C tool descriptor
`{name,description,parameters,outputSchema,sourceVersion}` from
`describeAcceptedInputTool()`. Its full JSON definition is frozen and hashed. The module
uses C's actual `acceptedInputRef(scope,input)` to render scoped handles. A registers
C's accepted-input tool with that same catalog and scope, checks the actual allowlist,
and returns the stored context; it does not append a second catalog/context or mutate
native presentation here. Registration, current grants and actual tool-set checks remain
A/C responsibilities. Selected Skills/MCP are explicitly unsupported by this text/read
slice, rather than silently dropped or marked authorized. File/code/Skills/MCP remain
necessary follow-up core integration, not a scope deletion.

`executionRunCompositionRequest(snapshot)` returns the exact selection, expertVersionId,
contextRefs, first message and input fingerprint. The native first message uses mode
followup and SHA256(JSON.stringify(['followup', text])), matching C's actual message
fingerprint. No accepted source body, full transcript or file bytes enter this message
or the metadata catalog. The native runtime uses the stored context/tool allowlist.

`assertExecutionRunComposition(saved,currentFacts,request): undefined` is A's synchronous
content check for assertConfiguration. It rebuilds from fresh producers and compares
full content and request projections. `assertWorkspace` must still validate the actual
Host capability/publication; a snapshot, text-only label or hash cannot implement that
permission check. Read-back validates strict schema, byte budget, digest, scope and all
derived context/message fields; it never resolves a pointer to latest.

## Same-owner durability and explicit start

`ExecutionService.readRunCompositionInputs(originalRequest: MemberRequest, body: unknown)`
is a Host-only preparation read in the same existing queue. The body is exactly
`{taskId,planId,revision,nodeId,spaceId}`; the result is
`ExecutionResult<ExecutionRunCompositionInputs>`, where
`ExecutionRunCompositionInputs = ExecutionRunCompositionInput['inputs']`:
`{actorId,spaceId,taskId,planId,revision,nodeId,items: readonly UpstreamInputView[]}`.
It uses the real current member lease, node/controller, recorded plan and space gates,
then the normal `readableRecords` / `upstreamInputsFor` projection. After asynchronous
directory reads it rechecks publication, member, task, plan, controller and current
directory, and synchronously copies current same-plan source rows before projecting.
Receipt presence alone is insufficient. The shared recorded-plan check requires a
well-formed receipt with unique node IDs including this node. Run access additionally
compares its fingerprint and complete node set against the exact AppliedPlan mapping,
and requires every mapped node row with that same full plan/node identity to exist.
Missing current/sibling IDs, duplicates, extra nodes, a foreign fingerprint or a missing
mapped row refuse admission. These checks run again after awaited directory reads and
after the first writer marker. They do not repair a receipt or create missing nodes.
Both expert-assigned and human-assigned nodes are covered even when absent from human
inbox items. Hidden/pending/replaced rows remain explicit; they never become a successful
empty catalog. The copied result contains metadata only, is not an execution grant, and
does not enable the writer marker, repair unlocks, write a node, create a Run, connect or
call a model. Start independently rechecks inputs with the same projection helper.

Formal `ExecutionService.startRun(originalMemberRequest, BeginRunRequest)` requires the
complete snapshot. In the existing queue it opens a real fresh member lease, checks the
current node/controller/space, normal readable B inputs, exact composition, Host model/
configuration and actual workspace. Only then may it explicitly enable the global writer
marker. Pure entry/mode/retry/capacity/ID/version constraints use the same internal decision
implementation as begin, through a validation-only function with no effect/capability result;
no pretend writer marker is supplied to admission. After awaiting persistence it rechecks the live publication/member/node/
controller/configuration/workspace/input facts. A stale preflight is not a capability.
One whole-node put then saves the Run, receipt, claim and full composition together;
failure returns no effect. A executes effects outside the queue after success.

`beginRun` also requires the snapshot, but requires an already durable marker. Mount,
read, history and composition construction never enable it. The older low-level
enableRunWriter remains Host-internal; A uses startRun instead of duplicating private
authorization logic to decide the first write.

The only persistent location is `nativeExecution.runs[i].composition` in the same existing
zhuma_execution node. `readRunComposition(ExecutionRunLocator)` returns a validated frozen
copy of that exact Run; there is no parallel configuration domain, journal or persistent
map. Old native rows without this field remain readable as legacy metadata, but cannot
certify configuration recovery and cannot bypass the mandatory new service request.
Existing native-aware human writers retain snapshots. Retry/restart saves a new intended
Run scope/configuration without replacing earlier content. Unknown new fields keep older
strict readers from silently adopting new records.

The serialized compact JSON snapshot is limited to 65,536 UTF-8 bytes, the context to
20,000 JS string units and 49,152 UTF-8 bytes, and the input catalog to 100 entries.
Limits reject, never truncate. Existing Run count/receipt limits also bound retained
configurations. The format stores no credentials or workspace paths.

## Evidence boundary

The independent composition tests use real core mapping plus explicit model/tool/identity
contract facts. Service tests use the actual product service, Cordis fiber and published
DSH JSON. They cover first-start pre/post-marker gates, source/hash/version negatives,
atomic snapshot failures, idempotency, old writer retention and separate-process read-back.
The synthetic tool descriptor in contract fixtures is deliberately not C's real declaration.
These checks do not certify actual Host capability issuance, native model/tool execution,
file bytes, normal UI or installation. C's real nativeAgentId can identify the same Run's
executor instance only after actual execution acknowledgement; binding/received alone is
not accepted, and idle is not product completion.

## Local file tool adoption

`local-tools` adds 1–3 actual `read` / `write` / `edit` descriptors; `read` is required,
names must be unique, and the existing complete snapshot byte budget still applies.
Each descriptor includes the actual JSON parameters, output schema and implementation
sourceVersion. Names or sourceVersion do not grant permission. With accepted inputs,
the variant also requires `acceptedInputReader`; without inputs it must be absent.
The real C reader must already be registered before local adoption succeeds. Old
text-only / reader snapshots retain their original derivation and read-back format.
Skills/MCP selection remains an explicit unsupported result in this first file slice;
their later core integration and foreground Shell are not removed from scope.

The Host constructs `NativeRunLocalToolProducer(context, source)` only from its
qualified, already registered official tool-fs/FileSystem services. `source` supplies
the implementation version, a live signal and synchronous `assertCurrent(): undefined`.
`describeNativeRunLocalTools(producer, selected)` copies actual JSON definitions and
does no file I/O, tool invocation, connection or model operation. It checks the public
Cordis `symbols.original` service identity and the actual registered definition objects;
different trace proxies are not treated as replacement services. This first producer
supports an explicitly qualified same-host local provider without sandbox-mode escalation.
An absent provider or an unsupported provider refuses; no default/global fallback is made.

After Run durability, A calls `adoptNativeRunLocalTools(agentCtx, binding, grant,
{composition, producer, workspace})` inside C's compose/setup before native publication.
`workspace` is a Host capability with exact full scope, root, `{read,write}` permissions,
signal and synchronous `assertCurrent('read'|'write'): undefined`. Only read-only or
read+write are supported, including after admission; write-only is refused. The caller
must obtain that capability from the real authorized workspace owner, never from the
snapshot, path, hash or Client fields. Matching saved scope/configuration/model and
actual descriptor JSON is mandatory. Setup returns the saved exact tool allowlist and
an awaited `dispose()`; it does not submit a product artifact or advance a workflow.

The leaf re-applies official tool-fs with the exported fixed config over an isolated
Run FileSystem facade and official observation policy. It does not copy global execute
closures. The underlying provider retains version guards, real target identity and
atomic write/edit. Cordis tracing reads method descriptors: the facade exposes its
controlled methods as own descriptors so it cannot recover raw prototype I/O methods.
Every operation checks the live Run grant, Host capability, source services and exact
scope before/after awaits. Paths are resolved by the actual provider; canonical root,
public processPath and provider containment are checked at each I/O boundary. Lexical
parent/sibling escape, symlink escape, root drift and changed new-file ancestors refuse.
Unsupported FileSystem operations refuse rather than passing through unguarded.

Whole handlers and provider operations use a 5-second cancellation deadline. Writes,
edits and complete source streams are capped at 1 MiB; output reads keep the official
64 KiB window and 200-line limit. Edit preflight also bounds the complete replacement
using conservative CRLF storage bytes and retains the provider's atomic version guard;
it may refuse a near-limit LF edit rather than admit an oversized result.
Revocation/cancellation closes streams and propagates
to actual provider operations. Disposal aborts admission and waits for all admitted I/O
and iterator returns, even if a faulting provider delays cancellation; it never reports
drain while such work remains. A write authorized before cancellation may already have
committed; cancellation is not rollback. Closed scope guards fence inherited fallback
tools until the Agent context is disposed. Restore uses a new context and saved config.

This is an application boundary over the real local provider, not an OS/kernel sandbox
or isolation from hostile processes that can concurrently rewrite filesystem ancestors.
The Host must qualify the actual local root, producer, lifetime and filesystem behavior.
Tests distinguish real Cordis/public tools/local bytes from contract member/Run/workspace
issuers and a session-bearing caller; they do not certify native Agent publication,
real member authorization, models, GUI, cross-platform runners or installation.
