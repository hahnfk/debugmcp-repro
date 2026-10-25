// Copyright (c) Frank Hahn 2026. All rights reserved.
'use strict';

// A bounded synthetic DAP peer. It starts no debuggee and uses no editor API.
const path = require('node:path');
let buffer = Buffer.alloc(0);
let sequence = 1;
let launchRequest;
let launchArguments;
let source;
let savedBreakpoints = [];
let ending = false;

const deadline = setTimeout(() => finish(70), 15000);

function send(message) {
    const payload = Buffer.from(JSON.stringify({ seq: sequence++, ...message }), 'utf8');
    process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
    process.stdout.write(payload);
}

function respond(request, body = {}) {
    send({ type: 'response', request_seq: request.seq, command: request.command, success: true, body });
}

function event(name, body = {}) {
    send({ type: 'event', event: name, body });
}

function finish(code = 0) {
    if (ending) {
        return;
    }
    ending = true;
    clearTimeout(deadline);
    process.exitCode = code;
    process.stdin.destroy();
    process.stdout.end(() => process.exit(code));
    // Ensure a disconnected or blocked parent cannot leave this fixture alive.
    setTimeout(() => process.exit(code), 100).unref();
}

function handle(request) {
    switch (request.command) {
        case 'initialize':
            respond(request, { supportsConfigurationDoneRequest: true });
            break;
        case 'launch':
            launchRequest = request;
            launchArguments = request.arguments;
            event('initialized');
            break;
        case 'setBreakpoints':
            source = request.arguments.source;
            savedBreakpoints = request.arguments.breakpoints;
            respond(request, {
                breakpoints: savedBreakpoints.map(item => ({ verified: true, line: item.line }))
            });
            break;
        case 'configurationDone':
            if (!launchRequest || savedBreakpoints.length !== 1 || !source?.path) {
                throw new Error('The fixture requires exactly one saved source breakpoint before launch completes.');
            }
            respond(request);
            event('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
            respond(launchRequest);
            break;
        case 'threads':
            respond(request, { threads: [{ id: 1, name: 'synthetic fixture thread' }] });
            break;
        case 'stackTrace':
            respond(request, {
                stackFrames: [{
                    id: 1,
                    name: 'syntheticBreakpoint',
                    line: savedBreakpoints[0].line,
                    column: 1,
                    source: { path: source.path, name: path.basename(source.path) }
                }],
                totalFrames: 1
            });
            break;
        case 'evaluate':
            if (request.arguments.expression !== 'fixtureIdentity') {
                throw new Error('Only the synthetic fixture identity expression is supported.');
            }
            respond(request, {
                result: JSON.stringify({ processId: process.pid, reviewRunId: launchArguments.reviewRunId }),
                type: 'string',
                variablesReference: 0
            });
            break;
        case 'continue':
            respond(request, { allThreadsContinued: true });
            event('continued', { threadId: 1, allThreadsContinued: true });
            event('exited', { exitCode: 0 });
            event('terminated');
            finish();
            break;
        case 'disconnect':
            respond(request);
            event('terminated');
            finish();
            break;
        default:
            throw new Error(`Unexpected synthetic DAP request: ${request.command}`);
    }
}

process.stdin.on('data', chunk => {
    try {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 1024 * 1024) {
            throw new Error('Synthetic DAP input exceeded its bound.');
        }
        while (!ending) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) {
                return;
            }
            const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
            if (!match) {
                throw new Error('Synthetic DAP input has no Content-Length.');
            }
            const length = Number(match[1]);
            if (!Number.isSafeInteger(length) || length > 1024 * 1024) {
                throw new Error('Invalid synthetic DAP input size.');
            }
            const start = headerEnd + 4;
            if (buffer.length < start + length) {
                return;
            }
            const request = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
            buffer = buffer.subarray(start + length);
            handle(request);
        }
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        finish(1);
    }
});
process.stdin.on('end', () => finish());
process.stdin.on('close', () => finish());
process.stdin.on('error', () => finish(1));
process.stdout.on('error', () => finish(1));
