# A completed VS Code launch waits for timeout while an independent session remains active

## Summary

Start a launch while an unrelated session already exists. If the new launch
ends without stopping and the unrelated session remains selected, the startup
readiness observer ignores the new launch's termination. `start_debugging` waits
until its configured timeout and reports that the debug session did not stop or
terminate, even though the newly started session already terminated.

The independent session is allowed to remain active. A general status request
may correctly describe that selected session. The mismatch reported here is the
readiness result and response for the newly started launch.

## Environment and assistance

- Microsoft/DebugMCP source commit: `d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4`.
- Test baseline: Windows x64, Node.js `v24.22.1`, root package version 2.4.4.
- Actual compiled `DebuggingExecutor` and `DebuggingHandler` implementations,
  with a synthetic event-driven VS Code host boundary and real Node timers.
- This investigation and report were prepared with assistance from OpenAI
  Codex desktop **26.1021.31345**, build **21828**, verified **2026-10-25**.
  This identifies the authoring/review environment. The automated reproduction
  runs directly under Node and calls the production handler; it does not send
  requests through a Codex client or an MCP transport.

No installed VS Code extension host, debug adapter or debuggee is started. This
is a controlled host-boundary reproduction of the source behavior, not a live
reproduction of a particular VS Code version's event ordering.

## Reproduction steps

1. Prepare a separate Microsoft/DebugMCP checkout at the pinned revision:

   ```powershell
   git clone https://github.com/microsoft/DebugMCP.git
   cd DebugMCP
   git checkout d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4
   npm ci --ignore-scripts
   npm run compile
   ```

2. Clone this reproduction repository's `main` branch in a separate directory
   and run the harness. Replace `<absolute-path-to-DebugMCP>` with the absolute
   path of the Microsoft/DebugMCP checkout prepared in step 1:

   ```powershell
   git clone --branch main https://github.com/hahnfk/debugmcp-repro.git
   cd debugmcp-repro
   node scripts/review/vscode-launch-termination-readiness.cjs --debugmcp-root "<absolute-path-to-DebugMCP>"
   ```

   Reproduction files on `main`:
   - [scripts/review/vscode-launch-termination-readiness.cjs](../../scripts/review/vscode-launch-termination-readiness.cjs)
   - [scripts/review/load-debugmcp.cjs](../../scripts/review/load-debugmcp.cjs)

3. The harness first represents independent session P as selected and running.
   P has `request: "launch"`, no selected frame, and no parent-child relationship
   with the new launch. These choices avoid the existing stopped-frame and
   attach-readiness fast paths.
4. It calls the actual start handler for a new named launch A. The handler uses
   the actual executor, including its ordinary VS Code startup-diagnostics path.
   The synthetic `vscode.debug.startDebugging` API delivers A's start event.
5. Twenty milliseconds after A starts, the host boundary selects P and delivers
   A's termination event. The event identifies exactly the same A that started.
   P remains selected and active. No later session-termination event is generated.
6. The harness records A's start response, elapsed time, the event trace, and the
   public global status. The configured readiness timeout is reduced to 200ms
   for this test, using real timers. A real event-loop checkpoint immediately
   after A's termination checks whether its startup operation has completed.
   Healthy completion must satisfy that checkpoint, rather than merely changing
   the response text after the full timeout.

The five controls check: a lone launch terminating normally, a selected frame
producing `stopped`, a running attach producing `attached`, no launch producing
`no-session`, and an unrelated termination while A is still waiting. The last
control includes a real event-loop checkpoint proving that the operation has
not settled, then selects A's frame and expects `stopped`.

The integrated cases use named configurations without `testName`; the existing
Testing API `runComplete` completion path is outside their scope.

The default command checks the expected fixed behavior and exits nonzero on the
reviewed commit. To require the exact current failure signature together with
all controls and cleanup checks, use:

```powershell
node scripts/review/vscode-launch-termination-readiness.cjs --debugmcp-root "<absolute-path-to-DebugMCP>" --expect-current-bug
```

A generic timeout exception, missing host API, logged state-retrieval error or
failed positive control does not count as reproducing this bug.

## Expected result

The new launch's termination should complete its startup-readiness observation
and report `terminated` promptly. The handler should say that A ran to completion
without stopping. It should not wait for unrelated P to terminate.

The independent session may remain globally active and visible through
`get_debug_status`. A fix must also preserve the control where termination of
some unrelated session does not complete A's still-pending startup observation.

## Actual result

A's own start event and subsequent termination event are both delivered and have
matching session IDs. P remains selected. Nevertheless, the operation consumes
the configured readiness interval and the start response says:

```text
Debug session is running but did not stop or terminate within the timeout for: ...
```

Its state describes P, which is still active. The synthetic global status for P
is correct; the completion classification for A is not.

The other five controls pass. The default regression exits with code 1;
`--expect-current-bug` exits with code 0 only when this precise mismatch, the
matching start/termination identities, the surviving independent session,
controls and cleanup are all confirmed. Locally generated session IDs are
observations, not reproduction constants.

The [recorded evidence](../evidence/2026-10-25-vscode-launch-readiness.json)
contains both central runs, the readiness results and event traces, the five
controls, source/compiled-module hashes, and subscription/timer/logger cleanup
checks.

## Cause and impact

[`waitForDebugSessionReady`](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/debuggingExecutor.ts#L856)
records newly started sessions, but its
[`onDidTerminateDebugSession` callback](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/debuggingExecutor.ts#L941)
settles only when `vscode.debug.activeDebugSession` is empty. It does not compare
the terminated session's identity with the launch being observed. With P still
active, A's termination therefore leaves the readiness promise pending until
the timeout. The handler then
[renders that timeout as a running-session response](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/debuggingHandler.ts#L167).

The VS Code API describes `activeDebugSession` as the currently selected session;
the [debug API](https://code.visualstudio.com/api/references/vscode-api#debug)
also exposes the session-specific termination event. A different selected
session can legitimately survive the launch that ended. This report uses an
independent session rather than asserting that parent/testhost sessions should
always be treated as separate completed operations.

## Scope and test seams

The compiled production executor and handler are loaded without replacing
methods or writing private fields. A narrowly scoped import hook supplies the
synthetic `vscode` host object and is restored immediately. The existing shared
loader then records the checkout identity and source/compiled-module hashes.
The same host object is used serially, with clean event subscriptions and
scheduled callbacks between scenarios.

Test seams are the event-driven VS Code APIs, deterministic launch-configuration
provider and logger sink. The executor is constructed without its optional DAP
execution-state tracker. The failing readiness termination condition does not
consult that tracker. Source lookup in the frame controls reads this harness's
own file through the synthetic document API.

Timers are real: the harness does not replace `setTimeout` or simulate clock
advancement. After each scenario, it checks that event subscriptions are removed,
host callbacks are cancelled, the production 100ms frame probe has drained, no
additional timeout resources remain, and no internally caught host error was
logged. A separate five-second deadline bounds the harness.

This result establishes the behavior for the disclosed host-event sequence. It
does not establish the frequency of that sequence in installed editors, a
particular VS Code version's callback ordering, or a live extension-host
reproduction.

## Related reports and changes

- [PR #97](https://github.com/microsoft/DebugMCP/pull/97) introduced identity-based
  completion for navigation when another session remains active. It does not
  change this startup-readiness termination callback.
- [PR #134](https://github.com/microsoft/DebugMCP/pull/134) handles prompt attach
  and continue responses for long-lived processes. Its running-attach path
  remains a positive control here.
- [Issue #159](https://github.com/microsoft/DebugMCP/issues/159) proposes optional
  session selection for broader multi-session support. This report identifies a
  concrete startup-wait classification error with a named launch, without
  requiring a new public session-selection API.
