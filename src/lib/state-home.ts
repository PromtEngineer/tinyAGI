import fs from 'fs';
import path from 'path';
import os from 'os';

export interface StateHomeInfo {
    home: string;
    legacyHome: string;
    migrated: boolean;
    migrationLog: string[];
}

const APP_DIR_NAME = '.tinyagi';
const LEGACY_DIR_NAME = '.tinyclaw';

function copyRecursive(src: string, dest: string): void {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dest, entry));
        }
        return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

function countFiles(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return 1;
    let total = 0;
    for (const entry of fs.readdirSync(dir)) {
        total += countFiles(path.join(dir, entry));
    }
    return total;
}

function looksLikeStateDir(dir: string): boolean {
    return fs.existsSync(path.join(dir, 'settings.json')) || fs.existsSync(path.join(dir, 'queue'));
}

/**
 * Resolve canonical state home for tinyAGI.
 *
 * Migration rules:
 * - Canonical home is ~/.tinyagi.
 * - If ~/.tinyagi is missing and ~/.tinyclaw exists, copy everything and verify basic parity.
 * - If copy succeeds, replace ~/.tinyclaw with a symlink to ~/.tinyagi when possible.
 * - If symlink fails, keep dual-read compatibility (callers still receive ~/.tinyagi).
 */
export function resolveStateHome(scriptDir: string): StateHomeInfo {
    const homeDir = os.homedir();
    const canonicalHome = path.join(homeDir, APP_DIR_NAME);
    const legacyHome = path.join(homeDir, LEGACY_DIR_NAME);
    const migrationLog: string[] = [];
    let migrated = false;

    // If repo-local .tinyagi exists, prefer it for local development.
    const localTinyagi = path.join(scriptDir, APP_DIR_NAME);
    if (looksLikeStateDir(localTinyagi)) {
        return {
            home: localTinyagi,
            legacyHome,
            migrated: false,
            migrationLog: ['Using repository-local .tinyagi state directory.'],
        };
    }

    // Backward-compatible local .tinyclaw support in repo mode.
    const localTinyclaw = path.join(scriptDir, LEGACY_DIR_NAME);
    if (!looksLikeStateDir(localTinyagi) && looksLikeStateDir(localTinyclaw)) {
        return {
            home: localTinyclaw,
            legacyHome,
            migrated: false,
            migrationLog: ['Using repository-local .tinyclaw state directory (legacy mode).'],
        };
    }

    if (!fs.existsSync(canonicalHome) && fs.existsSync(legacyHome)) {
        migrationLog.push(`Migrating legacy state from ${legacyHome} to ${canonicalHome}`);
        copyRecursive(legacyHome, canonicalHome);

        const sourceCount = countFiles(legacyHome);
        const destCount = countFiles(canonicalHome);
        if (destCount < sourceCount) {
            throw new Error(`State migration failed parity check: source=${sourceCount} dest=${destCount}`);
        }
        migrationLog.push(`State copy complete (source files=${sourceCount}, destination files=${destCount}).`);
        migrated = true;

        // Replace legacy directory with symlink when safe.
        try {
            if (fs.existsSync(legacyHome) && !fs.lstatSync(legacyHome).isSymbolicLink()) {
                fs.rmSync(legacyHome, { recursive: true, force: true });
            }
            if (!fs.existsSync(legacyHome)) {
                fs.symlinkSync(canonicalHome, legacyHome, 'dir');
                migrationLog.push(`Created compatibility symlink ${legacyHome} -> ${canonicalHome}`);
            }
        } catch (error) {
            migrationLog.push(`Could not create legacy symlink: ${(error as Error).message}`);
            migrationLog.push('Falling back to dual-read compatibility mode.');
        }
    }

    fs.mkdirSync(canonicalHome, { recursive: true });
    return {
        home: canonicalHome,
        legacyHome,
        migrated,
        migrationLog,
    };
}

