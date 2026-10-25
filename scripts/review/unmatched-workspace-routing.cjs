// Copyright (c) Frank Hahn 2026. All rights reserved.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { loadDebugMcp } = require('./load-debugmcp.cjs');

const REQUIRED_MODULES = ['routingDebuggingHandler', 'controlServer', 'utils/workspaceRegistry'];
const TEMP_PREFIX = 'debugmcp-routing-review-';
const RPC_TIMEOUT_MS = 2000;
const RUN_TIMEOUT_MS = 12000;

function parseArguments(argv) {
    const result = { root: undefined, expectCurrentBug: false, worker: false };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--debugmcp-root' && !result.root && argv[index + 1] && !argv[index + 1].startsWith('--')) {
            result.root = argv[++index];
        } else if (argument === '--expect-current-bug' && !result.expectCurrentBug) {
            result.expectCurrentBug = true;
        } else if (argument === '--worker' && !result.worker) {
            result.worker = true;
        } else {
            throw new Error(`Unexpected or incomplete argument: ${argument}`);
        }
    }
    if (!result.root) {
        throw new Error('Usage: node unmatched-workspace-routing.cjs --debugmcp-root <checkout> [--expect-current-bug]');
    }
    if (result.worker && !process.send) {
        throw new Error('The worker mode is reserved for this harness\'s own IPC child processes.');
    }
    return result;
}

// Only the actual debug operation is replaced. Registry lookup, target caching,
// request serialization, token verification and HTTP dispatch are upstream code.
class RecordingHandler {
    constructor(name) {
        this.name = name;
        this.calls = [];
    }

    record(operation, args) {
        this.calls.push({ window: this.name, operation, arguments: args });
        return Promise.resolve(JSON.stringify({ window: this.name, operation }));
    }

    handleStartDebugging(args) { return this.record('handleStartDebugging', args); }
    handleStepOver() { return this.record('handleStepOver', {}); }
}

function runWorker(checkoutRoot) {
    const sut = loadDebugMcp(checkoutRoot, REQUIRED_MODULES);
    const { ControlServer } = sut.module('controlServer');
    const { WorkspaceRegistry } = sut.module('utils/workspaceRegistry');
    let server;
    let registry;
    let handler;
    let stopping = false;

    process.on('message', async message => {
        try {
            let result;
            switch (message.command) {
                case 'start': {
                    assert.equal(server, undefined, 'A worker must be started only once.');
                    handler = new RecordingHandler(message.name);
                    server = new ControlServer(handler, message.token);
                    const port = await server.start();
                    registry = new WorkspaceRegistry(process.pid, message.registryDirectory);
                    registry.register({
                        controlPort: port,
                        controlToken: message.token,
                        workspaceFolders: [message.workspace],
                        name: message.name
                    });
                    result = { pid: process.pid, port, name: message.name };
                    break;
                }
                case 'reset':
                    handler.calls.length = 0;
                    result = true;
                    break;
                case 'calls':
                    result = handler.calls;
                    break;
                case 'stop':
                    stopping = true;
                    registry?.unregister();
                    await server?.stop();
                    result = true;
                    break;
                default:
                    throw new Error('Unknown fixture worker command.');
            }
            process.send({ id: message.id, result });
            if (message.command === 'stop') {
                setImmediate(() => process.disconnect());
            }
        } catch (error) {
            process.send({ id: message.id, error: error.message });
        }
    });

    process.on('disconnect', () => {
        if (stopping) { return; }
        stopping = true;
        registry?.unregister();
        const fallback = setTimeout(() => process.exit(1), 250);
        Promise.resolve(server?.stop()).finally(() => {
            clearTimeout(fallback);
            process.exit(0);
        });
    });
}

function startWorker(checkoutRoot) {
    const child = fork(__filename, ['--worker', '--debugmcp-root', checkoutRoot], {
        cwd: checkoutRoot,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    const pending = new Map();
    let sequence = 0;
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => {
        for (const task of pending.values()) {
            clearTimeout(task.timer);
            task.reject(new Error(`Fixture worker exited (${code ?? signal}). ${stderr}`));
        }
        pending.clear();
        resolve({ code, signal });
    }));
    child.on('message', message => {
        const task = pending.get(message.id);
        if (!task) { return; }
        pending.delete(message.id);
        clearTimeout(task.timer);
        if (message.error) { task.reject(new Error(message.error)); }
        else { task.resolve(message.result); }
    });
    child.on('error', error => {
        for (const task of pending.values()) {
            clearTimeout(task.timer);
            task.reject(error);
        }
        pending.clear();
    });
    return {
        child,
        exited,
        rpc(command, fields = {}) {
            return new Promise((resolve, reject) => {
                const id = ++sequence;
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`Fixture IPC timed out during ${command}. ${stderr}`));
                }, RPC_TIMEOUT_MS);
                pending.set(id, { resolve, reject, timer });
                child.send({ id, command, ...fields }, error => {
                    if (!error || !pending.delete(id)) { return; }
                    clearTimeout(timer);
                    reject(error);
                });
            });
        }
    };
}

async function stopWorker(worker) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) { return; }
    if (worker.child.connected) {
        await Promise.race([
            worker.rpc('stop').catch(() => undefined),
            new Promise(resolve => setTimeout(resolve, 300))
        ]);
    }
    const exitedGracefully = await Promise.race([
        worker.exited.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 300))
    ]);
    if (!exitedGracefully) {
        worker.child.kill(); // This exact child belongs to this harness.
        const killed = await Promise.race([
            worker.exited.then(() => true),
            new Promise(resolve => setTimeout(() => resolve(false), 700))
        ]);
        if (!killed) { throw new Error(`The fixture child ${worker.child.pid} did not exit.`); }
    }
}

function removeOwnTemporaryDirectory(directory) {
    const tempBase = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(directory);
    if (fs.lstatSync(directory).isSymbolicLink() || path.dirname(resolved) !== tempBase ||
        !path.basename(resolved).startsWith(TEMP_PREFIX) || path.basename(resolved) === TEMP_PREFIX) {
        throw new Error('Refusing to remove a directory outside the harness\'s own temporary root.');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}

async function run(options) {
    const sut = loadDebugMcp(options.root, REQUIRED_MODULES);
    const { RoutingDebuggingHandler } = sut.module('routingDebuggingHandler');
    const { WorkspaceRegistry } = sut.module('utils/workspaceRegistry');
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    const registryDirectory = path.join(temporaryDirectory, 'registry');
    const projects = Object.fromEntries(['A', 'B', 'C'].map(name => [name, path.join(temporaryDirectory, name)]));
    const workers = [];
    const cases = [];
    let expired = false;
    let deadline;
    let cleanupErrors = [];
    let runError;
    let registry;
    const makeRouter = () => new RoutingDebuggingHandler(registry, 1, 1500);
    const argumentsFor = name => ({ fileFullPath: path.join(projects[name], 'app.js'), workingDirectory: projects[name] });
    const wronglyDispatchedToA = (observed, calls, requested) => observed.outcome === 'resolved' &&
        observed.result.window === 'A' && observed.result.operation === 'handleStartDebugging' && calls.length === 1 &&
        calls[0].window === 'A' && calls[0].operation === 'handleStartDebugging' &&
        calls[0].arguments.workingDirectory === requested.workingDirectory && calls[0].arguments.fileFullPath === requested.fileFullPath;
    const rejectedUnmatchedPath = (observed, calls) => observed.outcome === 'rejected' && calls.length === 0 &&
        /could not find an open VS Code window whose workspace contains/i.test(observed.error) && observed.error.includes(projects.C);
    const emit = entry => process.stdout.write(JSON.stringify(entry) + '\n');
    const resetCalls = () => Promise.all(workers.map(worker => worker.rpc('reset')));
    const readCalls = async () => (await Promise.all(workers.map(worker => worker.rpc('calls')))).flat();
    const call = async operation => {
        if (expired) { throw new Error('The harness deadline has expired.'); }
        try { return { outcome: 'resolved', result: JSON.parse(await operation()) }; }
        catch (error) { return { outcome: 'rejected', error: error.message }; }
    };
    const record = (name, expected, actual, regressionPassed, bugReproduced = false) => {
        const entry = { type: 'case', name, expected, actual, regressionPassed, bugReproduced };
        cases.push(entry);
        emit(entry);
    };
    const addWindow = async name => {
        const worker = startWorker(sut.root);
        workers.push(worker);
        const identity = await worker.rpc('start', {
            name,
            registryDirectory,
            workspace: projects[name],
            token: crypto.randomUUID()
        });
        assert.equal(identity.pid, worker.child.pid);
        assert.ok(identity.port > 0);
    };

    try {
        emit({ type: 'metadata', ...sut, mode: options.expectCurrentBug ? 'expect-current-bug' : 'regression' });
        for (const folder of Object.values(projects)) {
            fs.mkdirSync(folder);
            fs.writeFileSync(path.join(folder, 'app.js'), '// Synthetic fixture only; never executed.\n');
        }
        registry = new WorkspaceRegistry(process.pid, registryDirectory);
        await Promise.race([
            (async () => {
                await addWindow('A');
                assert.equal(registry.findByPath(projects.C), undefined);
                await resetCalls();
                const first = await call(() => makeRouter().handleStartDebugging(argumentsFor('C')));
                const firstCalls = await readCalls();
                record('fresh-unmatched-path-with-sole-window',
                    { outcome: 'rejected', diagnostic: 'unmatched-workspace', workerCalls: [] }, { ...first, workerCalls: firstCalls },
                    rejectedUnmatchedPath(first, firstCalls),
                    wronglyDispatchedToA(first, firstCalls, argumentsFor('C')));

                await addWindow('B');
                await resetCalls();
                const cached = makeRouter();
                const established = await call(() => cached.handleStartDebugging(argumentsFor('A')));
                assert.equal(established.result?.window, 'A', 'The cache setup must first reach the matching A worker.');
                await resetCalls();
                assert.equal(registry.findByPath(projects.C), undefined);
                const second = await call(() => cached.handleStartDebugging(argumentsFor('C')));
                const secondCalls = await readCalls();
                record('cached-A-unmatched-path-with-two-windows',
                    { outcome: 'rejected', diagnostic: 'unmatched-workspace', workerCalls: [] }, { ...second, workerCalls: secondCalls },
                    rejectedUnmatchedPath(second, secondCalls),
                    wronglyDispatchedToA(second, secondCalls, argumentsFor('C')));

                await resetCalls();
                const matching = await call(() => makeRouter().handleStartDebugging(argumentsFor('B')));
                const matchingCalls = await readCalls();
                record('matching-path-selects-B', { outcome: 'resolved', window: 'B', workerCalls: 1 },
                    { ...matching, workerCalls: matchingCalls },
                    matching.outcome === 'resolved' && matching.result.window === 'B' && matchingCalls.length === 1 &&
                    matchingCalls[0].window === 'B' && matchingCalls[0].arguments.workingDirectory === projects.B);

                await resetCalls();
                const affinity = makeRouter();
                const affinitySetup = await call(() => affinity.handleStartDebugging(argumentsFor('A')));
                assert.equal(affinitySetup.result?.window, 'A');
                const followup = await call(() => affinity.handleStepOver());
                const affinityCalls = await readCalls();
                record('hintless-followup-keeps-cached-A', { outcome: 'resolved', window: 'A', operations: ['handleStartDebugging', 'handleStepOver'] },
                    { ...followup, workerCalls: affinityCalls },
                    followup.outcome === 'resolved' && followup.result.window === 'A' && affinityCalls.length === 2 &&
                    affinityCalls.every(entry => entry.window === 'A') && affinityCalls[1].operation === 'handleStepOver');

                await resetCalls();
                const ambiguous = await call(() => makeRouter().handleStepOver());
                const ambiguousCalls = await readCalls();
                record('fresh-hintless-two-window-call-rejects', { outcome: 'rejected', diagnostic: 'no-active-target', workerCalls: [] },
                    { ...ambiguous, workerCalls: ambiguousCalls }, ambiguous.outcome === 'rejected' && ambiguousCalls.length === 0 &&
                    /no active debug target for this session/i.test(ambiguous.error));
            })(),
            new Promise((_, reject) => {
                deadline = setTimeout(() => {
                    expired = true;
                    reject(new Error(`The isolated routing run exceeded ${RUN_TIMEOUT_MS} ms.`));
                }, RUN_TIMEOUT_MS);
            })
        ]);
    } catch (error) {
        runError = error.message;
    } finally {
        clearTimeout(deadline);
        expired = true;
        const stopped = await Promise.allSettled(workers.map(stopWorker));
        cleanupErrors = stopped.filter(result => result.status === 'rejected').map(result => result.reason.message);
        if (cleanupErrors.length === 0) {
            try { removeOwnTemporaryDirectory(temporaryDirectory); }
            catch (error) { cleanupErrors.push(error.message); }
        }
    }
    const bugCases = cases.slice(0, 2);
    const controls = cases.slice(2);
    const passed = !runError && cleanupErrors.length === 0 && cases.length === 5 && controls.every(entry => entry.regressionPassed) &&
        (options.expectCurrentBug ? bugCases.every(entry => entry.bugReproduced) : bugCases.every(entry => entry.regressionPassed));
    emit({ type: 'summary', mode: options.expectCurrentBug ? 'expect-current-bug' : 'regression', passed,
        cases: cases.length, positiveControlsPassed: controls.filter(entry => entry.regressionPassed).length,
        expectedBugSignaturesObserved: bugCases.filter(entry => entry.bugReproduced).length,
        fixtureWorkersStopped: cleanupErrors.length === 0, temporaryDirectoryRemoved: !fs.existsSync(temporaryDirectory),
        ...(runError ? { error: runError } : {}), ...(cleanupErrors.length ? { cleanupErrors } : {}) });
    process.exitCode = passed ? 0 : 1;
}

try {
    const options = parseArguments(process.argv.slice(2));
    if (options.worker) { runWorker(options.root); }
    else { run(options).catch(error => {
        process.stderr.write(JSON.stringify({ type: 'harness-error', error: error.message }) + '\n');
        process.exitCode = 1;
    }); }
} catch (error) {
    process.stderr.write(JSON.stringify({ type: 'harness-error', error: error.message }) + '\n');
    process.exitCode = 1;
}
