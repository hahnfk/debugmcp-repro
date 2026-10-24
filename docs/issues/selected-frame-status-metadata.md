# get_debug_status mixes the selected frame ID with top-frame source metadata

Published report: [microsoft/DebugMCP#179](https://github.com/microsoft/DebugMCP/issues/179).

The program stops inside `Synchronous`, but the user selects its caller `Main`
to inspect that caller's variables. Expression evaluation correctly follows
`Main`. The status response reports `Main`'s frame ID together with the name and
source of `Synchronous`, without saying that these fields describe two different
frames. This report asks for that distinction to be made explicit.

## Environment

- Windows x64; VS Code 1.143.1.
- DebugMCP extension 2.4.3; C# extension 2.160.4; C# Dev Kit 3.40.215.
- .NET SDK 10.0.402; runtime 10.0.13; Debug build with portable PDBs.
- Reproduction project: [hahnfk/debugmcp-repro](https://github.com/hahnfk/debugmcp-repro/tree/dd3594066a5441b7b420a96656f211fd86328df6).

## Reproduction steps

1. Clone and build the sample in a new folder:

   ```powershell
   git clone https://github.com/hahnfk/debugmcp-repro.git
   cd debugmcp-repro
   git checkout dd3594066a5441b7b420a96656f211fd86328df6
   dotnet restore DebugMcpRepro.csproj --configfile NuGet.Config
   dotnet build DebugMcpRepro.csproj --configuration Debug --no-restore
   ```

2. Open the checkout in a separate VS Code window. Use the DebugMCP connection
   associated with that workspace for all following MCP calls. The included
   workspace settings use `http://localhost:3002/mcp`.
3. Call `add_breakpoint` with the absolute path to `Scenarios.cs` and `line: 12`
   (marker `BREAK A`).
4. Call `start_debugging` with these inputs, replacing `<absolute-checkout>` with
   the actual absolute checkout path:

   ```json
   {
     "fileFullPath": "<absolute-checkout>/Scenarios.cs",
     "workingDirectory": "<absolute-checkout>",
     "configurationName": "Repro A - synchronous"
   }
   ```

5. At the breakpoint, call `get_debug_status` and evaluate `localNumber` through
   MCP to record the initial top-frame context.
6. In **Run and Debug → CALL STACK**, select the caller
   **`Program.Main(string[] args) Line 20`**. Do not step or resume execution.
7. In **Debug Console**, evaluate `1+1`, `args.Length`, and `localNumber` as three
   separate submissions, confirming each with Enter.
8. On the same MCP connection, call `get_debug_status`, evaluate those same three
   expressions separately with `evaluate_expression`, then call
   `get_debug_status` again. Keep `Program.Main` selected throughout.

Process, thread, and frame IDs are assigned locally and can change between runs
and machines. No particular PID, thread ID, or frame ID is required. Compare
identifiers only within the same paused session; select frames by their method
names and source positions.

## Expected result

The response should distinguish these two contexts:

- **Physical execution stop:** `Scenarios.Synchronous`, `Scenarios.cs:12`.
- **Selected evaluation frame:** `Program.Main`, `Program.cs:20`.

If `state.frameId` identifies the selected `Main` frame, its associated name and
source metadata should identify that frame. Alternatively, expose stopped-frame
and selected-frame information as explicitly separate fields/objects.

The selected `Main` frame should evaluate `1+1` to 2 and `args.Length` to 1.
`localNumber` should produce CS0103 there, because that local belongs to
`Scenarios.Synchronous`.

## Actual result

The direct Console and MCP expressions both use the selected `Main` scope
correctly:

| Expression | Direct Debug Console | MCP after selecting Main |
| --- | --- | --- |
| `1+1` | 2 | 2 |
| `args.Length` | 1 | 1 |
| `localNumber` | CS0103, expected | CS0103, expected |

After selecting `Program.Main`, `get_debug_status` returned the following fields.
The frame ID 1001 identifies the selected `Main` frame in this local run, but
the name and source still identify `Synchronous`:

```json
{
  "frameId": 1001,
  "frameName": "DebugMcpRepro.dll!DebugMcpRepro.Scenarios.Synchronous() Line 12",
  "fileName": "Scenarios.cs",
  "currentLine": 12
}
```

Calling `get_debug_status` again after the expression evaluations returned the
same fields.

These IDs are examples from the recorded local run, not reproduction constants.
The physical stop correctly remains at `Scenarios.cs:12`; selecting a caller does
not move execution. The inconsistency is that the response does not distinguish
that stopped-frame metadata from the selected evaluation frame's identity.
For example, an agent trusting `frameName: Synchronous` could expect
`localNumber` to be available. Its evaluation actually uses the selected `Main`
frame, where the resulting CS0103 is correct. The status should make that
evaluation context clear; it should not imply that all returned frame fields
belong to the same frame.

## Evidence and related report

[Findings](../findings.md), [full procedure](../reproduction.md), and
[curated synthetic evidence](../evidence/2026-10-24.json) contain the recorded
source positions and before/after status snapshots.

[Issue #82](https://github.com/microsoft/DebugMCP/issues/82) concerns stale source
positions after stepping. This case changes the selected caller without any
step or execution transition.
