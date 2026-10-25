# A live window stays undiscoverable after another window prunes its stale registry entry

Upstream issue: [microsoft/DebugMCP#194](https://github.com/microsoft/DebugMCP/issues/194).

## Summary

If one DebugMCP window misses registry heartbeats long enough for another window
to prune its entry, later heartbeats from the still-live owner do not restore
that entry. Other windows can no longer discover the owner's workspace until it
explicitly registers again.

This report isolates the registry recovery path. The reproduction simulates an
expired timestamp in its own fixture data; it does not suspend a real VS Code
extension host or reproduce an operating-system sleep/resume sequence.

## Environment

- Microsoft/DebugMCP source commit: `d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4`.
- Verified baseline: Windows x64, Node.js `v24.22.1`, package version 2.4.4.
- The actual compiled `WorkspaceRegistry` implementation, loaded from a separate
  checkout. Each run reports its commit, Node version, source state and
  source/compiled-module hashes.
- Two isolated Node fixture processes with real, distinct process IDs and an
  exclusive temporary registry. No installed editor registry is accessed.

## Reproduction steps

1. Prepare a separate checkout of Microsoft/DebugMCP at the pinned revision:

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
   node scripts/review/registry-heartbeat-recovery.cjs --debugmcp-root "<absolute-path-to-DebugMCP>"
   ```

   Reproduction files on `main`:
   - [scripts/review/registry-heartbeat-recovery.cjs](../../scripts/review/registry-heartbeat-recovery.cjs)
   - [scripts/review/load-debugmcp.cjs](../../scripts/review/load-debugmcp.cjs)

3. The harness creates its own temporary directory and starts fixture processes
   A and B. Each constructs a real `WorkspaceRegistry` with its own process ID,
   registers a synthetic workspace, and remains available over IPC. The harness
   confirms that B can list both registrations and find both workspace paths.
4. It changes **only `updatedAt` in A's own fixture registration file** to
   `Date.now() - 61000`. All other registration fields are preserved. This is a
   simulation of elapsed heartbeat time; the system clock and upstream methods
   are unchanged, and the test does not wait 61 seconds.
5. B calls the public `list()` method. On the reviewed commit this removes A's
   stale entry even though A remains alive. The harness confirms A's identity
   through its existing IPC channel and performs the read-only OS liveness check
   `process.kill(pid, 0)` before and after this operation.
6. A calls its real public `heartbeat()` three times. After every completed
   call, B uses `list()` and `findByPath(A)` to check discoverability. Both fixture
   processes must remain alive and responsive throughout.
7. Finally, A calls the public `register()` explicitly. B can then find A again,
   demonstrating a recovery workaround using the same live owner and registry.

The test also checks normal registration/path lookup, timestamp advancement and
file persistence during a fresh heartbeat, and explicit unregistration removing
only A while preserving B. The fresh-heartbeat control sets only its fixture
timestamp one second into the past, within the normal entry lifetime, to avoid a
clock-tick timing dependency. It does not call `heartbeat()` after explicit
unregistration or prescribe a reactivation policy for that case.

## Expected result

An owner that remains active and resumes heartbeats should remain discoverable
or recover its registry advertisement. After each heartbeat in this scenario,
B should be able to list A and find A's workspace while retaining its own entry.

The default regression command should exit with code 0 when that healthy
contract holds and all four controls and cleanup checks pass. It also accepts a
future implementation that keeps a live owner's entry instead of pruning it;
the test does not require a particular fix strategy.

## Actual result

On the reviewed commit:

| Phase | Observed result |
| --- | --- |
| Initial registrations | A and B are present; both workspace paths resolve correctly |
| B lists after A's timestamp was aged | A's file is removed; only B remains |
| A completes heartbeat 1 | A's file is still absent; B cannot find A |
| A completes heartbeat 2 | A's file is still absent; B cannot find A |
| A completes heartbeat 3 | A's file is still absent; B cannot find A |
| A explicitly registers again | A becomes discoverable again; B remains present |

IPC identity checks and OS liveness checks confirm that both original fixture
processes remain alive during pruning and all three heartbeats. All four
controls pass. The default regression command therefore exits with code 1.

The [recorded evidence](../evidence/2026-10-25-registry-heartbeat.json) contains
both central runs, all heartbeat outcomes, the controls, liveness checks,
cleanup results and source/compiled-module hashes.

To require the exact current failure signature, all controls and successful
cleanup, use:

```powershell
node scripts/review/registry-heartbeat-recovery.cjs --debugmcp-root "<absolute-path-to-DebugMCP>" --expect-current-bug
```

That diagnostic mode exits with code 0 only when B actually prunes the live A
registration and all three completed A heartbeats leave it absent while B stays
discoverable. An IPC timeout, crashed fixture, filesystem failure or unrelated
exception does not count as reproducing the bug.

## Cause and impact

[`list()`](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/utils/workspaceRegistry.ts#L90-L117)
prunes another process's entry when its timestamp is older than 60 seconds,
even if its process is alive. The owner's subsequent
[`heartbeat()`](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/utils/workspaceRegistry.ts#L72-L83)
first reads its existing file. Once that file is missing, `ENOENT` is ignored
and no replacement registration is written.

In the extension,
[`registerSelf()` is called on activation and workspace-folder changes](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/extension.ts#L91-L105),
whereas the periodic timer calls only `heartbeat()`. A peer-pruned window can
therefore stay undiscoverable until one of those explicit registration paths is
triggered. Existing cached routing targets may still work; this report concerns
registry discoverability and new path-based target resolution.

A recovery approach could retain the active registration inputs for recreation
or explicitly re-register active windows periodically. Avoiding removal of a
live owner's entry is another possible approach. The reproduction checks the
observable discoverability contract rather than choosing one implementation.

## Scope and test seams

The harness does not replace or monkeypatch registry methods or private fields.
It uses the real filesystem and actual child-process liveness checks. The only
direct registration-file edit is the controlled `updatedAt` fixture-data change.
The common loader suppresses logging; an error-counting logger sink also prevents
an unrelated internally logged heartbeat error from counting as the bug signature.
No real editor, debugger or MCP server is started. Each fixture owns an idle loopback listener solely to reserve an
OS-assigned port for its registration metadata; it is not a VS Code
`ControlServer`.

The scenario has a twelve-second deadline followed by bounded worker cleanup.
Cleanup uses only the harness's exact child-process handles, IPC disconnect and
the fixture's own exit path. Recursive removal verifies that the resolved target
is the harness's own prefixed directory immediately under the OS temporary
directory. Process IDs, ports, synthetic tokens and paths are locally generated
observations, not reproduction constants; tokens are not printed.

The evidence establishes the recovery failure after controlled timestamp aging.
It does not establish how often a real host pauses long enough to trigger
pruning, or claim a live reproduction of suspend/resume behavior.

## Related reports and changes

- [PR #104](https://github.com/microsoft/DebugMCP/pull/104) introduced multi-window
  registration and heartbeat-based pruning.
- [PR #154](https://github.com/microsoft/DebugMCP/pull/154) hardened registry
  storage, ownership checks and atomic writes. It preserves the missing-file
  heartbeat behavior described here.
- [Issue #165](https://github.com/microsoft/DebugMCP/issues/165) concerns per-workspace
  ports and multi-window reliability; it does not identify this recovery trigger.

## Investigation tooling

This investigation and its reproduction work were carried out with assistance
from OpenAI Codex.

- Codex desktop app version: `26.1021.31345` (build `21828`).
- Version verified on `2026-10-25`, when this tooling disclosure was added.

The automated reproduction runs directly as an isolated Node.js harness against
the DebugMCP implementation. Codex assisted the investigation, harness authoring
and report preparation.
