# Standalone CLI reports a paused session after its adapter exits during navigation

## Summary

When a standalone debug adapter exits while a step or continue request is
pending, the navigation call correctly returns an adapter-exit error. The next
`get_debug_status` nevertheless reports an active, paused session, even though
the adapter process is gone.

A rejected navigation request from an adapter that remains alive should preserve
the paused session. An adapter process exit should instead leave no active
session. The reproduction distinguishes these two outcomes.

## Environment

- DebugMCP source commit: `d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4`.
- Verified baseline: Windows x64, Node.js 24.22.1, compiled `out/` modules.
- The root extension manifest at this commit reports version 2.4.4; this is not
  a claim about an installed or published standalone npm package version.
- A bounded synthetic Node DAP adapter over standard input/output; no language
  debugger, VS Code debug session or real debuggee is started.

## Reproduction steps

1. Prepare a separate Microsoft/DebugMCP checkout at the pinned source revision:

   ```powershell
   git clone https://github.com/microsoft/DebugMCP.git
   cd DebugMCP
   git checkout d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4
   npm ci --ignore-scripts
   npm run compile
   ```

2. From this reproduction working copy, run the command below. Replace
   `<absolute-path-to-DebugMCP>` with the absolute path of the separate checkout
   prepared in step 1:

   ```powershell
   node scripts/review/cli-adapter-exit-navigation.cjs --debugmcp-root "<absolute-path-to-DebugMCP>"
   ```

   Reproduction files:
   - [scripts/review/cli-adapter-exit-navigation.cjs](../../scripts/review/cli-adapter-exit-navigation.cjs)
   - [scripts/review/fixtures/exit-navigation-adapter.cjs](../../scripts/review/fixtures/exit-navigation-adapter.cjs)
   - [scripts/review/load-debugmcp.cjs](../../scripts/review/load-debugmcp.cjs)

3. The test creates a fresh production `CliDebuggingExecutor` and
   `DebuggingHandler` for each scenario. Their real `DapClient` starts the
   fixture as a child process and performs the DAP initialization and launch
   sequence. The fixture reports a breakpoint stop. The test confirms the
   public status is active and paused and reads the fixture's process ID and
   per-run marker through a public evaluation request.
4. For `step_over`, the handler sends DAP `next`. The fixture immediately calls
   `process.exit(23)` with that request still pending. It sends **no response,
   `exited` event or `terminated` event**. The actual `DapClient` child-process
   exit path rejects the pending request.
5. After receiving the navigation error, confirm that the fixture process is
   absent and call the public `get_debug_status` handler.
6. Repeat with `continue_execution`, which sends DAP `continue`. Each case uses
   a fresh executor so no previous-session startup state is involved.

The test also runs four controls: live adapters rejecting `next` and `continue`
with `success:false`, a normal step to a new stop, and a normal continue through
program completion. All six initial launches must succeed.

The default regression command exits nonzero on the reviewed commit. To require
the exact current bug, all positive controls and successful cleanup, use:

```powershell
node scripts/review/cli-adapter-exit-navigation.cjs --debugmcp-root "<absolute-path-to-DebugMCP>" --expect-current-bug
```

An arbitrary startup failure, navigation timeout, or live adapter's ordinary
request rejection does not count as reproducing this adapter-exit bug.

## Expected result

Both abrupt-exit cases should return the adapter-exit error from navigation.
Afterward, `get_debug_status` should report:

```json
{
  "status": "no-session",
  "sessionActive": false,
  "paused": false
}
```

For comparison, a live adapter's rejected request should preserve its active,
paused session, and the adapter should still answer a fixture-identity request.
Normal step and continue operations should retain their usual behavior.

## Actual result

Navigation reports an error containing:

```text
Debug adapter exited with exit code 23
```

The fixture process is absent. Nevertheless, the subsequent public status is:

```json
{
  "status": "paused",
  "sessionActive": true,
  "paused": true
}
```

The stale active-session result occurs for both `next` and `continue`. The
live-rejection and normal-navigation controls behave as expected. Process and
session IDs in the emitted JSON are observations from each local run, not
constants that other users must reproduce.

## Cause

The production
[`DapClient` process-exit callback](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/cli/dapClient.ts#L51)
rejects pending requests and synchronously emits the client `exit` event. The
executor's
[`terminated` callback](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/cli/cliDebuggingExecutor.ts#L407)
therefore marks the session terminated and clears its thread/frame context.

When the rejected navigation request resumes its asynchronous error path,
[`runThreadCommand` restores `previousState`](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/cli/cliDebuggingExecutor.ts#L471),
overwriting that newer termination with the old `stopped` state. The status
request then treats the dead adapter's session as active and paused.

Restoring the previous paused state is appropriate for the live-rejection
controls. It should not replace a newer adapter-exit state.

## Scope and test seams

This is a standalone-executor lifecycle report. The reproduction uses the actual
compiled executor, handler and DAP-client implementations. It does not write
their private fields or replace their methods. Test seams are the synthetic DAP
peer, a deterministic configuration-manager double, the shared loader's inert
`vscode` import, and a quiet logger sink.

The fixture starts no debuggee and exits on closed input or its own ten-second
deadline. The harness has a separate twenty-second deadline. Normal cleanup uses
`executor.dispose()` and the production DAP client's owned child-process handle;
PID checks are read-only, and historical process IDs are never kill targets.
The JSON reports the tested commit, Node version, source/compiled-module hashes,
all controls and fixture-process cleanup. A rebuilt local fix can be tested with
the normal regression oracle; `sourceDirty` remains visible in its output.

## Related reports

[Issue #161](https://github.com/microsoft/DebugMCP/issues/161) and merged
[PR #162](https://github.com/microsoft/DebugMCP/pull/162) address breakpoint
synchronization between sessions by resetting adapter initialization. This case
concerns an in-flight navigation request restoring stale execution state after
an actual adapter process exit.
