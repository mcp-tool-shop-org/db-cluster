/**
 * Coverage — ClusterSDK: backend handle lifecycle (close), the test-seam
 * policy introspection warning, and policyExplain with and without a policy
 * set. Real SDK instances over temp directories; no mocks of SDK internals.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { createLocalCluster } from '../src/adapters/local/index.js';
import type { Principal } from '../src/types/policy.js';
import { DEFAULT_POLICIES, DEFAULT_TRUST_ZONES } from '../src/policy/default-policies.js';

describe('ClusterSDK', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-sdk-'));
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    describe('close()', () => {
        it('is a no-op for an all-local SDK and safe to repeat', async () => {
            const sdk = new ClusterSDK({ clusterDir: dir });
            expect(sdk.pool).toBeUndefined();
            expect(sdk.sqliteDb).toBeUndefined();
            await expect(sdk.close()).resolves.toBeUndefined();
            await expect(sdk.close()).resolves.toBeUndefined();
        });

        it('closes the shared sqlite handle: later queries through it fail, and a second close is harmless', async () => {
            const sdk = new ClusterSDK({ clusterDir: dir, backends: { canonical: 'sqlite' } });
            expect(sdk.sqliteDb).toBeDefined();
            // Works before close.
            expect(await sdk.listEntityVersions('no-such-entity')).toEqual([]);
            await sdk.close();
            await expect(sdk.listEntityVersions('no-such-entity')).rejects.toThrow();
            await expect(sdk.close()).resolves.toBeUndefined();
        });

        it('ends the postgres pool exactly once', async () => {
            const sdk = new ClusterSDK({
                clusterDir: dir,
                backends: { canonical: 'postgres' },
                postgresUrl: 'postgres://user:pw@127.0.0.1:1/never',
            });
            expect(sdk.pool).toBeDefined();
            expect(sdk.pool!.ended).toBe(false);
            await sdk.close();
            expect(sdk.pool!.ended).toBe(true);
            await expect(sdk.close()).resolves.toBeUndefined();
        });
    });

    describe('isPolicyEnforced()', () => {
        it('reports false for a raw SDK and true once policies are supplied', () => {
            vi.stubEnv('NODE_ENV', 'test');
            const raw = new ClusterSDK({ clusterDir: join(dir, 'raw') });
            expect(raw.isPolicyEnforced()).toBe(false);

            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const policed = new ClusterSDK({
                clusterDir: join(dir, 'policed'),
                policies: DEFAULT_POLICIES,
                trustZones: DEFAULT_TRUST_ZONES,
                principal: ClusterSDK.INTERNAL_TRUSTED_PRINCIPAL,
            });
            expect(policed.isPolicyEnforced()).toBe(true);
            // With an explicit principal the constructor stays quiet, and in test mode so does the seam.
            expect(warn).not.toHaveBeenCalled();
        });

        it('warns outside test mode that this is a test seam, but still answers', () => {
            const sdk = new ClusterSDK({ clusterDir: dir });
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            vi.stubEnv('NODE_ENV', 'production');
            expect(sdk.isPolicyEnforced()).toBe(false);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toContain('test-seam introspection');
        });

        it('warns when policies are supplied without a principal and falls back to the trusted one', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const sdk = new ClusterSDK({ clusterDir: dir, policies: DEFAULT_POLICIES, trustZones: DEFAULT_TRUST_ZONES });
            expect(sdk.isPolicyEnforced()).toBe(true);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toContain('policies provided without principal');
        });
    });

    describe('resolve()', () => {
        it('falls back to the raw object, unsanitized, for a store type the SDK does not know (documented last resort)', async () => {
            const sdk = new ClusterSDK({ clusterDir: dir });
            // Simulate a resolver from a newer build that returns a sixth store type.
            (sdk as unknown as { resolver: { resolve(uri: string): Promise<unknown> } }).resolver = {
                resolve: async () => ({ store: 'mystery', object: { id: 'm-1', note: 'raw' } }),
            };
            expect(await sdk.resolve('cluster://canonical/anything')).toEqual({
                store: 'mystery',
                object: { id: 'm-1', note: 'raw' },
            });
        });

        it('strips storagePath from a resolved artifact', async () => {
            const kernel = new ClusterKernel(createLocalCluster(dir), { dataDir: dir });
            const { artifact } = await kernel.ingestArtifact({
                filename: 'r.txt', content: Buffer.from('r'), mimeType: 'text/plain', actorId: 'op',
            });
            expect(artifact.storagePath).toBeTruthy();
            const sdk = new ClusterSDK({ clusterDir: dir });
            const resolved = await sdk.resolve(`cluster://artifact/${artifact.id}`);
            expect(resolved.store).toBe('artifact');
            expect(resolved.object).toMatchObject({ id: artifact.id, filename: 'r.txt' });
            expect(resolved.object).not.toHaveProperty('storagePath');
        });

        it('rejects a malformed URI with the typed INVALID_CLUSTER_URI error', async () => {
            const sdk = new ClusterSDK({ clusterDir: dir });
            await expect(sdk.resolve('not-a-uri')).rejects.toMatchObject({ code: 'INVALID_CLUSTER_URI' });
        });
    });

    describe('policyExplain()', () => {
        const principal: Principal = {
            id: 'reader-1',
            name: 'Reader',
            roles: ['reader'],
            trustZone: 'internal',
        };

        it('without policies, answers allow with the no-policy marker and echoes principal and zone', () => {
            const sdk = new ClusterSDK({ clusterDir: dir });
            const result = sdk.policyExplain({ principal, capability: 'read_owner_truth' });
            expect(result).toEqual({
                decision: 'allow',
                matchedPolicyId: '__no_policy',
                matchedPolicyName: 'No Policy Configured',
                capability: 'read_owner_truth',
                reason: 'No policies configured — default permissive.',
                principalId: 'reader-1',
                trustZone: 'internal',
                requiresApproval: false,
                explanation: 'No policies configured. All actions are permitted by default.',
            });
            // An explicit trust zone in the request wins over the principal's own.
            expect(sdk.policyExplain({ principal, capability: 'read_owner_truth', trustZone: 'external' }).trustZone).toBe('external');
        });

        it('with policies, evaluates the request without executing it', () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const sdk = new ClusterSDK({
                clusterDir: dir,
                policies: DEFAULT_POLICIES,
                trustZones: DEFAULT_TRUST_ZONES,
                principal: ClusterSDK.INTERNAL_TRUSTED_PRINCIPAL,
            });
            const result = sdk.policyExplain({
                principal: ClusterSDK.INTERNAL_TRUSTED_PRINCIPAL,
                capability: 'read_owner_truth',
                ownerStore: 'canonical',
            });
            expect(['allow', 'deny']).toContain(result.decision);
            expect(result.matchedPolicyId).not.toBe('__no_policy');
            expect(result.principalId).toBe(ClusterSDK.INTERNAL_TRUSTED_PRINCIPAL.id);
            expect(result.explanation.length).toBeGreaterThan(0);
        });
    });
});
