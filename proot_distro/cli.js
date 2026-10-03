#!/usr/bin/env node

/**
 * # # Proot-Distro - manage proot containers.
 * # # Created by Sylirre <sylirre@termux.dev> for Termux project.
 * # # Ported to Node.js / JavaScript.
 */

import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

// Constants and Helpers (mocked or imported from your modules)
import { IS_TERMUX, PROGRAM_NAME } from './proot_distro/constants.js';
import { C, msg, setQuiet, critError } from './proot_distro/message.js';
import { getProotBin } from './proot_distro/arch.js';
import { ALIAS_TO_CANONICAL, buildParser, requiredArgsFor } from './proot_distro/parser.js';

import { commandHelp, HELP_COMMANDS } from './proot_distro/commands/help.js';
import { commandInstall } from './proot_distro/commands/install.js';
import { commandRemove } from './proot_distro/commands/remove.js';
import { commandRename } from './proot_distro/commands/rename.js';
import { commandReset } from './proot_distro/commands/reset.js';
import { commandLogin } from './proot_distro/commands/login.js';
import { commandList } from './proot_distro/commands/list.js';
import { commandBackup } from './proot_distro/commands/backup.js';
import { commandRestore } from './proot_distro/commands/restore.js';
import { commandClearCache } from './proot_distro/commands/clear_cache.js';
import { commandCopy } from './proot_distro/commands/copy.js';
import { commandSync } from './proot_distro/commands/sync.js';
import { commandRun } from './proot_distro/commands/run.js';
import { commandBuild } from './proot_distro/commands/build.js';
import { commandPush } from './proot_distro/commands/push.js';
import { commandPs } from './proot_distro/commands/ps.js';
import { commandKill } from './proot_distro/commands/kill.js';
import { commandSearch } from './proot_distro/commands/search.js';

const COMMAND_HANDLERS = {
    'install': commandInstall,
    'remove': commandRemove,
    'rename': commandRename,
    'reset': commandReset,
    'login': commandLogin,
    'list': commandList,
    'backup': commandBackup,
    'restore': commandRestore,
    'clear-cache': commandClearCache,
    'copy': commandCopy,
    'sync': commandSync,
    'run': commandRun,
    'build': commandBuild,
    'push': commandPush,
    'ps': commandPs,
    'kill': commandKill,
    'search': commandSearch,
    'help': commandHelp,
};

function refuseNestedProot() {
    /** Exit when we're running inside a proot — nested proot is unsupported. */
    const errMessage = (
        `attempted to run ${PROGRAM_NAME} in a proot session. ` +
        `Please check your system configuration to ensure that this program ` +
        `does not run under any other proot instance. Additionally check the ` +
        `target container to ensure it does not invoke ${PROGRAM_NAME} on ` +
        `a loop basis. With 100% confidence this is not a mistake. Do not ` +
        `send bug reports!`
    );

    try {
        const pid = process.pid;
        const statusPath = `/proc/${pid}/status`;
        if (!fs.existsSync(statusPath)) return;

        const content = fs.readFileSync(statusPath, 'utf8');
        let tracerPid = 0;

        for (const line of content.split('\n')) {
            if (line.startsWith('TracerPid:')) {
                tracerPid = parseInt(line.split(/\s+/)[1], 10);
                break;
            }
        }

        if (tracerPid === 0) return;

        const tracerStatusPath = `/proc/${tracerPid}/status`;
        if (fs.existsSync(tracerStatusPath)) {
            const tracerContent = fs.readFileSync(tracerStatusPath, 'utf8');
            for (const tline of tracerContent.split('\n')) {
                if (tline.startsWith('Name:') && tline.includes('proot')) {
                    critError(errMessage);
                    process.exit(1);
                }
            }
        }
    } catch {
        // Ignore file system / permission errors reading /proc
    }
}

function ensureProotInstalled() {
    /** Verify proot is on PATH; offer to install it on Termux (TTY only). */
    if (process.env.PD_PROOT_BIN) {
        getProotBin();
    }

    // Check if 'proot' exists in PATH via command check or custom implementation
    const hasProot = spawnSync('which', ['proot']).status === 0;
    if (hasProot) return;

    msg();
    critError("proot utility does not exist on your system.");
    msg();

    if (!IS_TERMUX) {
        process.exit(1);
    }

    if (!process.stdin.isTTY) {
        msg(`${C.CYAN}Install it with: ${C.GREEN}pkg install proot${C.RST}`);
        msg();
        process.exit(1);
    }

    // Interactive prompt for TTY
    process.stderr.write(`${C.CYAN}Would you like to install it now? [y/N] ${C.RST}`);
    
    // For synchronous prompt handling in Node.js CLI:
    const buffer = Buffer.alloc(1024);
    let answer = "";
    try {
        const bytesRead = fs.readSync(0, buffer, 0, 1024, null);
        answer = buffer.toString('utf8', 0, bytesRead).trim().toLowerCase();
    } catch {
        answer = "";
    }

    if (answer !== 'y' && answer !== 'yes') {
        msg();
        msg(`${C.CYAN}Install it manually with: ${C.GREEN}pkg install proot${C.RST}`);
        msg();
        process.exit(1);
    }

    msg();
    try {
        const result = spawnSync('pkg', ['install', '-y', '-q', 'proot'], { stdio: 'inherit' });
        if (result.status !== 0) {
            throw new Error(`Exited with status ${result.status}`);
        }
    } catch (exc) {
        msg();
        critError(`failed to install proot: ${exc.message}`);
        msg();
        process.exit(1);
    }
}

function ensureProotAvailable(firstCanonical) {
    if (['build', 'push', 'kill', 'ps', 'search'].includes(firstCanonical)) {
        return;
    }
    ensureProotInstalled();
}

function dispatchHelp(rawArgs) {
    if (rawArgs.length < 2 || !['-h', '--help', '--usage'].includes(rawArgs[1])) {
        return false;
    }
    const cmd = ALIAS_TO_CANONICAL[rawArgs[0]] || rawArgs[0];
    if (HELP_COMMANDS[cmd]) {
        HELP_COMMANDS[cmd]();
        return true;
    }
    return false;
}

function rejectUnknownCommand(rawArgs) {
    if (rawArgs.length === 0) return;
    const first = rawArgs[0];
    if (
        !first.startsWith('-') &&
        !Object.prototype.hasOwnProperty.call(COMMAND_HANDLERS, first) &&
        !Object.prototype.hasOwnProperty.call(ALIAS_TO_CANONICAL, first)
    ) {
        msg();
        critError(`unknown command '${first}'.`);
        commandHelp();
        msg();
        process.exit(1);
    }
}

function splitSeparator(canonical, rawArgs, args) {
    if (canonical === 'login') {
        const sepIdx = rawArgs.indexOf('--');
        args.login_cmd = sepIdx !== -1 ? rawArgs.slice(sepIdx + 1) : [];
    } else if (canonical === 'run') {
        const sepIdx = rawArgs.indexOf('--');
        args.run_args = sepIdx !== -1 ? rawArgs.slice(sepIdx + 1) : [];
    }
}

function main() {
    // Route SIGQUIT to trigger clean exit behavior
    process.on('SIGQUIT', () => {
        process.emit('SIGINT');
    });

    refuseNestedProot();

    const rawArgs = process.argv.slice(2);
    let firstCanonical = '';
    if (rawArgs.length >= 1) {
        firstCanonical = ALIAS_TO_CANONICAL[rawArgs[0]] || rawArgs[0];
    }

    ensureProotAvailable(firstCanonical);

    if (rawArgs.length === 0 || ['-h', '--help', 'help', 'hel', 'he', 'h'].includes(rawArgs[0])) {
        commandHelp();
        process.exit(0);
    }

    if (dispatchHelp(rawArgs)) {
        process.exit(0);
    }

    rejectUnknownCommand(rawArgs);

    const parser = buildParser();
    let args;
    let unknown;
    try {
        const parsed = parser.parseKnownArgs(rawArgs);
        args = parsed.args;
        unknown = parsed.unknown;
    } catch {
        msg();
        critError(`unknown command '${rawArgs[0]}'.`);
        commandHelp();
        msg();
        process.exit(1);
    }

    const command = args.command;
    if (!command) {
        msg();
        critError(`unknown command '${rawArgs[0]}'.`);
        commandHelp();
        msg();
        process.exit(1);
    }

    const canonical = ALIAS_TO_CANONICAL[command] || command;

    if (args.help) {
        if (HELP_COMMANDS[canonical]) {
            HELP_COMMANDS[canonical]();
        } else {
            commandHelp();
        }
        process.exit(0);
    }

    let checkUnknown = unknown;
    if (['login', 'run'].includes(canonical) && rawArgs.includes('--')) {
        const sepIdx = rawArgs.indexOf('--');
        const reParsed = parser.parseKnownArgs(rawArgs.slice(0, sepIdx));
        checkUnknown = reParsed.unknown;
    }

    if (checkUnknown && checkUnknown.length > 0) {
        const bad = checkUnknown[0];
        const kind = bad.startsWith('-') ? 'unrecognized option' : 'unexpected argument';
        msg();
        critError(`${kind}: '${bad}'.`);
        if (HELP_COMMANDS[canonical]) {
            HELP_COMMANDS[canonical]();
        }
        msg();
        process.exit(1);
    }

    for (const [argName, errorMsg] of requiredArgsFor(canonical, args)) {
        if (args[argName] === undefined || args[argName] === null) {
            msg();
            critError(errorMsg);
            if (HELP_COMMANDS[canonical]) {
                HELP_COMMANDS[canonical]();
            }
            process.exit(1);
        }
    }

    splitSeparator(canonical, rawArgs, args);

    if (canonical !== 'list' && canonical !== 'ps' && args.quiet) {
        setQuiet(true);
    }

    const handler = COMMAND_HANDLERS[canonical];
    if (!handler) {
        critError(`unknown command '${command}'.`);
        process.exit(1);
    }

    handler(args);
}

main();
