import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(import.meta.dirname, '.test-cli');
const CLI = `node ${join(import.meta.dirname, '..', 'dist', 'cli.js')}`;

function run(cmd: string): string {
    return execSync(`${CLI} ${cmd}`, { cwd: TEST_DIR, encoding: 'utf-8' });
}

describe('Wave 4 — Golden-Path CLI', () => {
    beforeEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it('full golden-path scenario', async () => {
        // 1. Init cluster
        const initOut = run('init');
        expect(initOut).toContain('Cluster initialized');
        expect(existsSync(join(TEST_DIR, '.db-cluster', 'canonical'))).toBe(true);
        expect(existsSync(join(TEST_DIR, '.db-cluster', 'artifact'))).toBe(true);
        expect(existsSync(join(TEST_DIR, '.db-cluster', 'index'))).toBe(true);
        expect(existsSync(join(TEST_DIR, '.db-cluster', 'ledger'))).toBe(true);

        // 2. Create an example artifact file
        const exampleFile = join(TEST_DIR, 'evidence.md');
        writeFileSync(exampleFile, '# Federated Evidence\n\nAI needs specialized truth stores.');

        // 3. Ingest artifact
        const ingestOut = run('ingest evidence.md');
        expect(ingestOut).toContain('Ingested: evidence.md');
        const artifactId = ingestOut.match(/artifact:\s+(\S+)/)?.[1];
        expect(artifactId).toBeTruthy();

        // 4. Create entity
        const entityOut = run('entity create --kind concept --name "Federated Truth"');
        expect(entityOut).toContain('Created entity: concept/Federated Truth');
        const entityId = entityOut.match(/id:\s+(\S+)/)?.[1];
        expect(entityId).toBeTruthy();

        // 5. Link evidence
        const linkOut = run(`link --artifact ${artifactId} --entity ${entityId}`);
        expect(linkOut).toContain('Linked:');
        expect(linkOut).toContain(artifactId!);
        expect(linkOut).toContain(entityId!);

        // 6. Find through index
        const findOut = run('find "federated"');
        expect(findOut).toContain('index record(s)');

        // 7. Inspect entity (canonical truth, not index)
        const inspectOut = run(`inspect ${entityId}`);
        expect(inspectOut).toContain('concept/Federated Truth');
        expect(inspectOut).toContain('owner:      canonical');

        // 8. Trace provenance (requires cluster URI)
        const traceOut = run(`trace cluster://canonical/${entityId}`);
        expect(traceOut).toContain('Provenance trace from:');
        expect(traceOut).toContain(entityId!);

        // 9. Propose mutation (zero writes)
        const proposeJson = JSON.stringify({
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId, patch: { name: 'Federated Truth v2' } },
        });
        const proposeOut = run(`propose "${proposeJson.replace(/"/g, '\\"')}"`);
        expect(proposeOut).toContain('Proposed command:');
        expect(proposeOut).toContain('status: proposed');
        const commandId = proposeOut.match(/Proposed command:\s+(\S+)/)?.[1];
        expect(commandId).toBeTruthy();

        // 10. Commit mutation through command runtime
        const commitOut = run(`commit ${commandId}`);
        expect(commitOut).toContain('Committed:');
        expect(commitOut).toContain('status:  committed');

        // 11. List receipts
        const receiptsOut = run('receipts');
        expect(receiptsOut).toContain('Receipts');
        // Should have at least: ingest(1) + entity(1) + link(1) + commit(1) = 4
        const receiptCount = (receiptsOut.match(/\[.*?\]/g) || []).length;
        expect(receiptCount).toBeGreaterThanOrEqual(4);
    });

    it('init is idempotent', () => {
        run('init');
        const secondInit = run('init');
        expect(secondInit).toContain('already initialized');
    });

    it('commands fail without init', () => {
        expect(() => run('find "test"')).toThrow();
    });
});
