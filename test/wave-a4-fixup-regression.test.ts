/**
 * Wave A4 fix-up — regression nets for the 6 items closed by the coordinator
 * fix-up phase after the 5 parallel fix agents + 3-lens verifier ensemble.
 *
 * Each test probes a FULL invariant — must FAIL against the pre-fix code on
 * HEAD and PASS after the corresponding fix lands.
 *
 * Items closed:
 *  1. V1-A4-001 — 5 shipped examples missing contentHash in propose payload.
 *     ContentHashMismatchError at first run. Source-level sentinel: each
 *     example file imports createHash AND its ingest_artifact propose call
 *     carries a contentHash field.
 *
 *  2. V1-A4-002 — restore() ImportConflictError was unreachable. The
 *     STORES-B-003 byte-equivalence gate inside the adapter import* methods
 *     was bypassed end-to-end because restore() short-circuited on exists()
 *     BEFORE calling importSnapshot/importEvent/importReceipt. A tampered
 *     backup with the same id but altered fields silently masked. Fix calls
 *     assertContentMatch when exists(id) returns true and surfaces the
 *     mismatch via the surrounding try/catch into result.<store>.errors[].
 *
 *  3. AGG-A4-1 — redactError BUILTIN_ERROR_CODES missed adapter-tier typed
 *     errors. They extend plain Error (not ClusterError) because of the
 *     no-back-edge rule and thus collapsed into INTERNAL_ERROR at the MCP
 *     boundary. Fix maps their class names to stable codes.
 *
 *  4. AGG-A4-2 — kernel staging tmp suffix + sweep. Pre-fix produced
 *     `<hash>.<pid>-<16-hex>.tmp` tmp files in pending-content but the
 *     orphan-sweep regex only matches `[a-z0-9]{1,6}` — orphan files were
 *     unreachable AND no sweep was wired. Fix shrinks suffix to 6 hex chars
 *     AND wires a one-shot sweep on first getStagingDir() call.
 *
 *  5. AGG-A4-3 — CommandQueue.persist used fixed `${this.filePath}.tmp`,
 *     race-corruptible across concurrent CLI invocations. Fix uses a random
 *     suffix tmp path AND sweeps orphans at constructor time.
 *
 *  6. AGG-A4-3 (sibling) — cluster_trace + cluster_why MCP arms spread the
 *     trace graph raw, surfacing identifying content via node.label /
 *     node.metadata / edge.reason. Sibling of SURFACE-B-001 (find_sources
 *     LIST arm) closed in Wave A4 fix-1. Fix wraps both arms with
 *     sanitizeProvenanceGraphForOutput.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
    mkdtempSync,
    rmSync,
    existsSync,
    readdirSync,
    writeFileSync,
    readFileSync,
    utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { CommandQueue } from '../src/kernel/command-queue.js';
import { backup, restore } from '../src/ops/backup.js';
import { handleTool } from '../src/mcp/server.js';
import { redactError } from '../src/mcp/sanitize.js';
import {
    CorruptStoreError,
    InvalidContentHashError,
    ImportConflictError,
    LedgerCycleDetectedError,
} from '../src/adapters/local/errors.js';
import { ImportSnapshotNotSupportedError } from '../src/ops/errors.js';
import { ResolveError } from '../src/resolver/cluster-resolver.js';
import { ClusterUriError } from '../src/uri/cluster-uri.js';

const ROOT = resolve(import.meta.dirname, '..');
const EXAMPLES_DIR = join(ROOT, 'examples');

// ─── Item 1 — V1-A4-001: shipped examples carry contentHash ─────────────────

describe('Wave A4 fix-up Item 1 — shipped examples use contentHash', () => {
    const exampleFiles = [
        join(EXAMPLES_DIR, 'sdk', 'retrieval-bundle.ts'),
        join(EXAMPLES_DIR, 'sdk', 'local-cluster.ts'),
        join(EXAMPLES_DIR, 'research-evidence-cluster', 'index.ts'),
        join(EXAMPLES_DIR, 'agent-safe-app-db', 'index.ts'),
        join(EXAMPLES_DIR, 'project-memory-cluster', 'index.ts'),
    ];

    for (const file of exampleFiles) {
        it(`${file.replace(ROOT, '.')} imports createHash and propose carries contentHash`, () => {
            const src = readFileSync(file, 'utf-8');
            // Sentinel 1: createHash import is present (node:crypto OR alias).
            expect(/createHash\s*\}\s*from\s+['"]node:crypto['"]/.test(src) ||
                /from\s+['"]node:crypto['"]\s*;?\s*\n[^;]*createHash/.test(src) ||
                src.includes("import { createHash } from 'node:crypto'") ||
                src.includes('import { createHash } from "node:crypto"')).toBe(true);
            // Sentinel 2: the file contains an ingest_artifact propose call.
            expect(src).toContain("verb: 'ingest_artifact'");
            // Sentinel 3: the propose payload contains contentHash (the gate
            // we are guarding — pre-fix the payloads had no contentHash and
            // the kernel propose arm throws ContentHashMismatchError).
            expect(src).toContain('contentHash');
            // Sentinel 4: contentHash is computed from a Buffer with sha256.
            // Either an inline createHash(...).update(buf).digest('hex') or
            // assignment of that chain to a variable.
            const computesHash = /createHash\s*\(\s*['"]sha256['"]\s*\)\s*\.\s*update\s*\([^)]*\)\s*\.\s*digest\s*\(\s*['"]hex['"]\s*\)/.test(src);
            expect(computesHash).toBe(true);
        });
    }
});

// ─── Item 2 — V1-A4-002: restore() surfaces ImportConflictError ─────────────

describe('Wave A4 fix-up Item 2 — restore() surfaces ImportConflictError on tampered backup', () => {
    it('entity arm: tampered backup with matching id but altered name fails into result.entities.errors[]', async () => {
        // Seed source cluster with an entity.
        const sourceDir = mkdtempSync(join(tmpdir(), 'wave-a4-fixup-src-'));
        const sourceStores = createLocalCluster(sourceDir);
        const sourceKernel = new ClusterKernel(sourceStores, { dataDir: sourceDir });
        const { entity } = await sourceKernel.createEntity({
            kind: 'document',
            name: 'OriginalEntityName',
            attributes: { secret: 'original-value' },
            actorId: 'admin',
        });

        // Backup, then tamper the backup's entity name + attribute.
        const data = await backup(sourceStores);
        const tamperedData = JSON.parse(JSON.stringify(data));
        const tamperedEntity = tamperedData.entities.find((e: any) => e.id === entity.id);
        expect(tamperedEntity).toBeTruthy();
        tamperedEntity.name = 'TamperedEntityName';
        tamperedEntity.attributes = { secret: 'tampered-value' };

        // Pre-create the SAME entity (unmodified) in a fresh target cluster so
        // exists(id) returns true on restore — this is the path that pre-fix
        // would silently skip without checking byte-equivalence.
        const targetDir = mkdtempSync(join(tmpdir(), 'wave-a4-fixup-tgt-'));
        const targetStores = createLocalCluster(targetDir);
        await restore(targetStores, data); // first restore: clean

        // Second restore with the tampered backup must surface the conflict.
        const result = await restore(targetStores, tamperedData);
        expect(result.entities.errors.length).toBeGreaterThan(0);
        const errorMatch = result.entities.errors.find(
            (msg) => msg.includes(entity.id) && /Import conflict|ImportConflictError/i.test(msg),
        );
        expect(errorMatch).toBeTruthy();
        // The mismatching field's tampered value MUST appear in the error
        // (truncated JSON serialization — guaranteed by assertContentMatch).
        expect(errorMatch!).toContain('TamperedEntityName');

        rmSync(sourceDir, { recursive: true, force: true });
        rmSync(targetDir, { recursive: true, force: true });
    });

    it('artifact arm: tampered backup metadata with matching id but altered filename fails into errors[]', async () => {
        const sourceDir = mkdtempSync(join(tmpdir(), 'wave-a4-fixup-src-art-'));
        const sourceStores = createLocalCluster(sourceDir);
        const sourceKernel = new ClusterKernel(sourceStores, { dataDir: sourceDir });
        const buf = Buffer.from('artifact-content-bytes');
        const { artifact } = await sourceKernel.ingestArtifact({
            filename: 'original.txt',
            content: buf,
            mimeType: 'text/plain',
            actorId: 'admin',
        });

        const data = await backup(sourceStores);
        const targetDir = mkdtempSync(join(tmpdir(), 'wave-a4-fixup-tgt-art-'));
        const targetStores = createLocalCluster(targetDir);
        await restore(targetStores, data);

        // Tamper the artifact metadata (filename) but keep id matching.
        const tamperedData = JSON.parse(JSON.stringify(data));
        const tamperedArt = tamperedData.artifactSnapshots.find(
            (s: any) => s.metadata.id === artifact.id,
        );
        expect(tamperedArt).toBeTruthy();
        tamperedArt.metadata.filename = 'tampered-filename.txt';

        const result = await restore(targetStores, tamperedData);
        expect(result.artifacts.errors.length).toBeGreaterThan(0);
        const errorMatch = result.artifacts.errors.find(
            (msg) => msg.includes(artifact.id) && /Import conflict|ImportConflictError/i.test(msg),
        );
        expect(errorMatch).toBeTruthy();
        expect(errorMatch!).toContain('tampered-filename');

        rmSync(sourceDir, { recursive: true, force: true });
        rmSync(targetDir, { recursive: true, force: true });
    });

    it('identical re-restore is idempotent (no false positive on matching content)', async () => {
        // Guard against an over-eager assertContentMatch that flags
        // identical re-runs as conflicts — the legitimate idempotency
        // contract must still hold.
        const sourceDir = mkdtempSync(join(tmpdir(), 'wave-a4-fixup-src-idem-'));
        const sourceStores = createLocalCluster(sourceDir);
        const sourceKernel = new ClusterKernel(sourceStores, { dataDir: sourceDir });
        await sourceKernel.createEntity({
            kind: 'document',
            name: 'IdempotentEntity',
            attributes: { value: 'stable' },
            actorId: 'admin',
        });
        const buf = Buffer.from('idempotent-content');
        await sourceKernel.ingestArtifact({
            filename: 'stable.txt',
            content: buf,
            mimeType: 'text/plain',
            actorId: 'admin',
        });

        const data = await backup(sourceStores);
        const targetDir = mkdtempSync(join(tmpdir(), 'wave-a4-fixup-tgt-idem-'));
        const targetStores = createLocalCluster(targetDir);
        await restore(targetStores, data);
        const secondResult = await restore(targetStores, data);

        expect(secondResult.entities.errors).toEqual([]);
        expect(secondResult.artifacts.errors).toEqual([]);
        expect(secondResult.events.errors).toEqual([]);
        expect(secondResult.receipts.errors).toEqual([]);
        // All entries should skip on the second run.
        expect(secondResult.entities.skipped).toBeGreaterThan(0);

        rmSync(sourceDir, { recursive: true, force: true });
        rmSync(targetDir, { recursive: true, force: true });
    });
});

// ─── Item 3 — AGG-A4-1: redactError extended BUILTIN_ERROR_CODES ────────────

describe('Wave A4 fix-up Item 3 — redactError maps adapter-tier typed errors to stable codes', () => {
    it('CorruptStoreError → CORRUPT_STORE', () => {
        const err = new CorruptStoreError('/some/path/entities.json', new Error('bad json'));
        const result = redactError(err);
        expect(result.code).toBe('CORRUPT_STORE');
        // Path scrubber must still apply — the absolute path in message
        // is replaced with <path>.
        expect(result.message).toContain('<path>');
        expect(result.message).not.toContain('/some/path/entities.json');
    });

    it('InvalidContentHashError → INVALID_CONTENT_HASH', () => {
        const err = new InvalidContentHashError('not-a-real-hash');
        const result = redactError(err);
        expect(result.code).toBe('INVALID_CONTENT_HASH');
    });

    it('ImportConflictError → IMPORT_CONFLICT', () => {
        const err = new ImportConflictError('canonical', 'abc-id', '{"a":1}', '{"a":2}');
        const result = redactError(err);
        expect(result.code).toBe('IMPORT_CONFLICT');
    });

    it('LedgerCycleDetectedError → LEDGER_CYCLE_DETECTED', () => {
        const err = new LedgerCycleDetectedError(['a', 'b', 'a']);
        const result = redactError(err);
        expect(result.code).toBe('LEDGER_CYCLE_DETECTED');
    });

    it('ImportSnapshotNotSupportedError → IMPORT_SNAPSHOT_NOT_SUPPORTED', () => {
        const err = new ImportSnapshotNotSupportedError('canonical', 'importSnapshot');
        const result = redactError(err);
        expect(result.code).toBe('IMPORT_SNAPSHOT_NOT_SUPPORTED');
    });

    it('ResolveError → RESOLVE_NOT_FOUND', () => {
        const err = new ResolveError('cluster://canonical/missing-id', 'not found');
        const result = redactError(err);
        expect(result.code).toBe('RESOLVE_NOT_FOUND');
    });

    it('ClusterUriError → INVALID_CLUSTER_URI', () => {
        const err = new ClusterUriError('Cannot derive URI: unknown owner "x"');
        const result = redactError(err);
        expect(result.code).toBe('INVALID_CLUSTER_URI');
    });

    it('built-in JS errors still map (regression-guard for the existing 6 entries)', () => {
        expect(redactError(new TypeError('bad type')).code).toBe('INTERNAL_TYPE_ERROR');
        expect(redactError(new RangeError('out of range')).code).toBe('INTERNAL_RANGE_ERROR');
    });
});

// ─── Item 4 — AGG-A4-2: kernel staging sweep + suffix alignment ──────────────

describe('Wave A4 fix-up Item 4 — kernel staging tmp suffix matches sweep regex', () => {
    it('source-level: cluster-kernel.ts produces tmp files matching the staging-orphan regex', () => {
        const src = readFileSync(join(ROOT, 'src', 'kernel', 'cluster-kernel.ts'), 'utf-8');
        // The producer line must use randomBytes(3) so the suffix is 6 hex
        // chars — matching the cleanup regex `[a-f0-9]{64}\.\d+-[a-z0-9]{1,6}\.tmp$`.
        // Pre-fix randomBytes(8) → 16 hex chars → never matched.
        expect(src).toMatch(/randomBytes\s*\(\s*3\s*\)\.toString\s*\(\s*['"]hex['"]\s*\)/);
        // The 16-hex literal MUST be gone.
        expect(src).not.toMatch(/randomBytes\s*\(\s*8\s*\)\.toString\s*\(\s*['"]hex['"]\s*\)/);
        // A sweep must be wired — the kernel either uses the helper or
        // inlines the same regex/flow. We accept either shape but the
        // load-bearing property is the `[a-f0-9]{64}\.\d+-[a-z0-9]{1,6}\.tmp$`
        // pattern appearing somewhere AND a stagingSwept guard (one-shot).
        expect(src).toMatch(/\[a-f0-9\]\{64\}\\\.\\d\+-\[a-z0-9\]\{1,6\}\\\.tmp/);
        expect(src).toMatch(/stagingSwept|sweepContentDirOrphans/);
    });

    it('runtime: an orphan staging tmp file older than 5 minutes is swept on first kernel proposeMutation', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-a4-fixup-kernel-sweep-'));
        // Manually create the staging dir + plant an orphan tmp file matching
        // the producer shape: <64-hex>.<pid>-<6-hex>.tmp.
        const fakeHash = 'a'.repeat(64);
        const stagingDir = join(dir, 'pending-content');
        // mkdirSync via writeFileSync chain — easier: use fs.
        const { mkdirSync } = await import('node:fs');
        mkdirSync(stagingDir, { recursive: true });
        const orphanPath = join(stagingDir, `${fakeHash}.12345-abc123.tmp`);
        writeFileSync(orphanPath, 'orphan content');
        // Age it past the 5-min cutoff.
        const oldTime = new Date(Date.now() - 10 * 60 * 1000);
        utimesSync(orphanPath, oldTime, oldTime);
        expect(existsSync(orphanPath)).toBe(true);

        // Construct a kernel + trigger a proposeMutation that hits getStagingDir.
        const stores = createLocalCluster(dir);
        const kernel = new ClusterKernel(stores, { dataDir: dir });
        const buf = Buffer.from('hello-sweep');
        const contentHash = createHash('sha256').update(buf).digest('hex');
        await kernel.proposeMutation({
            verb: 'ingest_artifact',
            targetStore: 'artifact',
            payload: { filename: 'sweep-trigger.txt', content: buf, mimeType: 'text/plain', contentHash },
            proposedBy: 'sweep-test',
        });

        // The orphan must be gone now.
        expect(existsSync(orphanPath)).toBe(false);

        rmSync(dir, { recursive: true, force: true });
    });

    it('runtime: a YOUNG orphan staging tmp file is NOT swept (sibling-process safety)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-a4-fixup-kernel-young-'));
        const fakeHash = 'b'.repeat(64);
        const stagingDir = join(dir, 'pending-content');
        const { mkdirSync } = await import('node:fs');
        mkdirSync(stagingDir, { recursive: true });
        const youngPath = join(stagingDir, `${fakeHash}.12345-def456.tmp`);
        writeFileSync(youngPath, 'young content');
        // Leave mtime fresh (now).
        expect(existsSync(youngPath)).toBe(true);

        const stores = createLocalCluster(dir);
        const kernel = new ClusterKernel(stores, { dataDir: dir });
        const buf = Buffer.from('young-test');
        const contentHash = createHash('sha256').update(buf).digest('hex');
        await kernel.proposeMutation({
            verb: 'ingest_artifact',
            targetStore: 'artifact',
            payload: { filename: 'young-trigger.txt', content: buf, mimeType: 'text/plain', contentHash },
            proposedBy: 'sweep-test',
        });

        // Young file survives.
        expect(existsSync(youngPath)).toBe(true);

        rmSync(dir, { recursive: true, force: true });
    });
});

// ─── Item 5 — AGG-A4-3 (CommandQueue): random tmp suffix + orphan sweep ─────

describe('Wave A4 fix-up Item 5 — CommandQueue.persist uses random tmp suffix', () => {
    it('source-level: command-queue.ts persist body uses random tmp suffix (no fixed `.tmp` assignment)', () => {
        const src = readFileSync(join(ROOT, 'src', 'kernel', 'command-queue.ts'), 'utf-8');
        // A random-suffix tmp path generator must be present (either an
        // imported helper or an inline buildRandomTmpPath function).
        expect(src).toMatch(/buildRandomTmpPath\s*\(/);
        // Strip comment blocks to focus on actual code only.
        const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        // The persist body must use buildRandomTmpPath.
        const persistMatch = codeOnly.match(/private\s+persist\([^)]*\)[^{]*\{([\s\S]*?)\n\s{4}\}/);
        expect(persistMatch).toBeTruthy();
        if (persistMatch) {
            const body = persistMatch[1];
            expect(body).toContain('buildRandomTmpPath');
            // Pre-fix literal `${this.filePath}.tmp` assignment must be gone
            // from the actual code (comments allowed).
            expect(body).not.toMatch(/`\$\{this\.filePath\}\.tmp`/);
            // And the legacy assignment shape `const tmpPath = `…`.tmp`;`
            // pointing to a fixed suffix is gone.
            expect(body).not.toMatch(/const\s+tmpPath\s*=\s*`[^`]*\.tmp`\s*;/);
        }
    });

    it('runtime: an orphan tmp file matching the queue regex is swept at constructor time', () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-a4-fixup-queue-sweep-'));
        // Plant an orphan tmp matching the CommandQueue tmp shape:
        // `pending-commands.json.<pid>-<rand6>.tmp`.
        const orphanPath = join(dir, 'pending-commands.json.99999-abc123.tmp');
        writeFileSync(orphanPath, 'orphan queue tmp');
        const oldTime = new Date(Date.now() - 10 * 60 * 1000);
        utimesSync(orphanPath, oldTime, oldTime);
        expect(existsSync(orphanPath)).toBe(true);

        // Constructor sweep should fire here.
        new CommandQueue(dir);

        expect(existsSync(orphanPath)).toBe(false);

        rmSync(dir, { recursive: true, force: true });
    });

    it('runtime: persist() writes to a random-suffix tmp then renames (no fixed-suffix tmp left behind)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wave-a4-fixup-queue-persist-'));
        const queue = new CommandQueue(dir);
        // Persist a synthetic command to force a write.
        queue.save({
            id: 'cmd-1',
            status: 'proposed',
            verb: 'create_entity',
            targetStore: 'canonical',
            payload: { kind: 'k', name: 'n', attributes: {} },
            proposedBy: 'tester',
            proposedAt: new Date().toISOString(),
        } as any);

        // The fixed-suffix `pending-commands.json.tmp` must NOT exist as a
        // leftover (since persist() always renames). And any random-suffix
        // tmp files would also be renamed in the happy path — directory
        // should NOT contain any `.tmp` entries.
        const entries = readdirSync(dir);
        const tmpEntries = entries.filter((e) => e.endsWith('.tmp'));
        expect(tmpEntries).toEqual([]);

        // The committed file must exist.
        expect(existsSync(join(dir, 'pending-commands.json'))).toBe(true);

        rmSync(dir, { recursive: true, force: true });
    });
});

// ─── Item 6 — AGG-A4-3 (cluster_trace/why): MCP graph sanitization ──────────

describe('Wave A4 fix-up Item 6 — cluster_trace + cluster_why sanitize provenance graph at MCP boundary', () => {
    async function seedCluster(): Promise<{
        clusterDir: string;
        entityUri: string;
        entityId: string;
        sdk: ClusterSDK;
    }> {
        const dir = mkdtempSync(join(tmpdir(), 'wave-a4-fixup-trace-'));
        const stores = createLocalCluster(dir);
        const kernel = new ClusterKernel(stores, { dataDir: dir });
        // Seed an entity with a CONFIDENTIAL-marker name so we can assert it
        // doesn't appear in trace output.
        const { entity } = await kernel.createEntity({
            kind: 'document',
            name: 'CONFIDENTIAL-trace-probe',
            attributes: { secret: 'SECRET-trace-marker' },
            actorId: 'admin-trace-probe',
        });
        const sdk = new ClusterSDK({ clusterDir: dir });
        return {
            clusterDir: dir,
            entityUri: `cluster://canonical/${entity.id}`,
            entityId: entity.id,
            sdk,
        };
    }

    it('cluster_trace: nodes[*].label and metadata stripped, edges[*].reason redacted', async () => {
        const { clusterDir, entityUri, sdk } = await seedCluster();
        const result = (await handleTool('cluster_trace', { uri: entityUri }, sdk)) as any;

        expect(Array.isArray(result.nodes)).toBe(true);
        expect(result.nodes.length).toBeGreaterThan(0);

        // No node carries the CONFIDENTIAL marker in label OR metadata,
        // and metadata is undefined per sanitizer contract.
        for (const node of result.nodes) {
            expect(node.label).not.toContain('CONFIDENTIAL');
            expect(node.label).not.toContain('admin-trace-probe');
            expect(node.metadata).toBeUndefined();
        }
        // Edges have reason replaced with [redacted].
        for (const edge of result.edges) {
            expect(edge.reason).toBe('[redacted]');
        }
        // Structural shape preserved: nodes still have uri/type/ownerStore,
        // edges still have from/to/type.
        for (const node of result.nodes) {
            expect(typeof node.uri).toBe('string');
            expect(typeof node.type).toBe('string');
        }
        for (const edge of result.edges) {
            expect(typeof edge.from).toBe('string');
            expect(typeof edge.to).toBe('string');
            expect(typeof edge.type).toBe('string');
        }
        // The CONFIDENTIAL string is nowhere in the stringified payload.
        expect(JSON.stringify(result)).not.toContain('CONFIDENTIAL');
        expect(JSON.stringify(result)).not.toContain('SECRET-trace-marker');
        expect(JSON.stringify(result)).not.toContain('admin-trace-probe');

        rmSync(clusterDir, { recursive: true, force: true });
    });

    it('cluster_why: explanation string carries no CONFIDENTIAL identifiers', async () => {
        const { clusterDir, entityUri, sdk } = await seedCluster();
        const result = (await handleTool('cluster_why', { uri: entityUri }, sdk)) as any;

        expect(typeof result.explanation).toBe('string');
        expect(result.explanation).not.toContain('CONFIDENTIAL');
        expect(result.explanation).not.toContain('admin-trace-probe');
        expect(result.explanation).not.toContain('SECRET-trace-marker');
        // Sanity: the explanation still mentions the structural type.
        expect(result.explanation).toMatch(/entity|document|canonical/i);

        rmSync(clusterDir, { recursive: true, force: true });
    });

    it('cluster_trace: summary.oneLiner is regenerated structurally (no embedded focal label)', async () => {
        const { clusterDir, entityUri, sdk } = await seedCluster();
        const result = (await handleTool('cluster_trace', { uri: entityUri }, sdk)) as any;

        expect(typeof result.summary).toBe('object');
        expect(typeof result.summary.oneLiner).toBe('string');
        // Pre-sanitization the trace builder embedded focal.label (carrying
        // the CONFIDENTIAL name) into oneLiner.
        expect(result.summary.oneLiner).not.toContain('CONFIDENTIAL');
        // Post-sanitization oneLiner is a structural description.
        expect(result.summary.oneLiner).toMatch(/node|edge/i);

        rmSync(clusterDir, { recursive: true, force: true });
    });
});
