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
