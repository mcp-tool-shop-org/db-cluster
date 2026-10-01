/**
 * Coverage — ops/verify: each verify() check driven into every status.
 * Faults are injected by overlaying single methods on real local stores.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { verify } from '../src/ops/verify.js';
import type { ClusterHealth, HealthCheck } from '../src/types/health.js';
import type { ClusterStores } from '../src/contracts/index.js';
import type { Entity } from '../src/types/entity.js';
import type { Command } from '../src/types/command.js';

const ACTOR = 'operator';

function overlay<T extends object>(target: T, overrides: Record<string, unknown>): T {
    return new Proxy(target, {
        get(t, prop) {
            if (typeof prop === 'string' && prop in overrides) return overrides[prop];
            const value = Reflect.get(t, prop, t);
            return typeof value === 'function' ? value.bind(t) : value;
        },
    });
}

function check(health: ClusterHealth, name: string): HealthCheck {
    const found = health.checks.find((c) => c.name === name);
    if (!found) throw new Error(`no check named ${name}; have ${health.checks.map((c) => c.name).join(', ')}`);
    return found;
}

describe('verify()', () => {
    let dir: string;
    let stores: ClusterStores;
    let kernel: ClusterKernel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-verify-'));
        stores = createLocalCluster(dir);
        kernel = new ClusterKernel(stores);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('a consistent cluster verifies healthy and omits the bijection check without a command queue', async () => {
        await kernel.createEntity({ kind: 'note', name: 'one', attributes: {}, actorId: ACTOR });
        const health = await verify(stores);
        expect(health.status).toBe('healthy');
        expect(check(health, 'index_references_valid').message).toBe('All sampled index records resolve to existing source objects.');
        expect(check(health, 'canonical_lineage_intact').message).toBe('Canonical version chains are contiguous and update lineage is intact.');
        expect(health.checks.map((c) => c.name)).not.toContain('command_receipt_bijection');
    });

    it('includes the command-receipt bijection check when a queue is supplied', async () => {
        const health = await verify(stores, { commandQueue: { list: (): Command[] => [] } });
        expect(check(health, 'command_receipt_bijection').status).toBe('healthy');
    });

    it('reports index records whose canonical, artifact or ledger source is gone as corrupt', async () => {
        await stores.index.index({ sourceId: 'gone-entity', sourceStore: 'canonical', text: 'x', metadata: {} });
        await stores.index.index({ sourceId: 'gone-artifact', sourceStore: 'artifact', text: 'x', metadata: {} });
        await stores.index.index({ sourceId: 'gone-event', sourceStore: 'ledger', text: 'x', metadata: {} });
        const health = await verify(stores);
        const c = check(health, 'index_references_valid');
        expect(c).toMatchObject({ status: 'corrupt', severity: 'error', repairAvailable: true });
        expect(c.message).toBe('3 index record(s) reference non-existent source objects.');
        expect(c.suggestedCommand).toBe('db-cluster rebuild index');
        expect(health.status).toBe('corrupt');
    });

    it('a ledger source that throws on read (tamper) is not counted as missing', async () => {
        await stores.index.index({ sourceId: 'tampered-event', sourceStore: 'ledger', text: 'x', metadata: {} });
        const ledger = overlay(stores.ledger, { getEvent: async () => { throw new Error('integrity mismatch'); } });
        const c = check(await verify({ ...stores, ledger }), 'index_references_valid');
        expect(c.status).toBe('healthy');
    });

    it('reports entities missing from the index as stale', async () => {
        await kernel.createEntity({ kind: 'note', name: 'unindexed', attributes: {}, actorId: ACTOR });
        await stores.index.clear();
        const c = check(await verify(stores), 'index_references_valid');
        expect(c).toMatchObject({ status: 'stale', severity: 'warning', repairAvailable: true });
        expect(c.message).toBe('1 entity/artifact(s) not found in index. Index may need rebuild.');
    });

    it('reports unreachable when the index cannot be searched', async () => {
        const index = overlay(stores.index, { search: async () => { throw new Error('index file locked'); } });
        const c = check(await verify({ ...stores, index }), 'index_references_valid');
        expect(c).toMatchObject({ status: 'unreachable', severity: 'error' });
        expect(c.message).toBe('Index verification failed: index file locked');
    });

    it('reports orphaned mutation events, noting the cap when sampleLimit is smaller than the count', async () => {
        for (let i = 0; i < 3; i++) {
            await stores.ledger.append({ action: 'mutation_orphaned', actorId: 'kernel', subjectId: `s${i}`, subjectStore: 'canonical', detail: {} });
        }
        const uncapped = check(await verify(stores), 'no_orphaned_mutations');
        expect(uncapped).toMatchObject({ status: 'degraded', severity: 'warning' });
        expect(uncapped.message).toContain('3 orphaned mutation event(s) recorded.');

        const capped = check(await verify(stores, { sampleLimit: 2 }), 'no_orphaned_mutations');
        expect(capped.message).toContain('3 orphaned mutation event(s) recorded (showing first 2).');
    });

    it('reports unreachable when the orphan count cannot be read', async () => {
        const ledger = overlay(stores.ledger, { countEvents: async () => { throw new Error('count failed'); } });
        const c = check(await verify({ ...stores, ledger }), 'no_orphaned_mutations');
        expect(c).toMatchObject({ status: 'unreachable', severity: 'error' });
        expect(c.message).toBe('Orphan verification failed: count failed');
    });

    it('onProgress is called once per step with the same total, and a throwing callback is ignored', async () => {
        const steps: Array<[number, number, string]> = [];
        await verify(stores, { onProgress: (c, t, m) => steps.push([c, t, String(m)]) });
        expect(steps.map((s) => s[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(new Set(steps.map((s) => s[1]))).toEqual(new Set([8]));
        expect(steps.map((s) => s[2])).toEqual([
            'index_references_valid', 'provenance_references_valid', 'no_orphaned_mutations',
            'receipts_provenance_valid', 'artifact_content_integrity', 'ledger_integrity_chain',
            'command_receipt_bijection', 'canonical_lineage_intact',
        ]);
        const health = await verify(stores, { onProgress: () => { throw new Error('sink failed'); } });
        expect(health.status).toBe('healthy');
    });

    describe('canonical lineage', () => {
        function withVersions(versionsById: Record<string, Array<Partial<Entity>>>, listed: Array<Partial<Entity>>) {
            return overlay(stores.canonical, {
                list: async () => listed,
                listVersions: async (id: string) => versionsById[id] ?? [],
            });
        }

        it('flags an entity whose version chain has a gap and names the missing versions', async () => {
            const canonical = withVersions(
                { e1: [{ version: 1 }, { version: 3 }] },
                [{ id: 'e1' }, { id: 'e1' }],
            );
            const c = check(await verify({ ...stores, canonical }), 'canonical_lineage_intact');
            expect(c).toMatchObject({ status: 'corrupt', severity: 'error', store: 'canonical' });
            expect(c.message).toBe(
                'Canonical lineage broken: 1 entity version-chain gap(s): ' +
                'entity e1: have versions [1,3], expected 1..3 (missing 2).',
            );
            expect(c.suggestedCommand).toBe('db-cluster restore <backup.json>');
        });

        it('skips entities with no versions or no numeric versions, and accepts a contiguous chain', async () => {
            const canonical = withVersions(
                {
                    none: [],
                    nonNumeric: [{ version: undefined }],
                    ok: [{ version: 2 }, { version: 1 }],
                },
                [{ id: 'none' }, { id: 'nonNumeric' }, { id: 'ok' }],
            );
            const c = check(await verify({ ...stores, canonical }), 'canonical_lineage_intact');
            expect(c.status).toBe('healthy');
        });

        it('flags update_entity commits that lost their previous-version detail once others carry it', async () => {
            const { entity } = await kernel.createEntity({ kind: 'note', name: 'v1', attributes: {}, actorId: ACTOR });
            await stores.ledger.append({
                action: 'mutation_committed', actorId: ACTOR, subjectId: entity.id, subjectStore: 'canonical',
                detail: { verb: 'update_entity', previous: { version: 1 } },
            });
            await stores.ledger.append({
                action: 'mutation_committed', actorId: ACTOR, subjectId: entity.id, subjectStore: 'canonical',
                detail: { verb: 'update_entity' },
            });
            const c = check(await verify(stores), 'canonical_lineage_intact');
            expect(c.status).toBe('corrupt');
            expect(c.message).toBe(
                'Canonical lineage broken: 1 update_entity mutation_committed event(s) missing the `previous` lineage detail.',
            );
        });

        it('does not flag update commits that all lack previous (nothing to compare against)', async () => {
            const { entity } = await kernel.createEntity({ kind: 'note', name: 'v1', attributes: {}, actorId: ACTOR });
            await stores.ledger.append({
                action: 'mutation_committed', actorId: ACTOR, subjectId: entity.id, subjectStore: 'canonical',
                detail: { verb: 'update_entity' },
            });
            expect(check(await verify(stores), 'canonical_lineage_intact').status).toBe('healthy');
        });

        it('reports unverified when the canonical adapter cannot list versions', async () => {
            const canonical = overlay(stores.canonical, { listVersions: undefined });
            const c = check(await verify({ ...stores, canonical }), 'canonical_lineage_intact');
            expect(c).toMatchObject({ status: 'unverified', severity: 'info' });
            expect(c.message).toContain('does not expose listVersions()');
        });

        it('reports unreachable when the lineage walk itself fails', async () => {
            const canonical = overlay(stores.canonical, { list: async () => { throw new Error('canonical unreadable'); } });
            const c = check(await verify({ ...stores, canonical }), 'canonical_lineage_intact');
            expect(c).toMatchObject({ status: 'unreachable', severity: 'error' });
            expect(c.message).toBe('Canonical lineage verification failed: canonical unreadable');
        });
    });
});
