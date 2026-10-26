# Explicit foreground local Shell adoption

This is the next bounded #35 / #113 slice after local file tools. It does not enable
Shell by default or complete Skills/MCP integration. The fixed public implementation
is DSH `0.2.1-rc.2` (source `687f282e8625c6b8d11ff58211a90524be2e4317`).

## Host interface and ordering

1. Construct `NativeRunShellProducer(context, source)` from qualified, already mounted
   official foreground-only ToolBash, same-host local Shell/FileSystem/subprocess and
   shell-environment services. `source` carries the exact exported implementation
   version, a live AbortSignal and synchronous `assertCurrent(): undefined`. It must
   check the actual producer generation, providers, policy eligibility and lifetime;
   the version string is not authorization.
2. `describeNativeRunShellTool(producer)` copies the actual registered Bash JSON
   description, parameters and output schema with sourceVersion. It performs no file
   read, model call, executable lookup or process launch. Include this descriptor in
   `local-tools.shell` before freezing the complete Run composition. Omission retains
   the previous file/reader derivation byte-for-byte; a descriptor adds only `bash` to
   that saved allowlist.
3. After durable Run admission, inside C's unpublished compose/setup, first adopt the
   saved file/reader tools, then call `adoptNativeRunShellTool(agentCtx, binding, grant,
{composition, producer, capability})`. Exact full scope, model/configurationId and
   actual descriptor JSON must match. The final C tool validation still checks the
   complete actual set before publishing the native Agent.
4. The result contains the saved readonly `toolAllowlist` and an awaited `dispose()`.
   No model/command exit, tool result or disposal submits a product artifact or
   advances a workflow. A owns the public exports, real Host issuance and assembly.

`NativeRunShellCapability` is a Host-only live capability with
`authority: 'local-host-process'`, exact full `NativeWorkScope`, the real authorized
`root`, a signal and synchronous `assertCurrent('execute'): undefined`. The issuer
must derive it from real workspace authorization and the user's explicit frozen Run
selection of Shell. File read/write grants, browser fields, cwd, hashes and booleans
cannot create it. No actual issuer means not connected. This capability authorizes
local process execution, which may access host files and network: root is a cwd
boundary, not an OS read/network isolation guarantee. A source unable to establish
this exact authority must refuse.

## Scope and compatibility

The first implementation supports an explicitly qualified local producer whose
Shell and filesystem report no sandbox mode. A confining/sandbox producer is refused,
never rebuilt as unconfined or silently downgraded. Supporting its actual runner and
policy requires a separate qualified integration. Existing tools/pre-execution policy
remains in the original scope; userApproval is not replaced. Background/promotion and
escalation arguments are refused, so this slice does not claim a successful approval
or sandbox escalation flow. A current policy that requires confinement cannot be
bypassed to obtain the unconfined capability.

The leaf re-mounts the public LocalBash and ToolBash plugins with fixed foreground
settings over a Run-scoped facade of the actual subprocess runtime. It does not copy
global execute closures or implement another shell engine. Cordis own descriptors
keep traced calls on the controlled methods. Raw terminal/executable-lookup operations
are unavailable through this facade. Original Run, source, capability and native
session facts are checked at admission and I/O boundaries. Cwd uses real FileSystem
resolve/processPath/stat/contains; outside, parent/sibling, symlink escapes and root
drift refuse before spawn. This is application checking, not protection from hostile
external processes rewriting filesystem ancestors.

## Bounds, cancellation and drain

The fixed limits are 32 admitted command attempts per adoption, one concurrent call,
16 KiB UTF-8 command text, 5 seconds per call and 64 KiB retained stdout/stderr each.
There are no spill files. Truncation remains explicit in the official output. Provider
shorter deadlines are preserved along with the outer cancellation signal. SIGTERM
escalation grace is 250 ms. Credential-shaped explicit environment names are removed
using the official sensitive-name pattern in addition to the provider's ambient scrub;
this heuristic does not certify arbitrary environment content as secret-free. The
Host must qualify its shell-environment contributions and never inject owner secrets.

Actual SubprocessHandles remain owned until `waitForExit()` confirms the same managed
range is empty and `done` settles. Foreground completion also terminates and joins
remaining managed descendants, including shell-syntax background work. Source/Run/
capability/caller cancellation aborts the actual process signal. Dispose closes new
admission, waits for admitted calls and actual range observations, and releases both
official plugins and scoped services. A 5-second range probe that cannot confirm
quiescence yields failure/unknown; it never authorizes writer release. Cleanup errors
remain failures even when the scope is being disposed. Provider observation/signaling
limits still apply (including the documented macOS PGID fallback); this is not a
guarantee against detached or otherwise unobservable hostile descendants.

Stable HarnessError codes are `local-shell-unavailable`, `local-shell-denied`,
`local-shell-mismatch`, `local-shell-budget` and `local-shell-timeout`. Messages do not
copy provider errors, private root paths or credentials. Source/member/Run/capability
issuers and session-bearing test callers are contract fixtures; actual public Cordis,
official tools, local process handles and file bytes are tested separately. Those
tests do not certify real member authorization, native Agent publication, model
behavior, sandbox operation, normal UI, Windows or installation.
