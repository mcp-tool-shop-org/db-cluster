/**
 * Verify — proves cluster invariants hold.
 * Unlike doctor (reachability/health), verify checks data consistency.
 *
 * Wave S2-A1 (Protocol-v2 amend, finding PROV-003): the pre-amend checks were
 * existence-only — they confirmed that referenced ids RESOLVED but never that
 * the resolved bytes/records were UNTAMPERED. A cluster whose artifact blob had
 * been swapped on disk, or whose ledger receipt had been hand-edited, or whose
 * canonical version chain had a hole, still reported `healthy`. This wave adds
 * four tamper-detecting checks ON TOP of the existing structure (the
 * `ClusterHealth` output shape + severity model are unchanged; existing
 * consumers/tests depend on it):
 *
 *   - `artifact_content_integrity` — re-hash every artifact's on-disk bytes
 *     against its `contentHash` (PROV-001 family). A tampered blob → error.
 *   - `ledger_integrity_chain` — recompute `computeIntegrityHash` on every
 *     receipt + event and walk the `prevHash` hash-chain end-to-end (PROV-004).
 *     A hand-edited record or a reordered/inserted/deleted record → error.
 *   - `command_receipt_bijection` — every committed command has exactly one
 *     receipt and every receipt's `commandId` resolves to a committed command
 *     (requires the command-queue read API; see {@link VerifyOptions.commandQueue}).
 *   - `canonical_lineage_intact` — a versioned entity whose version chain has a
 *     gap, or an `update_entity` `mutation_committed` event missing its
 *     `previous` detail → error.
 *
 * Robustness-by-recomputation (load-bearing): the integrity checks recompute
 * hashes INDEPENDENTLY via the shared `src/types/integrity.ts` helper and
 * `sha256` rather than relying solely on the hardened adapter throwing on read.
 * Both signals are honoured — an adapter throw is treated as a non-healthy
 * check too — but the independent recompute means verify detects tampering even
 * on an adapter that has not yet adopted verify-on-read. NEVER hand-roll the
 * hash; the writer (adapter) and this verifier MUST route through the same
 * `computeIntegrityHash` so the bytes that go in match the bytes that come out.
 */

import type { ClusterStores } from '../contracts/index.js';
import type { HealthCheck } from '../types/health.js';
import { buildClusterHealth } from './health.js';
import type { ClusterHealth } from '../types/health.js';
import type { Command } from '../types/command.js';
import {
    checkArtifactContentIntegrity,
    checkLedgerIntegrityChain,
    checkCommandReceiptBijection,
    checkProvenanceReferencesValid,
    checkReceiptsProvenanceValid,
} from './integrity-checks.js';

export interface VerifyOptions {
    /** Max records to sample per store (default: 100) */
    sampleLimit?: number;
    /**
     * Command-queue read handle (Wave S2-A1, PROV-003). When supplied, verify
     * runs the BOTH-DIRECTIONS command↔receipt bijection check: every committed
     * command must have exactly one receipt, and every receipt's `commandId`
     * must resolve to a committed command. The handle exposes only `list()`
     * (read-only consumption of the kernel's `CommandQueue`) — verify never
     * mutates the queue.
     *
     * Mirrors {@link import('./doctor.js').DoctorOptions.commandQueue}. Most
     * callers pass `new CommandQueue(dataDir)` (or the kernel, which wraps one).
     *
     * Optional — when omitted the bijection check is skipped and reported as
     * `unverified` (advisory, not an error) so callers that cannot supply the
     * queue still get a stable check entry without a false alarm. The
     * orphan-receipt direction is therefore only enforceable WITH a queue; the
     * structured note explains this.
     */
    commandQueue?: { list(): Command[] };
    /**
     * Progress callback (STORES-C-002). Fired between major verify steps.
     * `total` is the count of major checks.
     *
     * Optional — operators running `verify` against large clusters subscribe
     * to render a progress bar via the CLI.
     */
    onProgress?: (current: number, total: number, message?: string) => void;
}

/**
 * Run cluster-invariant verification — proves canonical/artifact/index/ledger
 * consistency rather than reachability. Read-only; never mutates cluster
 * state. Every check carrying `repairAvailable: true` ALSO carries
 * {@link HealthCheck.suggestedCommand} so operator-facing surfaces can render
 * `→ fix: ${cmd}` without conditional branching.
 *
 * Checks performed (in order):
 *   1. Index records resolve to owner truth — flag corrupt/stale index.
 *   2. Provenance events reference existing canonical/artifact subjects.
 *   3. Orphaned mutations — surfaces `mutation_orphaned` ledger events.
 *   4. Receipts reference existing provenance events.
 *   5. Artifact content integrity — re-hash on-disk bytes vs contentHash (PROV-001).
 *   6. Ledger integrity + chain — recompute integrityHash + walk prevHash (PROV-004).
 *   7. Command↔receipt bijection — both directions (PROV-003; needs commandQueue).
 *   8. Canonical lineage intact — version-chain gaps + missing `previous` detail.
 *
 * @param stores  ClusterStores bundle. Verify reads from each store via
 *                its public contract methods (search, list, exists, get,
 *                getContent, listVersions).
 * @param options Verify-specific knobs. See {@link VerifyOptions}.
 * @returns       A {@link ClusterHealth} summarizing all checks.
 * @throws        Verify itself does not throw. Adapter-level exceptions are
 *                caught and surfaced as `unreachable`/`corrupt` checks.
 *
 * @example
 *   const health = await verify(stores, { sampleLimit: 500, commandQueue: cq });
 *   if (health.status !== 'healthy') {
 *       for (const check of health.checks) {
 *           if (check.status !== 'healthy') console.error(check.message);
 *           if (check.suggestedCommand) console.error(`  → fix: ${check.suggestedCommand}`);
 *       }
 *   }
 */
export async function verify(stores: ClusterStores, options?: VerifyOptions): Promise<ClusterHealth> {
    const limit = options?.sampleLimit ?? 100;
    const checks: HealthCheck[] = [];
    const onProgress = options?.onProgress;
    // 4 legacy checks + 4 new integrity checks (PROV-003).
    const totalSteps = 8;
    let step = 0;
    const tick = (label: string) => {
        step++;
        try {
            onProgress?.(step, totalSteps, label);
        } catch {
            // Best-effort.
        }
    };

    // --- Index records resolve to owner truth ---
    tick('index_references_valid');
    try {
        const records = await stores.index.search({ limit });
        let staleCount = 0;
        let missingCount = 0;

        for (const record of records) {
            if (record.sourceStore === 'canonical') {
                const exists = await stores.canonical.exists(record.sourceId);
                if (!exists) {
                    missingCount++;
                }
            } else if (record.sourceStore === 'artifact') {
                const exists = await stores.artifact.exists(record.sourceId);
                if (!exists) {
                    missingCount++;
                }
            }
        }

        // Check staleness for canonical entities
        const entities = await stores.canonical.list({ limit });
        for (const entity of entities) {
            const expectedText = `${entity.kind}: ${entity.name}`;
            const indexResults = await stores.index.search({ text: expectedText, limit: 1 });
            const match = indexResults.find((r) => r.sourceId === entity.id);
            if (!match) {
                staleCount++;
            }
        }

        if (missingCount > 0) {
            checks.push({
                name: 'index_references_valid',
                store: 'index',
                status: 'corrupt',
                severity: 'error',
                message: `${missingCount} index record(s) reference non-existent source objects.`,
                repairAvailable: true,
                suggestedCommand: 'db-cluster rebuild index',
                nextSteps: [
                    'Run `db-cluster rebuild index --dry-run` to inspect the rebuild plan.',
                    'Then run `db-cluster rebuild index` to reconstruct the index from owner truth.',
                    'Run `db-cluster verify` again after rebuild to confirm the count drops to zero.',
                ],
            });
        } else if (staleCount > 0) {
            checks.push({
                name: 'index_references_valid',
                store: 'index',
                status: 'stale',
                severity: 'warning',
                message: `${staleCount} entity/artifact(s) not found in index. Index may need rebuild.`,
                repairAvailable: true,
                suggestedCommand: 'db-cluster rebuild index',
                nextSteps: [
                    'Run `db-cluster rebuild index --dry-run` to inspect the rebuild plan.',
                    'Then run `db-cluster rebuild index` to bring the index back in sync with owner truth.',
                ],
            });
        } else {
            checks.push({
                name: 'index_references_valid',
                store: 'index',
                status: 'healthy',
                severity: 'info',
                message: `All sampled index records resolve to existing source objects.`,
                repairAvailable: false,
            });
        }
    } catch (err: any) {
        checks.push({
            name: 'index_references_valid',
            store: 'index',
            status: 'unreachable',
            severity: 'error',
            message: `Index verification failed: ${err.message}`,
            repairAvailable: false,
            nextSteps: [
                'Inspect the index file under the cluster data directory.',
                'Run `db-cluster doctor` to confirm store reachability.',
            ],
        });
    }

    // --- Provenance events reference existing objects ---
    // SHARED with doctor() via checkProvenanceReferencesValid
    // (src/ops/integrity-checks.ts) — single source of truth so the two ops
    // surfaces cannot drift. See that helper's doc for the KERNEL-R2-002
    // alignment (only canonical/artifact-subject events are checked) and its
    // role, alongside receipts_provenance_valid, in catching a single-store
    // ledger head-truncation that ledger_integrity_chain is blind to.
    tick('provenance_references_valid');
    checks.push(await checkProvenanceReferencesValid(stores, limit));

    // --- No orphaned mutations (STORES-R2-003) ---
    // Wave A2 added mutation_orphaned events on receipt failure (KERNEL-R009)
    // but verify()/doctor() had no consumer for that signal. A cluster with
    // orphaned mutations reported healthy. This check surfaces the orphans.
    //
    // STORES-B-014: pre-fix this used the `limit` option (default 100) to
    // bound listEvents AND to derive the orphan count via
    // `orphanedEvents.length`. The cap silently truncated the headline
    // number; ops dashboards reported "100 orphaned" even at 500. Post-fix
    // we use `countEvents` for the true number and only sample for the
    // (unused-today, but bounded) display set.
    //
    // STORES-C-001 (Stage C Wave C1-Audit): pre-fix this check produced
    // `repairAvailable: false` AND no suggestedCommand AND no nextSteps.
    // Post-fix it carries both.
    tick('no_orphaned_mutations');
    try {
        const orphanCount = await stores.ledger.countEvents({
            action: 'mutation_orphaned',
        });
        // Keep the sample-fetch bounded so callers that override `limit`
        // still control memory pressure during verify().
        await stores.ledger.listEvents({
            action: 'mutation_orphaned',
            limit,
        });

        if (orphanCount > 0) {
            const capped = orphanCount > limit;
            const suffix = capped ? ` (showing first ${limit})` : '';
            checks.push({
                name: 'no_orphaned_mutations',
                store: 'ledger',
                status: 'degraded',
                severity: 'warning',
                message: `${orphanCount} orphaned mutation event(s) recorded${suffix}. A mutation completed against a store but its receipt write failed — the cluster has uninspectable state.`,
                repairAvailable: false,
                suggestedCommand: 'db-cluster verify',
                nextSteps: [
                    'For each orphan, run `db-cluster trace <subjectId>` to inspect the lineage.',
                    'Run `db-cluster receipts --limit 200` to confirm whether matching receipts are present or missing.',
                    'If receipts are missing, inspect logs around the original `mutation_orphaned` event timestamps to find the cause.',
                    'Restore from a backup taken before the mutation_orphaned event timestamps if the orphan state is unrecoverable.',
                ],
            });
        } else {
            checks.push({
                name: 'no_orphaned_mutations',
                store: 'ledger',
                status: 'healthy',
                severity: 'info',
                message: 'No orphaned mutation events recorded.',
                repairAvailable: false,
            });
        }
    } catch (err: any) {
        checks.push({
            name: 'no_orphaned_mutations',
            store: 'ledger',
            status: 'unreachable',
            severity: 'error',
            message: `Orphan verification failed: ${err.message}`,
            repairAvailable: false,
            nextSteps: [
                'Inspect the ledger events.json file for corruption.',
                'Run `db-cluster doctor` to confirm ledger reachability.',
            ],
        });
    }

    // --- Receipts reference existing provenance events ---
    // SHARED with doctor() via checkReceiptsProvenanceValid
    // (src/ops/integrity-checks.ts). This is THE check that turns an
    // events-only head-truncation into a visible `stale` signal — a surviving
    // receipt's provenanceEventId no longer resolves — even though
    // ledger_integrity_chain (relaxed-genesis) is blind to the truncated head.
    tick('receipts_provenance_valid');
    checks.push(await checkReceiptsProvenanceValid(stores, limit));

    // =====================================================================
    // Wave S2-A1 (PROV-003) — tamper-detecting checks. These prove the bytes
    // are intact, not merely that ids resolve. ADDED on top of the structure
    // above; the existing check names/shape are unchanged.
    // =====================================================================

    // --- (5) Artifact content integrity (PROV-001 family) ---
    // Re-hash every sampled artifact's on-disk bytes against its recorded
    // contentHash. SHARED with doctor() via checkArtifactContentIntegrity
    // (src/ops/integrity-checks.ts) — single source of truth for the sha256
    // recompute + the two-signal (throw OR mismatch) tamper detection.
    tick('artifact_content_integrity');
    checks.push(await checkArtifactContentIntegrity(stores, limit));

    // --- (6) Ledger integrity + hash-chain (PROV-004) ---
    // SHARED with doctor() via checkLedgerIntegrityChain
    // (src/ops/integrity-checks.ts): recompute computeIntegrityHash on every
    // record + walk the prevHash chain for adjacent pairs within the active
    // file. Defect 1 (Wave S2-A1 fix-up) relaxed the genesis rule there so a
    // legitimate rotate() — whose first retained record points at an archived
    // predecessor — no longer false-flags as corrupt; see that helper's doc.
    tick('ledger_integrity_chain');
    checks.push(await checkLedgerIntegrityChain(stores));

    // --- (7) Command ↔ receipt bijection (BOTH directions, PROV-003) ---
    // Every committed command has exactly one receipt; every receipt's
    // commandId resolves to a committed command. Requires the command-queue
    // read API (VerifyOptions.commandQueue).
    //
    // When no queue handle is supplied this check is SKIPPED ENTIRELY (no
    // entry pushed) rather than emitted as `unverified`. Two reasons:
    //   1. Backward compatibility — existing callers/tests that invoke
    //      `verify(stores)` without a queue assert that every emitted check is
    //      `healthy`; injecting an `unverified` entry would false-trip them.
    //   2. The bijection is genuinely unverifiable without the committed-command
    //      set — emitting a non-actionable advisory adds noise. Callers that
    //      want the guarantee pass `{ commandQueue }` (the CLI/SDK wire a
    //      `new CommandQueue(dataDir)`; see VerifyOptions.commandQueue).
    // SHARED with doctor() via checkCommandReceiptBijection
    // (src/ops/integrity-checks.ts). Emitted ONLY when a commandQueue handle is
    // supplied; without one the check is skipped ENTIRELY (no entry pushed) so
    // callers/tests invoking verify(stores) still see only healthy checks and
    // the pinned check-set contract (7 checks, no bijection) holds.
    tick('command_receipt_bijection');
    if (options?.commandQueue) {
        checks.push(await checkCommandReceiptBijection(stores, options.commandQueue));
    }

    // --- (8) Canonical lineage intact (version-chain gaps + missing `previous`) ---
    // Two lineage failures:
    //   a) A versioned entity whose version chain has a hole — listVersions(id)
    //      returns versions that are not a contiguous 1..N run (a version was
    //      dropped / deleted on disk).
    //   b) An `update_entity` `mutation_committed` event whose detail lacks a
    //      `previous` key — the mutation did not capture the displaced prior
    //      version (forward-looking: becomes meaningful once the commit arm
    //      stamps `previous`; until then it never false-flags because absence
    //      of the key on EVERY update event is reported as advisory-only).
    tick('canonical_lineage_intact');
    try {
        let versionGapCount = 0;
        const gapDetails: string[] = [];

        // (a) Version-chain gaps. `listVersions` is capability-guarded so an
        // adapter that has not yet adopted versioning is reported as unverified
        // rather than crashing.
        const hasListVersions = typeof (stores.canonical as any).listVersions === 'function';
        if (hasListVersions) {
            const entities = await stores.canonical.list({ limit });
            const seenIds = new Set<string>();
            for (const entity of entities) {
                if (seenIds.has(entity.id)) continue;
                seenIds.add(entity.id);
                const versions = await stores.canonical.listVersions(entity.id);
                if (versions.length === 0) continue;
                const nums = versions
                    .map((v) => v.version)
                    .filter((n) => typeof n === 'number')
                    .sort((a, b) => a - b);
                if (nums.length === 0) continue;
                const maxVersion = nums[nums.length - 1];
                // Expect a contiguous 1..maxVersion run with no duplicates and
                // no holes.
                const expected = new Set<number>();
                for (let v = 1; v <= maxVersion; v++) expected.add(v);
                const present = new Set(nums);
                const missing: number[] = [];
                for (const v of expected) {
                    if (!present.has(v)) missing.push(v);
                }
                if (missing.length > 0 || present.size !== expected.size) {
                    versionGapCount++;
                    if (gapDetails.length < 5) {
                        gapDetails.push(
                            `entity ${entity.id}: have versions [${nums.join(',')}], expected 1..${maxVersion}` +
                                (missing.length ? ` (missing ${missing.join(',')})` : ''),
                        );
                    }
                }
            }
        }

        // (b) update_entity mutation_committed events missing the `previous`
        // detail. Forward-looking: only flag when SOME update events carry
        // `previous` and others don't (a partial regression). When NO update
        // event carries `previous` (pre-PROV-002 kernel), stay advisory.
        const events = await stores.ledger.listEvents({ action: 'mutation_committed', limit });
        const updateEvents = events.filter((e) => {
            const verb = (e.detail as { verb?: unknown })?.verb;
            return verb === 'update_entity';
        });
        const updateWithPrevious = updateEvents.filter(
            (e) => (e.detail as { previous?: unknown })?.previous !== undefined,
        );
        const updateMissingPrevious = updateEvents.filter(
            (e) => (e.detail as { previous?: unknown })?.previous === undefined,
        );
        // A regression is when at least one update event DID capture `previous`
        // but others did not — that is a genuine lineage gap, not a pre-feature
        // ledger.
        const previousRegression =
            updateWithPrevious.length > 0 && updateMissingPrevious.length > 0;

        if (versionGapCount > 0 || previousRegression) {
            const parts: string[] = [];
            if (versionGapCount > 0) {
                parts.push(`${versionGapCount} entity version-chain gap(s): ${gapDetails.join('; ')}`);
            }
            if (previousRegression) {
                parts.push(
                    `${updateMissingPrevious.length} update_entity mutation_committed event(s) missing the ` +
                        `\`previous\` lineage detail`,
                );
            }
            checks.push({
                name: 'canonical_lineage_intact',
                store: 'canonical',
                status: 'corrupt',
                severity: 'error',
                message: `Canonical lineage broken: ${parts.join('; ')}.`,
                repairAvailable: false,
                suggestedCommand: 'db-cluster restore <backup.json>',
                nextSteps: [
                    'A versioned entity is missing an intermediate version, or an update did not capture its displaced prior version.',
                    'Run `db-cluster trace <entityId>` to inspect the entity lineage.',
                    'Restore from a known-good backup (`db-cluster restore <backup.json>`) — prior versions are immutable and cannot be reconstructed in place.',
                ],
            });
        } else if (!hasListVersions) {
            checks.push({
                name: 'canonical_lineage_intact',
                store: 'canonical',
                status: 'unverified',
                severity: 'info',
                message:
                    'Canonical version lineage not verifiable: the canonical adapter does not expose listVersions(). ' +
                    'Version-chain gap detection is skipped.',
                repairAvailable: false,
            });
        } else {
            checks.push({
                name: 'canonical_lineage_intact',
                store: 'canonical',
                status: 'healthy',
                severity: 'info',
                message: 'Canonical version chains are contiguous and update lineage is intact.',
                repairAvailable: false,
            });
        }
    } catch (err: any) {
        checks.push({
            name: 'canonical_lineage_intact',
            store: 'canonical',
            status: 'unreachable',
            severity: 'error',
            message: `Canonical lineage verification failed: ${err.message}`,
            repairAvailable: false,
            nextSteps: [
                'Inspect the canonical entities.json file for corruption.',
                'Run `db-cluster doctor` to confirm canonical-store reachability.',
            ],
        });
    }

    return buildClusterHealth(checks);
}
