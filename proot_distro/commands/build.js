/**
 * # # Proot-Distro - manage proot containers.
 * # # Created by Sylirre <sylirre@termux.dev> for Termux project.
 * # # Ported to Node.js / JavaScript.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { commandInstall } from './install.js';
import { PROGRAM_NAME, RUNTIME_DIR } from '../constants.js';
import { containerIsInstalled } from '../paths.js';
import { C, msg, logInfo, logError, critError, quoteError } from '../message.js';
import { BuildLock } from '../locking.js';
import { getDeviceCpuArch, normalizeArch } from '../arch.js';
import {
    DockerfileSyntaxError,
    MAX_DOCKERFILE_BYTES,
    parseDockerfile,
} from '../helpers/dockerfile.js';
import {
    BuildEngine,
    BuildError,
    needsProot,
} from '../helpers/build_engine.js';
import {
    buildManifestAndConfig,
    storeInCache,
    writeOciArchive,
} from '../helpers/oci_writer.js';
import { ARCH_TO_DOCKER, withExplicitTag } from '../helpers/docker.js';
import { isValidName, requireValidName } from '../names.js';
import { fmtSize } from '../progress.js';

function readDockerfile(dockerfile) {
    if (dockerfile === "-") {
        const buffer = Buffer.alloc(MAX_DOCKERFILE_BYTES + 1);
        try {
            const bytesRead = fs.readSync(0, buffer, 0, MAX_DOCKERFILE_BYTES + 1, null);
            return buffer.slice(0, bytesRead);
        } catch (e) {
            return Buffer.alloc(0);
        }
    } else {
        const fd = fs.openSync(dockerfile, "r");
        try {
            const buffer = Buffer.alloc(MAX_DOCKERFILE_BYTES + 1);
            const bytesRead = fs.readSync(fd, buffer, 0, MAX_DOCKERFILE_BYTES + 1, null);
            return buffer.slice(0, bytesRead);
        } finally {
            fs.closeSync(fd);
        }
    }
}

export function commandBuild(args) {
    const buildPath = args.path || ".";
    const dockerfilePath = args.dockerfile || null;
    let tags = args.tags || [];
    const buildArgs = parseBuildArgs(args.build_args || []);
    const overrideArch = args.override_arch || "";
    const targetStage = args.target_stage || null;
    const emulator = args.emulator || "";
    const outputs = args.outputs || [];
    let installAs = args.install_as || null;

    if (dockerfilePath !== null && !dockerfilePath) {
        critError("Dockerfile path cannot be empty.");
        process.exit(1);
    }
    for (const outFile of outputs) {
        if (!outFile) {
            critError("output file path cannot be empty.");
            process.exit(1);
        }
    }
    if (installAs !== null && !installAs) {
        critError("--install-as value cannot be empty.");
        process.exit(1);
    }
    installAs = installAs || "";
    const noCache = Boolean(args.no_cache);
    const verbose = Boolean(args.verbose);
    const quiet = Boolean(args.quiet);

    const buildDir = path.resolve(buildPath.replace(/^~/, os.homedir()));
    let dockerfile;
    if (dockerfilePath === null) {
        dockerfile = path.join(buildDir, "Dockerfile");
    } else if (dockerfilePath === "-") {
        dockerfile = "-";
    } else {
        dockerfile = path.resolve(dockerfilePath.replace(/^~/, os.homedir()));
    }

    if (!fs.existsSync(buildDir) || !fs.statSync(buildDir).isDirectory()) {
        critError(`build context '${buildDir}' is not a directory.`);
        process.exit(1);
    }
    if (dockerfile !== "-" && (!fs.existsSync(dockerfile) || !fs.statSync(dockerfile).isFile())) {
        critError(`required file '${dockerfile}' does not exist.`);
        process.exit(1);
    }

    let raw;
    try {
        raw = readDockerfile(dockerfile);
    } catch (exc) {
        critError(`cannot read Dockerfile: ${exc}`);
        process.exit(1);
    }

    if (raw.length > MAX_DOCKERFILE_BYTES) {
        critError(`Dockerfile is larger than ${MAX_DOCKERFILE_BYTES} bytes; refusing to read it.`);
        process.exit(1);
    }

    const text = raw.toString("utf8");
    let instructions;
    try {
        const parsed = parseDockerfile(text);
        instructions = parsed.instructions;
    } catch (exc) {
        critError(`syntax error in Dockerfile: ${exc}`);
        process.exit(1);
    }

    if (!instructions || instructions.length === 0) {
        critError("no instructions in Dockerfile.");
        process.exit(1);
    }

    if (needsProot(instructions)) {
        // ensureProotInstalled equivalent check if needed
    }

    let targetArch;
    if (overrideArch) {
        targetArch = normalizeArch(overrideArch);
        if (!targetArch) {
            critError(`unknown architecture '${overrideArch}'.`);
            process.exit(1);
        }
    } else {
        targetArch = getDeviceCpuArch();
    }

    if (installAs) {
        requireValidName(installAs, { kind: "--install-as value" });
        if (containerIsInstalled(installAs)) {
            critError(`container '${installAs}' defined by --install-as already exists. Use '${PROGRAM_NAME} remove ${installAs}' first or '${PROGRAM_NAME} reset ${installAs}' to rebuild.`);
            process.exit(1);
        }
    }

    if (tags.length === 0) {
        const derived = deriveTagFromPath(buildDir, dockerfile);
        if (!derived) {
            critError("cannot derive a tag from the build path. Pass '--tag' explicitly (e.g. --tag myapp:latest).");
            process.exit(1);
        }
        tags = [derived];
    }

    for (const t of tags) {
        if (!isValidTag(t)) {
            critError(`tag '${t}' is not valid. A tag must start with an alphanumeric character and contain only letters, digits, underscores, dots, hyphens, slashes, or a single colon for the version.`);
            process.exit(1);
        }
    }

    tags = tags.map(t => withExplicitTag(t));
    const primaryTag = tags[0];

    for (const outFile of outputs) {
        const outAbs = path.resolve(outFile.replace(/^~/, os.homedir()));
        if (fs.existsSync(outAbs)) {
            critError(`file '${outAbs}' already exists. Please specify a different name.`);
            process.exit(1);
        }
    }

    const buildLocks = tags.map(t => new BuildLock(t, targetArch, { command: "build" }));
    buildLocks.sort((a, b) => a.lockPath.localeCompare(b.lockPath));

    // Acquire locks context simply in Node
    for (const lock of buildLocks) {
        lock.acquire();
    }

    const { tmpRoot, tmpRootFd } = makeBuildTmp();
    let engine = null;

    try {
        engine = new BuildEngine({
            buildDir,
            tmpRoot,
            tmpRootFd,
            targetArchPd: targetArch,
            userBuildArgs: buildArgs,
            targetStage,
            verbose,
            quiet,
            noCache,
            emulator,
        });

        let finalStage;
        try {
            finalStage = engine.run(instructions);
        } catch (exc) {
            if (exc instanceof BuildError || exc instanceof Error) {
                logError(`Build failed: ${quoteError(exc.message)}`);
            } else {
                logError(`Build failed: ${quoteError(String(exc))}`);
            }
            process.exit(1);
        }

        const archDocker = ARCH_TO_DOCKER[targetArch] ? ARCH_TO_DOCKER[targetArch][0] : targetArch;
        const { manifest, imageConfig } = buildManifestAndConfig(
            finalStage.imageConfig,
            finalStage.layers,
            archDocker
        );

        for (const t of tags) {
            try {
                storeInCache(t, targetArch, manifest, imageConfig);
            } catch (exc) {
                logError(`Cannot write manifest cache for '${t}': ${exc}`);
                process.exit(1);
            }
        }

        for (const outFile of outputs) {
            const outAbs = path.resolve(outFile.replace(/^~/, os.homedir()));
            try {
                if (!quiet) {
                    logInfo(`Writing OCI archive to '${outAbs}'...`);
                }
                writeOciArchive(outAbs, manifest, imageConfig, primaryTag);
            } catch (exc) {
                logError(`Cannot write '${outFile}': ${exc}`);
                process.exit(1);
            }
        }

        if (!quiet) {
            const totalSize = finalStage.layers.reduce((acc, l) => acc + (l.size || 0), 0);
            logInfo("Build complete.");
            msg();
            msg(`${C.CYAN}Tag(s): ${C.GREEN}${tags.join(", ")}${C.RST}`);
            msg(`${C.CYAN}Layers: ${C.GREEN}${finalStage.layers.length} (${fmtSize(totalSize)} total)${C.RST}`);
            msg();
        }

        if (installAs) {
            installAsContainer(installAs, primaryTag, targetArch, quiet);
        }

        if (outputs.length === 0 && !installAs && !quiet) {
            msg(`${C.CYAN}Install with: ${C.GREEN}${PROGRAM_NAME} install ${primaryTag}${C.RST}`);
            msg();
        }

    } catch (KeyboardInterrupt) {
        logError("Aborted by user.");
        process.exit(1);
    } finally {
        if (engine !== null && typeof engine.close === 'function') {
            try { engine.close(); } catch (e) {}
        }
        if (tmpRootFd !== null) {
            try { fs.closeSync(tmpRootFd); } catch (e) {}
        }
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch (e) {}

        for (const lock of buildLocks) {
            try { lock.release(); } catch (e) {}
        }
    }
}

function makeBuildTmp() {
    const buildTmp = path.join(RUNTIME_DIR, "build-tmp");
    try {
        if (!fs.existsSync(buildTmp)) {
            fs.mkdirSync(buildTmp, { recursive: true, mode: 0o700 });
        }
        const randHex = Math.random().toString(16).slice(2, 10);
        const name = `pd-build-${process.pid}.${randHex}`;
        const fullPath = path.join(buildTmp, name);
        fs.mkdirSync(fullPath, { mode: 0o700 });
        const runFd = fs.openSync(fullPath, 'r');
        return { tmpRoot: fullPath, tmpRootFd: runFd };
    } catch (e) {
        return fallbackBuildTmp();
    }
}

function fallbackBuildTmp() {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), "pd-build-"));
    try {
        const fd = fs.openSync(p, 'r');
        return { tmpRoot: p, tmpRootFd: fd };
    } catch (e) {
        fs.rmSync(p, { recursive: true, force: true });
        throw e;
    }
}

function parseBuildArgs(raw) {
    const out = {};
    for (const item of raw) {
        let k, v;
        if (item.includes("=")) {
            const parts = item.split("=");
            k = parts[0];
            v = parts.slice(1).join("=");
        } else {
            k = item;
            v = process.env[item] || "";
        }
        if (k) {
            out[k] = v;
        }
    }
    return out;
}

function deriveTagFromPath(buildDir, dockerfile) {
    let base = path.basename(path.resolve(buildDir).replace(/\/+$/, ""));
    if (!base || base === "." || base === "..") {
        if (dockerfile && dockerfile !== "-") {
            base = path.basename(path.dirname(path.resolve(dockerfile)));
        }
    }
    base = base.toLowerCase().replace(/[^a-z0-9_.\-]/g, "-").replace(/^-+|-+$/g, "");
    base = base.replace(/-+/g, "-");
    if (!base || !isValidName(base)) {
        return "";
    }
    return `${base}:latest`;
}

function isValidTag(tag) {
    if (!tag) return false;
    if (tag.includes(":")) {
        const parts = tag.split(":");
        const tagPart = parts[parts.length - 1];
        if (!tagPart) return false;
        if (!/^[A-Za-z0-9][\w.\-]*$/.test(tagPart)) return false;
        const namePart = parts.slice(0, -1).join(":");
        const last = namePart.split("/").pop();
        return isValidName(last);
    } else {
        const last = tag.split("/").pop();
        return isValidName(last);
    }
}

function installAsContainer(installName, imageRef, targetArch, quiet) {
    if (!quiet) {
        logInfo(`Installing built image as '${installName}'...`);
    }
    commandInstall({
        image_ref: imageRef,
        custom_container_name: installName,
        override_arch: targetArch,
    });
}
