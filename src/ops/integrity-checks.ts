/**
 * Integrity checks — SHARED tamper-detecting check bodies for the ops surfaces.
 *
 * Wave S2-A1 fix-up (Agent A). Single-source-of-truth discipline: the
 * artifact-content and ledger-chain integrity check bodies were originally
 * inlined inside `ops/verify.ts`. Finding (Defect 2) showed `ops/doctor.ts`
 * — the operator's first-line command — was NOT integrity-aware: it reported
 * `healthy` on a store that `verify()` calls `corrupt`. Rather than duplicate
 * the `sha256` / `computeIntegrityHash` / chain-walk logic into doctor (a second
 * copy is a future drift bug), the check bodies live here and BOTH `verify` and
 * `doctor` call them. Every emitted {@link HealthCheck} keeps the exact name,
 * status, severity, message shape, and remediation hints the pre-fix verify
 * code produced, so the pinned check-set contracts and existing consumers are
 * unchanged.
 *
 * Robustness-by-recomputation (load-bearing, inherited from verify): these
 * checks recompute hashes INDEPENDENTLY via the shared
 * {@link computeIntegrityHash} (src/types/integrity.ts) and `sha256` rather than
 * relying solely on the hardened adapter throwing on read. Both signals are
 * honoured — an adapter throw is treated as a non-healthy check too — but the
 * independent recompute means tampering is detected even on an adapter that has
 * not yet adopted verify-on-read. NEVER hand-roll the hash; the writer (adapter)
 * and these verifiers MUST route through the same `computeIntegrityHash`.
 */

import { createHash } from 'node:crypto';
import type { ClusterStores } from '../contracts/index.js';
import type { HealthCheck } from '../types/health.js';
import type { Command } from '../types/command.js';
import { computeIntegrityHash } from '../types/integrity.js';

/** Lowercase 64-char-hex sha256 of a buffer. */
export function sha256Hex(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
}

/** Minimal structural shape shared by Receipt + ProvenanceEvent for integrity. */
export interface IntegrityRecord {
    id: string;
    integrityHash?: string;
    prevHash?: string;
    [k: string]: unknown;
}

/**
 * Verify the tamper-evidence of an append-ordered list of ledger records.
 *
 * Two invariants per STAMPED record (records without an `integrityHash` come
 * from a pre-tamper-evidence ledger and are skipped so we never raise a false
 * alarm):
 *   1. `computeIntegrityHash(record)` === stored `integrityHash` (no field edit).
 *   2. Consecutive chaining holds for every ADJACENT stamped pair within the
 *      active file: `record.prevHash` === the prior stamped record's
 *      `integrityHash` (no reorder / insert / delete between two retained
 *      records).
 *
 * Defect 1 (Wave S2-A1 fix-up) — genesis rule RELAXED. The pre-fix code treated
 * the FIRST stamped record as genesis and flagged any non-`undefined` `prevHash`
 * as "a record was deleted/reordered ahead of it." That made `verify()` report
 * `ledger_integrity_chain = corrupt` on EVERY cluster that had run a normal,
 * SUPPORTED `rotate()`: after rotate archives the head, the first RETAINED
 * active record legitimately carries a `prevHash` pointing at an archived (now
 * absent) predecessor. We therefore NO LONGER require the first active record's
 * `prevHash` to be `undefined` — it may reference an archived predecessor. Only
 * the self-hash recompute and the adjacent-pair chaining (for i >= 1) are
 * enforced.
 *
 * KNOWN, TRACKED limitation: with this rule a deleted/truncated chain HEAD
 * (records removed from the FRONT of the active file without a persisted
 * chain-anchor) is NOT distinguishable from a legitimate rotation — both leave
 * a first active record whose `prevHash` references an absent predecessor.
 * Head-truncation detection requires a persisted chain anchor (the integrityHash
 * of the youngest archived record, written somewhere durable), which is deferred
 * to a follow-up. This is moot against the broader unkeyed-chain re-stamp
 * limitation disclosed separately: because the chain is unkeyed (anyone who can
 * write the ledger file can re-stamp a whole consistent chain), tamper-evidence
 * is a corruption/accident detector, not a cryptographic anti-tamper proof.
 * What REMAINS detected by this check: internal edits, reorders within the
 * active file, inserts/deletes between two retained records, and per-record hash
 * tampering.
 *
 * @param records  Records in append order (oldest first), per the contract.
 * @param kind     'event' | 'receipt' — used only for diagnostic messages.
 * @returns        Array of human-readable violation strings (empty == intact).
 */
export function checkIntegrityChain(records: IntegrityRecord[], kind: 'event' | 'receipt'): string[] {
    const issues: string[] = [];
    let prevStampedHash: string | undefined;
    let seenStamped = false;

    for (const record of records) {
        const stored = record.integrityHash;
        if (typeof stored !== 'string' || stored.length === 0) {
            // Un-stamped record — skip (pre-tamper-evidence ledger). Do NOT
            // advance the chain pointer; the chain is only defined over
            // stamped records.
            continue;
        }

        // (1) Self-hash: recompute and compare.
        const recomputed = computeIntegrityHash(record as unknown as Record<string, unknown>);
        if (recomputed !== stored) {
            issues.push(
                `${kind} ${record.id}: stored integrityHash does not match recomputed hash — ` +
                    `the record content was edited after it was written.`,
            );
            // Still advance the chain pointer using the STORED hash so that a
            // single edit doesn't cascade into spurious chain breaks for every
            // subsequent record (we report the edit once).
            prevStampedHash = stored;
            seenStamped = true;
            continue;
        }

        // (2) Chain link: prevHash must equal the prior stamped record's hash —
        // but ONLY for adjacent pairs WITHIN the active file (i >= 1). The FIRST
        // stamped record is NOT required to be genesis: after a legitimate
        // rotate() it carries a prevHash pointing at an archived predecessor.
        // See the Defect 1 note above for the tracked head-truncation limitation.
        if (seenStamped) {
            if (record.prevHash !== prevStampedHash) {
                issues.push(
                    `${kind} ${record.id}: prevHash does not match the preceding record's integrityHash — ` +
                        `the ledger was reordered, or a record was inserted/deleted.`,
                );
            }
        }

        prevStampedHash = stored;
        seenStamped = true;
    }

    return issues;
}

/**
 * (PROV-001 family) Artifact content integrity check body. Re-hash every
 * sampled artifact's on-disk bytes against its recorded `contentHash`. Two
 * independent signals, both honoured:
 *   1. `getContent(id)` THROWS (ContentReadIntegrityError /
 *      InvalidContentHashError / CorruptStoreError) — the hardened adapter
 *      caught the tamper; treat the throw as a corrupt check.
 *   2. The bytes come back but `sha256(bytes) !== contentHash` — caught
 *      independently (robust even on an adapter without verify-on-read).
 *
 * Returns the single {@link HealthCheck} the caller pushes verbatim — the name,
 * status, severity, message, and remediation hints match the pre-fix inlined
 * verify body exactly.
 *
 * @param stores  ClusterStores bundle.
 * @param limit   Max artifacts to sample (caller's existing sample limit).
 */
export async function checkArtifactContentIntegrity(
    stores: ClusterStores,
    limit: number,
): Promise<HealthCheck> {
    try {
        const artifacts = await stores.artifact.list({ limit });
        let tamperedCount = 0;
        let missingContentCount = 0;
        const firstFew: string[] = [];

        for (const artifact of artifacts) {
            try {
                const buf = await stores.artifact.getContent(artifact.id);
                if (buf === null) {
                    // Metadata exists but content is gone — a different kind of
                    // corruption (content moved/deleted out from under metadata).
                    missingContentCount++;
                    if (firstFew.length < 5) firstFew.push(artifact.id);
                    continue;
                }
                const actual = sha256Hex(buf);
                if (actual !== artifact.contentHash) {
                    tamperedCount++;
                    if (firstFew.length < 5) firstFew.push(artifact.id);
                }
            } catch (contentErr: any) {
                // A throw is the hardened-adapter tamper signal (PROV-001).
                tamperedCount++;
                if (firstFew.length < 5) {
                    firstFew.push(`${artifact.id} (${contentErr?.name ?? 'error'})`);
                }
            }
        }

        if (tamperedCount > 0) {
            return {
                name: 'artifact_content_integrity',
                store: 'artifact',
                status: 'corrupt',
                severity: 'error',
                message:
                    `${tamperedCount} artifact(s) have on-disk content that does not hash to their ` +
                    `recorded contentHash — the stored bytes were tampered with. Affected: ${firstFew.join(', ')}.`,
                repairAvailable: false,
                suggestedCommand: 'db-cluster restore <backup.json>',
                nextSteps: [
                    'The artifact content store has been altered out from under its metadata.',
                    'Run `db-cluster trace <artifactId>` for each affected id to inspect provenance.',
                    'Restore the affected content from a known-good backup (`db-cluster restore <backup.json>`).',
                    'Do NOT rebuild the index until content integrity is restored — a rebuild would index poisoned content.',
                ],
            };
        }
        if (missingContentCount > 0) {
            return {
                name: 'artifact_content_integrity',
                store: 'artifact',
                status: 'corrupt',
                severity: 'error',
                message:
                    `${missingContentCount} artifact(s) have metadata but missing content bytes ` +
                    `(content removed out from under metadata). Affected: ${firstFew.join(', ')}.`,
                repairAvailable: false,
                suggestedCommand: 'db-cluster restore <backup.json>',
                nextSteps: [
                    'The artifact metadata references content that is no longer on disk.',
                    'Restore the missing content from a known-good backup (`db-cluster restore <backup.json>`).',
                ],
            };
        }
        return {
            name: 'artifact_content_integrity',
            store: 'artifact',
            status: 'healthy',
            severity: 'info',
            message: `All ${artifacts.length} sampled artifact(s) hash to their recorded contentHash.`,
            repairAvailable: false,
        };
    } catch (err: any) {
        return {
            name: 'artifact_content_integrity',
            store: 'artifact',
            status: 'unreachable',
            severity: 'error',
            message: `Artifact content integrity verification failed: ${err.message}`,
            repairAvailable: false,
            nextSteps: [
                'Inspect the artifact content directory under the cluster data directory.',
                'Run `db-cluster doctor` to confirm artifact-store reachability.',
            ],
        };
    }
}

/**
 * (PROV-004) Ledger integrity + hash-chain check body. For receipts AND events:
 *   a) recompute `computeIntegrityHash(record)` and compare to stored
 *      `integrityHash` — a hand-edited field breaks this.
 *   b) walk the `prevHash` chain via {@link checkIntegrityChain} — a
 *      reorder/insert/delete between two retained records breaks this even when
 *      every record's own hash is internally consistent.
 * Pre-Agent-2 compatibility: if NO record carries an `integrityHash`, the chain
 * cannot be verified — report `unverified` (advisory) rather than a false alarm.
 *
 * A throw here is itself a tamper signal: the hardened getEvent/getReceipt
 * verify-on-read throws on a hash mismatch, and listEvents/listReceipts on a
 * corrupt file throws CorruptStoreError.
 *
 * Returns the single {@link HealthCheck} the caller pushes verbatim — name,
 * status, severity, message, and remediation hints match the pre-fix inlined
 * verify body exactly.
 */
export async function checkLedgerIntegrityChain(stores: ClusterStores): Promise<HealthCheck> {
    try {
        const events = await stores.ledger.listEvents({});
        const receipts = await stores.ledger.listReceipts({});

        const eventIssues = checkIntegrityChain(
            events as unknown as IntegrityRecord[],
            'event',
        );
        const receiptIssues = checkIntegrityChain(
            receipts as unknown as IntegrityRecord[],
            'receipt',
        );

        const totalRecords = events.length + receipts.length;
        const stampedRecords =
            events.filter((e) => typeof e.integrityHash === 'string' && e.integrityHash.length > 0).length +
            receipts.filter((r) => typeof r.integrityHash === 'string' && r.integrityHash.length > 0).length;

        const issues = [...eventIssues, ...receiptIssues];

        if (issues.length > 0) {
            return {
                name: 'ledger_integrity_chain',
                store: 'ledger',
                status: 'corrupt',
                severity: 'error',
                message:
                    `${issues.length} ledger integrity violation(s) detected: the tamper-evidence ` +
                    `hash or the prevHash chain does not hold. The append-only ledger has been ` +
                    `edited, reordered, or had records inserted/deleted.`,
                repairAvailable: false,
                suggestedCommand: 'db-cluster restore <backup.json>',
                details: issues.slice(0, 10).join('\n'),
                nextSteps: [
                    'The ledger is tamper-evident; a violation means on-disk records were altered.',
                    'Inspect the events.json / receipts.json files for hand edits or reordering.',
                    'Restore from a known-good backup (`db-cluster restore <backup.json>`) — the ledger is append-only and cannot be safely repaired in place.',
                ],
            };
        }
        if (totalRecords > 0 && stampedRecords === 0) {
            // No record carries an integrityHash yet — cannot verify. Advisory.
            return {
                name: 'ledger_integrity_chain',
                store: 'ledger',
                status: 'unverified',
                severity: 'info',
                message:
                    `Ledger tamper-evidence not verifiable: no record carries an integrityHash. ` +
                    `(This is expected only for ledgers written before tamper-evidence was enabled.)`,
                repairAvailable: false,
            };
        }
        return {
            name: 'ledger_integrity_chain',
            store: 'ledger',
            status: 'healthy',
            severity: 'info',
            message:
                `Ledger integrity intact: ${events.length} event(s) + ${receipts.length} receipt(s) ` +
                `hash correctly and form an unbroken prevHash chain.`,
            repairAvailable: false,
        };
    } catch (err: any) {
        return {
            name: 'ledger_integrity_chain',
            store: 'ledger',
            status: 'corrupt',
            severity: 'error',
            message: `Ledger integrity verification failed (tamper or corruption): ${err.message}`,
            repairAvailable: false,
            suggestedCommand: 'db-cluster restore <backup.json>',
            nextSteps: [
                'A verify-on-read integrity error or a corrupt ledger file was encountered.',
                'Inspect events.json / receipts.json for hand edits or truncation.',
                'Restore from a known-good backup (`db-cluster restore <backup.json>`).',
            ],
        };
    }
}

/**
 * (PROV-003) Command ↔ receipt bijection check body (BOTH directions). Every
 * committed command has exactly one receipt; every receipt's commandId resolves
 * to a committed command. REQUIRES the command-queue read API. The caller is
 * responsible for only invoking this when a queue handle is available — when it
 * is omitted the check is SKIPPED ENTIRELY (no entry pushed), preserving the
 * backward-compatible "verify(stores) emits only healthy checks" contract.
 *
 * Returns the single {@link HealthCheck} the caller pushes verbatim — name,
 * status, severity, and message shape match the pre-fix inlined verify body.
 *
 * @param stores        ClusterStores bundle (for listReceipts).
 * @param commandQueue  Read-only handle exposing `list(): Command[]`.
 */
export async function checkCommandReceiptBijection(
    stores: ClusterStores,
    commandQueue: { list(): Command[] },
): Promise<HealthCheck> {
    try {
        const receipts = await stores.ledger.listReceipts({});
        let commands: Command[] = [];
        try {
            commands = commandQueue.list();
        } catch (queueErr: any) {
            // A corrupt / persistence-lost command queue is itself a
            // non-healthy signal.
            throw new Error(`command queue unreadable: ${queueErr?.message ?? queueErr}`);
        }

        const committed = commands.filter(
            (c) => c.status === 'committed' || c.status === 'compensated',
        );
        const committedIds = new Set(committed.map((c) => c.id));

        // Count receipts per commandId.
        const receiptsByCommand = new Map<string, number>();
        for (const r of receipts) {
            receiptsByCommand.set(r.commandId, (receiptsByCommand.get(r.commandId) ?? 0) + 1);
        }

        // Direction A: every receipt's commandId resolves to a committed command.
        const orphanReceipts = receipts.filter((r) => !committedIds.has(r.commandId));

        // Direction B: every committed command has exactly one receipt.
        const receiptlessCommands = committed.filter(
            (c) => (receiptsByCommand.get(c.id) ?? 0) === 0,
        );
        const duplicatedCommands = committed.filter(
            (c) => (receiptsByCommand.get(c.id) ?? 0) > 1,
        );

        const problems: string[] = [];
        if (orphanReceipts.length > 0) {
            problems.push(
                `${orphanReceipts.length} orphan receipt(s) whose commandId resolves to no committed command ` +
                    `(e.g. ${orphanReceipts.slice(0, 3).map((r) => r.id).join(', ')})`,
            );
        }
        if (receiptlessCommands.length > 0) {
            problems.push(
                `${receiptlessCommands.length} committed command(s) with no receipt ` +
                    `(e.g. ${receiptlessCommands.slice(0, 3).map((c) => c.id).join(', ')})`,
            );
        }
        if (duplicatedCommands.length > 0) {
            problems.push(
                `${duplicatedCommands.length} committed command(s) with more than one receipt ` +
                    `(e.g. ${duplicatedCommands.slice(0, 3).map((c) => c.id).join(', ')})`,
            );
        }

        if (problems.length > 0) {
            return {
                name: 'command_receipt_bijection',
                store: 'ledger',
                status: 'corrupt',
                severity: 'error',
                message:
                    `Command↔receipt bijection broken: ${problems.join('; ')}. Every committed command ` +
                    `must have exactly one receipt and every receipt must resolve to a committed command.`,
                repairAvailable: false,
                suggestedCommand: 'db-cluster receipts --limit 200',
                nextSteps: [
                    'Run `db-cluster receipts --limit 200` to inspect the receipt set.',
                    'For an orphan receipt, run `db-cluster inspect-command <commandId>` — a missing command means the queue lost state or the receipt was forged.',
                    'For a receipt-less committed command, the post-mutation receipt write failed: check for a matching `mutation_orphaned` event and restore from a backup if needed.',
                ],
            };
        }
        return {
            name: 'command_receipt_bijection',
            store: 'ledger',
            status: 'healthy',
            severity: 'info',
            message:
                `Command↔receipt bijection intact: ${committed.length} committed command(s) each map to ` +
                `exactly one receipt and all ${receipts.length} receipt(s) resolve to a committed command.`,
            repairAvailable: false,
        };
    } catch (err: any) {
        return {
            name: 'command_receipt_bijection',
            store: 'ledger',
            status: 'corrupt',
            severity: 'error',
            message: `Command↔receipt bijection verification failed: ${err.message}`,
            repairAvailable: false,
            nextSteps: [
                'Inspect the command queue (`pending-commands.json`) and the ledger receipts file for corruption.',
            ],
        };
    }
}

// =====================================================================
// Cross-store reference checks — the signals that catch a SINGLE-STORE
// ledger head-truncation that the hash-chain check cannot.
//
// Wave S2-A1 follow-up (doctor/verify divergence hardening). These two
// checks were originally inlined inside `ops/verify.ts`; `ops/doctor.ts`
// shared the integrity-hash bodies above (Defect 2) but NOT these, leaving a
// real gap: a single-store head-truncation (e.g. the oldest events.json line
// deleted) does NOT trip `ledger_integrity_chain` — that check has a
// documented, accepted blind spot for head-truncation (the genesis-prevHash
// rule was relaxed in {@link checkIntegrityChain} so a legitimate `rotate()`
// does not false-positive). `verify()` still caught the truncation because it
// ALSO ran the cross-store checks below, which see the dangle the truncation
// leaves behind (a surviving record referencing a deleted one); `doctor()` ran
// neither and so gave a clean bill on a truncated ledger. Re-homing the bodies
// here lets BOTH ops surfaces run the IDENTICAL check — the same
// single-source-of-truth discipline that produced the integrity bodies above;
// a second copy is a future drift bug.
// =====================================================================

/**
 * Provenance events reference existing canonical/artifact subjects.
 *
 * KERNEL-R2-002 alignment: only canonical/artifact-subject events are checked.
 * Events with `subjectStore='ledger'` or `'index'` reference command / index
 * IDs by design — their reachability is not modelled by canonical/artifact
 * `exists()`. Checking them would false-flag every command_approved /
 * command_rejected / mutation_orphaned / command_compensated event as an orphan
 * (their subjectId is a command UUID never present in canonical or artifact).
 *
 * Catches a head-truncation whose deleted record was a canonical/artifact
 * mutation event still referenced by a SURVIVING event's subject — the
 * symmetric counterpart to {@link checkReceiptsProvenanceValid}.
 *
 * Returns the single {@link HealthCheck} the caller pushes verbatim — the name,
 * status, severity, message, and remediation hints match the pre-extraction
 * inlined verify() body exactly (the TESTS-B-016-pinned check-set contract and
 * existing consumers are unchanged).
 *
 * @param stores  ClusterStores bundle.
 * @param limit   Max events to sample (caller's existing sample limit).
 */
export async function checkProvenanceReferencesValid(
    stores: ClusterStores,
    limit: number,
): Promise<HealthCheck> {
    try {
        const events = await stores.ledger.listEvents({ limit });
        let orphanCount = 0;

        for (const event of events) {
            // Only canonical- and artifact-subject events are verifiable via
            // store.exists(). Ledger- and index-subject events reference
            // commandIds / indexIds whose reachability is not modelled by the
            // canonical/artifact stores.
            if (event.subjectStore !== 'canonical' && event.subjectStore !== 'artifact') {
                continue;
            }
            if (event.subjectId) {
                const inCanonical = await stores.canonical.exists(event.subjectId);
                const inArtifact = await stores.artifact.exists(event.subjectId);
                if (!inCanonical && !inArtifact) {
                    orphanCount++;
                }
            }
        }

        if (orphanCount > 0) {
            return {
                name: 'provenance_references_valid',
                store: 'ledger',
                status: 'stale',
                severity: 'warning',
                message: `${orphanCount} provenance event(s) reference objects not found in canonical/artifact stores.`,
                repairAvailable: false,
                // Wave C1-Amend fix-up (V1-C1-005): a producer with actionable
                // nextSteps also populates suggestedCommand so the doctor footer's
                // "Top fix" line can surface a concrete one-liner.
                suggestedCommand: 'db-cluster verify --json',
                nextSteps: [
                    'Run `db-cluster trace <subjectId>` for the affected subjects to inspect lineage.',
                    'Reconcile by either restoring the missing canonical/artifact records or removing the stale provenance events from the ledger.',
                ],
            };
        }
        return {
            name: 'provenance_references_valid',
            store: 'ledger',
            status: 'healthy',
            severity: 'info',
            message: 'All sampled provenance events reference existing objects.',
            repairAvailable: false,
        };
    } catch (err: any) {
        return {
            name: 'provenance_references_valid',
            store: 'ledger',
            status: 'unreachable',
            severity: 'error',
            message: `Provenance verification failed: ${err.message}`,
            repairAvailable: false,
            nextSteps: [
                'Inspect the ledger events.json file for corruption.',
            ],
        };
    }
}

/**
 * Receipts reference existing provenance events.
 *
 * This is THE check that turns an events-only head-truncation into a visible
 * signal: a surviving receipt's `provenanceEventId` no longer resolves
 * (`getEvent` returns `null` for the truncated event), so the cluster reports
 * `stale` even though {@link checkLedgerIntegrityChain} is blind to the
 * truncated chain head. See {@link checkProvenanceReferencesValid} for the
 * symmetric canonical/artifact-subject case.
 *
 * Verify-on-read interaction: `getEvent` recomputes the integrity hash and
 * THROWS a typed integrity error on a present-but-hand-edited event; that throw
 * is caught here and surfaced as `unreachable` (error). A TRUNCATED (absent)
 * event returns `null`, which is the `stale` path. Both are non-healthy.
 *
 * Returns the single {@link HealthCheck} the caller pushes verbatim — name,
 * status, severity, message, and remediation hints match the pre-extraction
 * inlined verify() body exactly.
 *
 * @param stores  ClusterStores bundle.
 * @param limit   Max receipts to sample (caller's existing sample limit).
 */
export async function checkReceiptsProvenanceValid(
    stores: ClusterStores,
    limit: number,
): Promise<HealthCheck> {
    try {
        const receipts = await stores.ledger.listReceipts({ limit });
        let missingEventCount = 0;

        for (const receipt of receipts) {
            if (receipt.provenanceEventId) {
                const event = await stores.ledger.getEvent(receipt.provenanceEventId);
                if (!event) {
                    missingEventCount++;
                }
            }
        }

        if (missingEventCount > 0) {
            return {
                name: 'receipts_provenance_valid',
                store: 'ledger',
                status: 'stale',
                severity: 'warning',
                message: `${missingEventCount} receipt(s) reference missing provenance events.`,
                repairAvailable: false,
                // Wave C1-Amend fix-up (V1-C1-005): suggestedCommand populated so
                // the doctor footer surfaces a concrete next command.
                suggestedCommand: 'db-cluster receipts',
                nextSteps: [
                    'Run `db-cluster receipts` to inspect the affected receipts.',
                    'Run `db-cluster trace <eventId>` for the missing provenance events to find the lineage gap.',
                ],
            };
        }
        return {
            name: 'receipts_provenance_valid',
            store: 'ledger',
            status: 'healthy',
            severity: 'info',
            message: 'All sampled receipts reference existing provenance events.',
            repairAvailable: false,
        };
    } catch (err: any) {
        return {
            name: 'receipts_provenance_valid',
            store: 'ledger',
            status: 'unreachable',
            severity: 'error',
            message: `Receipt verification failed: ${err.message}`,
            repairAvailable: false,
            nextSteps: [
                'Inspect the ledger receipts.json file for corruption.',
            ],
        };
    }
}
