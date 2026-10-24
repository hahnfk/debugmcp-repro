# Findings

## Status on 2026-10-24

**The executable sample and ordinary-run checks pass. Safe MCP/window association
is established, and automatic expression evaluation passed at all tested in-scope
A–E positions.** F produced the expected scope errors. The user's direct
individual-expression Debug Console results and MCP before/after explicit frame
selection agree in A, C after suspension at line 39, and E's return breakpoint
at line 61. Direct/manual
comparisons at the other positions remain unperformed;
the conditional D true/false observations are recorded below with a limitation
in the fast-ending false run's lifecycle message.
No cause of the historical frame-evaluation difficulty is
established. A targeted caller-selection follow-up did confirm that status mixes
selected-frame IDs with stopped-top-frame source information, while expressions
correctly follow the selected caller. That separate metadata observation, the
lifecycle anomaly, and breakpoint-removal path casing are documented independently.

## Repository and environment actually inspected

| Item | Observed value |
| --- | --- |
| Checkout | `D:\code\github-com\hahnfk\debugmcp-repro` |
| Origin | `https://github.com/hahnfk/debugmcp-repro.git` |
| Starting commit | `e6ab3a968ae06d1f156f288003bd118cb00e72ad` |
| Investigation branch (historical) | `codex/frame-evaluation-repro` |
| Initial folder | Only `.vscode/settings.json`; not a Git repository |
| Remote content preserved | README opening text, MIT LICENSE, existing ignore rules |
| Applicable repository instruction files | No AGENTS.md or additional project instructions in the cloned tree/checked ancestors |
| .NET SDKs installed | 8.0.426, 10.0.402; used 10.0.402 |
| .NET runtime used | Microsoft.NETCore.App 10.0.13, win-x64 |
| VS Code | 1.143.1, x64 (`code --version`) |
| DebugMCP | `ozzafar.debugmcpextension` 2.4.3, installed extension inspected |
| C# extension | `ms-dotnettools.csharp` 2.160.4, installed directory |
| C# Dev Kit | `ms-dotnettools.csdevkit` 3.40.215, installed directory |
| Build | Debug, optimize=false, portable PDB, warnings as errors |
| Launch options used | coreclr, justMyCode=true, requireExactSource=true, internalConsole |
| Additional runtime/debugger version | Actual loaded vsdbg executable version not measured |

The first restricted network operation could not reach GitHub; the explicitly
authorized clone then succeeded with network access. The pre-existing workspace
setting was preserved. A temporary no-checkout staging directory was removed
after its Git metadata was moved into the checked root; no existing files were
overwritten. Git ownership checks use per-command `safe.directory` where needed;
no global Git setting was added. During the initial investigation, no commits,
pushes, PRs, or published issues were created. Publication was authorized later.

The first restricted restore could not read the user NuGet configuration. Restore
and build subsequently succeeded with the required local read access. No package
feeds, packages, SDKs, extensions, or global configuration were added or updated.

## Actual verification results

Commands were run with the checked checkout as working directory. Restore used
the repository-local `NuGet.Config`; Debug build used `--no-restore` and completed with
**0 warnings, 0 errors**. `scripts/verify.ps1` launched the compiled DLL directly,
checked exit code and exact output, and limited each process to ten seconds.

| Ordinary run | Expected and observed stdout | Exit | Result |
| --- | --- | --- | --- |
| A `sync` | `A result=48` | 0 | Passed |
| B `completed-await` | `B result=49` | 0 | Passed |
| C `suspended-await` | `C result=50` | 0 | Passed |
| D `assigned-after-await` | `D result=37` | 0 | Passed |
| D false `assigned-after-await-success` | `D_FALSE result=51` | 0 | Passed |
| E `projection` | `E result=52` | 0 | Passed |
| F `out-of-scope` | `F result=53` | 0 | Passed |
| `all` | All seven lines above in order | 0 | Passed |
| No arguments | Same seven lines | 0 | Passed |
| `unknown` | `INPUT result=unknown-scenario` | 2 | Passed |
| `sync extra` | `INPUT result=invalid` | 2 | Passed |

All runs had empty stderr. The verifier additionally read the actual portable PDB:
its GUID/stamp matched the DLL CodeView entry (age 1), and all five document SHA-256
checksums matched disk sources. These facts establish the built artifacts on disk;
they do not establish a debugger's loaded module or expression context.

SHA-256 identities from this verified Debug build (rebuilds may change binary
identities; re-run verification after editing sources):

| File | SHA-256 |
| --- | --- |
| Program.cs | `2A3617C38059B9E22A69408AC08C3E16AB8422D8323EE2DD908FA31361A300A7` |
| Scenarios.cs | `C09174C616EE7C935DA9B17863D0C5B38D26F81A53ABE781221925873C945717` |
| AppendResult.cs | `3786D4E00E394FD52087F3E2C8D061263C513A3E388BE4E88C7B845586FEADBF` |
| DebugMcpRepro.dll | `2E05AE6EC24A4DC7A0310531EA1AB1E646D7D3C73B76B2CDB830F44504E7E298` |
| DebugMcpRepro.pdb | `F879C69C833DCF3968456907E4D686E746DBA1EA0594228FED52EAD37B8ACDF6` |

## Actual connection observations and isolation

- Existing Repro window title: `Welcome - debugmcp-repro - Visual Studio Code`.
  In a follow-up, the user explicitly confirmed the requested checkout folder
  was open and supplied a screenshot showing the Repro tree and working branch.
- Repro workspace file contains `debugmcp.serverPort: 3002`.
- Global DebugMCP port was **3001**, binding **127.0.0.1 and ::1**; these settings
  were preserved.
- Port 3002 was listening on **127.0.0.1 and ::1**, owned by PID **26376**.
  This is the extension-host listener PID, **not a Repro debuggee PID**. A
  listener alone does not establish which workspace the router controls or the
  advertised server address; the independent checks below complete that evidence.
- The inspected existing Codex `mcp_servers.debugmcp` entry is enabled at
  `http://localhost:3001/mcp`; no `debugmcp_repro` entry was found there, and only
  the existing `mcp__debugmcp__...` namespace is available in this chat.
- The user confirmed the Repro Output-channel line:
  `2026-10-24 10:02:37.572 [info] DebugMCP router running at: http://localhost:3002`.
  The public MCP endpoint `http://localhost:3002/mcp` was subsequently verified by
  a separate read-only handshake.
- The reviewable additive configuration is in `docs/debugmcp-repro.config.toml`.
  The separate connection was also prepared in the new ignored project-local
  `.codex/config.toml`. A read-only `codex mcp get debugmcp_repro --json` under the
  user's account confirmed that it is enabled with Streamable HTTP at the exact
  endpoint. Codex CLI version was 0.164.0. The restricted execution account's
  initial "No MCP server named ..." result did not describe the user's client
  configuration. The running chat still has no Repro tool namespace. No global
  client configuration or existing connection was changed.

A separate public Streamable HTTP client named `debugmcp_repro` then used
`initialize`, `notifications/initialized`, `tools/list`, and
`tools/call(get_debug_status, {waitForPauseSeconds:0})` at port 3002. It negotiated
MCP 2025-03-26 and retrieved the 17 actual tool schemas. The server advertised
`serverInfo={name:debugmcp,version:1.0.0}`; that static protocol metadata is **not**
the installed extension version (2.4.3).

The initial fresh router returned its public ambiguity error: two VS Code workspaces
were registered, and the exact confirmed Repro root appeared once. No target
window had yet been selected. Only the count and Repro match were retained;
the other workspace's path and data were not copied into the evidence. This
error is an expected routing prerequisite, **not an expression-evaluation error**.
The independently owned probe connection was closed afterwards. No existing
client connection was used, repointed, or restarted; no private extension API
was called. A repeat of the ordinary-run/PDB verification also passed.

Static inspection of the **installed** extension's `package.json`, README and
`dist/extension.js` found a shared window registry/router. MCP transport sessions
have their own cached target. Path hints are supported by breakpoint operations
and `start_debugging`; evaluation/status/continuation tools have no path/frame/
session selection parameter. A fresh router without a target may select the only
registered window, or report ambiguity with multiple windows. `no-session` does
not carry workspace identity. An unmatched path hint need not clear an old target.
Therefore a separate port alone cannot establish separation, and a fresh named
connection plus independently checked routing is required before mutation.

Local reference: extension directory
`C:\Users\Frank\.vscode\extensions\ozzafar.debugmcpextension-2.4.3`;
README sections for Codex configuration, port changes, and named launch profiles.
The router is an implementation observation, **not a documented public selection
API**. No private interfaces were called. The extension reads its port at activation;
no configuration-change listener was found, so a changed port requires reactivation
in the Repro window. No reload or extension restart was performed in this run.

The [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
documents separately named server tables and trusted project configuration.
This provides a configuration path, not evidence that a newly configured namespace
is already available or correctly routed in this running chat.

**Safety gate satisfied before mutation:** the exact user-confirmed folder and
Output announcement, extension-host PID 26376 on loopback port 3002, a fresh
independently owned public MCP session, the unique registered Repro root, and
the inspected deterministic path route jointly established the association.
Requiring an already selected target would be circular because the public API
has no read-only selector. The first `add_breakpoint` therefore used the proven
Repro path, rather than probing an unknown workspace. Its following launch and
paused state confirmed the expected profile, source, process, and loaded module.
No existing MCP connection was steered or replaced.

Immediately after the first addition, the Repro list contained only the newly
created point; before subsequent trials it was checked to be empty. This
installation's `remove_breakpoint` identifies points by URI/line rather than an
owned ID, so pre-existing user points at that location must not be overwritten
or removed. Only the investigation's own point was removed; no clear-all command
was used.

Static inspection found that status collects selected frame/thread IDs from
`activeStackItem`, while displayed function/source/line comes from
`stackFrames[0]`. The later **A_DEEP runtime comparison confirms this mixed
metadata**: selecting `Program.Main` changes the reported frame ID and expression
scope, while the name/source still describes `Synchronous`. The physical stop
remains correctly located at the top frame; the limitation is that selected-frame
and stopped-frame information is not distinguished. This does not establish the
historical evaluation failure's cause.

## Debug comparison ledger

All recorded process, thread, and frame IDs identify observations from the
particular local run only. They are assigned dynamically, may differ on every
run or machine, and must not be used as reproduction constants. Follow the
launch profile, source marker, and method/frame names instead.

The versions/build above apply to the actual trials below. Requested positions
and expected expressions are specified in
[reproduction.md](reproduction.md). Unperformed comparisons stay **Not run**.

| Prepared case | Requested source line | MCP automatic | Direct Debug Console | MCP after manual frame selection |
| --- | --- | --- | --- | --- |
| A sync | Scenarios.cs:12 | Passed; actual line 12 | Passed; four expressions entered separately by user | Passed; same four expressions |
| B completed await | Scenarios.cs:22 | Passed; actual line 22 | Not run | Not run |
| C before suspension | Scenarios.cs:37 | Passed; actual line 37 | Not run | Not run |
| C after suspension | Scenarios.cs:39 | Passed; actual line 39 | Passed; four separate expressions entered by user | Passed; same values |
| D result assigned after await, true / false | Scenarios.cs:52 | Passed; actual line 52 in both profiles | Not run | Not run |
| E before / stepped return | Scenarios.cs:60 / 61 | Passed; actual lines 60 / 61 via step-over | Not run | Not run |
| E return, direct breakpoint | Scenarios.cs:61 | Passed; actual line 61 | Passed; four separate expressions entered by user | Passed; same values |
| F lexical scope negative control | Scenarios.cs:72 | Passed negative control; expected CS0103 at actual line 72 | Not run | Not run |
| D conditional expression, true / false | Scenarios.cs:52 | True stopped with explicit true; false had no observed pause and then no-session; lifecycle-message limitation | Not run (direct breakpoint) | Not run |
| A_DEEP, deliberately selected caller | Physical stop Scenarios.cs:12; selected caller Program.cs:20 | Correct top-frame scope | Correct Main scope; user entered three expressions separately | Correct Main scope; status mixes selected ID with top-frame name/source |

### A: synchronous baseline, automatic MCP evaluation

The independently owned client called `add_breakpoint` with the exact full Repro
`Scenarios.cs` path and line 12, then `start_debugging` with that file,
`workingDirectory` equal to the checked checkout, and
`configurationName="Repro A - synchronous"`. No manual **CALL STACK** selection
preceded the evaluations.

| Trial detail | Observed value |
| --- | --- |
| Configuration | Debug; `Repro A - synchronous` |
| Requested / actual stopped position | `Scenarios.cs:12` / `Scenarios.cs:12` |
| Function | `DebugMcpRepro.Scenarios.Synchronous()` |
| Reported frame / thread | 1000 / 29960 |
| Debuggee PID | 25320, obtained by evaluating `System.Environment.ProcessId` |
| Loaded sample module | `D:\code\github-com\hahnfk\debugmcp-repro\bin\Debug\net10.0\DebugMcpRepro.dll`, obtained from `typeof(DebugMcpRepro.Scenarios).Assembly.Location` |
| Channel / frame selection | Public MCP `evaluate_expression`; automatic, no manual frame selection |
| `1+1` | Expected 2; observed `2 (int)` |
| `localNumber` | Expected 41; observed `41 (int)` |
| `appendResult` | Expected sample object; observed complex `DebugMcpRepro.AppendResult` with the two named properties |
| `appendResult.IsFailure` | Expected true; observed `true (bool)` |
| `appendResult.Value` | Expected 7; observed `7 (int)` |
| Local discovery / selected retrieval | Names and explicitly requested values succeeded |
| Normal completion | `continue_execution` ended the run; PID 25320 no longer existed; `get_debug_status` confirmed `no-session` |
| Outcome for automatic frame expressions | Passed; historical evaluation difficulty not reproduced in A |
| Direct Debug Console / manual frame cells | All four individual expressions passed; user-selected frame and direct results recorded in the comparison below |

This launch verifies the actual source position and loaded module for A, in
addition to the earlier disk PDB checks. It does not establish results for async
cases or a direct-vs-MCP comparison.

### A: direct/manual comparison

The comparison used `Repro A - synchronous`, PID 27996, paused at
`Scenarios.cs:12` in the `Synchronous` frame, with a 300-second bounded window.
Before manual selection, MCP returned `1+1=2`, `localNumber=41`, the sample object,
and `appendResult.IsFailure=true`.

The user selected `Synchronous` under **CALL STACK** and entered the four
expressions individually in **Debug Console**. The screenshot records 2, 41,
`{DebugMcpRepro.AppendResult}` with expanded `IsFailure=true`, `Value=7`, and true
for `appendResult.IsFailure`. The sample DLL had symbols loaded. MCP repeated
the same four expressions after the manual selection and returned identical
values. **All three A columns pass with no automatic-vs-manual difference.**

The run completed through `continue_execution` before its deadline.
`get_debug_status` confirmed `no-session`, PID 27996 was absent, and the owned
line-12 breakpoint was removed with an empty final breakpoint list. The watchdog
did not need to abort the run.

### B–F: automatic MCP trials

These trials used the same independent connection, Debug build, full source
path, named launch profiles, and automatic selection without user **CALL STACK**
interaction. Every paused state reported frame 1000 and the intended
`DebugMcpRepro.Scenarios` method. Requested positions below equal actual stopped
positions. Each pause first evaluated `1+1`, which returned 2, then the listed
locals and their properties. Explicit object evaluations in B–E returned complex
`DebugMcpRepro.AppendResult` values; `appendResult.Value` returned 7 throughout.

| Trial / method | Requested = actual line(s) | PID | Reported thread(s) | Expected and observed local/property results |
| --- | --- | --- | --- | --- |
| B / `CompletedAwaitAsync` | 22 | 48796 | 40456 | `localNumber=42`, `appendResult.IsFailure=true`, `completedBeforeAwait=true` |
| C / `SuspendedAwaitAsync` | 37, then 39 after continuation | 52856 at both pauses | 39332, then 53508 | `localNumber=43`, failure true, `completedBeforeAwait=false` at both positions |
| D true / `AssignedAfterAwaitAsync` | 52 | 49088 | 22128 | `localNumber=44`, failure true |
| D false / `AssignedAfterAwaitAsync` | 52 | 32080 | 11312 | `localNumber=44`, failure false |
| E stepped / `ProjectionAsync` | 60, then 61 via `step_over` | 25868 at both pauses | 38120 at both pauses | `localNumber=45`, failure true at both positions |
| E direct return / `ProjectionAsync` | 61, fresh breakpoint/launch | 31204 | 38332 | `localNumber=45`, failure true |
| F / `OutOfScope` | 72 | 6620 | 55172 | `localNumber=53`; both `outOfScope` and `outOfScope.IsFailure` returned expected CS0103 |

`list_variable_names(scope="local")` and explicit selected-value retrieval were
performed at every pause. In B–E they included the expected `localNumber` and
`appendResult`; F listed `localNumber` but omitted `outOfScope`, and selected
retrieval reported `outOfScope` not found. No global scope or unrelated values
were requested. After continuation/cleanup, every trial reported `no-session`
and an empty breakpoint list. Only its own source points were removed.

The C thread changed in this observed run; the noncompleted yield awaiter already
establishes the suspension path without requiring a thread change. D/E do not
establish that their caller awaited an unfinished helper task. E's direct return
breakpoint bound/stopped at line 61, matching the position reached by stepping
from line 60. These runs did not enter the lambda frame.

**Negative-control classification:** F's two CS0103 results are expected lexical
scope failures; its constant and in-scope local still evaluated correctly. The
MCP responses contained `Result: error CS0103...` without setting `isError`.
Checking only an MCP error flag would misclassify those expression failures;
the recorded result text is necessary. This is not evidence of the historical
unexpected `appendResult` failure.

The ordinary program results, A direct comparison, automatic B–F expressions,
expected F errors, and tooling response format are distinct observations. The
later direct/manual C-after and E-return comparisons are recorded separately below; they do
not retroactively turn the initial automatic runs into manually assisted trials.

### C after suspension: direct/manual follow-up

The user explicitly requested this additional comparison. A new launch of
`Repro C - suspended await` stopped at the requested and actual line 39 in
`DebugMcpRepro.Scenarios.SuspendedAwaitAsync()`, PID 24180, frame 1000, thread
7188. Its own pause window was limited to 300 seconds by an independently owned
watchdog. Before manual selection, MCP evaluated the same expressions and
verified the actual loaded module at the checked Repro
`bin/Debug/net10.0/DebugMcpRepro.dll` path.

The user selected the `SuspendedAwaitAsync` frame at line 39 and submitted the
four expressions individually. The supplied screenshot records `1+1=2`,
`localNumber=43`, an `AppendResult` object expanded with `IsFailure=true`,
`Value=7`, and `appendResult.IsFailure=true`. A further screenshot of Variables
shows `completedBeforeAwait=false`; that supplementary flag observation was in
the Variables view, not a separate direct Console expression result. MCP had
explicitly evaluated the flag as false before manual selection.

After the user's selection and direct Console results, MCP repeated the values:
2, 43, complex `DebugMcpRepro.AppendResult`, true, and property value 7. **The
automatic/direct/post-manual columns agree at C's post-suspension line 39.**
The yield awaiter and continued use of both locals establish that this position
follows an actual suspension. The comparison did not include manual Console
evaluation at the earlier line 37.

The run continued normally before its deadline. Final status was `no-session`,
PID 24180 was absent, the owned line-39 breakpoint was removed, and the
breakpoint list was empty. The watchdog helper was stopped and its marker
removed; it did not have to abort the debuggee.

### E return: direct/manual follow-up

The second requested follow-up launched `Repro E - projection return` with a
direct breakpoint at line 61. It stopped at actual line 61 in
`DebugMcpRepro.Scenarios.ProjectionAsync()`, PID 52764, frame 1000, thread 8536.
The independently owned watchdog bounded the pause to 300 seconds. Before
manual selection, MCP returned `1+1=2`, `localNumber=45`, the sample object,
`appendResult.IsFailure=true`, and `appendResult.Value=7`; its evaluated assembly
location matched the exact checked Repro DLL path.

The user selected `ProjectionAsync` at line 61 and entered four Console
expressions separately. The screenshot records 2, 45, the expanded
`DebugMcpRepro.AppendResult` object with true/7 properties, and true for
`appendResult.IsFailure`. It also shows the sample DLL with symbols loaded.
MCP repeated the same five values afterwards without a difference. **The
automatic/direct/post-manual columns agree at E's return breakpoint.**

This comparison remained in the original `ProjectionAsync` frame before
executing the return. It did not enter `Map` or the lambda, manually compare
line 60, or repeat the manually assisted comparison after reaching line 61 by
stepping. The existing automatic step-over trial remains separate. As before,
the helper's yield does not establish that the caller's own await suspended.

The run continued normally before the deadline. Final status was `no-session`,
PID 52764 was absent, the owned line-61 point was removed, and the breakpoint
list was empty. The watchdog helper and its marker were removed without a
deadline-triggered abort.

### A_DEEP: selected caller scope versus reported status

This targeted comparison tested the previously static metadata concern using
`Repro A - synchronous`, PID 13336, thread 35844, and a 300-second bounded pause.
No stepping or continuation occurred between the comparison columns.

The physical breakpoint stop was requested and observed at `Scenarios.cs:12`,
`DebugMcpRepro.Scenarios.Synchronous()`. Before manual selection, status reported
frame 1000. The sample's actual loaded module matched the checked Repro DLL.
The user then explicitly selected `Program.Main(string[] args)` at `Program.cs:20`
under **CALL STACK** and evaluated `1+1`, `args.Length`, and `localNumber` as three
separate Console requests.

| Expression | Automatic MCP in Synchronous | Direct Console in selected Main | MCP after selecting Main |
| --- | --- | --- | --- |
| `1+1` | 2 | 2 | 2 |
| `localNumber` | 41 | Expected CS0103 | Expected CS0103 |
| `args.Length` | Expected CS0103 | 1 | 1 |
| `scenario` | Expected CS0103 | Not requested | `"sync"` |

These results correctly distinguish the scopes: `localNumber` belongs to
`Synchronous`, while `args` and `scenario` belong to `Main`. After selection,
`list_variable_names(scope="local")` listed `args` and `scenario`; selected-value
retrieval returned those values and reported `localNumber` not found. This
demonstrates correct caller-context evaluation, not an expression-scope defect.

Status was captured immediately after the user's selection **before** the MCP
expressions, and again afterwards:

| Status snapshot | `frameId` | `threadId` | `frameName` / `fileName` / `currentLine` |
| --- | --- | --- | --- |
| Automatic top-frame selection | 1000 | 35844 | `Scenarios.Synchronous()` / `Scenarios.cs` / 12 |
| After explicit Main selection, before MCP expressions | 1001 | 35844 | Still `Scenarios.Synchronous()` / `Scenarios.cs` / 12 |
| After MCP expressions in Main | 1001 | 35844 | Still `Scenarios.Synchronous()` / `Scenarios.cs` / 12 |

**Observed metadata limitation:** the selected frame ID changes, and expressions
use the caller, while the associated reported name/source remains the stopped
top frame. **Execution does not move to Main line 20:** selecting a caller only
changes inspection context. `currentLine=12` still correctly describes the
physical stop, but the response does not separate those stop fields from the
selected-frame identity. Consequently a legitimate caller-scope CS0103 can appear
inconsistent if a consumer treats all these status fields as one frame.

This mechanism is reproduced in one completed caller-selection comparison,
with two status snapshots after selection. No independent fresh-launch repeat
or other-language comparison has been performed. Its contribution to the
historical `appendResult` report remains unproven because that original
selection/stop context was not captured.

The published [microsoft/DebugMCP#179](https://github.com/microsoft/DebugMCP/issues/179)
and [local report](issues/selected-frame-status-metadata.md) describe the metadata
observation rather than claiming incorrect expression evaluation.

The run continued normally before its deadline. Final status was
`no-session`, PID 13336 was absent, the owned line-12 point was removed, and the
breakpoint list was empty. The watchdog helper and marker were removed without
an abort. Closing only the independently owned MCP transport returned HTTP 200.

### D: conditional breakpoint control

After the unconditional D expression checks, the only owned point at
`Scenarios.cs:52` was configured with `appendResult.IsFailure`. Separate launches
used the existing true and false profiles; no unconditional point remained to
confound the comparison.

| Control | Expected | Observed |
| --- | --- | --- |
| True profile | Stop at line 52 with a valid true condition | Stopped at actual line 52 in `AssignedAfterAwaitAsync`; frame 1000, thread 40060, PID 51940. Explicit evaluations returned `1+1=2`, `localNumber=44`, the sample object, and `appendResult.IsFailure=true`. |
| False profile | No stop at the conditional point | No pause was observed; the following status and final status both reported `no-session`. No paused frame/thread/PID was available. Its debug stdout was not captured. |

The true run was continued, and both trials removed their owned conditional
point and ended with `no-session` and an empty breakpoint list. The returned
evidence contains no condition-expression error such as CS0103. **A stop alone
does not prove condition truth:** the explicit true evaluation and the false
control support the expected behavior here. The tools did not expose the raw
DAP stop reason or dedicated condition-evaluation error metadata, so that reason
remains unobserved rather than being invented.

**False-run tool limitation:** `start_debugging` returned the text
`Debug session is running but did not stop or terminate within the timeout`,
while its own embedded state was `sessionActive=false, paused=false` and the
subsequent status was `no-session`. This inconsistent lifecycle wording does not
establish a running or hung sample. The separate normal false run's output was
already verified as `D_FALSE result=51`; that output was **not** independently
captured from this conditional debug launch. The no-pause/no-session observation
is consistent with a completed false control, with the stated evidence limit.

The start call took approximately 180 seconds to return. A separate read-only
`get_debug_status` request on the same owned public connection already reported
`no-session` while the start call was pending. This establishes a tool-level
waiting/reporting inconsistency, not a 180-second application run or an
expression-evaluation failure.

**Static candidate explanation, not an observed event trace:** inspection of the
installed readiness wait found a termination callback that resolves only when
`vscode.debug.activeDebugSession` is absent, a saved started-session reference
that is not cleared, and a later timeout decision based on that saved reference.
An event-ordering race is plausible; the actual ordering was not captured. This
candidate concerns session lifecycle reporting and does not explain the earlier
historical scope/expression report.

A local, unpublished [English issue draft](issues/start-debugging-termination.md)
describes this separate launch/termination observation. The approximate 180.5
seconds are derived from the completed trial-file timestamps, not a dedicated
stopwatch. This lifecycle trial was observed once and was not repeated.

The condition's creation through VS Code's direct **Edit Breakpoint** UI was not
compared; no manual condition result is claimed.

### Separate cleanup observation: Windows path casing

After A, `remove_breakpoint` at the original uppercase drive spelling
`D:\code\github-com\hahnfk\debugmcp-repro\Scenarios.cs`, line 12, reported
`No breakpoint found`. The same removal using lowercase `d:` succeeded, and
`list_breakpoints` was empty afterwards. The source path returned by the paused
state also used lowercase `d:`. No breakpoint from another project was touched.

**Observed:** removal depends on path spelling in this run despite referring to
the same Windows file. **Candidate explanation:** URI normalization differs
between add/list and removal. This is separate from expression evaluation and
does not explain the historical `CS0103`. **Observed cleanup workaround:** use
the normalized lowercase-drive spelling for this owned breakpoint and verify its
absence. The first observation alone does not establish the full platform/version
scope of the issue.

## Interpretation and next step

**Established:** the isolated sample builds and produces the expected synthetic
results; its disk symbols match. Automatic constant, object, and property
evaluation works at the actual tested in-scope A–E positions, including C before
and after actual suspension and E on its return line. Direct Console and MCP
before/after explicit frame selection agree in A, C after suspension at line 39,
and E's direct return breakpoint at line 61. F's CS0103 errors match its lexical scope
negative control while its positive controls succeed.

Selecting the caller in A_DEEP correctly switches direct and MCP expression
scope. The reproduced issue is mixed selected/stopped-frame status metadata,
not failure to evaluate expressions in the selected caller.

**Reproduction outcome:** the historical unexpected frame/local evaluation
difficulty was **not reproduced in the executed positive cases**. This is a
bounded negative result for these specific positions, versions, and automatic
trials; the complete direct/manual comparison was performed for A, C after
suspension at line 39, and E's direct return breakpoint at line 61. The separate
session-lifecycle and path-casing observations are not substitutes for
the unobserved historical failure.

**Still open:** direct/manual B, C before suspension, D, E before/stepped return,
and F comparisons; direct creation of the conditional breakpoint; other caller
or async-frame-selection cases, sequence points inside lambda code, and the exact frame/scope at
the historical failure. The historical `CS0103` and failed explicit expression
evaluation remain distinct unverified reports. They do not establish an application
memory error. Historical constant/logpoint success does not prove local visibility.

**Frame-evaluation workaround:** none validated. In A, C at line 39, and E's return
breakpoint at line 61, evaluation worked both before and after explicit selection,
so manual selection was not required to make these expressions work. That does
not establish a historical fix. The
separate lowercase-drive cleanup workaround succeeded for the owned A breakpoint.
For interpreting status, the validated procedure is to distinguish the physical
stop from the user's selected inspection frame and verify scope with a
frame-specific value. The constant `1+1` cannot distinguish those frames.

**Next step:** complete the remaining direct/manual and direct conditional
comparisons in agreed bounded windows if those remaining cells are needed to
resolve a specific question. Review the separate lifecycle-reporting evidence
and reproduced status-metadata limitation independently. The complete A,
C-after, E-return, and deliberately selected Main comparisons are the
baselines. Use at most three targeted repeats
if an actual difference appears. Create an English frame-evaluation issue draft
only once sufficient real evidence exists.
No changes were made to the separate Wissensmanagement project or its resources.

The [curated synthetic trial records](evidence/2026-10-24.json) retain actual
positions, expressions, frame/thread/process observations, and cleanup results.
They do not contain other projects' paths, logs, or global configuration dumps.

The initial investigation's final cleanup confirmed `no-session`, an empty Repro breakpoint list, no remaining
owned debuggees or watchdog helpers, and HTTP 200 when closing only the owned MCP
transport. The existing connection and other projects remained unchanged.

The later C39/E61 manual-comparison phase also ended with `no-session`, no
remaining owned breakpoints or debuggees, and closure of only its own MCP
transport (HTTP 200). Both assisted runs completed normally within their
300-second windows; neither required a deadline abort. Source and built-artifact
hashes still match the recorded baseline.

The later caller-selection trial also completed normally before its deadline:
PID 13336 exited, its breakpoint at `Scenarios.cs:12` was removed, its watchdog
was stopped, final status was `no-session`, and the owned MCP transport was
closed with HTTP 200. Final checks found no active manual markers or remaining
owned helpers. No source or extension change was required for the observation.
