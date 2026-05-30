/**
 * Wave V2 — A2 regression: policy enforcement on version-history + command reads.
 * SECURITY-CRITICAL. Pins:
 *  - VERSIONS-001 per-element redaction: a list of versions must be redacted PER
 *    ELEMENT (never redact-latest-then-return-raw-history). The array-vs-single trap.
 *  - Coarse deny: a principal without the capability gets PolicyDeniedError, not data.
 *  - getEntityVersion oracle: mirrors inspectEntity — unknown id under a per-resource
 *    rule yields PolicyDeniedError (not null), so it can't become an existence oracle.
 *  - AI-009 per-item: listCommands gates+redacts PER ITEM (KERNEL-R007), payloads stripped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PolicyEnforcedKernel, PolicyDeniedError } from '../src/kernel/policy-enforced-kernel.js';
import type { Policy, Principal } from '../src/types/policy.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';

const restrictedReader: Principal = { id: 'reader-1', name: 'Restricted', roles: ['restricted-reader'], trustZone: 'ai-facing' };
const deniedReader: Principal = { id: 'denied-1', name: 'Denied', roles: ['denied'], trustZone: 'ai-facing' };
const kindScoped: Principal = { id: 'ks-1', name: 'KindScoped', roles: ['kind-scoped'], trustZone: 'ai-facing' };

const policies: Policy[] = [
    // restricted-reader: read owner truth + commands, but redact attributes / payload / content
    { id: 'rr-owner', name: 'RR owner', priority: 20, match: { principals: ['restricted-reader'], capabilities: ['read_owner_truth'], stores: ['canonical'] }, decision: 'allow', reason: 'redacted owner read', redaction: { id: 'strip-attrs', target: 'entity_attributes', behavior: 'strip', reason: 'attrs restricted' } },
    { id: 'rr-art', name: 'RR art', priority: 20, match: { principals: ['restricted-reader'], capabilities: ['read_owner_truth'], stores: ['artifact'] }, decision: 'allow', reason: 'redacted artifact read', redaction: { id: 'strip-content', target: 'artifact_content', behavior: 'strip', reason: 'content restricted' } },
    { id: 'rr-cmd', name: 'RR cmd', priority: 20, match: { principals: ['restricted-reader'], capabilities: ['read_command'] }, decision: 'allow', reason: 'redacted command read', redaction: { id: 'strip-payload', target: 'command_payload', behavior: 'strip', reason: 'payload restricted' } },
    // denied: explicit deny of owner-truth + command reads
    { id: 'deny-all', name: 'deny', priority: 10, match: { principals: ['denied'], capabilities: ['read_owner_truth', 'read_command'] }, decision: 'deny', reason: 'denied' },
    // kind-scoped: allow owner truth generally, DENY kind 'secret' (a per-resource rule)
    { id: 'ks-deny-secret', name: 'KS deny secret', priority: 10, match: { principals: ['kind-scoped'], capabilities: ['read_owner_truth'], kinds: ['secret'] }, decision: 'deny', reason: 'secret denied' },
    { id: 'ks-allow', name: 'KS allow', priority: 20, match: { principals: ['kind-scoped'], capabilities: ['read_owner_truth'] }, decision: 'allow', reason: 'general owner read' },
];

describe('Wave V2 — A2 policy enforcement (VERSIONS-001 / AI-009 redaction + oracle)', () => {
    let dir: string;
    let entityId: string;
    let commandId: string;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'db-cluster-v2-policy-'));
        // Seed via an admin (raw) kernel on the same dataDir.
        const adminCluster = createLocalCluster(dir);
        const adminKernel = new ClusterKernel(adminCluster, { dataDir: dir });
        const { entity } = await adminKernel.createEntity({ kind: 'doc', name: 'Doc', attributes: { secret: 'V1SECRET' }, actorId: 'admin' });
        entityId = entity.id;
        await adminCluster.canonical.update(entityId, { attributes: { secret: 'V2SECRET' } }); // append v2
        await adminKernel.ingestArtifact({ filename: 'a.md', content: Buffer.from('one'), mimeType: 'text/markdown', actorId: 'admin' });
        await adminKernel.ingestArtifact({ filename: 'a.md', content: Buffer.from('two-content'), mimeType: 'text/markdown', actorId: 'admin' });
        const cmd = await adminKernel.proposeMutation({ verb: 'create_entity', targetStore: 'canonical', payload: { kind: 'doc', name: 'PAYLOADNAME', attributes: {} }, proposedBy: 'admin' });
        commandId = cmd.id;
    });
    afterEach(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    function kernelFor(principal: Principal): PolicyEnforcedKernel {
        return new PolicyEnforcedKernel(createLocalCluster(dir), { principal, trustZone: principal.trustZone }, { policies, dataDir: dir });
    }

    it('PER-ELEMENT: listEntityVersions redacts EVERY version — no raw history leaks', async () => {
        const versions = await kernelFor(restrictedReader).listEntityVersions(entityId);
        expect(versions).toHaveLength(2); // both versions returned (redacted, not dropped)
        expect(versions.map((v) => v.version)).toEqual([1, 2]); // version preserved
        // CRITICAL: the trap is redact-latest-return-raw-history. EVERY element must be stripped.
        for (const v of versions) {
            expect(v.attributes).toEqual({});
        }
        // Raw secret values from NEITHER version may appear anywhere in the result.
        const serialized = JSON.stringify(versions);
        expect(serialized).not.toContain('V1SECRET');
        expect(serialized).not.toContain('V2SECRET');
    });

    it('getEntityVersion redacts the fetched version', async () => {
        const v1 = await kernelFor(restrictedReader).getEntityVersion(entityId, 1);
        expect(v1).not.toBeNull();
        expect(v1!.version).toBe(1);
        expect(v1!.attributes).toEqual({});
        expect(JSON.stringify(v1)).not.toContain('V1SECRET');
    });

    it('coarse deny: a principal without read_owner_truth gets PolicyDeniedError, not data', async () => {
        await expect(kernelFor(deniedReader).listEntityVersions(entityId)).rejects.toBeInstanceOf(PolicyDeniedError);
        await expect(kernelFor(deniedReader).getEntityVersion(entityId, 1)).rejects.toBeInstanceOf(PolicyDeniedError);
    });

    it('ORACLE: getEntityVersion on an unknown id (under a per-resource rule) is PolicyDeniedError, not null', async () => {
        // kindScoped carries a kind-scoped deny → hasAnyPerResourceRule is true → an
        // unknown id must unify to PolicyDeniedError (mirroring inspectEntity), so the
        // refined-deny path and the not-found path are indistinguishable.
        await expect(kernelFor(kindScoped).getEntityVersion('nonexistent-xyz', 1)).rejects.toBeInstanceOf(PolicyDeniedError);
    });

    it('AI-009 PER-ITEM: listCommands gates + redacts each command (payload stripped)', async () => {
        const commands = await kernelFor(restrictedReader).listCommands();
        const mine = commands.find((c) => c.id === commandId);
        expect(mine).toBeDefined();
        expect(mine!.payload).toEqual({}); // payload stripped per-item
        // The entity name carried in the payload must not leak through the list surface.
        expect(JSON.stringify(commands)).not.toContain('PAYLOADNAME');
    });

    it('coarse deny: listCommands without read_command gets PolicyDeniedError', async () => {
        await expect(kernelFor(deniedReader).listCommands()).rejects.toBeInstanceOf(PolicyDeniedError);
    });

    it('listArtifactVersions applies per-element redaction and returns both versions', async () => {
        const versions = await kernelFor(restrictedReader).listArtifactVersions('a.md');
        expect(versions).toHaveLength(2);
        // storagePath (absolute fs path) must never leak through the version surface.
        expect(JSON.stringify(versions)).not.toContain(dir);
    });
});
