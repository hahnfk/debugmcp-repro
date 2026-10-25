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
        throw new Error('Usage: node scripts/review/cli-second-start-readiness.cjs --debugmcp-root <checkout> [--expect-current-bug]');
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

function replyKind(reply) {
    if (/^Debug session stopped at breakpoint\b/.test(reply)) {
        return 'stopped';
    }
    if (/^Debug session for .* ran to completion without stopping\b/.test(reply)) {
        return 'terminated';
    }
    return 'other';
}

function summarize(state) {
    return {
        sessionActive: state.sessionActive,
        paused: state.isPaused(),
        frameId: state.frameId,
        threadId: state.threadId,
        fileName: state.fileName,
        currentLine: state.currentLine
    };
}

function processPresent(processId) {
    try {
        process.kill(processId, 0);
        return true;
    } catch (error) {
        if (error.code === 'ESRCH') {
            return false;
        }
        throw error;
    }
}

async function run() {
    const options = argumentsForRun(process.argv.slice(2));
    const sut = loadDebugMcp(options.root, ['cli/cliDebuggingExecutor', 'cli/dapClient', 'debuggingHandler']);
    const { CliDebuggingExecutor } = sut.module('cli/cliDebuggingExecutor');
    const { DebuggingHandler } = sut.module('debuggingHandler');
    const fixture = path.join(__dirname, 'fixtures', 'readiness-adapter.cjs');
    const fixtureLine = 3;
    const executors = [];
    const ownedProcessIds = new Set();
    const result = {
        test: 'CLI second-start readiness',
        oracle: options.expectCurrentBug ? 'expect-current-bug' : 'regression',
        target: {
            root: sut.root, commit: sut.commit, version: sut.version, nodeVersion: sut.nodeVersion,
            sourceDirty: sut.sourceDirty, modules: sut.modules
        },
        expected: { everyStartReply: 'stopped', sessionActive: true, paused: true },
        controls: {},
        cases: [],
        cleanup: { completed: false, ownedProcessIds: [] }
    };
    function createHost() {
        const reviewRunId = randomUUID();
        const configuration = {
            name: 'review CLI readiness', type: 'review-fixture', request: 'launch', adapterName: 'review-fixture',
            adapter: { command: process.execPath, args: [fixture], type: 'review-fixture', extensions: ['.cjs'] },
            reviewRunId
        };
        const executor = new CliDebuggingExecutor();
        executors.push(executor);
        const manager = {
            getDebugConfig: async () => configuration,
            detectLanguageFromFilePath: () => 'review-fixture'
        };
        const handler = new DebuggingHandler(executor, manager, 2);
        return { executor, handler, configuration, reviewRunId };
    }

    async function launch(host) {
        const response = await bounded(host.handler.handleStartDebugging({
            fileFullPath: fixture, workingDirectory: __dirname, configurationName: host.configuration.name
        }), 7000, 'Starting a synthetic DAP session');
        const state = await bounded(host.executor.getCurrentDebugState(), 2000, 'Reading the synthetic paused state');
        assert.equal(state.sessionActive, true, 'The new synthetic DAP session must exist.');
        assert.equal(state.isPaused(), true, 'The fixture must deliver its breakpoint stop.');
        const identityReply = await bounded(
            host.executor.evaluateExpression('fixtureIdentity', state.frameId), 2000, 'Reading the fixture identity');
        const identity = JSON.parse(identityReply.result);
        assert.equal(identity.reviewRunId, host.reviewRunId, 'Only a child created for this test may be recorded.');
        assert.ok(Number.isSafeInteger(identity.processId) && identity.processId > 0 && identity.processId !== process.pid);
        ownedProcessIds.add(identity.processId);
        return {
            response, responseKind: replyKind(response), snapshot: summarize(state),
            sessionId: host.executor.getActiveSession().id, processId: identity.processId
        };
    }

    async function addSavedBreakpoint(host) {
        await host.handler.handleAddBreakpoint({ fileFullPath: fixture, line: fixtureLine });
        const saved = host.executor.getBreakpoints();
        assert.equal(saved.length, 1);
        assert.equal(saved[0].fileFullPath, fixture);
        assert.equal(saved[0].line, fixtureLine);
    }

    async function recoveryCase(endMethod) {
        const host = createHost();
        await addSavedBreakpoint(host);
        const first = await launch(host);
        assert.equal(first.responseKind, 'stopped', 'The first start is a positive control.');
        const endedResponse = await bounded(
            endMethod === 'stop_debugging'
                ? host.handler.handleStopDebugging()
                : host.handler.handleContinue(),
            4000, 'Ending the first synthetic DAP session');
        const inactive = await host.executor.getCurrentDebugState();
        assert.equal(inactive.sessionActive, false, 'The first session must end before the second start.');
        const second = await launch(host);
        assert.notEqual(second.sessionId, first.sessionId, 'The second start must create a new session.');
        const saved = host.executor.getBreakpoints();
        const sameSavedBreakpoint = saved.length === 1 && saved[0].fileFullPath === fixture && saved[0].line === fixtureLine;
        assert.equal(sameSavedBreakpoint, true, 'Both starts must use the same saved breakpoint.');
        const embeddedState = JSON.parse(second.response.slice(second.response.indexOf('{')));
        const exactBug = second.responseKind === 'terminated' &&
            second.snapshot.sessionActive && second.snapshot.paused &&
            embeddedState.sessionActive === true && embeddedState.paused === true;
        const observed = {
            endFirstWith: endMethod, first, afterFirstEnd: summarize(inactive), endedResponse,
            second, sameSavedBreakpoint, exactCurrentBugObserved: exactBug,
            actual: { secondStartReply: second.responseKind, ...second.snapshot }
        };
        result.cases.push(observed);
        await bounded(host.handler.handleStopDebugging(), 4000, 'Stopping the second synthetic DAP session');
        assert.equal((await host.executor.getCurrentDebugState()).sessionActive, false);
        return observed;
    }

    const hardDeadline = setTimeout(() => {
        // Exit only this harness. Closing its pipes lets the fixture exit, and
        // each fixture independently enforces its own 15-second deadline.
        // Historical process IDs must never be used for destructive cleanup.
        process.stderr.write('Synthetic readiness regression exceeded its 20-second process deadline.\n');
        process.exit(2);
    }, 20000);

    try {
        await recoveryCase('stop_debugging');
        await recoveryCase('continue_execution');
        const fresh = createHost();
        await addSavedBreakpoint(fresh);
        result.controls.freshExecutorFirstStart = await launch(fresh);
        assert.equal(result.controls.freshExecutorFirstStart.responseKind, 'stopped');
        await bounded(fresh.handler.handleStopDebugging(), 4000, 'Stopping the fresh-executor control');
        result.controls.firstStartsStopped = result.cases.every(item => item.first.responseKind === 'stopped');
        result.controls.firstSessionsEnded = result.cases.every(item => item.afterFirstEnd.sessionActive === false);
        result.controls.freshExecutorPassed = true;
        result.passed = options.expectCurrentBug
            ? result.cases.every(item => item.exactCurrentBugObserved)
            : result.cases.every(item => item.second.responseKind === 'stopped');
    } catch (error) {
        result.passed = false;
        result.error = { name: error.name, message: error.message };
    } finally {
        const cleanupErrors = [];
        for (const executor of executors) {
            try {
                await bounded(executor.dispose(), 3000, 'Disposing an owned synthetic DAP session');
            } catch (error) {
                cleanupErrors.push(error.message);
            }
        }
        const remaining = [...ownedProcessIds].filter(processPresent);
        result.cleanup = {
            completed: cleanupErrors.length === 0 && remaining.length === 0,
            ownedProcessIds: [...ownedProcessIds],
            stillPresentAfterDispose: remaining,
            errors: cleanupErrors
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
    process.stdout.write(`${JSON.stringify({ test: 'CLI second-start readiness', passed: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
});
