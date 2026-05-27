/**
 * Random-suffix tmp file orphan cleanup for the local store adapters.
 *
 * Closes STORES-B-001 (Stage B Wave B1 audit). The pre-fix adapters wrote to a
 * fixed `${target}.tmp` suffix during persist(): two processes calling persist()
 * concurrently would race on the same tmp file and the second writer would
 * truncate the first one's data silently. The fix shifts each persist call to
 * a random-suffix tmp path so concurrent writers never collide.
 *
 * The new failure mode is orphan tmp files: if a process dies between
 * writeFileSync and renameSync the random-suffix tmp file lingers forever.
 * `cleanupOrphanTmpFiles` sweeps the data directory at constructor time and
 * removes orphan tmp files older than maxAgeMs (default 5 minutes). Young tmp
 * files are kept because they may belong to a sibling process that is still
 * writing — deleting them mid-flight would corrupt that sibling.
 *
 * The pattern we match is `${baseName}.\d+-[a-z0-9]{1,6}\.tmp` which
 * corresponds to the `${target}.${process.pid}-${rand}.tmp` shape used by the
 * adapters' persist() methods.
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Build the per-call random tmp path used by the local-store persist methods.
 * Centralized here so the cleanup regex stays in sync with the producer.
 *
 * Format: `${targetPath}.${process.pid}-${rand6}.tmp` where rand6 is 1-6
 * base36 characters. process.pid is included so per-process collision is
 * impossible; the random suffix handles intra-process concurrency.
 */
export function buildRandomTmpPath(targetPath: string): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${targetPath}.${process.pid}-${rand}.tmp`;
}

/**
 * Scan dir for random-suffix orphan tmp files matching baseName and unlink
 * the ones older than maxAgeMs. Best-effort: any error during readdir / stat /
 * unlink is swallowed so a half-broken filesystem cannot prevent an adapter
 * from constructing.
 *
 * The match regex is anchored to baseName specifically so unrelated `.tmp`
 * files in the directory (e.g. operator backups, scratch files) survive.
 *
 * @param dir       Absolute path of the directory to scan.
 * @param baseName  The base file name (e.g. `entities.json`) — must NOT
 *                  contain path separators; the helper escapes regex
 *                  metacharacters but does not split paths.
 * @param maxAgeMs  Orphan threshold in ms. Files with mtime older than
 *                  `now - maxAgeMs` are removed; younger files are kept
 *                  because they may belong to an actively-writing sibling
 *                  process. Default: 5 minutes.
 */
export function cleanupOrphanTmpFiles(
    dir: string,
    baseName: string,
    maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): void {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        // Directory missing or unreadable — nothing to clean.
        return;
    }

    // Escape regex metacharacters in baseName (e.g. periods in `entities.json`
    // would otherwise act as wildcards).
    const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const orphanPattern = new RegExp(`^${escapedBase}\\.\\d+-[a-z0-9]{1,6}\\.tmp$`);

    const cutoff = Date.now() - maxAgeMs;

    for (const entry of entries) {
        if (!orphanPattern.test(entry)) continue;
        const fullPath = join(dir, entry);
        let mtimeMs: number;
        try {
            const stat = statSync(fullPath);
            mtimeMs = stat.mtimeMs;
        } catch {
            // Lost the race or stat failed — skip.
            continue;
        }
        if (mtimeMs >= cutoff) {
            // Young file — may belong to an actively-writing sibling process.
            continue;
        }
        try {
            unlinkSync(fullPath);
        } catch {
            // Best-effort. A failure here is non-fatal; we tried.
        }
    }
}

/**
 * Sweep the artifact content directory for orphan random-suffix tmp files.
 *
 * Artifact content files are named after their sha256 hex hash ([a-f0-9]{64}).
 * Their tmp variants look like `<sha256>.<pid>-<rand>.tmp`. We don't know
 * each hash up-front so we match any file whose name fits
 * `^[a-f0-9]{64}\.\d+-[a-z0-9]{1,6}\.tmp$` and apply the same age threshold
 * as cleanupOrphanTmpFiles.
 *
 * Kept separate from cleanupOrphanTmpFiles because the artifact content dir
 * uses a different filename pattern (hash, not a fixed basename); collapsing
 * them would require a much more permissive regex that risks matching
 * unrelated files.
 */
export function sweepContentDirOrphans(
    contentDir: string,
    maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): void {
    let entries: string[];
    try {
        entries = readdirSync(contentDir);
    } catch {
        return;
    }

    const orphanPattern = /^[a-f0-9]{64}\.\d+-[a-z0-9]{1,6}\.tmp$/;
    const cutoff = Date.now() - maxAgeMs;

    for (const entry of entries) {
        if (!orphanPattern.test(entry)) continue;
        const fullPath = join(contentDir, entry);
        let mtimeMs: number;
        try {
            const stat = statSync(fullPath);
            mtimeMs = stat.mtimeMs;
        } catch {
            continue;
        }
        if (mtimeMs >= cutoff) continue;
        try {
            unlinkSync(fullPath);
        } catch {
            // Best-effort.
        }
    }
}
