// Copyright (c) Frank Hahn. All rights reserved.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

function loadDebugMcp(checkoutRoot, requiredModules) {
    if (typeof checkoutRoot !== 'string' || checkoutRoot.trim() === '') {
        throw new Error('Provide --debugmcp-root with the path to a separate Microsoft/DebugMCP checkout.');
    }
    const root = fs.realpathSync(path.resolve(checkoutRoot));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.name !== 'debugmcpextension') {
        throw new Error('The supplied directory is not a DebugMCP checkout.');
    }
    const gitArgs = ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root];
    const git = (...args) => execFileSync('git', [...gitArgs, ...args], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    const commit = git('rev-parse', '--verify', 'HEAD');
    const sourceDirty = git('status', '--porcelain', '--untracked-files=no') !== '';
    const outRoot = path.join(root, 'out');
    const names = new Set([...requiredModules, 'utils/logger']);
    for (const name of names) {
        if (!/^[\w-]+(?:\/[\w-]+)*$/.test(name)) {
            throw new Error(`Invalid compiled module name: ${name}`);
        }
        if (!fs.existsSync(path.join(outRoot, `${name}.js`))) {
            throw new Error(`Missing out/${name}.js. Run npm ci and npm run compile in the DebugMCP checkout first.`);
        }
    }

    // CLI and routing imports refer to the VS Code executor module. Only that
    // module's host import is stubbed. No debugger/handler/routing method is
    // replaced, and accidentally calling a VS Code API fails immediately.
    const vscodeImportOnly = Object.freeze({ debug: Object.freeze({}) });
    const loaded = new Map();
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return vscodeImportOnly;
            }
            return previousLoad.call(this, request, parent, isMain);
        };
        for (const name of names) {
            loaded.set(name, require(path.join(outRoot, `${name}.js`)));
        }
    } finally {
        Module._load = previousLoad;
    }
    loaded.get('utils/logger').logger.setSink({ debug() {}, info() {}, warn() {}, error() {} });

    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const loadedFiles = Object.keys(require.cache).filter(file => file.startsWith(outRoot + path.sep) && file.endsWith('.js'));
    const modules = loadedFiles.map(compiled => {
        const relative = path.relative(outRoot, compiled);
        const source = path.join(root, 'src', relative.replace(/\.js$/, '.ts'));
        if (!fs.existsSync(source)) {
            throw new Error(`The compiled module has no matching source: ${relative}`);
        }
        if (fs.statSync(source).mtimeMs > fs.statSync(compiled).mtimeMs) {
            throw new Error(`Compiled output is older than src/${relative.replace(/\.js$/, '.ts')}; rebuild DebugMCP first.`);
        }
        return {
            source: path.relative(root, source).replaceAll('\\', '/'),
            sourceSha256: hash(source),
            compiledSha256: hash(compiled)
        };
    });
    return {
        root,
        commit,
        version: manifest.version,
        nodeVersion: process.version,
        sourceDirty,
        modules,
        module(name) {
            if (!loaded.has(name)) {
                throw new Error(`Module ${name} was not declared in requiredModules.`);
            }
            return loaded.get(name);
        }
    };
}

module.exports = { loadDebugMcp };
