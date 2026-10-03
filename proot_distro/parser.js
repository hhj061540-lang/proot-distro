/**
 * # # Proot-Distro - manage proot containers.
 * # # Created by Sylirre <sylirre@termux.dev> for Termux project.
 * # # Ported to Node.js / JavaScript.
 */

import { IS_TERMUX, PROGRAM_NAME } from './constants.js';
import { msg, critError } from './message.js';
import { HELP_COMMANDS } from './commands/help.js';

// Define the version constant here
const VERSION = '3.0.0';

export const REQUIRED_ARGS = {
    "install": [["image_ref", "Docker image reference is not specified (e.g. 'ubuntu:24.04')."]],
    "remove": [["target", "container name is not specified."]],
    "rename": [
        ["orig_name", "the original container name is not specified."],
        ["new_name", "the new container name is not specified."]
    ],
    "reset": [["container_name", "container name is not specified."]],
    "login": [["container_name", "container name is not specified."]],
    "backup": [["container_name", "container name is not specified."]],
    "copy": [
        ["source", "source path is not specified."],
        ["destination", "destination path is not specified."]
    ],
    "sync": [
        ["source", "source path is not specified."],
        ["destination", "destination path is not specified."]
    ],
    "run": [["container_name", "container name is not specified."]],
    "push": [["image_ref", "image reference is not specified (e.g. 'myrepo/myapp:1.0')."]],
    "search": [["query", "search query is not specified (e.g. 'ubuntu')."]],
};

export function requiredArgsFor(canonical, args) {
    /**
     * Return the required [argName, errorMessage] pairs for a command.
     */
    if (canonical === "remove" && args.image) {
        return [["target", "image reference is not specified (e.g. 'ubuntu:24.04')."]];
    }
    return REQUIRED_ARGS[canonical] || [];
}

export const ALIAS_TO_CANONICAL = {
    "add": "install",
    "i": "install",
    "in": "install",
    "ins": "install",
    "rm": "remove",
    "sh": "login",
    "li": "list",
    "ls": "list",
    "bak": "backup",
    "bkp": "backup",
    "clear": "clear-cache",
    "cl": "clear-cache",
    "cp": "copy",
    "s": "search",
    "se": "search",
    "h": "help",
    "he": "help",
    "hel": "help",
};

/**
 * Custom Parser Class supporting global options including --version and ps subcommand.
 */
class PdArgumentParser {
    constructor(prog, description) {
        this.prog = prog;
        this.description = description;
    }

    error(message, pdCommand = null) {
        msg();
        critError(message);
        if (pdCommand && HELP_COMMANDS[pdCommand]) {
            HELP_COMMANDS[pdCommand]();
        }
        msg();
        process.exit(1);
    }

    parseKnownArgs(rawArgs) {
        const args = {
            command: null,
            help: false,
            version: false,
            quiet: false,
            verbose: false,
            image: false,
            image_ref: null,
            target: null,
            orig_name: null,
            new_name: null,
            container_name: null,
            source: null,
            destination: null,
            query: null,
            archive: null,
            login_cmd: [],
            run_args: [],
        };

        const unknown = [];
        let i = 0;

        if (rawArgs.length > 0) {
            const first = rawArgs[0];
            if (first === '-h' || first === '--help') {
                args.help = true;
                return { args, unknown };
            }
            if (first === '--version' || first === '-V') {
                args.version = true;
                msg(`${this.prog} ${VERSION}`);
                process.exit(0);
            }

            if (!first.startsWith('-')) {
                args.command = ALIAS_TO_CANONICAL[first] || first;
                i = 1;
            }
        }

        while (i < rawArgs.length) {
            const arg = rawArgs[i];
            if (arg === '-h' || arg === '--help') {
                args.help = true;
                i++;
            } else if (arg === '--version' || arg === '-V') {
                args.version = true;
                msg(`${this.prog} ${VERSION}`);
                process.exit(0);
            } else if (arg === '-q' || arg === '--quiet') {
                args.quiet = true;
                i++;
            } else if (arg === '-v' || arg === '--verbose') {
                args.verbose = true;
                i++;
            } else if (arg === '-i' || arg === '--image') {
                args.image = true;
                i++;
            } else if (arg.startsWith('-')) {
                unknown.push(arg);
                i++;
            } else {
                if (args.command === 'install' || args.command === 'push') {
                    if (!args.image_ref) args.image_ref = arg;
                } else if (args.command === 'remove' || args.command === 'kill') {
                    if (!args.target) args.target = arg;
                } else if (args.command === 'rename') {
                    if (!args.orig_name) args.orig_name = arg;
                    else if (!args.new_name) args.new_name = arg;
                } else if (['reset', 'login', 'backup', 'run'].includes(args.command)) {
                    if (!args.container_name) args.container_name = arg;
                } else if (args.command === 'copy' || args.command === 'sync') {
                    if (!args.source) args.source = arg;
                    else if (!args.destination) args.destination = arg;
                } else if (args.command === 'search') {
                    if (!args.query) args.query = arg;
                } else if (args.command === 'restore') {
                    if (!args.archive) args.archive = arg;
                }
                i++;
            }
        }

        return { args, unknown };
    }
}

export function buildParser() {
    /**
     * Construct the top-level parser supporting global options including --version and ps subcommand.
     */
    const parser = new PdArgumentParser(PROGRAM_NAME, "Manage Linux proot containers.");
    return parser;
}
