/**
 * Wave B1-Amend — Kernel domain regression nets.
 *
 * Each test pins one Stage B Wave B1 architectural invariant. The tests
 * were written BEFORE the fixes landed (per v2 protocol per-finding
 * test-first gate); each was confirmed to FAIL on the pre-fix HEAD and
 * passes on the post-fix HEAD. The breadcrumb of "what FAILED before"
 * sits in the test description so a regression that re-introduces the
 * shape produces a self-explaining failure.
 *
 * Findings covered:
 *
 *  - KERNEL-B-005 — `cause.message` leak into `mutation_orphaned`
 *    ledger detail. The pre-fix `recordOrphanMutation` persisted the
 *    underlying error message verbatim. We now scrub through
 *    `redactErrorMessage`.
 *
 *  - KERNEL-B-006 — TraceBuilder baked entity identifiers into the
 *    `label` string field of every node. Even with policy-driven
 *    actor redaction, names / filenames leaked because the regex only
 *    caught `by <actor>`. We now store structured `labelData` and
 *    render labels at consumer boundary (`renderProvenanceLabel`) with
 *    policy-aware redaction.
 *
 *  - V2-004 follow-up (KERNEL-B-017) — `validateCommand` ran no shape
 *    probe on `payload.content`. A post-JSON-roundtrip `{type:'Buffer',
 *    data:[...]}` slipped past validate and reached the queue, opening
 *    the silent-corruption window Wave A4 closed at commit-time. We
 *    now reject the ambiguous shape at validate-time.
 *
 *  - AGG-005 — Redactor functions were a denylist (strip named
 *    fields; everything else surfaces). New domain fields added to
 *    `Entity` / `Artifact` / etc. would leak silently. We now
 *    `PRESERVED_FIELDS_X`-allowlist every type; unknown fields collapse
 *    to a `RedactedMarker(unknown_field)`.
 *
 *  - AGG-008 — Mixed-shape redaction (`'[REDACTED]'` string,
 *    `{_redacted: true}` object, empty string, bare deletion). We now
 *    use the structural `RedactedMarker` everywhere.
 */

import { describe, it, expect } from 'vitest';
import {
    mkdtempSync,
    rmSync,
    existsSync,
    readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import {
    redactArtifact,
    redactEntity,
    redactCommand,
    redactReceipt,
    redactProvenanceEvent,
    redactErrorMessage,
    PRESERVED_FIELDS_ARTIFACT,
    PRESERVED_FIELDS_ENTITY,
    PRESERVED_FIELDS_COMMAND,
    PRESERVED_FIELDS_RECEIPT,
    PRESERVED_FIELDS_PROVENANCE_EVENT,
    PRESERVED_FIELDS_INDEX_RECORD,
    redactIndexRecord,
} from '../src/policy/redactor.js';
import { renderProvenanceLabel } from '../src/provenance/trace-builder.js';
import { TraceBuilder } from '../src/provenance/trace-builder.js';
import { isRedactedMarker } from '../src/types/redaction.js';
import {
    InvalidContentShapeError,
} from '../src/kernel/errors.js';
import type { Artifact } from '../src/types/artifact.js';
import type { Entity } from '../src/types/entity.js';
import type { Command } from '../src/types/command.js';
import type { Receipt } from '../src/types/receipt.js';
import type { ProvenanceEvent } from '../src/types/provenance-event.js';
import type { IndexRecord } from '../src/types/index-record.js';
import type { RedactionRule } from '../src/types/policy.js';
import { validateCommand, proposeCommand } from '../src/kernel/commands.js';

function freshDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

describe('Wave B1-Amend — Kernel regression nets', () => {
    // ─── KERNEL-B-005 — cause.message scrub in mutation_orphaned detail ─────

    describe('KERNEL-B-005 — cause.message scrub in mutation_orphaned detail', () => {
        it('B1-KERNEL-005-a — redactErrorMessage scrubs Windows absolute paths', () => {
            const sensitive =
                'Failed to open C:\\Users\\sensitive\\path.json (ENOENT)';
            const scrubbed = redactErrorMessage(new Error(sensitive));
            expect(scrubbed).not.toContain('C:\\Users\\sensitive');
            expect(scrubbed).not.toContain('C:/Users/sensitive');
        });

        it('B1-KERNEL-005-b — redactErrorMessage scrubs POSIX absolute paths', () => {
            const sensitive = 'open /etc/passwd: not found';
            const scrubbed = redactErrorMessage(new Error(sensitive));
            expect(scrubbed).not.toContain('/etc/passwd');
        });

        it('B1-KERNEL-005-c — ReceiptFailedError cause.message in mutation_orphaned ledger event is scrubbed (full invariant)', async () => {
            // Probe the FULL invariant: trigger a receipt-failure path whose
            // cause carries a sensitive path; verify the persisted ledger
            // event does NOT leak the path through detail.error.
            const dir = freshDir('b1-kernel-005-c-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                // Stub appendReceipt to throw an error whose message embeds
                // a sensitive absolute path. The mutation already succeeded
                // (artifact store wrote), so the orphan-mutation arm fires
                // and persists the cause.message into the ledger.
                const sensitivePath = 'C:\\Users\\sensitive\\secret-token.json';
                const originalAppendReceipt = stores.ledger.appendReceipt.bind(stores.ledger);
                let throwOnce = true;
                stores.ledger.appendReceipt = async (...args) => {
                    if (throwOnce) {
                        throwOnce = false;
                        throw new Error(
                            `Failed to write receipt at ${sensitivePath}: EPERM`,
                        );
                    }
                    return originalAppendReceipt(...args);
                };

                const content = Buffer.from('payload');
                const contentHash = createHash('sha256').update(content).digest('hex');
                await expect(
                    kernel.ingestArtifact({
                        filename: 'doc.txt',
                        content,
                        mimeType: 'text/plain',
                        actorId: 'agent',
                    }),
                ).rejects.toThrow();
                void contentHash; // referenced for future debugging

                // Now look up the mutation_orphaned event. The persisted
                // detail.error MUST NOT contain the sensitive path.
                const events = await stores.ledger.listEvents({ action: 'mutation_orphaned' });
                expect(events.length).toBeGreaterThan(0);
                const orphan = events[0];
                const detailJson = JSON.stringify(orphan.detail ?? {});
                expect(detailJson).not.toContain('sensitive');
                expect(detailJson).not.toContain('C:\\Users\\sensitive');
                expect(detailJson).not.toContain('C:/Users/sensitive');
                // Verify the diagnostic shape is preserved (errorName still
                // there so operators can still triage)
                expect(orphan.detail?.errorName).toBe('Error');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ─── KERNEL-B-006 — TraceBuilder structured labelData ───────────────────

    describe('KERNEL-B-006 — TraceBuilder structured labelData (AGG-008 marker integration)', () => {
        it('B1-KERNEL-006-a — entity node carries structured labelData on metadata (policy-aware re-render shape)', async () => {
            const dir = freshDir('b1-kernel-006-a-');
            try {
                const stores = createLocalCluster(dir);
                const kernel = new ClusterKernel(stores, { dataDir: dir });

                const created = await kernel.createEntity({
                    kind: 'document',
                    name: 'Sensitive Project Name',
                    attributes: { topic: 'classified' },
                    actorId: 'agent',
                });

                const graph = await kernel.traceObject(`cluster://canonical/${created.entity.id}`);
                const entityNode = graph.nodes.find(
                    (n) => n.type === 'entity' && n.uri === `cluster://canonical/${created.entity.id}`,
                );
                expect(entityNode).toBeTruthy();

                // KERNEL-B-006 invariant: TraceBuilder STORES structured labelData
                // so policy-aware consumers (PolicyEnforcedKernel, MCP cluster_trace,
                // dashboard) can re-render labels with their own policy view.
                // Bare ClusterKernel is the trusted boundary's INSIDE — its
                // `node.label` carries the literal form. The downstream MCP /
                // dashboard / etc boundaries call `renderProvenanceLabel(
                // metadata.labelData, policyView)` to produce the policy-gated
                // display form.
                //
                // Both halves of the invariant:
                //   1. metadata.labelData is structurally present and well-typed
                expect(entityNode!.metadata).toBeTruthy();
                const labelData = (entityNode!.metadata as { labelData?: unknown }).labelData;
                expect(labelData).toBeTruthy();
                expect((labelData as { kind?: string }).kind).toBe('entity');
                expect((labelData as { name?: string }).name).toBe('Sensitive Project Name');
                expect((labelData as { kind_value?: string }).kind_value).toBe('document');
                //   2. renderProvenanceLabel produces a redacted form when policy denies entity_name
                const denyPolicy: RedactionRule[] = [
                    { id: 'deny-name', target: 'entity_name', behavior: 'strip', reason: 'test' },
                ];
                const rendered = renderProvenanceLabel(labelData as Parameters<typeof renderProvenanceLabel>[0], denyPolicy);
                expect(rendered).not.toContain('Sensitive Project Name');
                expect(rendered).toContain('[REDACTED]');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('B1-KERNEL-006-b — renderProvenanceLabel collapses to RedactedMarker form when policy denies entity_name', () => {
            const labelData = {
                kind: 'entity' as const,
                kind_value: 'document',
                name: 'Sensitive Project Name',
            };
            const denyPolicy: RedactionRule[] = [
                {
                    id: 'deny-entity-name',
                    target: 'entity_name',
                    behavior: 'strip',
                    reason: 'Test',
                },
            ];
            const rendered = renderProvenanceLabel(labelData, denyPolicy);
            // The rendered label MUST NOT carry the literal name and MUST
            // signal the redaction.
            expect(rendered).not.toContain('Sensitive Project Name');
            expect(rendered).toContain('[REDACTED]');
        });

        it('B1-KERNEL-006-c — renderProvenanceLabel renders policy-allowed labels normally', () => {
            const labelData = {
                kind: 'entity' as const,
                kind_value: 'document',
                name: 'Public Doc',
            };
            const rendered = renderProvenanceLabel(labelData, []);
            expect(rendered).toContain('document');
            expect(rendered).toContain('Public Doc');
        });
    });

    // ─── V2-004 follow-up — payload.content shape probe ─────────────────────

    describe('V2-004 follow-up — validateCommand probes payload.content shape', () => {
        it('B1-KERNEL-V2-004-a — ingest_artifact with post-roundtrip Buffer object shape is rejected at validate-time', () => {
            const cmd = proposeCommand(
                'ingest_artifact',
                'artifact',
                {
                    filename: 'evil.bin',
                    // The JSON-roundtrip artifact: not a Buffer, just looks like one.
                    content: { type: 'Buffer', data: [1, 2, 3] },
                    mimeType: 'application/octet-stream',
                },
                'agent',
            );
            expect(() => validateCommand(cmd)).toThrow(InvalidContentShapeError);
        });

        it('B1-KERNEL-V2-004-b — ingest_artifact with real Buffer content passes validate', () => {
            const cmd = proposeCommand(
                'ingest_artifact',
                'artifact',
                {
                    filename: 'doc.txt',
                    content: Buffer.from('real bytes'),
                    mimeType: 'text/plain',
                },
                'agent',
            );
            expect(() => validateCommand(cmd)).not.toThrow();
        });

        it('B1-KERNEL-V2-004-c — ingest_artifact with contentHash string content (post-stage form) passes validate', () => {
            const cmd = proposeCommand(
                'ingest_artifact',
                'artifact',
                {
                    filename: 'doc.txt',
                    content: 'a'.repeat(64), // looks like a hex hash
                    contentHash: 'a'.repeat(64),
                    mimeType: 'text/plain',
                },
                'agent',
            );
            expect(() => validateCommand(cmd)).not.toThrow();
        });
    });

    // ─── AGG-005 — allowlist contract on each redactor ──────────────────────

    describe('AGG-005 — redactor allowlist contract', () => {
        it('B1-AGG-005-a — PRESERVED_FIELDS_ARTIFACT enumerates the intentional fields', () => {
            // The allowlist is documented and intentional. The test exists so
            // a future contributor adding a new sensitive field to Artifact
            // sees a failing test until they decide whether the field belongs
            // on the allowlist.
            expect(PRESERVED_FIELDS_ARTIFACT).toEqual(
                expect.arrayContaining([
                    'id',
                    'filename',
                    'contentHash',
                    'mimeType',
                    'sizeBytes',
                    'version',
                    'storagePath',
                    'ingestedAt',
                    'owner',
                ]),
            );
        });

        it('B1-AGG-005-b — unknown fields on Artifact are stripped (replaced by RedactedMarker) on a redactor pass', () => {
            // Simulate a future Artifact extension carrying an unknown field
            // that didn't exist when the redactor was written.
            const art: Artifact & { newSensitiveField: string } = {
                id: 'art-1',
                filename: 'doc.txt',
                contentHash: 'abc',
                mimeType: 'text/plain',
                sizeBytes: 10,
                version: 1,
                storagePath: 'C:/store/art-1',
                ingestedAt: '2026-05-27T00:00:00Z',
                owner: 'artifact',
                newSensitiveField: 'LEAK ME',
            };
            const rules: RedactionRule[] = [
                {
                    id: 'r',
                    target: 'artifact_content',
                    behavior: 'strip',
                    reason: 't',
                },
            ];
            const result = redactArtifact(art, rules) as Artifact & {
                newSensitiveField?: unknown;
            };
            // The unknown field must NOT carry the literal value.
            expect(result.newSensitiveField).not.toBe('LEAK ME');
            // It SHOULD be either absent or carry a marker.
            if ('newSensitiveField' in result) {
                expect(isRedactedMarker(result.newSensitiveField)).toBe(true);
            }
        });

        it('B1-AGG-005-c — every redactor switch handles unknown behavior via default arm (no undefined return)', () => {
            // Build a rule with a behavior literal outside the union. TypeScript
            // would reject this at compile time, but runtime-loaded policies
            // bypass that gate (the whole point of AGG-005's defensive ask).
            const bogusRule = {
                id: 'r',
                target: 'artifact_content',
                behavior: 'NOT_A_REAL_BEHAVIOR' as any,
                reason: 't',
            } as RedactionRule;
            const art: Artifact = {
                id: 'art-1',
                filename: 'doc.txt',
                contentHash: 'abc',
                mimeType: 'text/plain',
                sizeBytes: 10,
                version: 1,
                storagePath: '/store/art',
                ingestedAt: '2026-05-27T00:00:00Z',
                owner: 'artifact',
            };
            const out = redactArtifact(art, [bogusRule]);
            // Must NOT be undefined. Default arm must return either the
            // safest-possible shape or throw a typed error.
            expect(out).toBeDefined();
            // It should NOT carry the storagePath if behavior is unknown
            // — fall back to the most defensive shape.
            if (typeof out.storagePath === 'string') {
                expect(out.storagePath).not.toBe('/store/art');
            }
        });

        it('B1-AGG-005-d — Entity, Command, Receipt, ProvenanceEvent, IndexRecord all have PRESERVED_FIELDS_X', () => {
            expect(PRESERVED_FIELDS_ENTITY.length).toBeGreaterThan(0);
            expect(PRESERVED_FIELDS_COMMAND.length).toBeGreaterThan(0);
            expect(PRESERVED_FIELDS_RECEIPT.length).toBeGreaterThan(0);
            expect(PRESERVED_FIELDS_PROVENANCE_EVENT.length).toBeGreaterThan(0);
            expect(PRESERVED_FIELDS_INDEX_RECORD.length).toBeGreaterThan(0);
        });

        it('B1-AGG-005-e — redactEntity strips unknown attribute extension fields', () => {
            const ent: Entity & { secretSidecar?: string } = {
                id: 'ent-1',
                kind: 'doc',
                name: 'name',
                attributes: { ok: 1 },
                createdAt: 't',
                updatedAt: 't',
                owner: 'canonical',
                secretSidecar: 'LEAK',
            };
            const rules: RedactionRule[] = [
                {
                    id: 'r',
                    target: 'entity_attributes',
                    behavior: 'strip',
                    reason: 't',
                },
            ];
            const out = redactEntity(ent, rules) as Entity & {
                secretSidecar?: unknown;
            };
            if ('secretSidecar' in out) {
                expect(isRedactedMarker(out.secretSidecar)).toBe(true);
            }
            // attributes still respects the rule
            expect(out.attributes).toEqual({});
        });

        it('B1-AGG-005-f — redactCommand strips unknown sidecar fields', () => {
            const cmd: Command & { sidecarSecret?: string } = {
                id: 'cmd-1',
                verb: 'create_entity',
                targetStore: 'canonical',
                payload: { kind: 'doc', name: 'x' },
                proposedAt: 't',
                proposedBy: 'u',
                status: 'proposed',
                sidecarSecret: 'LEAK',
            };
            const rules: RedactionRule[] = [
                {
                    id: 'r',
                    target: 'command_payload',
                    behavior: 'strip',
                    reason: 't',
                },
            ];
            const out = redactCommand(cmd, rules) as Command & {
                sidecarSecret?: unknown;
            };
            if ('sidecarSecret' in out) {
                expect(isRedactedMarker(out.sidecarSecret)).toBe(true);
            }
        });

        it('B1-AGG-005-g — redactReceipt strips unknown sidecar fields, preserves affectedIds shape per behavior', () => {
            const r: Receipt & { sidecar?: string } = {
                id: 'r-1',
                commandId: 'c-1',
                committedAt: 't',
                resultSummary: 'summary',
                affectedIds: ['a', 'b'],
                provenanceEventId: 'p-1',
                sidecar: 'LEAK',
            };
            const rules: RedactionRule[] = [
                {
                    id: 'r',
                    target: 'receipt_details',
                    behavior: 'strip',
                    reason: 't',
                },
            ];
            const out = redactReceipt(r, rules) as Receipt & {
                sidecar?: unknown;
            };
            if ('sidecar' in out) {
                expect(isRedactedMarker(out.sidecar)).toBe(true);
            }
        });

        it('B1-AGG-005-h — redactProvenanceEvent strips unknown sidecar fields', () => {
            const ev: ProvenanceEvent & { sidecar?: string } = {
                id: 'e-1',
                timestamp: 't',
                action: 'entity_created',
                actorId: 'u',
                subjectId: 's',
                subjectStore: 'canonical',
                detail: { x: 1 },
                owner: 'ledger',
                sidecar: 'LEAK',
            };
            const rules: RedactionRule[] = [
                {
                    id: 'r',
                    target: 'receipt_details',
                    behavior: 'strip',
                    reason: 't',
                },
            ];
            const out = redactProvenanceEvent(ev, rules) as ProvenanceEvent & {
                sidecar?: unknown;
            };
            if ('sidecar' in out) {
                expect(isRedactedMarker(out.sidecar)).toBe(true);
            }
            // detail still respects rule (cleared to empty by receipt_details rule)
            expect(out.detail).toEqual({});
        });

        it('B1-AGG-005-i — redactIndexRecord exists and applies allowlist contract', () => {
            const rec: IndexRecord & { secretSidecar?: string } = {
                id: 'idx-1',
                sourceId: 'src-1',
                sourceStore: 'canonical',
                text: 'text',
                metadata: { kind: 'doc' },
                indexedAt: 't',
                owner: 'index',
                secretSidecar: 'LEAK',
            };
            const rules: RedactionRule[] = [
                {
                    id: 'r',
                    target: 'index_source_uri',
                    behavior: 'strip',
                    reason: 't',
                },
            ];
            const out = redactIndexRecord(rec, rules) as IndexRecord & {
                secretSidecar?: unknown;
            };
            if ('secretSidecar' in out) {
                expect(isRedactedMarker(out.secretSidecar)).toBe(true);
            }
        });
    });

    // ─── AGG-008 — RedactedMarker shape stability ───────────────────────────

    describe('AGG-008 — RedactedMarker shape stability', () => {
        it('B1-AGG-008-a — isRedactedMarker accepts the canonical shape and rejects similar non-markers', () => {
            expect(isRedactedMarker({ _redacted: true, kind: 'string', reason: 'capability_denied' })).toBe(true);
            expect(isRedactedMarker({ _redacted: false })).toBe(false);
            expect(isRedactedMarker({})).toBe(false);
            expect(isRedactedMarker(null)).toBe(false);
            expect(isRedactedMarker('[REDACTED]')).toBe(false);
            expect(isRedactedMarker(undefined)).toBe(false);
        });

        it('B1-AGG-008-b — markers survive JSON round-trip unchanged (cross-domain stability)', () => {
            const original = {
                _redacted: true as const,
                kind: 'string' as const,
                reason: 'unknown_field' as const,
            };
            const roundtripped = JSON.parse(JSON.stringify(original));
            expect(isRedactedMarker(roundtripped)).toBe(true);
            expect(roundtripped.kind).toBe('string');
            expect(roundtripped.reason).toBe('unknown_field');
        });
    });
});
