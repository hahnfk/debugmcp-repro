# A second standalone CLI launch reports completion while the new session is paused

## Summary

Reusing one standalone CLI handler after a debug session ends makes the next
`start_debugging` response describe that previous session's termination. The new
session starts normally and hits its breakpoint, but the response says that it
"ran to completion without stopping". Its embedded state simultaneously reports
an active, paused session.

This concerns the standalone CLI executor and handler. It does not reproduce a
VS Code launch or rely on editor focus or VS Code's selected frame.

## Environment

- DebugMCP source commit: `d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4`.
- The root package manifest at this commit reports extension version 2.4.4.
- Verified baseline: Windows x64, Node.js 24.22.1 and the repository's compiled
  `out/` modules.
- A bounded synthetic Node DAP adapter communicating over standard input/output.
  The adapter starts no debuggee and requires no installed language debugger.

The test emits the actual checkout commit, Node version, source/compiled-module
hashes, session IDs and fixture-process IDs. IDs are assigned during the run;
no particular process or session ID is a reproduction prerequisite.

## Reproduction steps

1. In a separate DebugMCP checkout, select the commit above and build its modules:

   ```powershell
   git checkout d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4
   npm ci --ignore-scripts
   npm run compile
   ```

2. From this reproduction repository, run the regression against that checkout:

   ```powershell
   node scripts/review/cli-second-start-readiness.cjs --debugmcp-root "<absolute-path-to-DebugMCP>"
   ```

   Local test files:
   - [Regression harness](../../scripts/review/cli-second-start-readiness.cjs)
   - [Synthetic DAP adapter](../../scripts/review/fixtures/readiness-adapter.cjs)
   - [Module loader](../../scripts/review/load-debugmcp.cjs)

   These paths are relative to the reproduction repository.

3. The test constructs the actual `CliDebuggingExecutor` and `DebuggingHandler`
   with the actual `DapClient`. It saves one breakpoint through the public
   handler and starts the synthetic adapter. The adapter performs
   `initialize → launch → initialized → setBreakpoints → configurationDone → stopped`.
   The first start reports the breakpoint stop correctly.
4. It ends that first session using `stop_debugging`, confirms the executor is
   inactive, and starts again through the **same handler** with the same saved
   breakpoint. The new adapter delivers another real DAP `stopped` event.
5. It repeats the comparison after normal completion via `continue_execution`.
   An independent fresh-executor first start is an additional positive control.

The default command checks the expected fixed behavior and exits nonzero on the
reviewed commit. To require the exact current bug together with the positive
controls and successful process cleanup, add `--expect-current-bug`:

```powershell
node scripts/review/cli-second-start-readiness.cjs --debugmcp-root "<absolute-path-to-DebugMCP>" --expect-current-bug
```

An arbitrary startup failure does not count as reproducing the bug.

## Expected result

Every new launch should wait for and describe that launch's readiness outcome.
Both starts above hit the saved breakpoint, so each response should report a
breakpoint stop with `sessionActive: true` and `paused: true`.

## Actual result

The first start reports a breakpoint stop. After the first session ends, the
second response says:

```text
Debug session for <fixture-path> ran to completion without stopping (no breakpoint hit).
```

The same response's state describes the new session:

```json
{
  "sessionActive": true,
  "paused": true,
  "configurationName": "review CLI readiness"
}
```

An independent state request confirms that the second session is active and
paused. Its session ID differs from the first session's ID. Both the explicit
stop and normal-completion cases exhibit the mismatch; a fresh executor's first
start remains a successful positive control.

## Cause and scope

[`handleStartDebugging`](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/debuggingHandler.ts#L134)
creates its readiness promise before starting the next session. The CLI
[`waitForDebugSessionReady`](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/cli/cliDebuggingExecutor.ts#L361)
immediately returns an existing ready state. After a previous run,
[`readyState`](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/cli/cliDebuggingExecutor.ts#L424)
returns `terminated`. That already-resolved promise is then used for the new
launch even though its state has advanced to a new active session.

The reproduction exercises production executor, handler and DAP-client methods
without writing private fields or replacing their methods. Its test seams are
the synthetic DAP adapter, a deterministic configuration-manager double supplying
the same launch configuration, the loader's inert `vscode` import and its quiet
logger sink. No VS Code window, language extension or real debuggee is controlled.
Fixture processes exit on continue/disconnect, closed input or their own
15-second deadline. Normal cleanup uses `executor.dispose()`, which closes the
adapter through its owned child-process handle. The harness has a separate
20-second deadline and reports remaining process IDs without killing by PID.

For the recorded baseline, use the clean pinned checkout above. The harness also
accepts a rebuilt local fix, reports `sourceDirty` and module hashes, and applies
the normal regression oracle when `--expect-current-bug` is omitted.

## Related reports

- [Issue #161](https://github.com/microsoft/DebugMCP/issues/161) and merged
  [PR #162](https://github.com/microsoft/DebugMCP/pull/162) address breakpoint
  synchronization after session termination by clearing `initialized`.
  Breakpoint editing between sessions works in this reproduction. The remaining
  mismatch is the readiness result selected for the second launch.
- This draft reports source behavior at the pinned commit. It makes no claim
  about which npm package versions have been published or installed.
