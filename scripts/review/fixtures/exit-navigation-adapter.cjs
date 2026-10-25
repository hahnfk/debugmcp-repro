// Copyright (c) Frank Hahn 2026. All rights reserved.
'use strict';

const path = require('node:path');
let input = Buffer.alloc(0);
let sequence = 1;
let launchRequest;
let launchArguments;
let breakpointSource;
let breakpointLine;
let currentLine;
let ending = false;
const deadline = setTimeout(() => finish(70), 10000);

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
    setTimeout(() => process.exit(code), 100).unref();
}

function navigate(request) {
    if (request.command !== launchArguments.reviewCommand) {
        throw new Error('The navigation request did not match this scenario.');
    }
    if (launchArguments.reviewMode === 'crash') {
        // Deliberately bypass finish(): no response, exited or terminated event.
        // The production DapClient must observe the child-process exit itself.
        process.exit(23);
    }
    if (launchArguments.reviewMode === 'reject') {
        send({
            type: 'response', request_seq: request.seq, command: request.command,
            success: false, message: 'Synthetic navigation rejection; adapter remains paused.'
        });
        return;
    }
    if (request.command === 'next') {
        respond(request);
        currentLine++;
        event('stopped', { reason: 'step', threadId: 1, allThreadsStopped: true });
    } else {
        respond(request, { allThreadsContinued: true });
        event('continued', { threadId: 1, allThreadsContinued: true });
        event('exited', { exitCode: 0 });
        event('terminated');
        finish();
    }
}

function handle(request) {
    switch (request.command) {
        case 'initialize':
            respond(request, { supportsConfigurationDoneRequest: true });
            break;
        case 'launch':
            launchRequest = request;
            launchArguments = request.arguments;
            if (!['crash', 'reject', 'success'].includes(launchArguments.reviewMode) ||
                !['next', 'continue'].includes(launchArguments.reviewCommand) ||
                typeof launchArguments.reviewRunId !== 'string') {
                throw new Error('Invalid synthetic navigation scenario.');
            }
            event('initialized');
            break;
        case 'setBreakpoints':
            if (request.arguments.breakpoints.length !== 1) {
                throw new Error('The fixture requires one source breakpoint.');
            }
            breakpointSource = request.arguments.source;
            breakpointLine = request.arguments.breakpoints[0].line;
            currentLine = breakpointLine;
            respond(request, { breakpoints: [{ verified: true, line: breakpointLine }] });
            break;
        case 'configurationDone':
            if (!launchRequest || !breakpointSource?.path || !Number.isInteger(breakpointLine)) {
                throw new Error('The fixture was not configured before launch completed.');
            }
            respond(request);
            event('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
            respond(launchRequest);
            break;
        case 'stackTrace':
            respond(request, {
                stackFrames: [{
                    id: 1, name: 'syntheticNavigation', line: currentLine, column: 1,
                    source: { path: breakpointSource.path, name: path.basename(breakpointSource.path) }
                }],
                totalFrames: 1
            });
            break;
        case 'threads':
            respond(request, { threads: [{ id: 1, name: 'synthetic navigation thread' }] });
            break;
        case 'evaluate':
            if (request.arguments.expression !== 'fixtureIdentity') {
                throw new Error('Only the synthetic fixture identity expression is supported.');
            }
            respond(request, {
                result: JSON.stringify({ processId: process.pid, reviewRunId: launchArguments.reviewRunId }),
                type: 'string', variablesReference: 0
            });
            break;
        case 'next':
        case 'continue':
            navigate(request);
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
        input = Buffer.concat([input, chunk]);
        if (input.length > 1024 * 1024) {
            throw new Error('Synthetic DAP input exceeded its bound.');
        }
        while (!ending) {
            const headerEnd = input.indexOf('\r\n\r\n');
            if (headerEnd < 0) {
                return;
            }
            const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(input.subarray(0, headerEnd).toString('ascii'));
            if (!match) {
                throw new Error('Synthetic DAP input has no Content-Length.');
            }
            const length = Number(match[1]);
            if (!Number.isSafeInteger(length) || length > 1024 * 1024) {
                throw new Error('Invalid synthetic DAP input size.');
            }
            const start = headerEnd + 4;
            if (input.length < start + length) {
                return;
            }
            const request = JSON.parse(input.subarray(start, start + length).toString('utf8'));
            input = input.subarray(start + length);
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
