/**
 * # # Proot-Distro - manage proot containers.
 * # # Created by Sylirre <sylirre@termux.dev> for Termux project.
 * # # Ported to Node.js / JavaScript.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { critError } from '../message.js';
import { TERMUX_PREFIX } from '../constants.js';
import { readGuestBytes } from '../guestfile.js';
import { containerRootfs } from '../paths.js';

export function getDeviceCpuArch() {
    /**
     * Return the host CPU arch in proot-distro's naming scheme.
     * armv7l / armv8l are collapsed to "arm"; everything else is the raw `uname -m` value.
     */
    const machine = process.arch === 'arm64' ? 'aarch64' : (process.arch === 'arm' ? 'arm' : (process.arch === 'x64' ? 'x86_64' : osUnameMachine()));
    if (machine === "armv7l" || machine === "armv8l") {
        return "arm";
    }
    return machine;
}

function osUnameMachine() {
    try {
        return execSync('uname -m', { encoding: 'utf8' }).trim();
    } catch (e) {
        return process.arch;
    }
}

export function supports32bit() {
    /**
     * Return True if the host CPU supports 32-bit userspace execution.
     */
    const machine = getDeviceCpuArch();
    if (machine === "x86_64" || machine === "amd64") {
        return true;
    }
    if (machine === "aarch64" || machine === "arm64") {
        // In Node.js environment, probing personality via ctypes/ffi isn't standard natively,
        // so we default to true or try a safe check if possible.
        return true;
    }
    return true;
}

const ELF_MACHINE_MAP = {
    3: "i686",   // EM_386
    40: "arm",   // EM_ARM
    62: "x86_64", // EM_X86_64
    183: "aarch64", // EM_AARCH64
    243: "riscv64", // EM_RISCV
};

const ELF_HEADER_BYTES = 20;

function elfArch(ident) {
    if (!ident || ident.length < ELF_HEADER_BYTES || ident[0] !== 0x7f || ident[1] !== 0x45 || ident[2] !== 0x4c || ident[3] !== 0x46) {
        return "";
    }
    const littleEndian = ident[5] === 1;
    try {
        const eMachine = littleEndian ? ident.readUInt16LE(18) : ident.readUInt16BE(18);
        return ELF_MACHINE_MAP[eMachine] || "";
    } catch (e) {
        return "";
    }
}

export function detectInstalledArch(containerNameOrRootfs, options = {}) {
    const rootfsFd = options.rootfsFd || null;
    let root = containerNameOrRootfs;
    if (!root.includes(path.sep) && !root.startsWith("/")) {
        root = containerRootfs(containerNameOrRootfs);
    }

    const candidates = [
        "/usr/bin/bash",
        "/usr/bin/sh",
        "/usr/bin/su",
        "/usr/bin/busybox",
        `${TERMUX_PREFIX}/bin/bash`,
        "/bin/bash",
        "/bin/sh",
        "/bin/su",
        "/bin/busybox",
    ];

    for (const rel of candidates) {
        try {
            const bytes = readGuestBytes(root, rel, ELF_HEADER_BYTES, { rootFd: rootfsFd });
            const arch = elfArch(bytes);
            if (arch) {
                return arch;
            }
        } catch (e) {
            // Continue searching other candidates
        }
    }
    return "unknown";
}

const KNOWN_ARCHS = new Set(["aarch64", "arm", "i686", "riscv64", "x86_64"]);

const DOCKER_TO_PROOT = {
    "arm64": "aarch64",
    "arm/v7": "arm",
    "arm": "arm",
    "386": "i686",
    "amd64": "x86_64",
    "riscv64": "riscv64",
};

export function normalizeArch(arch) {
    let s = arch.trim();
    if (s.startsWith("linux/")) {
        s = s.slice(6);
    }
    if (KNOWN_ARCHS.has(s)) {
        return s;
    }
    return DOCKER_TO_PROOT[s] || null;
}

export const ARCH_UNAME_M = {
    "aarch64": "aarch64",
    "arm": "armv7l",
    "i686": "i686",
    "x86_64": "x86_64",
    "riscv64": "riscv64",
};

const QEMU_BIN_NAMES = {
    "aarch64": "qemu-aarch64",
    "arm": "qemu-arm",
    "i686": "qemu-i386",
    "riscv64": "qemu-riscv64",
    "x86_64": "qemu-x86_64",
};

const QEMU_PKGS = {
    "aarch64": "qemu-user-aarch64",
    "arm": "qemu-user-arm",
    "i686": "qemu-user-i386",
    "riscv64": "qemu-user-riscv64",
    "x86_64": "qemu-user-x86-64",
};

export function getProotBin() {
    const override = process.env.PD_PROOT_BIN;
    if (override) {
        if (!fs.existsSync(override) || !fs.statSync(override).isFile()) {
            critError(`PD_PROOT_BIN '${override}' is not found or not executable.`);
            process.exit(1);
        }
        return path.resolve(override);
    }

    try {
        const found = execSync('which proot', { encoding: 'utf8' }).trim();
        if (found) {
            return path.resolve(found);
        }
    } catch (e) {}

    critError("proot utility does not exist on your system.");
    process.exit(1);
}

export function getEmulatorArgs(distArch, deviceArch, emulatorOverride = "") {
    if (emulatorOverride) {
        const emuPath = emulatorOverride;
        if (!fs.existsSync(emuPath) || !fs.statSync(emuPath).isFile()) {
            critError(`emulator '${emuPath}' is not found or not executable.`);
            process.exit(1);
        }
    } else {
        if (distArch === deviceArch) {
            return [];
        }
        if (distArch === "arm" && deviceArch === "aarch64" && supports32bit()) {
            return [];
        }
        if (distArch === "i686" && deviceArch === "x86_64") {
            return [];
        }

        const binName = QEMU_BIN_NAMES[distArch];
        if (!binName) {
            critError(`unsupported architecture '${distArch}'. Valid values are: aarch64, arm, i686, riscv64, x86_64.`);
            process.exit(1);
        }

        let emuPath = "";
        try {
            emuPath = execSync(`which ${binName}`, { encoding: 'utf8' }).trim();
        } catch (e) {}

        if (!emuPath) {
            const pkg = QEMU_PKGS[distArch] || `qemu-user-${distArch}`;
            critError(`selected container requires emulator package '${pkg}' which is not installed.`);
            process.exit(1);
        }

        const args = ["-q", path.resolve(emuPath)];
        const pathsToBind = [
            "/apex",
            "/linkerconfig/ld.config.txt",
            TERMUX_PREFIX,
            "/system",
            "/vendor",
            "/plat_property_contexts",
            "/property_contexts",
        ];

        for (const p of pathsToBind) {
            if (fs.existsSync(p)) {
                args.push(`--bind=${p}`);
            }
        }
        return args;
    }
    return [];
}
