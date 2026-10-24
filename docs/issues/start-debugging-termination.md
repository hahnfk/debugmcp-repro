# Draft: start_debugging waits until timeout after a C# launch has terminated

Local, unpublished issue draft. This is separate from the original frame-selection
and expression-evaluation investigation. Observed once; no repeated launch-timeout
trial has been performed yet.

## Environment

- Windows x64; VS Code 1.143.1.
- DebugMCP extension 2.4.3; C# extension 2.160.4; C# Dev Kit 3.40.215.
- .NET SDK 10.0.402, runtime 10.0.13; Debug build, portable PDB, optimization off.
- Two VS Code workspaces were registered. A separate fresh Streamable HTTP MCP
  connection at `http://localhost:3002/mcp` was associated with the Repro workspace
  using its verified exact source path. The existing connection was untouched.
- The Repro window reported a 180-second DebugMCP timeout.

## Steps

1. Build this repository using the README commands.
2. In its separate VS Code window, use launch profile
   `Repro D - assigned after await (failure false)`.
3. Add only the owned breakpoint at `Scenarios.cs`, marker `BREAK D` (line 52),
   with condition `appendResult.IsFailure`.
4. Call the public `start_debugging` tool with the exact Repro source path,
   checkout as `workingDirectory`, and the profile name above.
5. While the call is still waiting, query `get_debug_status` with
   `waitForPauseSeconds: 0` on the **same independent MCP transport** using a
   distinct JSON-RPC request ID. Do not pause or resume another project's session.
6. Observe the start call's eventual reply and then remove only this breakpoint.

The ordinary CLI run of this variant returns `D_FALSE result=51`. With an
unconditional breakpoint, its `appendResult.IsFailure` evaluates to false. The
true profile stops at the conditional breakpoint and explicitly evaluates to
true. These controls distinguish this report from the original expression issue.

## Expected

When the launched debug session terminates without a breakpoint stop,
`start_debugging` should promptly report termination. A completed session should
not be described as still running.

## Observed

The independent read-only status call already reported:

```json
{"status":"no-session","paused":false,"sessionActive":false}
```

The start call nevertheless remained pending until approximately the configured
180-second timeout. Its eventual text said:

```text
Debug session is running but did not stop or terminate within the timeout ...
```

The **same response** included this current state:

```json
{"sessionActive":false,"paused":false}
```

No stop was observed for this false variant. Debuggee stdout was not captured,
and the actual DAP stop reason/condition-error metadata was not exposed by the
used tools. This report does not claim a condition-evaluation error or an
application hang. Cleanup confirmed no active session and no remaining owned
breakpoints.

## Possible explanation, not a confirmed runtime cause

Static inspection of the installed bundle found that `waitForDebugSessionReady`
listens for termination, but resolves it only if global
`vscode.debug.activeDebugSession` is already empty during the callback. A stored
started-session reference is not reset there; the timeout later consults that
reference. If the active session is cleared after the termination event, the
event could be missed by this logic. The event ordering was not captured, so this
remains a hypothesis.

A possible fix to review is matching the termination event to the launched
session itself, clearing stale state, and making the timeout message reflect
the actual current session. No extension change has been made or tested.

## Scope and evidence

The original local-variable/async expression issue did **not** reproduce in the
performed automatic A-E trials. The F negative control produced the expected
out-of-scope CS0103. The full automatic/direct-console/manual-selection comparison
was initially completed for A. Subsequent comparisons at C after suspension
(line 39) and E's direct return breakpoint (line 61) also passed all three
channels. Other positions remain unperformed in the direct/manual columns.
Do not combine those findings with this launch lifecycle report.

See [findings](../findings.md), [reproduction steps](../reproduction.md), and the
[curated trial records](../evidence/2026-10-24.json). No reliable avoidance of the
start-wait problem has been validated; the independent status call is useful
for distinguishing the waiting tool from an active debuggee.
