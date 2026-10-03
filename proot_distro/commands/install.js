/**
 * # # Proot-Distro - manage proot containers.
 * # # Created by Sylirre <sylirre@termux.dev> for Termux project.
 * # # Ported to Node.js / JavaScript.
 */

import fs from 'fs';
import path from 'path';
import tar from 'tar';
import { BASE_CACHE_DIR, PROGRAM_NAME } from '../constants.js';
import { C, msg, logInfo, logError, critError } from '../message.js';
import { clearBar } from '../progress.js';
import { ContainerLock } from '../locking.js';
import { getDeviceCpuArch, normalizeArch } from '../arch.js';
import { isValidName, requireValidName } from '../names.js';
import {
    containerDir,
    containerManifest,
    containerRootfs,
    containerIsInstalled,
    openContainerPair,
} from '../paths.js';
import { setupFakeSysdata } from '../sysdata.js';
import { deriveAlias, pullImage } from '../helpers/docker.js';
import {
    openEtc,
    registerAndroidIdsAt,
    writeHostsAt,
    writeResolvConfAt,
} from '../helpers/rootfs.js';
import { downloadFile } from '../helpers/download.js';
import { installFromLocalFile } from './install_local.js';
import { removeStateTree } from '../statedir.js';

const ARCHIVE_EXTS = [
    ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz",
    ".oci.tar.xz", ".oci.tar.gz", ".oci.tar.zst", ".oci.tar",
    ".tar.lzma", ".tlzma", ".tar.zst", ".tzst", ".tar"
];

function isLocalPath(ref) {
    return ref.startsWith("/") || ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("~");
}

function isUrl(ref) {
    return ref.startsWith("http://") || ref.startsWith("https://");
}

function deriveLocalName(filePath) {
    let base = path.basename(filePath);
    let low = base.toLowerCase();
    for (const ext of ARCHIVE_EXTS) {
        if (low.endsWith(ext)) {
            base = base.slice(0, -ext.length);
            break;
        }
    }
    base = base.toLowerCase().replace(/[^a-z0-9_.\-]/g, "-");
    base = base.replace(/^[^a-z0-9]+/, "");
    base = base.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
    return base;
}

function cacheTempFile(prefix) {
    if (!fs.existsSync(BASE_CACHE_DIR)) {
        fs.mkdirSync(BASE_CACHE_DIR, { recursive: true });
    }
    const randHex = Math.random().toString(16).slice(2, 10);
    const tempName = `${prefix}.${process.pid}.${randHex}.tmp`;
    const fullPath = path.join(BASE_CACHE_DIR, tempName);
    fs.writeFileSync(fullPath, "", { mode: 0o600 });
    return fullPath;
}

export function commandInstall(args) {
    const imageRef = args.image_ref;
    const customContainerName = args.custom_container_name;

    if (customContainerName !== null && customContainerName !== undefined && !customContainerName) {
        critError("container name can't be empty.");
        process.exit(1);
    }
    if (customContainerName) {
        requireValidName(customContainerName);
    }

    const deviceArch = getDeviceCpuArch();
    const rawArch = args.override_arch;
    let distArch = deviceArch;

    if (rawArch) {
        distArch = normalizeArch(rawArch);
        if (!distArch) {
            critError(
                `unknown architecture '${rawArch}'. Valid values: aarch64, arm, i686, riscv64, x86_64 ` +
                `(or Docker format: linux/arm64, linux/amd64, linux/arm/v7, linux/386, linux/riscv64).`
            );
            process.exit(1);
        }
    }

    const localPath = isLocalPath(imageRef) ? imageRef.replace(/^~/, process.env.HOME || "") : null;
    const url = isUrl(imageRef) ? imageRef : null;

    const installName = resolveInstallName(imageRef, localPath, url, customContainerName);
    const allowInsecure = Boolean(args.allow_insecure);

    const lock = new ContainerLock(installName, { exclusive: true, command: "install" });
    lock.withLock(() => {
        runInstall(installName, imageRef, localPath, url, distArch, allowInsecure);
    });
}

function resolveInstallName(imageRef, localPath, url, customContainerName) {
    if (localPath !== null) {
        if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
            critError(`local file '${localPath}' does not exist or is not a regular file.`);
            process.exit(1);
        }
        if (customContainerName) return customContainerName;
        const derived = deriveLocalName(localPath);
        if (!derived || !isValidName(derived)) {
            critError(`cannot determine a valid container name from '${path.basename(localPath)}'. Specify the name with '--name NAME'.`);
            process.exit(1);
        }
        return derived;
    }

    if (url !== null) {
        if (customContainerName) return customContainerName;
        const urlPath = url.split("?")[0].split("#")[0];
        const derived = deriveLocalName(urlPath);
        if (!derived || !isValidName(derived)) {
            critError(`cannot determine a valid container name from '${url}'. Specify the name with '--name NAME'.`);
            process.exit(1);
        }
        return derived;
    }

    const derived = customContainerName ? customContainerName : deriveAlias(imageRef);
    if (!isValidName(derived)) {
        critError(`cannot derive a valid container name from '${imageRef}'. Specify the name with '--name NAME'.`);
        process.exit(1);
    }
    return derived;
}

function runInstall(installName, imageRef, localPath, url, distArch, allowInsecure = false) {
    const containerPath = containerDir(installName);
    const rootfsDir = containerRootfs(installName);

    if (containerIsInstalled(installName)) {
        msg();
        critError(`container '${installName}' already exists. Specify a different name with '--name NAME'.`);
        msg();
        msg(`${C.CYAN}Start shell: ${C.GREEN}${PROGRAM_NAME} login ${installName}${C.RST}`);
        msg(`${C.CYAN}Reinstall: ${C.GREEN}${PROGRAM_NAME} reset ${installName}${C.RST}`);
        msg(`${C.CYAN}Uninstall: ${C.GREEN}${PROGRAM_NAME} remove ${installName}${C.RST}`);
        msg();
        process.exit(1);
    }

    if (localPath !== null) {
        logInfo(`Installing from '${path.basename(localPath)}' as '${installName}'...`);
    } else if (url !== null) {
        logInfo(`Installing from URL '${url}' as '${installName}'...`);
    } else {
        const lastComponent = imageRef.split("/").pop();
        const displayRef = lastComponent.includes(":") ? imageRef : `${imageRef}:latest`;
        logInfo(`Installing '${displayRef}' as '${installName}'...`);
    }

    const { containerFd, rootfsFd } = openContainerPair(installName, { create: true });

    const cleanup = () => {
        try {
            removeStateTree(containerPath);
        } catch (e) {}
    };

    let tmpArchive = null;
    try {
        let metadata = null;
        if (localPath !== null) {
            logInfo("Extracting rootfs from archive...");
            metadata = installFromLocalFile(localPath, rootfsFd, distArch);
        } else if (url !== null) {
            tmpArchive = cacheTempFile(`dl_install_${installName}`);
            logInfo("Downloading archive...");
            downloadFile(url, tmpArchive, { insecure: allowInsecure });
            logInfo("Extracting rootfs from archive...");
            metadata = installFromLocalFile(tmpArchive, rootfsFd, distArch);
        } else {
            metadata = pullImage(imageRef, rootfsFd, distArch, { insecure: allowInsecure });
        }

        if (metadata !== null) {
            const manifestData = {
                image_ref: metadata.image_ref || (localPath === null ? imageRef : ""),
                arch: metadata.arch || distArch,
                manifest: metadata.manifest || {},
                image_config: metadata.image_config || {},
            };
            try {
                const manifestPath = containerManifest(installName);
                fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), "utf8");
            } catch (exc) {
                logError(`Warning: could not write manifest.json: ${exc}`);
            }
        }

        const etcFd = openEtc(rootfsFd);
        if (etcFd !== null) {
            try {
                logInfo("Updating '/etc/resolv.conf'...");
                writeResolvConfAt(etcFd);
                logInfo("Updating '/etc/hosts'...");
                writeHostsAt(etcFd);
                
                const passwdPath = path.join(etcFd, "passwd");
                if (fs.existsSync(passwdPath) && fs.statSync(passwdPath).isFile()) {
                    logInfo("Registering Android-specific UIDs and GIDs...");
                    registerAndroidIdsAt(etcFd);
                }
            } finally {
                // close handle abstraction if needed
            }
        }

        setupFakeSysdata(rootfsDir, { containerFd });

    } catch (exc) {
        clearBar();
        logError(`Failed to install: ${exc}`);
        logError("See 'proot-distro install --help' on how to install distribution image.");
        cleanup();
        process.exit(1);
    } finally {
        if (rootfsFd !== null) {
            try { fs.closeSync(rootfsFd); } catch (e) {}
        }
        if (containerFd !== null) {
            try { fs.closeSync(containerFd); } catch (e) {}
        }
        if (tmpArchive !== null) {
            try { fs.unlinkSync(tmpArchive); } catch (e) {}
        }
    }

    logInfo("Finished installation.");
    msg();
    
    // Placeholder extraction for entrypoint check
    const entrypoint = null;
    const shellLabel = entrypoint ? "Start shell: " : "Start shell:";
    msg(`${C.CYAN}${shellLabel} ${C.GREEN}${PROGRAM_NAME} login ${installName}${C.RST}`);
    if (entrypoint) {
        msg(`${C.CYAN}Run entrypoint: ${C.GREEN}${PROGRAM_NAME} run ${installName}${C.RST}`);
    }
    msg();
}
