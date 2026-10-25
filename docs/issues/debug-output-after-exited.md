# VS Code output capture discards output between DAP exited and terminated

Upstream issue: [microsoft/DebugMCP#196](https://github.com/microsoft/DebugMCP/issues/196).

## Summary

With output capture enabled, DebugMCP records output before a DAP `exited`
event, but drops subsequent output delivered before `terminated`. The tracker
treats debuggee exit as the end of its message-observation lifetime, even though
the adapter can still emit debugger output before the debug session ends.

Execution-state tracking and output-capture lifetime need separate handling.
The session should remain execution-ended after `exited`; preserving its final
output must not recreate paused execution state or revive a stopped tracker.

## Environment and assistance

- Microsoft/DebugMCP source commit: `d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4`.
- Test baseline: Windows x64, Node.js `v24.22.1`, root package version 2.4.4.
- Actual compiled `DebugSessionTracker`, `DebugOutputBuffer`, `DebuggingExecutor`
  and `DebuggingHandler` implementations, with a synthetic VS Code tracker-factory
  API and synthetic harmless DAP output markers.
- This investigation and report were prepared with assistance from OpenAI
  Codex desktop **26.1021.31345**, build **21828**, verified **2026-10-25**.
  This identifies the authoring/review environment. The automated reproduction
  runs directly under Node and calls the production output handler; it does not
  send requests through a Codex client or an MCP transport.

No real editor, debug adapter or debuggee is started. Capture is enabled solely
by the test buffer's local provider; installed editor or user settings are not
changed.

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
   node scripts/review/debug-output-after-exited.cjs --debugmcp-root "<absolute-path-to-DebugMCP>"
   ```

   Reproduction files on `main`:
   - [scripts/review/debug-output-after-exited.cjs](../../scripts/review/debug-output-after-exited.cjs)
   - [scripts/review/load-debugmcp.cjs](../../scripts/review/load-debugmcp.cjs)

3. The harness constructs the real buffer with an enabled local opt-in provider,
   passes it to the real session tracker, and obtains tracker callbacks through
   its registered public factory. The real executor and handler read captured
   output from that tracker.
4. Through `onDidSendMessage`, it delivers a session's DAP events in this order:

   ```text
   output("before-exited")
   exited(exitCode: 0)
   output("after-exited-one")
   output("after-exited-two")
   terminated
   ```

   Each output is a harmless `console` marker beginning with the same explicit
   prefix. Each DAP event has standard `seq`, `type`, `event` and `body` fields.
5. It reads the first marker through the production output handler before
   `exited`, using a one-entry page limit. After the remaining events, it reuses
   the returned cursor to read incrementally until empty, then reads the full
   filtered history. It also verifies that the public tracker remains
   execution-ended after `exited` and after the later output.

Seven controls check normal pagination and post-end retention, session
isolation, disabled capture, three actual owner-stop callbacks, and protection
against stale tracker generations sharing a session ID. A late `stopped` event
in the normal lifecycle control must not restore execution after `exited`.

The default command checks the expected fixed behavior and exits nonzero on the
reviewed commit. To require the exact current failure signature together with
all controls and cleanup checks, use:

```powershell
node scripts/review/debug-output-after-exited.cjs --debugmcp-root "<absolute-path-to-DebugMCP>" --expect-current-bug
```

A disabled-capture error, missing session, unrelated exception or failed control
does not count as reproducing this output-loss bug.

## Expected result

The first read returns `before-exited`. Incremental reads then return
`after-exited-one` and `after-exited-two` exactly once, followed by an empty page.
The full history contains all three markers in order. Each incremental page
respects the explicit one-entry limit.

The session remains execution-ended after `exited`. Output capture should not
revive paused state, admit a superseded tracker generation, or recreate history
after tracker disposal. Existing history remains readable within the existing
buffer limits after the session ends.

## Actual result

On the reviewed commit, only `before-exited` is retained. The first incremental
read after the remaining events returns no entries, its cursor does not advance,
and it reports no more output. The full filtered history likewise contains only
the first marker, despite both subsequent output events reaching the production
tracker callback before `terminated`.

All seven controls pass, and execution remains ended. The default regression
exits with code 1; `--expect-current-bug` exits with code 0 only when the exact
first-marker-only loss and all controls/cleanup are confirmed. Session IDs and
cursor values in the output are local observations, not reproduction constants.

The [recorded evidence](../evidence/2026-10-25-debug-output-after-exited.json)
contains both central runs, event traces and incremental reads, all seven
controls, execution-state checks, factory/subscription/buffer cleanup and
source/compiled-module hashes.

## Protocol and adapter-source context

The [DAP session-end overview](https://microsoft.github.io/debug-adapter-protocol/overview#debug-session-end)
distinguishes a debuggee's `exited` event from the debugging session's
`terminated` event. It does not require all debugger output to precede `exited`.
The controlled sequence above follows that distinction; the harness does not
claim to have observed an installed adapter flushing output in this order.

There is also a concrete static example in LLDB-DAP source at pinned LLVM commit
`06eaf2c9557dfc54a375f2e1d033e493639d02a0`. Its
[process-exit path](https://github.com/llvm/llvm-project/blob/06eaf2c9557dfc54a375f2e1d033e493639d02a0/lldb/tools/lldb-dap/EventHelper.cpp#L474-L479)
sends `exited` before calling `SendTerminatedEvent`. The
[termination helper](https://github.com/llvm/llvm-project/blob/06eaf2c9557dfc54a375f2e1d033e493639d02a0/lldb/tools/lldb-dap/DAP.cpp#L777-L784)
runs configured terminate commands before sending `terminated` on its first
invocation. Those commands
[delegate to the command-output path](https://github.com/llvm/llvm-project/blob/06eaf2c9557dfc54a375f2e1d033e493639d02a0/lldb/tools/lldb-dap/DAP.cpp#L667-L670),
which [sends nonempty command output to the console](https://github.com/llvm/llvm-project/blob/06eaf2c9557dfc54a375f2e1d033e493639d02a0/lldb/tools/lldb-dap/DAP.cpp#L605-L612).
Configured terminate commands that produce output can therefore place console
output between these events. This is source corroboration, not an LLDB runtime
test performed by this reproduction.

## Cause

The public tracker callback
[gates every incoming adapter message on its current execution-state entry](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/utils/debugSessionTracker.ts#L75-L78).
On `exited`,
[`observe` calls `endSession`](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/utils/debugSessionTracker.ts#L157-L161),
which
[removes that execution-state entry](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/utils/debugSessionTracker.ts#L135-L139).
Later output callbacks fail the gate and never reach the actual buffer. Existing
buffered data survives, which explains why the first marker remains readable.

Preserving final output should retain appropriate capture ownership and
generation checks without recreating execution state after debuggee exit.

## Scope and cleanup

The harness uses actual compiled tracker, buffer, executor and handler methods.
It does not write their private fields or replace their methods. Test seams are
the public VS Code factory/termination API boundary, the local capture-enabled
provider and a logger sink that counts unexpected internal errors. The shared
loader's inert `vscode` import is sufficient; no additional import hook is used.

Output reads use the production handler with an explicit session ID and
prefix/category filters. The test does not cover MCP transport, live editor
events, buffer eviction pressure or new redaction rules. All markers are
synthetic and contain no secrets.

Post-stop drop controls use `onWillStopSession`, adapter `onExit`, and VS Code's
`onDidTerminateDebugSession`. They do not prescribe dropping every output event
solely because a DAP `terminated` message has arrived. The generation control
recreates a tracker for the same session ID and confirms that old output/stop
callbacks and old cursors cannot affect the replacement generation.

Each fixture disposes its real tracker and verifies removal of factory and
termination subscriptions, buffer clearing, rejection of capture from retained
old callbacks, absence of execution-state reactivation, and refusal to create
another tracker through the disposed public factory. Unexpected logged errors
fail the oracle. A separate eight-second
deadline bounds the harness.

## Related reports and changes

[Issue #178](https://github.com/microsoft/DebugMCP/issues/178) requested output
retrieval; merged [PR #185](https://github.com/microsoft/DebugMCP/pull/185)
introduced the capture path. This report concerns that feature's lifecycle after
debuggee exit, while preserving its existing opt-in, bounds, filters and session
isolation.
