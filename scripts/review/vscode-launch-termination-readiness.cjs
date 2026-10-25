// Copyright (c) Frank Hahn 2026. All rights reserved.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { loadDebugMcp } = require('./load-debugmcp.cjs');

const READINESS_MS = 200;

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
        throw new Error('Usage: node scripts/review/vscode-launch-termination-readiness.cjs --debugmcp-root <checkout> [--expect-current-bug]');
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

function responseKind(response) {
    if (/^Debug session stopped at breakpoint\b/.test(response)) return 'stopped';
    if (/^Debug session attached to the running process\b/.test(response)) return 'attached';
    if (/^Debug session for .* ran to completion without stopping\b/.test(response)) return 'terminated';
    if (/^Debug session is running but did not stop or terminate within the timeout\b/.test(response)) return 'timeout';
    return 'other';
}

function timeoutResources() {
    return process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
}

function createHostDouble() {
    let fixture;
    const subscriptions = new Map();
    const event = name => listener => {
        const listeners = subscriptions.get(name) ?? new Set();
        subscriptions.set(name, listeners);
        listeners.add(listener);
        return { dispose() { listeners.delete(listener); } };
    };
    const countListeners = () => [...subscriptions.values()].reduce((sum, listeners) => sum + listeners.size, 0);
    const emit = (name, value) => {
        for (const listener of [...(subscriptions.get(name) ?? [])]) listener(value);
    };
    const trace = (name, session) => {
        fixture.trace.push({
            event: name, sessionId: session?.id, activeSessionId: fixture.activeSession?.id ?? null,
            elapsedMs: Math.round(performance.now() - fixture.beganAt)
        });
    };
    const schedule = (callback, milliseconds) => {
        const handle = setTimeout(() => {
            fixture.timers.delete(handle);
            callback();
        }, milliseconds);
        fixture.timers.add(handle);
    };
    const immediate = callback => {
        const handle = setImmediate(() => {
            fixture.immediates.delete(handle);
            callback();
        });
        fixture.immediates.add(handle);
    };
    const uri = file => ({ fsPath: file, toString: () => `file://${file.replaceAll('\\', '/')}` });
    const folder = { uri: uri(__dirname), name: 'synthetic host workspace', index: 0 };

    function session(name, request = 'launch') {
        return {
            id: randomUUID(), name, type: 'synthetic-host', configuration: { name, type: 'synthetic-host', request },
            async customRequest(command) {
                assert.equal(command, 'stackTrace', 'Only the synthetic frame control requests a stack trace.');
                return {
                    stackFrames: [{ id: 1, name: 'syntheticFrame', line: 5, column: 1, source: { path: __filename } }]
                };
            }
        };
    }

    function selectFrame() {
        fixture.activeSession = fixture.own;
        fixture.activeStackItem = { session: fixture.own, frameId: 1, threadId: 1 };
        trace('own-frame-selected', fixture.own);
        emit('stack', fixture.activeStackItem);
    }

    function terminateOwn(remaining) {
        fixture.activeSession = remaining;
        fixture.activeStackItem = undefined;
        fixture.ownTerminated = true;
        trace('own-terminated', fixture.own);
        emit('terminate', fixture.own);
        immediate(() => {
            fixture.ownTerminationCompletedAtCheckpoint = fixture.settled;
            trace('own-termination-checkpoint', fixture.own);
        });
    }

    const host = {
        Disposable: class {
            constructor(dispose) { this.release = dispose; }
            dispose() { this.release(); }
        },
        Uri: { file: uri },
        debug: {
            get activeDebugSession() { return fixture?.activeSession; },
            get activeStackItem() { return fixture?.activeStackItem; },
            breakpoints: [],
            onDidStartDebugSession: event('start'),
            onDidChangeActiveStackItem: event('stack'),
            onDidTerminateDebugSession: event('terminate'),
            async startDebugging(_folder, configuration) {
                assert.equal(configuration.name, fixture.own.configuration.name);
                fixture.startCalls++;
                fixture.activeSession = fixture.own;
                trace('own-started', fixture.own);
                emit('start', fixture.own);
                if (fixture.kind === 'terminated-alone') {
                    schedule(() => terminateOwn(undefined), 20);
                } else if (fixture.kind === 'unrelated-stays-active') {
                    schedule(() => terminateOwn(fixture.other), 20);
                } else if (fixture.kind === 'frame-selected') {
                    schedule(selectFrame, 20);
                } else if (fixture.kind === 'unrelated-termination') {
                    schedule(() => {
                        trace('unrelated-terminated', fixture.other);
                        emit('terminate', fixture.other);
                        // A real event-loop turn lets any prematurely completed
                        // production readiness/handler promise settle first.
                        immediate(() => {
                            fixture.pendingAfterUnrelatedTermination = !fixture.settled;
                            trace('unrelated-termination-checkpoint', fixture.own);
                            selectFrame();
                        });
                    }, 20);
                }
                return true;
            }
        },
        workspace: {
            getWorkspaceFolder: () => folder,
            getConfiguration: () => ({ get: (_name, fallback) => fallback }),
            async openTextDocument(documentUri) {
                const lines = fs.readFileSync(documentUri.fsPath, 'utf8').split(/\r?\n/);
                return { lineCount: lines.length, lineAt: index => ({ text: lines[index] }) };
            }
        },
        tasks: { onDidStartTask: event('task-start'), onDidEndTaskProcess: event('task-end') }
    };
    return {
        host,
        countListeners,
        current: () => fixture,
        begin(kind) {
            assert.equal(countListeners(), 0, 'A previous scenario leaked event subscriptions.');
            const own = session('review own launch', kind === 'attach-running' ? 'attach' : 'launch');
            const other = session('review independent existing launch');
            fixture = {
                kind, own, other, startCalls: 0, ownTerminated: false, settled: false,
                activeSession: kind === 'unrelated-stays-active' ? other : undefined,
                activeStackItem: undefined, timers: new Set(), immediates: new Set(), trace: [], loggerErrors: [],
                beganAt: performance.now()
            };
            trace('fixture-begin', fixture.activeSession);
            return fixture;
        },
        clearScheduled() {
            for (const handle of fixture.timers) clearTimeout(handle);
            for (const handle of fixture.immediates) clearImmediate(handle);
            fixture.timers.clear();
            fixture.immediates.clear();
        }
    };
}

async function run() {
    const options = argumentsForRun(process.argv.slice(2));
    // Validate the checkout and quiet the real logger before priming imports.
    const preflight = loadDebugMcp(options.root, []);
    const boundary = createHostDouble();
    const originalLoad = Module._load;
    const names = ['debuggingExecutor', 'debuggingHandler'];
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return boundary.host;
            return originalLoad.call(this, request, parent, isMain);
        };
        for (const name of names) require(path.join(preflight.root, 'out', `${name}.js`));
    } finally {
        Module._load = originalLoad;
    }
    assert.equal(Module._load, originalLoad, 'The temporary host import hook was not restored.');
    const sut = loadDebugMcp(preflight.root, names);
    const { DebuggingExecutor } = sut.module('debuggingExecutor');
    const { DebuggingHandler } = sut.module('debuggingHandler');
    const globalErrors = [];
    sut.module('utils/logger').logger.setSink({
        debug() {}, info() {}, warn() {},
        error(message) { (boundary.current()?.loggerErrors ?? globalErrors).push(String(message)); }
    });
    const result = {
        test: 'VS Code launch termination readiness',
        oracle: options.expectCurrentBug ? 'expect-current-bug' : 'regression',
        target: {
            root: sut.root, commit: sut.commit, version: sut.version, nodeVersion: sut.nodeVersion,
            sourceDirty: sut.sourceDirty, modules: sut.modules
        },
        testBoundary: 'event-driven synthetic VS Code host; real executor, handler and timers; no real editor or adapter',
        readinessTimeoutMs: READINESS_MS,
        scenarios: [], controls: {}, cleanup: { completed: false }
    };

    async function scenario(kind, expected) {
        const fixture = boundary.begin(kind);
        const baselineTimers = timeoutResources();
        const executor = new DebuggingExecutor();
        const handler = new DebuggingHandler(executor, {
            getDebugConfig: async () => fixture.own.configuration,
            detectLanguageFromFilePath: () => 'synthetic-host'
        }, READINESS_MS / 1000);
        const observation = new AbortController();
        const entry = { kind, expected, scope: kind === 'no-launch' ? 'executor readiness method' : 'production start handler and executor' };
        result.scenarios.push(entry);
        try {
            const pending = (kind === 'no-launch'
                ? executor.waitForDebugSessionReady(READINESS_MS, observation.signal)
                : handler.handleStartDebugging({
                    fileFullPath: __filename, workingDirectory: __dirname, configurationName: fixture.own.configuration.name
                })).then(value => {
                fixture.settled = true;
                fixture.trace.push({ event: 'operation-settled', elapsedMs: Math.round(performance.now() - fixture.beganAt) });
                return value;
            });
            const response = await bounded(pending, 1500, 'Observing synthetic host launch readiness');
            // Let the post-termination checkpoint run even when healthy
            // completion resolved the handler before that immediate executes.
            await new Promise(resolve => setImmediate(resolve));
            const actual = kind === 'no-launch' ? response : responseKind(response);
            entry.response = response;
            entry.actual = actual;
            entry.elapsedMs = Math.round(performance.now() - fixture.beganAt);
            entry.trace = fixture.trace;
            entry.ownSessionId = fixture.own.id;
            entry.independentSessionId = fixture.other.id;
            entry.startCalls = fixture.startCalls;
            entry.ownTerminated = fixture.ownTerminated;
            if (fixture.ownTerminated) {
                entry.ownTerminationCompletedAtCheckpoint = fixture.ownTerminationCompletedAtCheckpoint;
            }
            entry.activeSessionIdAfter = boundary.host.debug.activeDebugSession?.id ?? null;
            entry.globalStatusAfter = JSON.parse(await handler.handleGetDebugStatus());
            entry.regressionPassed = actual === expected;
            if (kind === 'unrelated-stays-active') {
                const started = fixture.trace.find(event => event.event === 'own-started');
                const ended = fixture.trace.find(event => event.event === 'own-terminated');
                assert.ok(started && ended && started.sessionId === ended.sessionId);
                assert.ok(fixture.trace.indexOf(started) < fixture.trace.indexOf(ended));
                assert.equal(fixture.trace[0].activeSessionId, fixture.other.id, 'The independent session must predate readiness.');
                assert.equal(ended.activeSessionId, fixture.other.id);
                assert.equal(entry.activeSessionIdAfter, fixture.other.id);
                assert.equal(entry.globalStatusAfter.sessionActive, true, 'The independent session should remain globally active.');
                assert.equal(entry.globalStatusAfter.sessionId, fixture.other.id);
                entry.regressionPassed = actual === expected && fixture.ownTerminationCompletedAtCheckpoint === true;
                entry.exactCurrentBugObserved = actual === 'timeout' && fixture.ownTerminated &&
                    fixture.startCalls === 1 && fixture.ownTerminationCompletedAtCheckpoint === false &&
                    entry.elapsedMs >= READINESS_MS - 15;
            } else {
                assert.equal(actual, expected, `${kind} control did not produce its expected readiness outcome.`);
                if (kind === 'terminated-alone') {
                    assert.equal(fixture.ownTerminationCompletedAtCheckpoint, true,
                        'A terminated lone launch must complete at the real event-loop checkpoint.');
                }
                if (kind === 'unrelated-termination') {
                    assert.equal(fixture.pendingAfterUnrelatedTermination, true,
                        'Unrelated termination must not complete the pending own launch.');
                    entry.pendingAfterUnrelatedTermination = fixture.pendingAfterUnrelatedTermination;
                }
                if (kind === 'no-launch') assert.equal(fixture.startCalls, 0);
                entry.controlPassed = true;
            }
        } finally {
            observation.abort();
            boundary.clearScheduled();
            await handler.dispose();
            // The production implementation schedules a real 100ms frame probe
            // after start. Let that bounded probe drain without faking its timer.
            await new Promise(resolve => setTimeout(resolve, 130));
            await new Promise(resolve => setImmediate(resolve));
            entry.cleanup = {
                subscriptionsRemaining: boundary.countListeners(),
                hostTimersRemaining: fixture.timers.size,
                hostImmediatesRemaining: fixture.immediates.size,
                timeoutResourcesBefore: baselineTimers,
                timeoutResourcesAfterQuiescence: timeoutResources(),
                loggerErrors: fixture.loggerErrors
            };
            entry.cleanup.completed = entry.cleanup.subscriptionsRemaining === 0 &&
                entry.cleanup.hostTimersRemaining === 0 && entry.cleanup.hostImmediatesRemaining === 0 &&
                entry.cleanup.timeoutResourcesAfterQuiescence <= baselineTimers && fixture.loggerErrors.length === 0;
            assert.equal(entry.cleanup.completed, true, `${kind} leaked a subscription/timer or logged a host error.`);
        }
    }

    const deadline = setTimeout(() => {
        process.stderr.write('Synthetic VS Code readiness regression exceeded its five-second deadline.\n');
        process.exit(2);
    }, 5000);
    try {
        await scenario('unrelated-stays-active', 'terminated');
        await scenario('terminated-alone', 'terminated');
        await scenario('frame-selected', 'stopped');
        await scenario('attach-running', 'attached');
        await scenario('no-launch', 'no-session');
        await scenario('unrelated-termination', 'stopped');
        const bug = result.scenarios[0];
        const controls = result.scenarios.slice(1);
        result.controls = {
            count: controls.length,
            allFivePassed: controls.length === 5 && controls.every(item => item.controlPassed),
            unrelatedTerminationDidNotCompleteOwnLaunch: result.scenarios.find(item => item.kind === 'unrelated-termination').pendingAfterUnrelatedTermination
        };
        result.passed = result.controls.allFivePassed &&
            (options.expectCurrentBug ? bug.exactCurrentBugObserved : bug.regressionPassed);
    } catch (error) {
        result.passed = false;
        result.error = { name: error.name, message: error.message };
    } finally {
        clearTimeout(deadline);
        result.cleanup = {
            completed: result.scenarios.every(item => item.cleanup?.completed) && boundary.countListeners() === 0 &&
                globalErrors.length === 0 && Module._load === originalLoad,
            subscriptionsRemaining: boundary.countListeners(),
            hostImportHookRestored: Module._load === originalLoad,
            errorsOutsideScenarios: globalErrors
        };
        result.passed = result.passed === true && result.cleanup.completed;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.passed) process.exitCode = 1;
}

run().catch(error => {
    process.stdout.write(`${JSON.stringify({ test: 'VS Code launch termination readiness', passed: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
});
