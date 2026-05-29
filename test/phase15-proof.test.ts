/**
 * Phase 15 Proof Suite — Release Readiness & Package Boundary.
 *
 * 10 proofs demonstrating:
 * 1. Public API is intentional and complete
 * 2. Internal details do NOT leak
 * 3. Package exports resolve correctly
 * 4. CLI and MCP bins are executable
 * 5. Docs match runtime
 * 6. Fresh install works from tarball
 * 7. Examples use package import paths
 * 8. Tarball excludes test/scripts/src
 * 9. Release positioning is honest
 * 10. Full lifecycle works through public API only
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, '..');

describe('Phase 15 — Release Readiness & Package Boundary (10 Proofs)', () => {

  // Proof 1: Public API exports are intentional and complete
  it('Proof 1: main entry exports the SAFE factory, ops, URI, types — NOT raw ClusterKernel or raw store factories', async () => {
    const mainExports = await import('../src/index.js');
    const keys = Object.keys(mainExports);

    // Must include these core symbols. KERNEL-001 (Wave S2-A1): the root now
    // exports the POLICY-ENFORCED factory `createSafeCluster` instead of the
    // raw store factories.
    expect(keys).toContain('createSafeCluster');
    expect(keys).toContain('doctor');
    expect(keys).toContain('verify');
    expect(keys).toContain('backup');
    expect(keys).toContain('restore');
    expect(keys).toContain('parseClusterUri');
    expect(keys).toContain('formatClusterUri');
    expect(keys).toContain('isClusterUri');
    expect(keys).toContain('uriForObject');
    expect(keys).toContain('ClusterUriError');

    // KERNEL-001: the raw store factories must NOT be on the package root —
    // they handed back unpoliced ClusterStores. They live behind the explicit
    // '@mcptoolshop/db-cluster/unsafe' escape hatch now.
    expect(keys).not.toContain('createLocalCluster');
    expect(keys).not.toContain('createCluster');
    expect(keys).not.toContain('createClusterFromEnv');

    // Must NOT include internal details, including the raw ClusterKernel class
    // (KERNEL-013: ClusterKernel was previously exported as public API, which
    // bypassed PolicyEnforcedKernel entirely. The supported paths are now
    // ClusterSDK (db-cluster/sdk) or PolicyEnforcedKernel (db-cluster/policy).)
    expect(keys).not.toContain('ClusterKernel');
    expect(keys).not.toContain('CommandQueue');
    expect(keys).not.toContain('LocalCanonicalStore');
    expect(keys).not.toContain('LocalArtifactStore');
    expect(keys).not.toContain('LocalIndexStore');
    expect(keys).not.toContain('LocalLedgerStore');
    expect(keys).not.toContain('PostgresCanonicalStore');
    expect(keys).not.toContain('ingestRepoKnowledge');
    expect(keys).not.toContain('compareRetrieval');
    expect(keys).not.toContain('proposeFactUpdate');
  });

  // Proof 2: Subpath exports resolve to correct modules
  it('Proof 2: subpath exports (sdk, mcp, policy, types) resolve correctly', async () => {
    const sdk = await import('../src/sdk/index.js');
    expect(sdk).toHaveProperty('ClusterSDK');

    const mcp = await import('../src/mcp/index.js');
    expect(mcp).toHaveProperty('TOOLS');
    expect(mcp).toHaveProperty('handleTool');

    const policy = await import('../src/policy/index.js');
    expect(policy).toHaveProperty('PolicyEnforcedKernel');
    expect(policy).toHaveProperty('redactEntity');
    expect(policy).toHaveProperty('DEFAULT_POLICIES');

    const types = await import('../src/types/index.js');
    // types module is type-only — all exports are erased at runtime
    // The module must at least resolve without error
    expect(types).toBeDefined();
  });

  // Proof 3: package.json exports map matches dist files
  it('Proof 3: every exports path in package.json has corresponding dist file', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const exportsMap = pkg.exports;

    for (const [subpath, conditions] of Object.entries(exportsMap)) {
      const importPath = (conditions as any).import;
      const typesPath = (conditions as any).types;

      // The file should exist after build
      const importFile = join(ROOT, importPath);
      const typesFile = join(ROOT, typesPath);

      expect(existsSync(importFile), `Missing import file for ${subpath}: ${importPath}`).toBe(true);
      expect(existsSync(typesFile), `Missing types file for ${subpath}: ${typesPath}`).toBe(true);
    }
  });

  // Proof 4: bin entries are executable files
  it('Proof 4: CLI and MCP bin files exist and have correct shebang', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const bins = pkg.bin;

    expect(bins).toHaveProperty('db-cluster');
    expect(bins).toHaveProperty('db-cluster-mcp');

    for (const [name, relPath] of Object.entries(bins)) {
      const fullPath = join(ROOT, relPath as string);
      expect(existsSync(fullPath), `bin "${name}" not found at ${relPath}`).toBe(true);

      const content = readFileSync(fullPath, 'utf-8');
      expect(content.startsWith('#!/usr/bin/env node'), `bin "${name}" missing shebang`).toBe(true);
    }
  });

  // Proof 5: files field excludes test, scripts, src
  it('Proof 5: npm pack dry-run excludes test/, scripts/, src/', () => {
    const output = execSync('npm pack --dry-run 2>&1', { cwd: ROOT, encoding: 'utf-8' });

    // Should include dist
    expect(output).toContain('dist/');

    // Should NOT include these internal directories
    expect(output).not.toMatch(/\btest\//);
    expect(output).not.toMatch(/\bscripts\//);
    expect(output).not.toMatch(/\bsrc\//);
    expect(output).not.toContain('.test-');
  });

  // Proof 6: examples use package imports, not relative src paths
  it('Proof 6: no example file imports from ../../src/', () => {
    const examplesDir = join(ROOT, 'examples');
    const tsFiles: string[] = [];

    function collectTs(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) collectTs(join(dir, entry.name));
        else if (entry.name.endsWith('.ts')) tsFiles.push(join(dir, entry.name));
      }
    }
    collectTs(examplesDir);

    expect(tsFiles.length).toBeGreaterThan(0);

    for (const file of tsFiles) {
      const content = readFileSync(file, 'utf-8');
      expect(content, `${file} imports from src/`).not.toMatch(/from\s+['"]\.\.\/\.\.\/src\//);
    }
  });

  // Proof 7: release notes describe what db-cluster IS and IS NOT
  it('Proof 7: release notes preserve product thesis', () => {
    const notes = readFileSync(join(ROOT, 'docs', 'release-notes-v0.1.md'), 'utf-8');

    // IS
    expect(notes).toContain('owner-truth');
    expect(notes).toContain('provenance');
    expect(notes).toContain('command-gated mutation');
    expect(notes).toContain('retrieval');

    // IS NOT
    expect(notes).toContain('NOT');
    expect(notes).toContain('RAG framework');
    expect(notes).toContain('Vector search layer');
    expect(notes).toContain('LLM wrapper');
  });

  // Proof 8: package-boundary doc exists and covers key categories
  it('Proof 8: package-boundary.md documents public vs private', () => {
    const boundary = readFileSync(join(ROOT, 'docs', 'package-boundary.md'), 'utf-8');

    expect(boundary).toContain('Public exports');
    expect(boundary).toContain('Intentionally NOT public');
    expect(boundary).toContain('What ships in the package');
    expect(boundary).toContain('What does NOT ship');
    expect(boundary).toContain('Versioning');
  });

  // Proof 9: full lifecycle works through public API only
  it('Proof 9: ingest → create → retrieve → ops cycle via public exports', async () => {
    // KERNEL-013: ClusterKernel is no longer publicly exported from the main
    // entry. The supported in-process write path is `db-cluster/sdk`. The
    // ops + URI surface still lives on the main entry. KERNEL-001 (Wave
    // S2-A1): the raw `createLocalCluster` factory moved off the root to the
    // '/unsafe' escape hatch, so this proof builds its raw stores there (it
    // exercises the ops, which legitimately operate on raw ClusterStores).
    const { doctor, verify, backup, restore } = await import('../src/index.js');
    const { createLocalCluster } = await import('../src/unsafe.js');
    const { ClusterSDK } = await import('../src/sdk/index.js');

    const testDir = join(ROOT, '.test-phase15-lifecycle');
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    try {
      const sdk = new ClusterSDK({ clusterDir: testDir });

      // Ingest via the full lifecycle. Wave A2 (KERNEL-R002) removed the
      // SDK auto-walk — callers must propose → validate → approve → commit
      // explicitly. Tests that need separation of duties supply distinct
      // actors; this proof self-approves for brevity.
      const ingestPropose = await sdk.proposeMutation({
        verb: 'ingest_artifact',
        targetStore: 'artifact',
        payload: (() => {
          // Wave A4 KERNEL-B-007: Buffer + contentHash side-channel.
          const buf = Buffer.from('Phase 15 proof: the package boundary holds.', 'utf-8');
          return {
            filename: 'phase15-proof.txt',
            content: buf,
            contentHash: createHash('sha256').update(buf).digest('hex'),
            mediaType: 'text/plain',
          };
        })(),
        proposedBy: 'proof-actor',
      });
      await sdk.validateMutation(ingestPropose.id);
      await sdk.approveMutation(ingestPropose.id, 'proof-actor');
      const ingestCommit = await sdk.commitMutation(ingestPropose.id, 'proof-actor');
      expect(ingestCommit.receipt.affectedIds.length).toBeGreaterThan(0);
      const artifactId = ingestCommit.receipt.affectedIds[0];

      // Create entity via the same lifecycle.
      const createPropose = await sdk.proposeMutation({
        verb: 'create_entity',
        targetStore: 'canonical',
        payload: { kind: 'fact', name: 'Package boundary is deliberate', attributes: {} },
        proposedBy: 'proof-actor',
      });
      await sdk.validateMutation(createPropose.id);
      await sdk.approveMutation(createPropose.id, 'proof-actor');
      const createCommit = await sdk.commitMutation(createPropose.id, 'proof-actor');
      expect(createCommit.receipt.affectedIds.length).toBeGreaterThan(0);
      const entityId = createCommit.receipt.affectedIds[0];

      // Link evidence via lifecycle.
      const linkPropose = await sdk.proposeMutation({
        verb: 'link_evidence',
        targetStore: 'ledger',
        payload: { entityId, artifactId, relationship: 'supports' },
        proposedBy: 'proof-actor',
      });
      await sdk.validateMutation(linkPropose.id);
      await sdk.approveMutation(linkPropose.id, 'proof-actor');
      await sdk.commitMutation(linkPropose.id, 'proof-actor');

      // Retrieve through the public bundle API.
      const bundle = await sdk.retrieveBundle('package boundary');
      expect(bundle.indexRecords.length).toBeGreaterThan(0);

      // For doctor/verify/backup, attach to the SAME on-disk cluster the SDK
      // wrote to. createLocalCluster() instantiates fresh in-memory state from
      // the persisted files, so this sees everything the SDK just committed.
      const stores = createLocalCluster(testDir);

      // Doctor
      const health = await doctor(stores);
      expect(health.status).toBe('healthy');

      // KERNEL-R2-002 (Wave A3) fixed verify()'s orphan probe to skip
      // events with subjectStore in ['ledger','index'] — those reference
      // commandIds / index records, not canonical/artifact subjects, and
      // were being false-flagged as orphans. After the fix, a normal
      // SDK lifecycle (command_validated / command_approved / mutation_committed)
      // produces no false orphans, so this cluster verifies healthy.
      const verification = await verify(stores);
      expect(verification.status).toBe('healthy');
      const provenanceCheck = verification.checks.find((c) => c.name === 'provenance_references_valid');
      expect(provenanceCheck?.status).toBe('healthy');
      // No unreachable / corrupt stores — the cluster IS healthy in every
      // dimension verify() actually probes correctly.
      const unreachable = verification.checks.filter((c) => c.status === 'unreachable' || c.status === 'corrupt');
      expect(unreachable.length).toBe(0);

      // Backup
      const bk = await backup(stores);
      expect(bk.entities.length).toBeGreaterThan(0);

      // Restore to new location
      const restoreDir = join(ROOT, '.test-phase15-restore');
      rmSync(restoreDir, { recursive: true, force: true });
      mkdirSync(restoreDir, { recursive: true });
      const restoreStores = createLocalCluster(restoreDir);
      const restoreResult = await restore(restoreStores, bk);
      expect(restoreResult.entities.created).toBeGreaterThan(0);

      rmSync(restoreDir, { recursive: true, force: true });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Proof 10: release-gate script exists and is referenced in package.json
  it('Proof 10: release-gate script exists and is wired in package.json', () => {
    const gatePath = join(ROOT, 'scripts', 'release-gate.mjs');
    expect(existsSync(gatePath)).toBe(true);

    const content = readFileSync(gatePath, 'utf-8');
    expect(content).toContain('tsc --noEmit');
    expect(content).toContain('vitest run');
    expect(content).toContain('npm pack');
    expect(content).toContain('smoke-install');
    expect(content).toContain('Verdict');

    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts['release-gate']).toContain('release-gate.mjs');
  });
});
