# Source-level review reproductions

These independent Node.js harnesses investigate two findings from the review of
Microsoft/DebugMCP commit
`d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4` (package version 2.4.4).
They are separate from this repository's C# frame-evaluation sample.

| Harness | Expected healthy behavior | Observed at the reviewed commit |
| --- | --- | --- |
| `scripts/review/unmatched-workspace-routing.cjs` | Reject an explicit project path that belongs to no registered workspace, without forwarding an operation. | A fresh router with one registered workspace, or a router with a cached target, forwards the operation to that unrelated workspace. |
| `scripts/review/cli-second-start-readiness.cjs` | A second launch through the same handler waits for its own breakpoint and reports a stopped session. | The old session's `terminated` readiness produces a completion message for the still-active new launch. |

## Preparation

Requirements: Git, Node.js, and a separate Microsoft/DebugMCP checkout with its
locked npm dependencies. The recorded baseline uses Node.js 24.22.1 on Windows
x64. VS Code, its installed DebugMCP extension, and language debug adapters are
not needed for these harnesses.

Use the reviewed commit in a dedicated checkout when reproducing the reports.
Do not reset an existing checkout with unrelated changes. For example, after
cloning Microsoft/DebugMCP into your chosen directory:

```powershell
$debugMcpRoot = 'D:\code\github-com\microsoft\DebugMCP'
git -C $debugMcpRoot rev-parse HEAD
# For a fresh review checkout only:
git -C $debugMcpRoot checkout d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4

Push-Location $debugMcpRoot
try {
    npm ci --ignore-scripts --no-audit --no-fund
    npm run compile
} finally {
    Pop-Location
}
```

Compilation is a required preparation step, including after any upstream source
change. The loader records the checkout commit, source-dirty flag, and hashes
of loaded source/JavaScript modules; it rejects obviously older compiled output.
These checks provide traceability, not proof that arbitrary pre-existing
JavaScript was generated from the adjacent TypeScript.

## Run as regression tests

Run these commands from this repository's root, supplying your actual upstream
checkout path:

```powershell
node ./scripts/review/unmatched-workspace-routing.cjs --debugmcp-root $debugMcpRoot
node ./scripts/review/cli-second-start-readiness.cjs --debugmcp-root $debugMcpRoot
```

Each harness compares actual behavior with the healthy contract. On the reviewed
commit it returns a nonzero exit code because the regression is present.
Positive controls must still pass. After a suitable upstream fix and rebuild,
the corresponding default regression command should pass.

## Confirm the known defect signatures

For automated reproduction on the reviewed baseline:

```powershell
node ./scripts/review/unmatched-workspace-routing.cjs --debugmcp-root $debugMcpRoot --expect-current-bug
node ./scripts/review/cli-second-start-readiness.cjs --debugmcp-root $debugMcpRoot --expect-current-bug
```

This mode returns zero only when the specific reported defect and the positive
controls are both observed. A setup failure, timeout, unrelated launch failure,
or a fixed implementation must not count as successful bug reproduction.
The JSON output distinguishes expected and actual results.

The [recorded baseline results](evidence/2026-10-25-review-reproductions.json)
contain four central runs: each harness in regression and confirmation mode.
Both routing failure cases reproduced with all three controls passing. Both CLI
recovery cases reproduced after explicit stop and normal completion; the first
launches and fresh-executor control passed. All owned workers, adapter
processes, and temporary registry files were cleaned up.

## What is real and what is simulated

The routing harness uses the upstream router, on-disk workspace registry, and
HTTP control servers. Recording handlers replace only the debugger operations
at those servers. The two failure cases use separate router instances and
explicitly establish that the requested path has no registry match.

The CLI harness uses the upstream handler, CLI executor, and DAP client. A small
Node.js fixture process implements a controlled DAP exchange over stdio. It
generates protocol events; it does not assign private executor state or replace
executor methods. A deterministic configuration-provider double supplies the
fixture's launch options instead of resolving an editor configuration. The
first launch and a fresh-executor control distinguish the failure from a
generally broken adapter or launch configuration.

The loader supplies an import-only `vscode` stub for modules shared with the
extension and suppresses the upstream logger. No VS Code operation is executed.
Thus the findings are isolated integration reproductions, not claims about a
particular real language adapter or a live VS Code window.

Temporary registries, ports, credentials, and adapter processes belong to the
harnesses and are cleaned up. Existing VS Code windows, user settings, installed
extensions, live workspace registrations, and GitHub content are not changed.
PID, port, session, and temporary-path values are assigned locally and are not
reproduction constants.

## Issue reports

- [Unmatched workspace routing](issues/unmatched-workspace-routing.md)
- [Second CLI launch readiness](issues/cli-second-start-readiness.md)

The reports link to pinned upstream code. Their fixture links are relative to
this reproduction repository. The GitHub issue versions use fixed-commit links
for those files so the reports remain independent of branch names.
