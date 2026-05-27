/**
 * Canonical tmp-paths helper — random-suffix tmp filenames and orphan-tmp
 * sweep logic for any module that writes-then-renames a file atomically.
 *
 * Wave B1-Amend (CI/Docs domain) extracted this helper after Wave A4
 * shipped THREE inline copies of the same logic:
 *   - `src/adapters/local/tmp-cleanup.ts` (the original, Stores adapters)
 *   - `src/kernel/cluster-kernel.ts` getStagingDir + sweepStagingOrphans
 *   - `src/kernel/command-queue.ts` (buildRandomTmpPath + cleanupOrphanTmpFiles)
 *
 * Triplication arose because the kernel tree is forbidden from importing
 * adapters/ (no-back-edge rule). The fix is to make THIS module the canonical
 * source — both kernel/ and adapters/ may import from src/util/ without
 * violating any layer boundary. Adapters' tmp-cleanup.ts may delegate to this
 * module; kernel's inline copies may delegate too. Migration is incremental;
 * callers can adopt at their own pace.
 *
 * Why a util module is allowed from both layers:
 *   - kernel/ → util/ is fine (util has no domain dependencies)
 *   - adapters/ → util/ is fine (same)
 *   - util/ MUST NOT import from kernel/ or adapters/
 *
 * The "no-back-edge rule" forbids kernel ↔ adapters import; it does not forbid
 * either from importing a leaf utility module that has no upstream coupling.
 *
 * Format: `${targetPath}.${process.pid}-${rand6}.tmp` where rand6 is 1-6
 * base36 characters. The pid + random suffix combination ensures:
 *   - per-process collision is impossible (different PIDs)
 *   - intra-process concurrency is safe (Math.random within a process)
 *
 * Cleanup contract: the orphan-sweep helper is best-effort. It swallows ALL
 * errors (readdir, stat, unlink) because a half-broken filesystem must not
 * prevent the module that uses tmp-paths from constructing. Young tmp files
 * (mtime within the age threshold) are PRESERVED — they may belong to a
 * sibling process that is still writing.
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_TMP_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Build the per-call random tmp path used by atomic writes.
 *
 * @param targetPath  The final path that the tmp file will be renamed onto.
 *                    May be an absolute path or a relative path; passed
 *                    through to the returned string verbatim with `.${pid}-${rand}.tmp`
 *                    appended.
 * @returns           A string in the format `${targetPath}.${pid}-${rand}.tmp`
 *                    suitable for `writeFileSync` followed by `renameSync`.
 */
export function buildRandomTmpPath(targetPath: string): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${targetPath}.${process.pid}-${rand}.tmp`;
}

/**
 * Options for {@link cleanupOrphanTmpFiles} and {@link sweepContentDirOrphans}.
 */
export interface CleanupOptions {
    /**
     * Age threshold in ms. Files with mtime older than `now - maxAgeMs` are
     * removed; younger files are kept because they may belong to an
     * actively-writing sibling process. Default: 5 minutes.
     */
    maxAgeMs?: number;
}

/**
 * Result returned by sweep helpers — count of files actually unlinked.
 */
export interface CleanupResult {
    /** Number of files removed by this sweep. */
    swept: number;
}

/**
 * Scan `dir` for orphan tmp files matching `${baseName}.\d+-[a-z0-9]{1,6}\.tmp`
 * and unlink the ones older than the age threshold.
 *
 * Best-effort: directory missing, stat errors, and unlink errors are all
 * swallowed and counted as "not swept." Returns the number of files actually
 * removed so callers can log a metric if they want.
 *
 * The regex is anchored to `baseName` so unrelated `.tmp` files (e.g. operator
 * backups, scratch files) survive.
 *
 * @param dir       Absolute path of the directory to scan. Missing dir is a
 *                  no-op (returns { swept: 0 }).
 * @param baseName  The base file name (e.g. `entities.json`) — must NOT
 *                  contain path separators; regex metacharacters are escaped
 *                  but the helper does not split paths.
 * @param options   See {@link CleanupOptions}.
 */
export function cleanupOrphanTmpFiles(
    dir: string,
    baseName: string,
    options: CleanupOptions = {},
): CleanupResult {
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_TMP_MAX_AGE_MS;
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        // Directory missing or unreadable — nothing to clean.
        return { swept: 0 };
    }

    // Escape regex metacharacters in baseName (periods in `entities.json`
    // would otherwise act as wildcards).
    const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const orphanPattern = new RegExp(`^${escapedBase}\\.\\d+-[a-z0-9]{1,6}\\.tmp$`);

    const cutoff = Date.now() - maxAgeMs;
    let swept = 0;

    for (const entry of entries) {
        if (!orphanPattern.test(entry)) continue;
        const fullPath = join(dir, entry);
        let mtimeMs: number;
        try {
            mtimeMs = statSync(fullPath).mtimeMs;
        } catch {
            continue;
        }
        if (mtimeMs >= cutoff) continue;
        try {
            unlinkSync(fullPath);
            swept++;
        } catch {
            // Best-effort.
        }
    }

    return { swept };
}

/**
 * Sweep a content-addressed directory (artifact content, kernel staging) for
 * orphan random-suffix tmp files. Matches the pattern
 * `^[a-f0-9]{64}\.\d+-[a-z0-9]{1,6}\.tmp$` (sha256 hex hash basename + the
 * standard tmp suffix shape).
 *
 * Kept separate from {@link cleanupOrphanTmpFiles} because the filename
 * pattern differs (hash, not a fixed basename); a single permissive regex
 * would risk matching unrelated files.
 */
export function sweepContentDirOrphans(
    contentDir: string,
    options: CleanupOptions = {},
): CleanupResult {
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_TMP_MAX_AGE_MS;
    let entries: string[];
    try {
        entries = readdirSync(contentDir);
    } catch {
        return { swept: 0 };
    }

    const orphanPattern = /^[a-f0-9]{64}\.\d+-[a-z0-9]{1,6}\.tmp$/;
    const cutoff = Date.now() - maxAgeMs;
    let swept = 0;

    for (const entry of entries) {
        if (!orphanPattern.test(entry)) continue;
        const fullPath = join(contentDir, entry);
        let mtimeMs: number;
        try {
            mtimeMs = statSync(fullPath).mtimeMs;
        } catch {
            continue;
        }
        if (mtimeMs >= cutoff) continue;
        try {
            unlinkSync(fullPath);
            swept++;
        } catch {
            // Best-effort.
        }
    }

    return { swept };
}
