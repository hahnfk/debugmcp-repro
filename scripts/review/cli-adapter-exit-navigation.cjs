// Copyright (c) Frank Hahn 2026. All rights reserved.
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadDebugMcp } = require('./load-debugmcp.cjs');

function argumentsForRun(args) {
    const options = { expectCurrentBug: false };
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--debugmcp-root' && args[index + 1] && !options.root) {
            options.root = args[++index];
        } else if (args[index] === '--expect-current-bug' && !options.expectCurrentBug) {
            options.expectCurrentBug = true;
        } else {
            throw new Error(`Unsupported argument: ${args[index]}`);
        }
    }
    if (!options.root) {
        throw new Error('Usage: node scripts/review/cli-adapter-exit-navigation.cjs --debugmcp-root <checkout> [--expect-current-bug]');
    }
    return options;
}

function bounded(promise, milliseconds, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms.`)), milliseconds);
        })
    ]).finally(() => clearTimeout(timer));
}

function processPresent(processId) {
    try {
        // Signal zero is an existence check, never a process-termination action.
        process.kill(processId, 0);
        return true;
    } catch (error) {
        if (error.code === 'ESRCH') {
            return false;
        }
        throw error;
    }
}

async function processGone(processId) {
    const deadline = Date.now() + 500;
    while (processPresent(processId) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    return !processPresent(processId);
}

function inactive(status) {
    return status.status === 'no-session' && status.sessionActive === false && status.paused === false;
}

function paused(status) {
    return status.status === 'paused' && status.sessionActive === true && status.paused === true;
}

async function run() {
    const options = argumentsForRun(process.argv.slice(2));
    const sut = loadDebugMcp(options.root, ['cli/cliDebuggingExecutor', 'cli/dapClient', 'debuggingHandler']);
    const { CliDebuggingExecutor } = sut.module('cli/cliDebuggingExecutor');
    const { DebuggingHandler } = sut.module('debuggingHandler');
    const fixture = path.join(__dirname, 'fixtures', 'exit-navigation-adapter.cjs');
    const fixtureLine = 5;
    const activeExecutors = new Set();
    const ownedProcessIds = new Set();
    const result = {
        test: 'CLI adapter exit during navigation',
        oracle: options.expectCurrentBug ? 'expect-current-bug' : 'regression',
        target: {
            root: sut.root, commit: sut.commit, version: sut.version, nodeVersion: sut.nodeVersion,
            sourceDirty: sut.sourceDirty, modules: sut.modules
        },
        expectedAfterAdapterExit: { status: 'no-session', sessionActive: false, paused: false },
        scenarios: [],
        controls: {},
        cleanup: { completed: false, ownedProcessIds: [] }
    };

    function createHost(mode, command) {
        const reviewRunId = randomUUID();
        const configuration = {
            name: 'review adapter exit navigation', type: 'review-fixture', request: 'launch',
            adapterName: 'review-fixture',
            adapter: { command: process.execPath, args: [fixture], type: 'review-fixture', extensions: ['.cjs'] },
            reviewMode: mode, reviewCommand: command, reviewRunId
        };
        const executor = new CliDebuggingExecutor();
        activeExecutors.add(executor);
        const manager = {
            getDebugConfig: async () => configuration,
            detectLanguageFromFilePath: () => 'review-fixture'
        };
        return { executor, handler: new DebuggingHandler(executor, manager, 2), configuration, reviewRunId };
    }

    async function readIdentity(host, frameId) {
        const reply = await bounded(host.executor.evaluateExpression('fixtureIdentity', frameId), 1500, 'Reading fixture identity');
        const identity = JSON.parse(reply.result);
        assert.equal(identity.reviewRunId, host.reviewRunId, 'The fixture must belong to this scenario.');
        assert.ok(Number.isSafeInteger(identity.processId) && identity.processId > 0 && identity.processId !== process.pid);
        ownedProcessIds.add(identity.processId);
        return identity;
    }

    async function scenario(mode, command) {
        const host = createHost(mode, command);
        const observed = {
            mode, navigation: command === 'next' ? 'step_over' : 'continue_execution',
            dapCommand: command, firstLaunchPassed: false, cleanupCompleted: false
        };
        result.scenarios.push(observed);
        let identity;
        try {
            await host.handler.handleAddBreakpoint({ fileFullPath: fixture, line: fixtureLine });
            const started = await bounded(host.handler.handleStartDebugging({
                fileFullPath: fixture, workingDirectory: __dirname, configurationName: host.configuration.name
            }), 4000, 'Launching a fresh synthetic adapter');
            const before = JSON.parse(await bounded(host.handler.handleGetDebugStatus(), 1500, 'Reading initial status'));
            assert.match(started, /^Debug session stopped at breakpoint\b/);
            assert.equal(paused(before), true, 'Every fresh host must start at its real DAP breakpoint.');
            assert.equal(before.state.currentLine, fixtureLine);
            identity = await readIdentity(host, before.state.frameId);
            assert.equal(processPresent(identity.processId), true);
            observed.firstLaunchPassed = true;
            observed.before = before;
            observed.fixture = identity;

            let navigationError = null;
            let navigationResponse = null;
            try {
                navigationResponse = await bounded(
                    command === 'next' ? host.handler.handleStepOver() : host.handler.handleContinue(),
                    3000, 'Performing synthetic navigation');
            } catch (error) {
                navigationError = error.message;
            }
            observed.navigationError = navigationError;
            observed.navigationResponse = navigationResponse;
            const shouldEnd = mode === 'crash' || (mode === 'success' && command === 'continue');
            observed.adapterProcessPresent = shouldEnd
                ? !(await processGone(identity.processId))
                : processPresent(identity.processId);
            const after = JSON.parse(await bounded(host.handler.handleGetDebugStatus(), 1500, 'Reading public post-navigation status'));
            observed.after = after;

            if (mode === 'crash') {
                assert.match(navigationError ?? '', /Debug adapter exited with exit code 23\b/,
                    'Only the intended real DapClient child-exit error may reproduce this bug.');
                assert.equal(observed.adapterProcessPresent, false, 'The adapter must really have exited.');
                observed.expected = { navigationError: 'adapter exited with exit code 23', ...result.expectedAfterAdapterExit };
                observed.regressionPassed = inactive(after);
                observed.exactCurrentBugObserved = paused(after) && after.sessionId === before.sessionId;
            } else if (mode === 'reject') {
                assert.match(navigationError ?? '', /Synthetic navigation rejection; adapter remains paused\./);
                assert.equal(observed.adapterProcessPresent, true);
                assert.equal(paused(after), true, 'A rejected request must preserve a live paused session.');
                const stillAlive = await readIdentity(host, after.state.frameId);
                assert.deepEqual(stillAlive, identity, 'The same adapter must still answer DAP requests.');
                observed.expected = { navigationError: 'synthetic rejection', status: 'paused', sessionActive: true, paused: true };
                observed.controlPassed = true;
            } else {
                assert.equal(navigationError, null, 'Successful navigation is a positive control.');
                observed.expected = command === 'next'
                    ? { navigationError: null, status: 'paused', sessionActive: true, paused: true, line: fixtureLine + 1 }
                    : { navigationError: null, ...result.expectedAfterAdapterExit };
                if (command === 'next') {
                    assert.equal(observed.adapterProcessPresent, true);
                    assert.equal(paused(after), true);
                    assert.equal(after.state.currentLine, fixtureLine + 1, 'A normal step must reach its fresh stop.');
                    assert.deepEqual(await readIdentity(host, after.state.frameId), identity);
                } else {
                    assert.equal(observed.adapterProcessPresent, false);
                    assert.equal(inactive(after), true, 'A normal continue must report program completion.');
                }
                observed.controlPassed = true;
            }
            observed.actual = {
                navigationError, adapterProcessPresent: observed.adapterProcessPresent,
                status: after.status, sessionActive: after.sessionActive, paused: after.paused
            };
        } finally {
            await bounded(host.executor.dispose(), 2500, 'Disposing an owned adapter handle');
            activeExecutors.delete(host.executor);
            const gone = identity ? await processGone(identity.processId) : true;
            observed.cleanupCompleted = gone;
            assert.equal(gone, true, 'The owned adapter process must be absent after disposal.');
        }
    }

    const hardDeadline = setTimeout(() => {
        // Terminate only this harness. Fixtures also exit on closed stdin and
        // their own deadline; a historical PID is never a kill target.
        process.stderr.write('Adapter-exit regression exceeded its 20-second process deadline.\n');
        process.exit(2);
    }, 20000);

    try {
        for (const command of ['next', 'continue']) {
            await scenario('crash', command);
            await scenario('reject', command);
            await scenario('success', command);
        }
        const crashes = result.scenarios.filter(item => item.mode === 'crash');
        const rejections = result.scenarios.filter(item => item.mode === 'reject');
        const successful = result.scenarios.filter(item => item.mode === 'success');
        result.controls = {
            sixFreshFirstLaunchesPassed: result.scenarios.length === 6 && result.scenarios.every(item => item.firstLaunchPassed),
            rejectionPreservesLivePausedSession: rejections.length === 2 && rejections.every(item => item.controlPassed),
            normalNavigationPassed: successful.length === 2 && successful.every(item => item.controlPassed)
        };
        result.passed = Object.values(result.controls).every(Boolean) && crashes.length === 2 && crashes.every(item =>
            options.expectCurrentBug ? item.exactCurrentBugObserved : item.regressionPassed);
    } catch (error) {
        result.passed = false;
        result.error = { name: error.name, message: error.message };
    } finally {
        const errors = [];
        for (const executor of activeExecutors) {
            try {
                await bounded(executor.dispose(), 2500, 'Final cleanup of an owned adapter handle');
            } catch (error) {
                errors.push(error.message);
            }
        }
        const remaining = [...ownedProcessIds].filter(processPresent);
        result.cleanup = {
            completed: errors.length === 0 && remaining.length === 0 && result.scenarios.every(item => item.cleanupCompleted),
            ownedProcessIds: [...ownedProcessIds],
            stillPresentAfterDispose: remaining,
            errors
        };
        clearTimeout(hardDeadline);
        result.passed = result.passed === true && result.cleanup.completed;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.passed) {
        process.exitCode = 1;
    }
}

run().catch(error => {
    process.stdout.write(`${JSON.stringify({ test: 'CLI adapter exit during navigation', passed: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
});
