/**
 * Coverage — doctor()'s policy_defaults check when the default policy module
 * cannot be loaded, or loads empty. The module is replaced with vi.doMock and
 * doctor is imported fresh so its dynamic import sees the replacement.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';

describe('doctor() policy_defaults check', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cov-doctor-policy-'));
        vi.resetModules();
    });
    afterEach(() => {
        vi.doUnmock('../src/policy/default-policies.js');
        vi.resetModules();
        rmSync(dir, { recursive: true, force: true });
    });

    it('reports a corrupt policy_defaults check with remediation when the default policies fail to load', async () => {
        vi.doMock('../src/policy/default-policies.js', () => {
            throw new Error('default policy table is malformed');
        });
        const { doctor } = await import('../src/ops/doctor.js');
        const health = await doctor(createLocalCluster(dir));
        const policy = health.checks.find((c) => c.name === 'policy_defaults');
        expect(policy).toMatchObject({ store: 'policy', status: 'corrupt', severity: 'error', repairAvailable: false });
        expect(policy?.message).toContain('Failed to load policy defaults:');
        expect(policy?.nextSteps?.[0]).toContain('policies.json');
        expect(health.status).toBe('corrupt');
    });

    it('emits no policy_defaults check at all when the default policy list is empty', async () => {
        vi.doMock('../src/policy/default-policies.js', () => ({ DEFAULT_POLICIES: [] }));
        const { doctor } = await import('../src/ops/doctor.js');
        const health = await doctor(createLocalCluster(dir));
        expect(health.checks.map((c) => c.name)).not.toContain('policy_defaults');
        expect(health.status).toBe('healthy');
    });
});
