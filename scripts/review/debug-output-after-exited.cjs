// Copyright (c) Frank Hahn 2026. All rights reserved.
'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadDebugMcp } = require('./load-debugmcp.cjs');

const PREFIX = 'PROBE|output-exit-review|';

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
        throw new Error('Usage: node scripts/review/debug-output-after-exited.cjs --debugmcp-root <checkout> [--expect-current-bug]');
    }
    return options;
}

function createHostBoundary() {
    let activeFactory;
    let retainedFactory;
    const terminated = new Set();
    return {
        api: {
            registerDebugAdapterTrackerFactory(type, factory) {
                assert.equal(type, '*');
                assert.equal(activeFactory, undefined);
                activeFactory = retainedFactory = factory;
                return { dispose() { activeFactory = undefined; } };
            },
            onDidTerminateDebugSession(callback) {
                terminated.add(callback);
                return { dispose() { terminated.delete(callback); } };
            }
        },
        create(session) {
            assert.ok(activeFactory, 'A live tracker factory must be registered.');
            const callbacks = activeFactory.createDebugAdapterTracker(session);
            assert.ok(callbacks, 'The registered factory must return its production tracker callbacks.');
            return callbacks;
        },
        terminate(session) {
            for (const callback of [...terminated]) callback(session);
        },
        createAfterDisposal(session) {
            return retainedFactory.createDebugAdapterTracker(session);
        },
        counts() {
            return { factoryRegistrations: activeFactory ? 1 : 0, terminationSubscriptions: terminated.size };
        }
    };
}

async function run() {
    const options = argumentsForRun(process.argv.slice(2));
    const sut = loadDebugMcp(options.root, [
        'utils/debugSessionTracker', 'utils/debugOutputBuffer', 'debuggingExecutor', 'debuggingHandler'
    ]);
    const { DebugSessionTracker } = sut.module('utils/debugSessionTracker');
    const { DebugOutputBuffer } = sut.module('utils/debugOutputBuffer');
    const { DebuggingExecutor } = sut.module('debuggingExecutor');
    const { DebuggingHandler } = sut.module('debuggingHandler');
    let current;
    const globalErrors = [];
    sut.module('utils/logger').logger.setSink({
        debug() {}, info() {}, warn() {},
        error(message) { (current?.loggerErrors ?? globalErrors).push(String(message)); }
    });
    const fixtures = [];
    const result = {
        test: 'Debug output after DAP exited',
        oracle: options.expectCurrentBug ? 'expect-current-bug' : 'regression',
        target: {
            root: sut.root, commit: sut.commit, version: sut.version, nodeVersion: sut.nodeVersion,
            sourceDirty: sut.sourceDirty, modules: sut.modules
        },
        testBoundary: 'public VS Code tracker-factory callbacks with synthetic DAP events; actual tracker, buffer, executor and handler',
        scenarios: [], controls: {}, cleanup: { completed: false }
    };

    function fixture(captureEnabled = true) {
        const host = createHostBoundary();
        const state = { enabled: captureEnabled, loggerErrors: [], sessions: [], phase: 'scenario', trace: [] };
        const buffer = new DebugOutputBuffer(() => state.enabled);
        const tracker = new DebugSessionTracker(host.api, buffer);
        const executor = new DebuggingExecutor(tracker);
        const handler = new DebuggingHandler(executor, {
            getDebugConfig() { throw new Error('No launch-configuration lookup belongs to an output-read test.'); },
            detectLanguageFromFilePath() { throw new Error('No language lookup belongs to an output-read test.'); }
        }, 1);
        const value = {
            ...state,
            host, buffer, tracker, executor, handler,
            setEnabled(enabled) { state.enabled = enabled; },
            create(label, sessionId = randomUUID()) {
                const session = { id: sessionId, name: label, type: 'synthetic-output', configuration: { name: label, type: 'synthetic-output', request: 'launch' } };
                const callbacks = host.create(session);
                let sequence = 0;
                const owner = {
                    session, callbacks, label,
                    send(event, body = {}) {
                        const message = { seq: ++sequence, type: 'event', event, body };
                        state.trace.push({ phase: state.phase, owner: label, sessionId, message });
                        callbacks.onDidSendMessage(message);
                    },
                    output(marker) { this.send('output', { category: 'console', output: `${PREFIX}${marker}\n` }); }
                };
                state.sessions.push(owner);
                return owner;
            },
            async read(owner, arguments_ = {}) {
                return JSON.parse(await handler.handleGetDebugOutput({
                    sessionId: owner.session.id, prefix: PREFIX, category: 'console', limit: 1, ...arguments_
                }));
            },
            execution(owner) {
                return { sessionEnded: tracker.hasSessionEnded(owner.session), pausedState: String(tracker.getPausedState(owner.session.id)) };
            },
            assertExecutionEnded(owner) {
                assert.equal(tracker.hasSessionEnded(owner.session), true);
                assert.equal(tracker.getPausedState(owner.session.id), undefined, 'Output capture must not restore execution state.');
            },
            async disposeAndCheck() {
                tracker.dispose();
                state.enabled = true;
                state.phase = 'after-disposal';
                for (const owner of state.sessions) {
                    owner.output('after-disposal-must-not-recreate-capture');
                    owner.send('stopped', { reason: 'pause', threadId: 1, allThreadsStopped: true });
                }
                const disposedSession = { id: randomUUID(), name: 'disposed factory check', type: 'synthetic-output' };
                assert.equal(host.createAfterDisposal(disposedSession), undefined, 'A disposed factory must not create another tracker.');
                for (const sessionId of new Set(state.sessions.map(owner => owner.session.id))) {
                    assert.equal(tracker.getPausedState(sessionId), undefined, 'Disposed callbacks must not recreate execution state.');
                    await assert.rejects(handler.handleGetDebugOutput({ sessionId, prefix: PREFIX }), /No captured output session/,
                        'Disposed tracker callbacks must not recreate buffered history.');
                }
                const counts = host.counts();
                assert.deepEqual(counts, { factoryRegistrations: 0, terminationSubscriptions: 0 });
                assert.deepEqual(state.loggerErrors, [], 'Unexpected internally logged errors must not count as a reproduction.');
                return {
                    completed: true, ...counts, bufferCleared: true,
                    oldCallbacksDidNotRecreateCapture: true, oldCallbacksDidNotRecreateExecutionState: true,
                    disposedFactoryCreatedNoTracker: true,
                    loggerErrors: state.loggerErrors
                };
            }
        };
        fixtures.push(value);
        return value;
    }

    async function drain(value, owner, cursor) {
        const pages = [];
        const outputs = [];
        let lastSequence = 0;
        for (let index = 0; index < 8; index++) {
            const page = await value.read(owner, cursor === undefined ? {} : { cursor });
            assert.equal(page.sessionId, owner.session.id);
            assert.equal(page.entries.length <= 1, true, 'The explicit one-entry page bound must be respected.');
            assert.equal(page.truncated, false, 'These small fixtures must not evict output.');
            for (const entry of page.entries) {
                assert.ok(entry.sequence > lastSequence, 'Incremental reads must not duplicate earlier entries.');
                assert.equal(entry.category, 'console');
                assert.equal(entry.redacted, false, 'Only harmless synthetic markers are used.');
                lastSequence = entry.sequence;
                outputs.push(entry.output);
            }
            pages.push(page);
            cursor = page.nextCursor;
            if (page.entries.length === 0 && !page.hasMore) return { pages, outputs, nextCursor: cursor };
        }
        throw new Error('Small synthetic output history did not reach its incremental end.');
    }

    async function scenario(name, captureEnabled, body) {
        const value = fixture(captureEnabled);
        current = value;
        const entry = { name, captureEnabled, trace: value.trace };
        result.scenarios.push(entry);
        try {
            await body(value, entry);
        } finally {
            entry.cleanup = await value.disposeAndCheck();
        }
    }

    const deadline = setTimeout(() => {
        process.stderr.write('Synthetic output regression exceeded its eight-second deadline.\n');
        process.exit(2);
    }, 8000);
    try {
        await scenario('output-between-exited-and-terminated', true, async (value, entry) => {
            const owner = value.create('late output owner');
            const expected = ['before-exited', 'after-exited-one', 'after-exited-two'].map(marker => `${PREFIX}${marker}\n`);
            owner.output('before-exited');
            const first = await value.read(owner);
            assert.deepEqual(first.entries.map(item => item.output), [expected[0]], 'Initial capture is a positive prerequisite.');
            owner.send('exited', { exitCode: 0 });
            value.assertExecutionEnded(owner);
            entry.executionAfterExited = value.execution(owner);
            owner.output('after-exited-one');
            owner.output('after-exited-two');
            value.assertExecutionEnded(owner);
            entry.executionAfterLateOutput = value.execution(owner);
            owner.send('terminated');
            value.assertExecutionEnded(owner);
            const incremental = await drain(value, owner, first.nextCursor);
            const history = await value.read(owner, { limit: 100 });
            entry.firstPage = first;
            entry.incremental = incremental;
            entry.expectedOutputs = expected;
            entry.actualOutputs = history.entries.map(item => item.output);
            entry.regressionPassed = JSON.stringify(entry.actualOutputs) === JSON.stringify(expected) &&
                JSON.stringify(incremental.outputs) === JSON.stringify(expected.slice(1));
            entry.exactCurrentBugObserved = entry.actualOutputs.length === 1 && entry.actualOutputs[0] === expected[0] &&
                incremental.outputs.length === 0 && incremental.pages.length === 1 &&
                incremental.nextCursor === first.nextCursor && incremental.pages[0].hasMore === false;
        });

        await scenario('normal-pagination-execution-end-and-retention', true, async (value, entry) => {
            const owner = value.create('normal retained history');
            owner.send('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
            assert.equal(value.tracker.getPausedState(owner.session.id), true);
            owner.output('normal-one');
            owner.output('normal-two');
            owner.send('exited', { exitCode: 0 });
            value.assertExecutionEnded(owner);
            owner.send('stopped', { reason: 'pause', threadId: 1, allThreadsStopped: true });
            value.assertExecutionEnded(owner);
            owner.send('terminated');
            const retained = await drain(value, owner);
            assert.deepEqual(retained.outputs, [`${PREFIX}normal-one\n`, `${PREFIX}normal-two\n`]);
            assert.equal(retained.pages[0].hasMore, true);
            assert.equal(retained.pages.at(-1).entries.length, 0);
            entry.retained = retained;
            entry.execution = value.execution(owner);
            entry.controlPassed = true;
        });

        await scenario('session-isolation', true, async (value, entry) => {
            const a = value.create('isolated A');
            const b = value.create('isolated B');
            a.output('session-A');
            b.output('session-B-one');
            a.callbacks.onWillStopSession();
            b.output('session-B-two');
            const firstA = await value.read(a);
            const bHistory = await drain(value, b);
            assert.deepEqual(firstA.entries.map(item => item.output), [`${PREFIX}session-A\n`]);
            assert.deepEqual(bHistory.outputs, [`${PREFIX}session-B-one\n`, `${PREFIX}session-B-two\n`]);
            await assert.rejects(value.read(b, { cursor: firstA.nextCursor }), /Invalid output cursor/);
            entry.a = firstA;
            entry.b = bHistory;
            entry.controlPassed = true;
        });

        await scenario('capture-disabled', false, async (value, entry) => {
            const owner = value.create('capture disabled');
            owner.output('must-not-be-captured');
            await assert.rejects(value.read(owner), /Debug output capture is disabled/);
            value.setEnabled(true);
            await assert.rejects(value.read(owner), /No captured output session/);
            entry.captureWasDisabled = true;
            entry.noHistoryAppearedAfterLocalOptIn = true;
            entry.controlPassed = true;
        });

        for (const boundary of ['onWillStopSession', 'onExit', 'onDidTerminateDebugSession']) {
            await scenario(`closed-owner-${boundary}`, true, async (value, entry) => {
                const owner = value.create(boundary);
                owner.output('before-owner-close');
                if (boundary === 'onDidTerminateDebugSession') value.host.terminate(owner.session);
                else if (boundary === 'onExit') owner.callbacks.onExit(0, undefined);
                else owner.callbacks.onWillStopSession();
                value.assertExecutionEnded(owner);
                owner.output('after-owner-close-must-not-appear');
                const retained = await drain(value, owner);
                assert.deepEqual(retained.outputs, [`${PREFIX}before-owner-close\n`]);
                entry.retained = retained;
                entry.execution = value.execution(owner);
                entry.controlPassed = true;
            });
        }

        await scenario('stale-tracker-generation', true, async (value, entry) => {
            const old = value.create('old tracker generation');
            old.output('old-generation');
            const oldPage = await value.read(old);
            const fresh = value.create('fresh tracker generation', old.session.id);
            fresh.send('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
            fresh.output('fresh-generation');
            old.output('stale-callback-must-not-contaminate');
            old.callbacks.onWillStopSession();
            old.callbacks.onExit(0, undefined);
            assert.equal(value.tracker.hasSessionEnded(fresh.session), false);
            assert.equal(value.tracker.getPausedState(fresh.session.id), true);
            const history = await drain(value, fresh);
            assert.deepEqual(history.outputs, [`${PREFIX}fresh-generation\n`]);
            await assert.rejects(value.read(fresh, { cursor: oldPage.nextCursor }), /Invalid output cursor/);
            entry.sameSessionIdNewGeneration = true;
            entry.history = history;
            entry.execution = value.execution(fresh);
            entry.controlPassed = true;
        });

        const bug = result.scenarios[0];
        const controls = result.scenarios.slice(1);
        result.controls = {
            count: controls.length,
            allSevenPassed: controls.length === 7 && controls.every(entry => entry.controlPassed),
            names: controls.map(entry => entry.name)
        };
        result.passed = result.controls.allSevenPassed &&
            (options.expectCurrentBug ? bug.exactCurrentBugObserved : bug.regressionPassed);
    } catch (error) {
        result.passed = false;
        result.error = { name: error.name, message: error.message };
    } finally {
        for (const value of fixtures) value.tracker.dispose();
        clearTimeout(deadline);
        result.cleanup = {
            completed: result.scenarios.every(entry => entry.cleanup?.completed) &&
                fixtures.every(value => Object.values(value.host.counts()).every(count => count === 0)) && globalErrors.length === 0,
            factoryRegistrationsRemaining: fixtures.reduce((sum, value) => sum + value.host.counts().factoryRegistrations, 0),
            terminationSubscriptionsRemaining: fixtures.reduce((sum, value) => sum + value.host.counts().terminationSubscriptions, 0),
            errorsOutsideScenarios: globalErrors
        };
        result.passed = result.passed === true && result.cleanup.completed;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.passed) process.exitCode = 1;
}

run().catch(error => {
    process.stdout.write(`${JSON.stringify({ test: 'Debug output after DAP exited', passed: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
});
