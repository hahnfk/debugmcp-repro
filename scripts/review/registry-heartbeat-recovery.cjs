// Copyright (c) Frank Hahn 2026. All rights reserved.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { loadDebugMcp } = require('./load-debugmcp.cjs');

const REQUIRED_MODULES = ['utils/workspaceRegistry'];
const TEMP_PREFIX = 'debugmcp-registry-heartbeat-review-';
const RPC_TIMEOUT_MS = 2000;
const RUN_TIMEOUT_MS = 12000;
const STALE_FIXTURE_AGE_MS = 61000;

function parseArguments(argv) {
    const options = { root: undefined, expectCurrentBug: false, worker: false };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--debugmcp-root' && !options.root && argv[index + 1] && !argv[index + 1].startsWith('--')) {
            options.root = argv[++index];
        } else if (argument === '--expect-current-bug' && !options.expectCurrentBug) {
            options.expectCurrentBug = true;
        } else if (argument === '--worker' && !options.worker) {
            options.worker = true;
        } else {
            throw new Error(`Unexpected or incomplete argument: ${argument}`);
        }
    }
    if (!options.root) {
        throw new Error('Usage: node registry-heartbeat-recovery.cjs --debugmcp-root <checkout> [--expect-current-bug]');
    }
    if (options.worker && !process.send) {
        throw new Error('Worker mode requires this harness\'s own IPC connection.');
    }
    return options;
}

function publicEntry(entry) {
    if (!entry) { return null; }
    return {
        pid: entry.pid,
        controlPort: entry.controlPort,
        name: entry.name,
        workspaceFolders: entry.workspaceFolders,
        updatedAt: entry.updatedAt
    };
}

function runWorker(checkoutRoot) {
    const sut = loadDebugMcp(checkoutRoot, REQUIRED_MODULES);
    const { WorkspaceRegistry } = sut.module('utils/workspaceRegistry');
    const registryErrors = [];
    sut.module('utils/logger').logger.setSink({
        debug() {}, info() {}, warn() {},
        error(message) { registryErrors.push(message); }
    });
    let registry;
    let registration;
    let identityNonce;
    let portReservation;
    let stopping = false;
    const stop = async () => {
        stopping = true;
        registry?.unregister();
        if (portReservation?.listening) {
            await new Promise(resolve => portReservation.close(resolve));
        }
    };

    process.on('message', async message => {
        try {
            let result;
            const previousErrorCount = registryErrors.length;
            switch (message.command) {
                case 'start': {
                    assert.equal(registry, undefined, 'A fixture worker can be started only once.');
                    identityNonce = message.identityNonce;
                    // This idle listener supplies an actual OS-assigned port for
                    // the registry metadata. It is not a VS Code control server.
                    portReservation = net.createServer(socket => socket.destroy());
                    const port = await new Promise((resolve, reject) => {
                        portReservation.once('error', reject);
                        portReservation.listen(0, '127.0.0.1', () => resolve(portReservation.address().port));
                    });
                    registration = {
                        controlPort: port,
                        controlToken: message.token,
                        workspaceFolders: [message.workspace],
                        name: message.name
                    };
                    registry = new WorkspaceRegistry(process.pid, message.registryDirectory);
                    registry.register(registration);
                    result = { pid: process.pid, name: registration.name, controlPort: port, identityNonce };
                    break;
                }
                case 'ping':
                    result = { pid: process.pid, name: registration.name, identityNonce };
                    break;
                case 'snapshot':
                    result = {
                        entries: registry.list().map(publicEntry),
                        matches: Object.fromEntries(Object.entries(message.paths).map(([name, target]) =>
                            [name, publicEntry(registry.findByPath(target))]))
                    };
                    break;
                case 'heartbeat':
                    registry.heartbeat();
                    result = { completed: true, registryErrorCount: registryErrors.length - previousErrorCount };
                    break;
                case 'unregister':
                    registry.unregister();
                    result = { completed: true };
                    break;
                case 'register':
                    registry.register(registration);
                    result = { completed: true };
                    break;
                case 'stop':
                    await stop();
                    result = { completed: true };
                    break;
                default:
                    throw new Error('Unknown fixture IPC command.');
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
        const fallback = setTimeout(() => process.exit(1), 250);
        stop().finally(() => {
            clearTimeout(fallback);
            process.exit(0);
        });
    });
}

function startWorker(checkoutRoot, name) {
    const child = fork(__filename, ['--worker', '--debugmcp-root', checkoutRoot], {
        cwd: checkoutRoot,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    const pending = new Map();
    let sequence = 0;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => {
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error(`Fixture worker ${name} exited (${code ?? signal}). ${stderr}`));
        }
        pending.clear();
        resolve({ code, signal });
    }));
    child.on('message', message => {
        const request = pending.get(message.id);
        if (!request) { return; }
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) { request.reject(new Error(message.error)); }
        else { request.resolve(message.result); }
    });
    child.on('error', error => {
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        pending.clear();
    });
    return {
        name,
        child,
        exited,
        identityNonce: crypto.randomUUID(),
        rpc(command, fields = {}) {
            return new Promise((resolve, reject) => {
                const id = ++sequence;
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`Fixture IPC timed out for ${name}/${command}. ${stderr}`));
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
    const gracefulExit = await Promise.race([
        worker.exited.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 300))
    ]);
    if (!gracefulExit) {
        worker.child.kill(); // Only this exact fixture child is a kill target.
        const killed = await Promise.race([
            worker.exited.then(() => true),
            new Promise(resolve => setTimeout(() => resolve(false), 700))
        ]);
        if (!killed) { throw new Error(`Fixture child ${worker.child.pid} did not exit.`); }
    }
}

function removeOwnTemporaryDirectory(directory) {
    const actualTempBase = fs.realpathSync(os.tmpdir());
    const actualRoot = fs.realpathSync(directory);
    if (fs.lstatSync(directory).isSymbolicLink() || path.dirname(actualRoot) !== actualTempBase ||
        !path.basename(actualRoot).startsWith(TEMP_PREFIX) || path.basename(actualRoot) === TEMP_PREFIX) {
        throw new Error('Refusing recursive removal outside this harness\'s own temporary root.');
    }
    fs.rmSync(actualRoot, { recursive: true, force: true });
}

function readEntry(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') { return null; }
        throw error;
    }
}

function simulateFixtureEntryAge(file, ageMs) {
    const before = readEntry(file);
    assert.ok(before, 'The fixture entry must exist before simulating its age.');
    const simulatedAt = Date.now();
    const aged = { ...before, updatedAt: simulatedAt - ageMs };
    fs.writeFileSync(file, JSON.stringify(aged), 'utf8');
    const stored = readEntry(file);
    const withoutTimestamp = entry => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'updatedAt'));
    assert.ok(isDeepStrictEqual(withoutTimestamp(before), withoutTimestamp(stored)),
        'Fixture aging must preserve every field except updatedAt.');
    assert.equal(stored.updatedAt, simulatedAt - ageMs);
    return { simulated: true, ageMs, simulatedAt, previousUpdatedAt: before.updatedAt,
        storedUpdatedAt: stored.updatedAt, onlyUpdatedAtChanged: true };
}

async function run(options) {
    const sut = loadDebugMcp(options.root, REQUIRED_MODULES);
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    const registryDirectory = path.join(temporaryDirectory, 'registry');
    const projects = { A: path.join(temporaryDirectory, 'A'), B: path.join(temporaryDirectory, 'B') };
    const workers = [];
    const cases = [];
    const liveness = [];
    let deadline;
    let expired = false;
    let runError;
    let cleanupErrors = [];
    let workersStopped = false;
    const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
    const record = (name, kind, expected, actual, regressionPassed, bugReproduced = false) => {
        const result = { type: 'case', name, kind, expected, actual, regressionPassed, bugReproduced };
        cases.push(result);
        emit(result);
    };
    const ensureRunning = () => { if (expired) { throw new Error('The harness deadline has expired.'); } };
    const addWorker = async name => {
        ensureRunning();
        const worker = startWorker(sut.root, name);
        workers.push(worker);
        const identity = await worker.rpc('start', { name, registryDirectory, workspace: projects[name],
            token: crypto.randomUUID(), identityNonce: worker.identityNonce });
        assert.equal(identity.pid, worker.child.pid);
        assert.equal(identity.identityNonce, worker.identityNonce);
        assert.ok(identity.controlPort > 0);
        worker.identity = identity;
        worker.entryFile = path.join(registryDirectory, `window-${worker.child.pid}.json`);
        return worker;
    };
    const checkAlive = async (worker, phase) => {
        ensureRunning();
        const ping = await worker.rpc('ping');
        const ipcConfirmed = ping.pid === worker.child.pid && ping.name === worker.name && ping.identityNonce === worker.identityNonce;
        let osProcessAlive;
        try { process.kill(worker.child.pid, 0); osProcessAlive = true; }
        catch (error) {
            if (error.code !== 'EPERM') { throw error; }
            osProcessAlive = true;
        }
        assert.ok(ipcConfirmed && worker.child.exitCode === null && worker.child.signalCode === null,
            `Fixture ${worker.name} must still be the same live child at ${phase}.`);
        const result = { phase, worker: worker.name, pid: worker.child.pid, ipcConfirmed, osProcessAlive };
        liveness.push(result);
        return result;
    };
    const matchesWorker = (entry, worker) => !!entry && entry.pid === worker.child.pid && entry.name === worker.name &&
        entry.controlPort === worker.identity.controlPort && entry.workspaceFolders.length === 1 &&
        entry.workspaceFolders[0] === projects[worker.name];

    try {
        emit({ type: 'metadata', ...sut, mode: options.expectCurrentBug ? 'expect-current-bug' : 'regression',
            fixtureClockPolicy: 'Only timestamps in this harness\'s own registry file are aged; the system clock and upstream methods are unchanged.',
            fixturePortPolicy: 'Own idle loopback listeners reserve OS-assigned metadata ports; these are not VS Code control servers.' });
        for (const folder of Object.values(projects)) { fs.mkdirSync(folder); }
        await Promise.race([
            (async () => {
                const A = await addWorker('A');
                const B = await addWorker('B');
                assert.notEqual(A.child.pid, B.child.pid);
                const snapshot = () => B.rpc('snapshot', { paths: projects });
                const bothAlive = phase => Promise.all([checkAlive(A, phase), checkAlive(B, phase)]);
                await bothAlive('after-registration');
                const initial = await snapshot();
                const initiallyFound = initial.entries.length === 2 && matchesWorker(initial.matches.A, A) && matchesWorker(initial.matches.B, B);
                record('register-and-find-live-workers', 'control', { registered: ['A', 'B'], findByPath: { A: 'A', B: 'B' } },
                    initial, initiallyFound);
                assert.ok(initiallyFound, 'Both fixture registrations must be valid before proceeding.');

                // Keep this entry within the normal 60-second lifetime, but use
                // fixture data rather than a fragile wait for the next clock tick.
                const freshAging = simulateFixtureEntryAge(A.entryFile, 1000);
                const freshHeartbeat = await A.rpc('heartbeat');
                const refreshedEntry = readEntry(A.entryFile);
                const afterFreshHeartbeat = await snapshot();
                const refreshed = freshHeartbeat.completed === true && !!refreshedEntry &&
                    refreshedEntry.updatedAt > freshAging.storedUpdatedAt && matchesWorker(afterFreshHeartbeat.matches.A, A) &&
                    matchesWorker(afterFreshHeartbeat.matches.B, B) && afterFreshHeartbeat.entries.length === 2;
                record('fresh-heartbeat-updates-persistent-entry', 'control', { filePresent: true, timestampAdvanced: true, bothWorkersFound: true },
                    { fixtureTimestampAging: freshAging, heartbeatCompleted: freshHeartbeat.completed,
                        filePresent: !!refreshedEntry, updatedAt: refreshedEntry?.updatedAt, snapshot: afterFreshHeartbeat }, refreshed);

                await A.rpc('unregister');
                const afterUnregister = await snapshot();
                const unregistered = readEntry(A.entryFile) === null && afterUnregister.entries.length === 1 &&
                    afterUnregister.matches.A === null && matchesWorker(afterUnregister.matches.B, B);
                record('unregister-removes-only-own-entry', 'control', { ARegistered: false, BRegistered: true },
                    { AFilePresent: !!readEntry(A.entryFile), snapshot: afterUnregister }, unregistered);
                // Deliberately do not heartbeat after unregister: this control
                // does not prescribe an automatic reactivation policy.
                await A.rpc('register');
                const beforeAging = await snapshot();
                assert.ok(matchesWorker(beforeAging.matches.A, A) && matchesWorker(beforeAging.matches.B, B),
                    'Explicit setup registration must restore A before the stale-entry scenario.');

                await bothAlive('before-simulated-expiry');
                const staleAging = simulateFixtureEntryAge(A.entryFile, STALE_FIXTURE_AGE_MS);
                await bothAlive('after-simulated-expiry-before-peer-list');
                ensureRunning();
                const afterPeerPrune = await snapshot();
                const peerPrunedA = readEntry(A.entryFile) === null && afterPeerPrune.entries.length === 1 &&
                    afterPeerPrune.matches.A === null && matchesWorker(afterPeerPrune.matches.B, B);
                await bothAlive('after-peer-list');
                const attempts = [];
                for (let attempt = 1; attempt <= 3; attempt++) {
                    await bothAlive(`before-heartbeat-${attempt}`);
                    const heartbeat = await A.rpc('heartbeat');
                    const alive = await bothAlive(`after-heartbeat-${attempt}`);
                    const observed = await snapshot();
                    const storedEntry = readEntry(A.entryFile);
                    const recovered = heartbeat.completed === true && !!storedEntry && observed.entries.length === 2 &&
                        matchesWorker(observed.matches.A, A) && matchesWorker(observed.matches.B, B);
                    const stillMissing = heartbeat.completed === true && heartbeat.registryErrorCount === 0 &&
                        storedEntry === null && observed.entries.length === 1 &&
                        observed.matches.A === null && matchesWorker(observed.matches.B, B);
                    attempts.push({ attempt, heartbeatCompleted: heartbeat.completed, AFilePresent: !!storedEntry,
                        registryErrorCount: heartbeat.registryErrorCount,
                        bothWorkersAlive: alive.every(item => item.ipcConfirmed && item.osProcessAlive),
                        snapshot: observed, recovered, stillMissing });
                }
                const healthyRecovery = attempts.every(attempt => attempt.recovered && attempt.bothWorkersAlive);
                const exactBug = peerPrunedA && attempts.every(attempt => attempt.stillMissing && attempt.bothWorkersAlive);
                record('live-owner-heartbeat-recovers-after-peer-pruning', 'regression',
                    { AFindableAfterEveryHeartbeat: true, BFindable: true, heartbeatAttempts: 3 },
                    { fixtureTimestampAging: staleAging, peerPrunedA, afterPeerList: afterPeerPrune, attempts },
                    healthyRecovery, exactBug);

                const beforeExplicitRegister = await snapshot();
                const explicitRegistration = await A.rpc('register');
                const restored = await snapshot();
                await bothAlive('after-explicit-registration');
                const registrationWorks = explicitRegistration.completed === true && !!readEntry(A.entryFile) && restored.entries.length === 2 &&
                    matchesWorker(restored.matches.A, A) && matchesWorker(restored.matches.B, B);
                record('explicit-register-restores-discoverability', 'control', { ARegistered: true, BRegistered: true },
                    { before: beforeExplicitRegister, registerCompleted: explicitRegistration.completed, after: restored }, registrationWorks);
            })(),
            new Promise((_, reject) => {
                deadline = setTimeout(() => {
                    expired = true;
                    reject(new Error(`The registry scenario exceeded ${RUN_TIMEOUT_MS} ms.`));
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
        workersStopped = cleanupErrors.length === 0;
        if (workersStopped) {
            try { removeOwnTemporaryDirectory(temporaryDirectory); }
            catch (error) { cleanupErrors.push(error.message); }
        }
    }
    const controls = cases.filter(result => result.kind === 'control');
    const regression = cases.find(result => result.kind === 'regression');
    const passed = !runError && cleanupErrors.length === 0 && cases.length === 5 && controls.length === 4 &&
        controls.every(result => result.regressionPassed) && !!regression &&
        (options.expectCurrentBug ? regression.bugReproduced : regression.regressionPassed);
    emit({ type: 'liveness-evidence', observations: liveness });
    emit({ type: 'summary', mode: options.expectCurrentBug ? 'expect-current-bug' : 'regression', passed,
        cases: cases.length, controlsPassed: controls.filter(result => result.regressionPassed).length,
        currentBugReproduced: regression?.bugReproduced ?? false, healthyRecovery: regression?.regressionPassed ?? false,
        fixtureWorkersStopped: workersStopped, temporaryDirectoryRemoved: !fs.existsSync(temporaryDirectory),
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
