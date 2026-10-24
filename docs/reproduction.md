# Reproduction procedure

## Safety gate and connection setup

Use only this repository, its own VS Code window, and synthetic data. Never touch
another project's processes, sessions, breakpoints, client connection, or settings.
Do not install or update SDKs or extensions as part of these trials.

1. Confirm the open folder is the actual repository root. In this investigation:
   `D:\code\github-com\hahnfk\debugmcp-repro`.
2. Confirm `.vscode/settings.json` contains `"debugmcp.serverPort": 3002`.
   Global settings are independent; do not restore an unknown old value. The
   inspected global port was 3001 and loopback binding was already configured.
3. Verify port 3002 is free or belongs to this Repro window. A listener by itself
   does not establish window identity. In **View → Output**, select **DebugMCP**
   and record only `DebugMCP router running at: ...` from this window. If its
   workspace port was changed after activation, use **Ctrl+Shift+P → Developer:
   Reload Window** in this window only. No reload was performed in this run.
   Follow-up evidence now confirms the checkout folder and the Repro announcement
   `2026-10-24 10:02:37.572 ... http://localhost:3002`; repeating this user check
   is unnecessary unless the window/endpoint changes.
4. Use a new, separately named client connection, `debugmcp_repro`, to the
   confirmed endpoint, expected to be `http://localhost:3002/mcp`. Preserve the
   existing `debugmcp` connection. A concrete additive TOML example is in
   [debugmcp-repro.config.toml](debugmcp-repro.config.toml). The example itself is
   not loaded. An additive local `.codex/config.toml` has also been prepared and
   is ignored by Git; no Repro tool namespace is available in this running chat.
   [Official client documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
   documents `[mcp_servers.<name>]` and `url`; trusted projects can use their own
   `.codex/config.toml`. Confirm that the client trusts and loads this project's
   configuration without interrupting other work. If a global addition is necessary, have the user approve
   this exact addition first. Never use automatic DebugMCP client setup here.
   Follow-up CLI inspection under the user's account confirms this separate
   configuration is enabled. A separate public MCP client named `debugmcp_repro`
   verified endpoint, schemas, and unique Repro workspace registration. Actual
   trials use an independently owned Streamable HTTP session with the public
   `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`
   methods. They do not use the old connection or a private extension interface.
5. Verify the new connection's available tool schemas and routing independently
   of its name and URL. The inspected 2.4.3 installation contains a shared
   cross-window router, although its README does not document the router.
   Path-based operations can select a window; subsequent status/evaluation/
   continuation tools use a cached target. None accepts a frame or session ID.
   A nonmatching hint may retain a previous target. A fresh connection is essential.
6. Establish the exact Repro workspace and intended source/launch target before
   any mutating tool call. If only `no-session` is returned, it has no workspace
   identity. Do not use a breakpoint or a launch as an exploratory routing probe.
   If the public tools cannot establish identity, stop this part and request the
   missing client/window evidence. Do not call private extension interfaces.
   In this investigation the gate was satisfied by the user's folder/Output
   confirmation, the port's extension-host PID, a fresh independently owned MCP
   session, exactly one matching registered Repro root, and inspection of the
   deterministic exact-path routing behavior. The first breakpoint used that
   proven source path; it was not an exploratory attempt to discover a window.
   Requiring a previously selected target would make this bootstrap circular.
   Establish that the chosen URI/line has no pre-existing breakpoint: removal is
   by URI/line and can remove other owners' points at the same location.

After an authorized launch, additionally verify the stopped source and profile,
the Repro DLL/module, and the new target process. If identity becomes ambiguous,
do not send continuation or stop commands to an unknown target. Use the known
Repro window to clean up its own resources.

## Build and ordinary execution

Use the README commands first. `scripts/verify.ps1` checks every CLI variant,
aggregate/default execution, invalid input, DLL/PDB debug identifiers, and all
five source-document SHA-256 hashes (three maintained and two generated sources).
It starts only its own normal processes, each with a ten-second timeout.
It does not drive a debugger. Rebuild and repeat this check after source changes.

All launch profiles run the same `bin/Debug/net10.0/DebugMcpRepro.dll` with
`requireExactSource: true` and a Debug build task. The loaded module still has to
be checked during the actual trial; checking disk files cannot prove what a
debug adapter loaded. See [the C# debugger settings](https://code.visualstudio.com/docs/csharp/debugger-settings).

## Source positions and expectations

All markers are in `Scenarios.cs`. Line numbers describe the initial checked
source; always resolve the marker again after edits. Stop **before execution** of
the marked statement, after the inspected values have been assigned. Do not
evaluate the `result` local before its initializer has executed.

| Case | Launch profile | Marker / requested line | Expected locals at the marker |
| --- | --- | --- | --- |
| A | `Repro A - synchronous` | `BREAK A` / 12 | `localNumber=41`, `appendResult.Value=7`, `IsFailure=true` |
| B | `Repro B - completed await` | `BREAK B` / 22 | `localNumber=42`, result value 7, failure true, `completedBeforeAwait=true` |
| C before | `Repro C - suspended await` | `BREAK C_BEFORE_AWAIT` / 37 | `localNumber=43`, result value 7, failure true, `completedBeforeAwait=false` |
| C after | same | `BREAK C_AFTER_AWAIT` / 39 | same values after suspension |
| D true | `Repro D - assigned after await (failure true)` | `BREAK D` / 52 | `localNumber=44`, result value 7, failure true |
| D false | `Repro D - assigned after await (failure false)` | `BREAK D` / 52 | same number/value, failure false |
| E before | `Repro E - projection return` | `BREAK E_BEFORE_RETURN` / 60 | `localNumber=45`, result value 7, failure true |
| E return | same | `BREAK E_RETURN` / 61 | same values in the `ProjectionAsync` frame |
| F | `Repro F - out of scope (negative control)` | `BREAK F_NEGATIVE_CONTROL` / 72 | `localNumber=53`; `outOfScope` outside lexical scope |

B awaits `Task.FromResult`; its task is already successfully completed. It is not
evidence of suspension. C uses a `Task.Yield` awaiter with `IsCompleted=false` and
uses both locals after the await. This forces the async suspension path; a
different managed thread ID is not required. The helper in D/E also yields, but
its returned task could finish before the caller awaits it. Do not claim D/E
guarantee suspension of the caller; C is the isolated comparison.

E's synthetic `Map` always applies the value projection; it is not a production
failure-propagation API. The lambda captures `localNumber`, not `appendResult`.
If stepping enters `Map` or the lambda, `appendResult` is legitimately unavailable
there. Select the original `Scenarios.ProjectionAsync` frame for a valid comparison.
Record the actual function name, including state-machine names if displayed.

F expects expression evaluation of `outOfScope` (and `outOfScope.IsFailure`) to
fail. An object remaining alive or a remaining storage slot does not extend lexical
scope. Record actual adapter behavior; never present this negative control as the
suspected failure. `1+1` and `localNumber` must remain positive controls in F.

## Minimal frame/evaluation matrix

Only proceed after the safety gate. Begin with A, then B, C before/after, D, E
before/return, and F. For each position use a new launch or a clearly recorded
continuation within the same session. Do not change build/options between cells.

1. Set one owned, unconditional breakpoint at the marker. Launch with its exact
   `configurationName`. The supported `start_debugging` fields are `fileFullPath`,
   `workingDirectory`, and `configurationName`; do not invent extra selectors.
2. Check the requested and **actual bound/stopped** source line and function. A
   requested return line can bind elsewhere. Capture available frame/thread IDs,
   profile, module, process identity, and stop reason. Missing fields stay unknown.
3. Without clicking **CALL STACK**, call `evaluate_expression` for `1+1` first.
   Then, individually, evaluate `localNumber`, `appendResult`, and
   `appendResult.IsFailure`. An object display such as `{DebugMcpRepro.AppendResult}`
   is sufficient for the object cell; additionally request `appendResult.Value`.
   For F substitute `outOfScope` and keep `localNumber` as a positive control.
4. Optionally use `list_variable_names(scope="local")` and
   `get_variables_values(variableNames=["localNumber","appendResult"], scope="local")`
   to compare discovery/retrieval with expression evaluation. F requests only
   `localNumber` and `outOfScope`. Never dump global variables or unrelated state.
5. In **Run and Debug → CALL STACK**, manually select this same Repro method frame.
   Enter those same expressions separately in **Debug Console**. Record the user
   action as manual. Repeat DebugMCP expression calls after that selection.
   Submit **one expression with Enter**, wait for its result, then enter the next.
6. If automatic selection needs a fresh control, repeat the launch once without
   a manual selection. A preceding manual console comparison may already change
   selection, so do the automatic MCP cell first or use a separate launch.

The three comparison columns are **DebugMCP automatic**, **Debug Console in the
explicitly selected frame**, and **DebugMCP after that manual selection**.
Every `1+1` must produce 2. Expected local values are above. The tools expose no
explicit frame-selection or stacktrace command; do not simulate one with
unsupported parameters. Record frame details exposed by `get_debug_status` if any.
Inspect the returned evaluation text as well as transport/error metadata: in the
actual F control, CS0103 appeared in `Result` text without an MCP `isError` flag.

The completed follow-up at C's line 39 used this same ordering within one new
pause: automatic MCP values, the user's explicit `SuspendedAwaitAsync` selection
and four individual Console expressions, then MCP again. A Variables screenshot
additionally showed `completedBeforeAwait=false`; record that as Variables-view
evidence rather than a fifth Console evaluation. It does not fill C's line-37
direct/manual cells.

For E, first stop on the preceding `GC.KeepAlive` statement, then **Step Over** to
the return as a separate recorded variation. Compare with a fresh direct return
breakpoint. Record if stepping already entered another frame before evaluating.
The completed manual E follow-up used a fresh direct breakpoint at line 61 and
the selected `ProjectionAsync` frame, followed by four individual Console
expressions and MCP again. Its successful comparison does not fill the
direct/manual cells for line 60 or the separately stepped route to line 61.

## Selected caller and stopped-frame status (A_DEEP)

This is a deliberate frame change, separate from the same-frame comparisons
above. Complete the connection safety gate and agree on a 300-second bounded
pause before starting. Replace `<REPRO_ROOT>` below with the verified absolute
checkout path. Frame, thread, and process IDs are assigned per run; do not use
the example observations as selectors or reproduction constants.

### Reproduction steps

1. Restore and build the sample using the README commands. In its separate VS
   Code window, confirm the named profile `Repro A - synchronous` exists.
2. Use `add_breakpoint` for `<REPRO_ROOT>/Scenarios.cs`, line 12 (`BREAK A`).
   Call `start_debugging` on the independent MCP connection with these arguments:

   ```json
   {
     "fileFullPath": "<REPRO_ROOT>/Scenarios.cs",
     "workingDirectory": "<REPRO_ROOT>",
     "configurationName": "Repro A - synchronous"
   }
   ```

3. At the physical stop in `Scenarios.Synchronous`, call `get_debug_status` with
   `waitForPauseSeconds: 0`. Record frame ID, thread, name, full source path, and
   line. Before any manual frame selection, use `evaluate_expression` for `1+1`,
   `localNumber`, `args.Length`, and `scenario`, one expression per call.
4. In the same paused Repro session, select `Program.Main(string[] args)` at
   `Program.cs:20` under **Run and Debug → CALL STACK**. Do not step or resume.
   In **Debug Console**, submit `1+1`, `args.Length`, and `localNumber`
   individually with Enter, waiting for each result before entering the next.
5. Call `get_debug_status` again **before** further MCP expression calls. Through
   MCP, evaluate `1+1`, `args.Length`, `localNumber`, and `scenario` individually.
   Optionally inspect only the local names and selected values `args`, `scenario`,
   and `localNumber`. Capture another status immediately afterwards.
6. Compare frame identity and name/source across these status snapshots while
   keeping the same session, thread, process, and physical pause. Then continue
   only the owned session, remove its breakpoint, and verify `no-session` plus
   an empty owned breakpoint list.

### Expected result

Selecting Main changes the inspection context, while physical execution remains
paused in `Scenarios.Synchronous` at line 12. The status should describe the
selected frame consistently or explicitly distinguish the selected evaluation
frame from the stopped frame. If a frame ID denotes Main, its associated selected
name/source should identify `Program.Main`, `Program.cs:20`. The physical stop
at `Scenarios.cs:12` can be reported separately.

| Expression | Automatic MCP in Synchronous | Direct Console in selected Main | MCP after Main selection |
| --- | --- | --- | --- |
| `1+1` | 2 | 2 | 2 |
| `localNumber` | 41 | CS0103, outside Main scope | CS0103, outside Main scope |
| `args.Length` | CS0103, outside Synchronous scope | 1 | 1 |
| `scenario` | CS0103, outside Synchronous scope | Not requested | `"sync"` |

Local-name/value inspection in Main should identify `args` and `scenario`, with
`localNumber` absent. The constant `1+1` alone cannot distinguish the two frames.

### Actual result

The expression and local-variable results matched that scope table. However,
after Main selection the reported frame ID changed from 1000 to 1001 while both
status snapshots still named `Scenarios.Synchronous` at `Scenarios.cs:12`.
Those IDs are observations from the recorded local run. MCP correctly evaluated
the selected Main context; the response mixed its selected frame ID with the
top frame's name/source without distinguishing their meanings.

The physical stop remained at line 12. This result does not show execution moving
to Main line 20, a wrong physical stop line, or an expression-evaluation failure.
It reproduces the metadata limitation reported in
[microsoft/DebugMCP#179](https://github.com/microsoft/DebugMCP/issues/179).
One completed caller-selection run supplied the two post-selection snapshots;
other languages and independent fresh-launch repetitions remain untested.

## Conditional breakpoints (only after unconditional expression checks)

At D's marker replace only the owned unconditional breakpoint with condition
`appendResult.IsFailure`. Use the true profile, then the false profile. With a
successfully evaluated condition, true should stop and false should finish with
`D_FALSE result=51` without stopping there. Retain no second unconditional
breakpoint that could confuse the observation. Leave exception settings unchanged.

A pause by itself proves neither condition truth nor evaluation success. Record
the stop reason and any narrowly scoped condition error from this synthetic run.
`CS0103` reported for the condition is separate from an error from an explicit
`evaluate_expression` request. If metadata cannot distinguish the reason, report
it as unknown. Run the same two variants through VS Code's **Edit Breakpoint →
Expression** control for the direct-adapter comparison, preserving expression,
source, and profile. Do not infer failure merely from the false case completing.

In the executed false control, `start_debugging` waited about 180 seconds and
reported a running/timeout message even though an independent read-only status
on the same connection already reported `no-session`; the final status agreed.
Record such lifecycle-reporting inconsistencies separately. Do not interpret
the message alone as an application hang or a failed condition evaluation, and
do not stop an unrelated session in response.

## Bounded manual assistance and cleanup

Request one concrete window/profile/frame/expression at a time. For example:
in the Repro window, session `Repro A - synchronous`, select
`Scenarios.Synchronous` under **CALL STACK**, evaluate `1+1` in **Debug Console**,
and report only `2` or the short error. Never request a full console dump.

Agree on a bounded 300-second window for a manually assisted pause **before**
starting it. If the deadline is reached, end only the positively identified
Repro session using its own window/connection; do not leave it paused indefinitely.
Do not start a manual trial without a verified cleanup path. Automated sample
trials were resumed and ended; no process is intentionally left paused awaiting
an unannounced manual action.

Remove only the exact breakpoints/logpoints created for this trial using
`remove_breakpoint(fileFullPath, line)` or the corresponding Repro editor controls.
Never call `clear_all_breakpoints`. Finish only the owned session/process.
Repeat interesting differences at most three times; do not run uncontrolled loops.

The first A trial exposed a separate cleanup issue: adding at an uppercase `D:`
path succeeded, but removal using the same spelling reported `No breakpoint
found`. Removal at the identical path with lowercase `d:` succeeded, and the
subsequent breakpoint list was empty. Preserve the exact returned/normalized URI
spelling when removing an owned point and verify its absence. This observation
concerns breakpoint identity, not expression frames or local-variable scope.

## Evidence record

Copy this small record per real debug trial; do not fill observations from expected
values. Keep only synthetic evidence, not global configuration dumps or foreign logs.

| Field | Value |
| --- | --- |
| Trial ID, date, scenario, repeat | |
| SDK/runtime/VS Code/C#/Dev Kit/DebugMCP versions | |
| Configuration and source/DLL/PDB identity | |
| Window, separate connection, actual endpoint, target process/profile | |
| Requested/bound/stopped file and line, function/frame/thread | |
| Frame selection: automatic / explicit manual (who performed it) | |
| Channel: Debug Console / MCP tool and exact supported arguments | |
| Expression, expected result, observed result/error | |
| Conditional truth / condition evaluation error / unknown | |
| Outcome: reproduced / not reproduced / failed / not run | |
| Limitations and cleanup | |

Keep application failures, expected scope errors, condition errors, explicit
evaluation errors, missing frame information, and unsupported tooling separate.
Compare possible causes only after observing the same source/frame across columns.
