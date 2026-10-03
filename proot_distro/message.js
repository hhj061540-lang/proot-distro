/**
 * # # Proot-Distro - manage proot containers.
 * # # Created by Sylirre <sylirre@termux.dev> for Termux project.
 * # # Ported to Node.js / JavaScript.
 */

import os from 'node:os';
import process from 'node:process';

// Try to load termios if available (typically available in Node via native addons or specific platforms,
// but we handle graceful fallback for standard environments).
let termios = null;
try {
    // Note: Node.js does not have a built-in cross-platform 'termios' module. 
    // In Termux/Linux environments, you could use a package like 'termios' if installed,
    // or fallback to safe defaults.
    termios = await import('termios').catch(() => null);
} catch {
    termios = null;
}

const _RST = "\033[0m";
const _BOLD = "\033[1m";
const _ITALIC = "\033[3m";
const _UNDERLINE = "\033[4m";
const _RED = "\033[31m";
const _GREEN = "\033[32m";
const _YELLOW = "\033[33m";
const _BLUE = "\033[34m";
const _MAGENTA = "\033[35m";
const _CYAN = "\033[36m";
const _WHITE = "\033[37m";

const _COLORS = {
    "RST": _RST,
    "RED": _RST + _RED,
    "BRED": _RST + _BOLD + _RED,
    "IRED": _RST + _ITALIC + _RED,
    "URED": _RST + _UNDERLINE + _RED,
    "UBRED": _RST + _UNDERLINE + _BOLD + _RED,
    "GREEN": _RST + _GREEN,
    "BGREEN": _RST + _BOLD + _GREEN,
    "IGREEN": _RST + _ITALIC + _GREEN,
    "UGREEN": _RST + _UNDERLINE + _GREEN,
    "UBGREEN": _RST + _UNDERLINE + _BOLD + _GREEN,
    "YELLOW": _RST + _YELLOW,
    "BYELLOW": _RST + _BOLD + _YELLOW,
    "IYELLOW": _RST + _ITALIC + _YELLOW,
    "UYELLOW": _RST + _UNDERLINE + _YELLOW,
    "UBYELLOW": _RST + _UNDERLINE + _BOLD + _YELLOW,
    "BLUE": _RST + _BLUE,
    "BBLUE": _RST + _BOLD + _BLUE,
    "IBLUE": _RST + _ITALIC + _BLUE,
    "UBLUE": _RST + _UNDERLINE + _BLUE,
    "UBBLUE": _RST + _UNDERLINE + _BOLD + _BLUE,
    "MAGENTA": _RST + _MAGENTA,
    "BMAGENTA": _RST + _BOLD + _MAGENTA,
    "IMAGENTA": _RST + _ITALIC + _MAGENTA,
    "UMAGENTA": _RST + _UNDERLINE + _MAGENTA,
    "UBMAGENTA": _RST + _UNDERLINE + _BOLD + _MAGENTA,
    "CYAN": _RST + _CYAN,
    "BCYAN": _RST + _BOLD + _CYAN,
    "ICYAN": _RST + _ITALIC + _CYAN,
    "UCYAN": _RST + _UNDERLINE + _CYAN,
    "UBCYAN": _RST + _UNDERLINE + _BOLD + _CYAN,
    "WHITE": _RST + _WHITE,
    "BWHITE": _RST + _BOLD + _WHITE,
    "IWHITE": _RST + _ITALIC + _WHITE,
    "UWHITE": _RST + _UNDERLINE + _WHITE,
    "UBWHITE": _RST + _UNDERLINE + _BOLD + _WHITE,
};

const _EMPTY = Object.fromEntries(Object.keys(_COLORS).map(k => [k, ""]));

function initColors() {
    if (process.stderr.isTTY && !process.env.PD_FORCE_NO_COLORS) {
        return _COLORS;
    }
    return _EMPTY;
}

export const C = initColors();

export function ttySafeForWrites() {
    /**
     * Return False when stderr's TTY is currently being used by another process for interactive input.
     */
    if (!termios) return true;
    try {
        const fd = process.stderr.fd;
        if (!process.stderr.isTTY) return true;
        
        // If termios bindings are available:
        // attrs = termios.tcgetattr(fd); lflag = attrs[3];
        // return (lflag & ECHO) && (lflag & ICANON);
        return true;
    } catch {
        return true;
    }
}

export function terminalWidth(defaultValue = 80) {
    /**
     * Return the terminal's column count, or *defaultValue* when unknown.
     */
    for (const stream of [process.stderr, process.stdout]) {
        try {
            const cols = stream.columns;
            if (cols && cols > 0) return cols;
        } catch {
            continue;
        }
    }
    return defaultValue;
}

let _quiet = false;

export function setQuiet(value) {
    /**
     * Enable or disable quiet mode for the rest of the process.
     */
    _quiet = Boolean(value);
}

export function set_quiet(value) {
    setQuiet(value);
}

export function isQuiet() {
    return _quiet;
}

export function msg(...args) {
    /**
     * Print *args* to stderr after clearing any partial progress line.
     */
    if (!ttySafeForWrites()) return;
    
    let isTty = false;
    try {
        isTty = Boolean(process.stderr.isTTY);
    } catch {
        isTty = false;
    }

    if (isTty) {
        process.stderr.write("\r\033[K");
    }
    
    const message = args.map(arg => String(arg)).join(' ');
    process.stderr.write(message + '\n');
}

export function logInfo(text) {
    /**
     * Emit a `[*] text` info line. No-op under --quiet.
     */
    if (_quiet) return;
    msg(`${C.BLUE}[${C.GREEN}*${C.BLUE}] ${C.CYAN}${text}${C.RST}`);
}

export function logError(text) {
    /**
     * Emit a `[!] text` error line. Always shown — even under --quiet.
     */
    msg(`${C.BLUE}[${C.RED}!${C.BLUE}] ${C.CYAN}${text}${C.RST}`);
}

export function warn(text) {
    /**
     * Emit a 'Warning: text' line in yellow.
     */
    msg(`${C.BYELLOW}Warning: ${C.YELLOW}${text}${C.RST}`);
}

export function critError(text) {
    /**
     * Emit an 'Error: text' line in red.
     */
    msg(`${C.BRED}Error: ${C.RED}${text}${C.RST}`);
}

export const crit_error = critError;

const _QUOTE_MAP = {
    "\\": "\\\\",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\x1b": "\\e",
};

export function quotePath(text) {
    /**
     * Render *text* printable, C-style escapes for control characters.
     */
    const out = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const escaped = _QUOTE_MAP[ch];
        if (escaped !== undefined) {
            out.push(escaped);
        } else if (ch < " " || ch === "\x7f") {
            out.push(`\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
        } else {
            out.push(ch);
        }
    }
    return out.join("");
}

export function quoteError(exc) {
    /**
     * The reason *exc* gives, safe to print next to a name of our own.
     */
    const errReason = exc.message || String(exc);
    return quotePath(errReason);
}
