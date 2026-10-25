# debugmcp-repro
Minimal C#/.NET repro cases for investigating DebugMCP stack frame selection, async/await variable inspection, and conditional breakpoint evaluation in VS Code.

The sample is implemented and its normal runs are verified. An independent
DebugMCP connection has been safely associated with this workspace. Automatic
expression evaluation passes at the intended in-scope A–E positions, including
before/after a real suspension and the projection return. F reports the expected
out-of-scope error. In A, C after suspension (line 39), and E at its return
breakpoint (line 61), automatic MCP, direct Debug Console, and MCP after manual
selection of the same frame agree. Other matrix cells remain unperformed.

A targeted caller-selection trial additionally confirmed **mixed status
metadata**: after selecting `Program.Main`, MCP expressions correctly used that
caller, but status combined its selected `frameId` with the stopped top frame's
name/source/line. Execution remained paused in `Scenarios.Synchronous`. The
historical unexpected expression failure remains unreproduced. The D condition
controls and separate lifecycle/path-casing observations are detailed in the findings.

The mixed status metadata is reported in
[microsoft/DebugMCP#179](https://github.com/microsoft/DebugMCP/issues/179), with a
[local report](docs/issues/selected-frame-status-metadata.md). A separate,
unsubmitted [draft](docs/issues/start-debugging-termination.md) describes the
start/termination inconsistency. [Curated trial evidence](docs/evidence/2026-10-24.json)
is included.

## Prerequisites and quick start

- .NET SDK 10.0.402 (or a later patch in the same feature band, via `global.json`).
- VS Code with the C# debugger; DebugMCP is needed only for MCP comparisons.
- PowerShell 7.2+ for the optional verification script.

Run all commands from this repository's root:

```powershell
dotnet restore DebugMcpRepro.csproj --configfile NuGet.Config
dotnet build DebugMcpRepro.csproj --configuration Debug --no-restore
dotnet run --project DebugMcpRepro.csproj --configuration Debug --no-build -- all
./scripts/verify.ps1
```

There are no package dependencies or external services. `NuGet.Config` clears
package sources. No credentials, environment setup, or interactive input are
required. Normal runs terminate by themselves; verification limits each process
to ten seconds.

| Scenario argument | Purpose | Expected output |
| --- | --- | --- |
| `sync` | A: synchronous baseline | `A result=48` |
| `completed-await` | B: await an already completed task | `B result=49` |
| `suspended-await` | C: locals across a real suspension | `C result=50` |
| `assigned-after-await` | D: result assigned after await; condition true | `D result=37` |
| `assigned-after-await-success` | D: condition false control | `D_FALSE result=51` |
| `projection` | E: return with a lambda projection | `E result=52` |
| `out-of-scope` | F: lexical scope negative control | `F result=53` |

Replace `all` in the command above with any argument. No arguments also runs all
variants. Invalid arguments return exit code 2. Valid variants return 0.

## Debugging and isolation

Open this folder in a separate VS Code window. Select a named `Repro ...` launch
profile under **Run and Debug**. Its build task, program, and working directory
use `${workspaceFolder}`. Debug builds produce portable PDBs without optimization;
profiles require exact source matches. All seven profiles have been launched
through the separate connection. Loaded module paths were verified in A and the
direct/manual C-after and E-return follow-ups.

The existing `.vscode/settings.json` specifies `debugmcp.serverPort: 3002`.
Keep loopback binding. A different port alone does not isolate a DebugMCP window:
the installed version contains a cross-window router. Do not steer the debugger
until the workspace, source, and launch target are positively associated with the
separate connection. Do not repoint an existing connection or run automatic client
configuration.

Read [the reproduction procedure](docs/reproduction.md) for expressions, source
markers, frame selection, conditional controls, and cleanup. See
[the findings](docs/findings.md) for verified results and remaining comparisons.
[The proposed MCP addition](docs/debugmcp-repro.config.toml) is a review artifact,
not an active configuration. The same separate connection is prepared in the
ignored local `.codex/config.toml` and was recognized by the user's Codex CLI.
The running chat exposes no additional tool namespace, so the investigation uses
its own standard Streamable HTTP MCP client named `debugmcp_repro` at the confirmed
`http://localhost:3002/mcp` endpoint. No global connection was changed.

Normal output checks and matching PDBs do not prove debugger expression evaluation.
The negative control intentionally requests a variable outside its scope; that
failure would not reproduce the suspected defect.

## Source-level review reproductions

The separate [review harnesses](docs/review-reproductions.md) investigate unmatched
workspace routing, readiness on a second standalone CLI launch, execution
state after an adapter exits during navigation, registry recovery after
missed heartbeats, and readiness after a VS Code launch ends while another
session remains selected. They load
compiled code from a separately supplied Microsoft/DebugMCP checkout and use
isolated recording workers, a synthetic DAP adapter, or a VS Code host API double.
Their default mode checks
the healthy contract; `--expect-current-bug` verifies the specific observed
defect signatures and positive controls. See the procedure for setup, scope,
expected exit codes, and the issue reports.

Published findings are reported as
[Microsoft/DebugMCP#191](https://github.com/microsoft/DebugMCP/issues/191)
(unmatched workspace routing) and
[Microsoft/DebugMCP#192](https://github.com/microsoft/DebugMCP/issues/192)
(second CLI launch readiness). The adapter-exit finding is tracked in
[Microsoft/DebugMCP#193](https://github.com/microsoft/DebugMCP/issues/193), and registry
recovery in [Microsoft/DebugMCP#194](https://github.com/microsoft/DebugMCP/issues/194).
The VS Code launch-readiness report is awaiting upstream publication.
Issue instructions and reproduction links use
this repository's `main` branch. Publish reproduction material through a merged
pull request before creating an upstream issue; the tested Microsoft source
commit remains recorded separately as the version baseline.
