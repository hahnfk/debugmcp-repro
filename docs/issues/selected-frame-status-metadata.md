# Draft: get_debug_status mixes the selected frame ID with top-frame source metadata

Local, unpublished issue draft. The expression evaluator used the correct
selected frame in this trial. The problem is the ambiguous combination of frame
identity and source metadata in the status response.

## Environment and sample

- Windows x64, VS Code 1.143.1.
- DebugMCP extension 2.4.3, C# extension 2.160.4, C# Dev Kit 3.40.215.
- .NET SDK 10.0.402, runtime 10.0.13, Debug build with portable PDBs and exact source.
- Sample: this repository, profile `Repro A - synchronous`, CLI argument `sync`.
- Own verified Repro window and independent MCP transport at port 3002; no other
  project's session, connection, processes, or breakpoints were changed.

`Scenarios.Synchronous` has `localNumber=41` and stops at `Scenarios.cs:12`.
Its caller is `Program.Main(string[] args)` at `Program.cs:20`, where `args.Length`
is 1 and `scenario` is `"sync"`.

## Reproduction

1. Build the sample with the README commands.
2. Set one owned breakpoint at `Scenarios.cs:12` (`BREAK A`) and launch the named
   profile using `start_debugging` with exact source path and working directory.
3. Before manual selection, call `get_debug_status`. In this run the top frame
   was ID 1000, `Scenarios.Synchronous`, `Scenarios.cs:12`.
4. In VS Code **Run and Debug → CALL STACK**, click the caller
   `Program.Main(string[] args) Line 20`. Do not step or resume.
5. In **Debug Console**, evaluate each expression separately: `1+1`, `args.Length`,
   and `localNumber`. Observe 2, 1, and the expected CS0103 for `localNumber`.
6. On the same MCP transport, call `get_debug_status` before any further expression
   call, then evaluate those expressions with MCP. Query status again afterwards.

Process, thread, and frame IDs are assigned locally and can change between
runs and machines. Any IDs below are observations from one run, not constants
or reproduction parameters. Use the profile, source positions, and frame names
to reproduce the behavior; compare IDs only within the same paused session.

## Observed

The manually selected caller was visible at `Program.cs:20`. The debuggee process
and reported thread stayed the same throughout this single local comparison.

Both status snapshots after caller selection contained this combination
(the numeric IDs are examples from that local run):

```json
{
  "frameId": 1001,
  "threadId": 35844,
  "frameName": "DebugMcpRepro.dll!DebugMcpRepro.Scenarios.Synchronous() Line 12",
  "fileName": "Scenarios.cs",
  "currentLine": 12
}
```

The returned stack trace also contained the caller at `Program.cs:20`.
MCP evaluation and selected-variable inspection used that caller correctly:

| Expression | Debug Console in selected Main frame | MCP after selection |
| --- | --- | --- |
| `1+1` | 2 | 2 |
| `args.Length` | 1 | 1 |
| `localNumber` | CS0103, expected outside this method | CS0103, expected |
| `scenario` | Not evaluated in Debug Console; Variables view showed `"sync"` | `"sync"` |

MCP listed `args` and `scenario` as locals and reported `localNumber` not found.
Before caller selection, MCP had instead read `localNumber=41` and correctly
reported `args` and `scenario` outside the `Synchronous` scope.

The physical breakpoint stop is still `Scenarios.cs:12`. Selecting its caller
does **not** move execution to `Program.cs:20`. Reporting the top stop location
is therefore not inherently wrong. The problem is that the response combines
the selected caller's frame ID with a `frameName` and source from a different
frame, without distinguishing those two meanings.

## Expected

Expose consistent frame identity/name/source for the selected evaluation frame,
or explicitly separate the physical stopped frame/location from the selected
evaluation frame. An agent should be able to tell which frame its expressions
use without interpreting mixed fields as a single frame description.

## Impact and scope

Trusting the reported `Synchronous` source while evaluating the selected `Main`
frame can make a legitimate scope error appear unexpected. This provides a
concrete ambiguity in context reporting; it does not establish the cause of
the historical application-specific expression failure.

One successful assisted run produced the same mixed metadata in snapshots both
before and after MCP evaluation. An earlier assisted attempt expired before a
complete caller comparison and is not counted as a successful reproduction.
No repeated fresh-launch reproduction or other-language test has been performed.

## Related report

[Issue #82](https://github.com/microsoft/DebugMCP/issues/82) describes stale source
positions after stepping. This reproduction uses a different trigger: selecting
a caller without stepping or resuming. The physical stop stays fixed while the
selected evaluation frame changes. The report distinguishes those locations
rather than claiming that execution moved to the caller.

## Implementation observation and possible fix

Static inspection of the installed 2.4.3 bundle indicates that the selected frame
ID comes from `activeStackItem`, while name/source extraction uses the first
`stackTrace` element rather than matching that selected ID. This agrees with the
observed response. Review whether extraction should match the selected frame or
whether the response should contain separate stopped/selected frame objects.
No extension code was changed or patched during this investigation.

## Evidence and cleanup

See [findings](../findings.md), [reproduction procedure](../reproduction.md), and
[curated synthetic evidence](../evidence/2026-10-24.json). The user supplied the
direct-console screenshot; no unrelated data or logs were copied.

The successful run was continued normally before its 300-second deadline.
Its process exited, the owned breakpoint was removed, final status was
`no-session`, and only the owned MCP transport was closed.
