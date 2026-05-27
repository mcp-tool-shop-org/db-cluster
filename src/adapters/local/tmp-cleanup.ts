/**
 * Random-suffix tmp file orphan cleanup for the local store adapters.
 *
 * Closes STORES-B-001 (Stage B Wave B1 audit). The pre-fix adapters wrote to a
 * fixed `${target}.tmp` suffix during persist(): two processes calling persist()
 * concurrently would race on the same tmp file and the second writer would
 * truncate the first one's data silently. The fix shifts each persist call to
 * a random-suffix tmp path so concurrent writers never collide.
 *
 * Wave B1-Amend (cross-domain consolidation): the load-bearing helpers below
 * now delegate to {@link src/util/tmp-paths.ts}, the canonical implementation
 * extracted by the CI/Docs agent to close the AGG-A4-2 triplication finding
 * (this file, `src/kernel/cluster-kernel.ts::getStagingDir`, and
 * `src/kernel/command-queue.ts` all shipped the same logic inline pre-amend).
 * The signatures and return shapes of these adapter-side helpers were
 * preserved as `void` for back-compat with existing call sites.
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

import {
    buildRandomTmpPath as utilBuildRandomTmpPath,
    cleanupOrphanTmpFiles as utilCleanupOrphanTmpFiles,
    sweepContentDirOrphans as utilSweepContentDirOrphans,
} from '../../util/tmp-paths.js';

/**
 * Build the per-call random tmp path used by the local-store persist methods.
 * Centralized in `src/util/tmp-paths.ts`; re-exported here as a back-compat
 * shim so existing adapter call sites need no edits.
 *
 * Format: `${targetPath}.${process.pid}-${rand6}.tmp` where rand6 is 1-6
 * base36 characters. process.pid is included so per-process collision is
 * impossible; the random suffix handles intra-process concurrency.
 */
export function buildRandomTmpPath(targetPath: string): string {
    return utilBuildRandomTmpPath(targetPath);
}

/**
 * Scan `dir` for random-suffix orphan tmp files matching `baseName` and unlink
 * the ones older than `maxAgeMs`. Best-effort.
 *
 * The adapter-side shim swallows the cleanup-count return value and presents
 * a `void` signature for back-compat with the original Wave A4 callers.
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
    maxAgeMs?: number,
): void {
    utilCleanupOrphanTmpFiles(dir, baseName, maxAgeMs !== undefined ? { maxAgeMs } : undefined);
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
    maxAgeMs?: number,
): void {
    utilSweepContentDirOrphans(contentDir, maxAgeMs !== undefined ? { maxAgeMs } : undefined);
}
