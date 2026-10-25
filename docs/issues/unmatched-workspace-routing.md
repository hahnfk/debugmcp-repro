# Explicit unmatched workspace paths can be forwarded to a different VS Code window

## Environment and scope

- Microsoft/DebugMCP commit: `d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4` (`main`, package version 2.4.4).
- Measured baseline: Windows x64, Node.js `v24.22.1`.
- The actual Node.js version, source state, and source/compiled hashes are reported by each run's metadata line.
- This reproduces routing, registry, authenticated loopback HTTP forwarding, and worker dispatch using unchanged compiled upstream modules.
- Only the debug operation is a recording handler. The workers are isolated fixture processes, not real VS Code windows; no application is launched or stepped.

## Reproduction steps

1. Prepare a separate checkout of Microsoft/DebugMCP at the commit above and run its normal dependency installation and TypeScript build:

   ```powershell
   git clone https://github.com/microsoft/DebugMCP.git
   cd DebugMCP
   git checkout d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4
   npm ci --ignore-scripts
   npm run compile
   ```

2. From the reproduction repository, run the [routing regression harness](../../scripts/review/unmatched-workspace-routing.cjs), supplying that checkout's absolute path:

   ```powershell
   node scripts/review/unmatched-workspace-routing.cjs --debugmcp-root "<absolute-path-to-DebugMCP>"
   ```

   Its companion [loader](../../scripts/review/load-debugmcp.cjs) checks the checkout and compiled output. The script has no dependency on a running editor or MCP server.

3. The harness creates its own temporary registry and three synthetic project directories, A, B, and C. It starts fixture worker A using the real `ControlServer` and `WorkspaceRegistry`; C is deliberately not registered.
4. On a new `RoutingDebuggingHandler`, it calls `handleStartDebugging` with C's absolute source path and working directory. The real registry returns no match for C.
5. It starts a second registered fixture worker B, creates another router, and first makes a valid call for A. On that same router it then requests C again.
6. It also checks three controls: a valid path selects B, a hintless follow-up preserves A, and a fresh hintless call with A and B registered is rejected.

The harness emits JSON lines with expected and actual results for each case, stops its own workers, and removes only its own temporary registry and synthetic files. Worker PIDs, ports, tokens, and temporary paths are generated locally; none is a reproduction constant. The routing run has a 12-second deadline plus bounded worker cleanup.

## Expected result

An explicit path that belongs to no registered workspace should be rejected without invoking any worker. A previously cached target or the existence of a sole unrelated window should not override that explicit path.

The three positive controls should continue to pass. In default regression mode the harness should exit with code 0 when this behavior is implemented.

The rejection checks require the existing actionable unmatched-workspace diagnostic (including C's path) or, for the ambiguous hintless control, the no-active-target diagnostic. A timeout, transport failure, or unrelated exception does not count as correct behavior. If a future fix deliberately changes these diagnostic messages, the oracle should be updated to match its documented replacement.

## Actual result

Both unmatched-path cases are forwarded to worker A:

| Case | Expected | Observed |
| --- | --- | --- |
| New router; only A registered; request explicitly targets C | Reject; no worker called | A receives `handleStartDebugging` with C's paths |
| A and B registered; router previously selected A; request explicitly targets C | Reject; no worker called | Cached A receives `handleStartDebugging` with C's paths |

The valid-B, cached-A hintless, and fresh ambiguous hintless controls pass. The normal regression command consequently exits with code 1 on the reviewed commit.

To verify these two specific current bug signatures while requiring the same positive controls to pass, use:

```powershell
node scripts/review/unmatched-workspace-routing.cjs --debugmcp-root "<absolute-path-to-DebugMCP>" --expect-current-bug
```

That diagnostic mode exits with code 0 only when both requests are actually dispatched to A with C's arguments and all three controls pass. It is not the expected post-fix behavior.

## Cause and impact

[`resolveTarget()`](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/routingDebuggingHandler.ts#L44-L68) adopts a new target only when `findByPath()` succeeds. On a miss it retains an existing cached target; if no target is cached, it runs the sole-window recovery even though an explicit path was supplied.

This bypasses the registry's deliberate [no-foreign-workspace fallback](https://github.com/microsoft/DebugMCP/blob/d0b4a334a6a3d8d600c5aa75ec60d9de272af3c4/src/utils/workspaceRegistry.ts#L120-L153). As a result, a request can be processed in a VS Code window whose workspace does not contain the requested project. The exact subsequent launch behavior depends on that window's configurations. The fixture demonstrates the wrong dispatch; it does not claim that a particular real application was launched.

A possible fix is to reject an explicit unmatched path immediately, while preserving cached-target and sole-window recovery for hintless operations.

## Related reports and changes

- [PR #104](https://github.com/microsoft/DebugMCP/pull/104) introduced multi-window routing. This report isolates a remaining unmatched-path/cache case.
- [Issue #165](https://github.com/microsoft/DebugMCP/issues/165) concerns workspace ports and multi-window reliability; it does not specify this trigger.
- [Open PR #137](https://github.com/microsoft/DebugMCP/pull/137) extends routing for virtual source URIs. Its reviewed diff preserves the native-path cache/recovery behavior described here.

The historical registry tests reject a foreign path at the registry layer. The missing integration coverage is the router's subsequent fallback after that rejection.
