/**
 * Wave V5 — S-1 regression: `ResolvedEvidence.snippet` must be redacted WITH content.
 *
 * The finding (composed-system security re-audit, S-1, I3, feature-introduced
 * V1/RETR-004): `snippet` is a ≤240-char window of raw artifact CONTENT that
 * rides the `ResolvedEvidence` WRAPPER, outside `redactArtifact`'s reach (which
 * only touches `.object`). On `PolicyEnforcedKernel.retrieveBundle` (per-object
 * loop + bundle-level map) and through the public `ClusterSDK.retrieveBundle`,
 * the `{ ...ra, object }` spreads carried `snippet` untouched — so under an
 * `ai-facing` / `external` zone (`artifact_content: strip`) the artifact OBJECT
 * was content-stripped while the snippet leaked the same content.
 *
 * Invariant pinned here: `snippet` is present IFF the caller is allowed artifact
 * content. When the matched redaction rules carry an `artifact_content` rule
 * (strip/mask/summarize/hash) the snippet is ABSENT; when no content rule
 * applies (content allowed) the snippet SURVIVES unchanged (V1's feature must
 * not be over-stripped).
 *
 * Test-first: the two strip tests FAIL at HEAD `15d6538` (snippet present) and
 * PASS after the kernel-source fix. The no-over-strip tests guard the feature.
 * Existing snippet coverage (`wave-v1-retrieval-regression.test.ts`) only
 * exercises the RAW kernel path and asserts snippet PRESENCE — this is the
 * missing policed-path coverage on both surfaces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCluster } from '../src/adapters/local/index.js';
import { ClusterKernel } from '../src/kernel/cluster-kernel.js';
import { PolicyEnforcedKernel } from '../src/kernel/policy-enforced-kernel.js';
import { ClusterSDK } from '../src/sdk/cluster-sdk.js';
import type { Policy, Principal, TrustZone } from '../src/types/policy.js';
import type { ClusterStores } from '../src/contracts/index.js';

// A distinctive content marker that lives ONLY in the artifact body (never in
// the index text `${filename} [${mimeType}]`), so finding it in the returned
// wrapper proves a raw-content excerpt rode through.
const CONTENT_MARKER = 'RAW_CONTENT_LEAK_MARKER_S1';
const ARTIFACT_CONTENT = `# Sensitive Doc\n\n${CONTENT_MARKER} must never ride the snippet past a content-strip policy.`;

// Allowed to resolve artifacts, but sits in the content-stripping `ai-facing`
// zone → object content stripped; snippet MUST be dropped too.
const aiReader: Principal = {
    id: 'ai-reader-1',
    name: 'AI Reader',
    roles: ['ai-reader'],
    trustZone: 'ai-facing',
};
// Sits in the `internal` zone (no content rule) → content allowed; snippet MUST
// survive (don't over-strip V1's feature).
const trustedReader: Principal = {
    id: 'trusted-1',
    name: 'Trusted Reader',
    roles: ['trusted'],
    trustZone: 'internal',
};

const policies: Policy[] = [
    {
        id: 'ai-reader-read',
        name: 'AI Reader Read',
        priority: 10,
        match: {
            principals: ['ai-reader'],
            capabilities: ['read_derivative', 'read_owner_truth', 'discover_existence'],
        },
        decision: 'allow',
        reason: 'AI reader resolves artifacts; the ai-facing zone strips content.',
    },
    {
        id: 'trusted-read',
        name: 'Trusted Read',
        priority: 10,
        match: { principals: ['trusted'] },
        decision: 'allow',
        reason: 'Trusted reader gets full content.',
    },
];

const trustZones: TrustZone[] = [
    {
        id: 'ai-facing',
        name: 'AI-Facing',
        defaultCapabilities: [],
        defaultScope: { stores: ['*'] },
        approvalMode: 'require_approval_for_writes',
        // The load-bearing rule: this is the exact production posture
        // (DEFAULT_TRUST_ZONES `ai-facing`) the re-audit flagged.
        redactionRules: [
            {
                id: 'ai-strip-artifact-content',
                target: 'artifact_content',
                behavior: 'strip',
                reason: 'AI-facing zone does not receive raw artifact content.',
            },
        ],
        visibilityRules: [],
    },
    {
        id: 'internal',
        name: 'Internal',
        defaultCapabilities: [],
        defaultScope: { stores: ['*'] },
        approvalMode: 'auto',
        redactionRules: [],
        visibilityRules: [],
    },
];

/**
 * Seed one text artifact into `dir` via the RAW kernel (auto-indexed by
 * filename). Querying a filename term ('sensitive') resolves the candidate;
 * the snippet is then drawn from CONTENT — so a snippet carrying CONTENT_MARKER
 * proves the raw-content excerpt is present.
 */
async function seedArtifact(stores: ClusterStores, dir: string): Promise<void> {
    const kernel = new ClusterKernel(stores, { dataDir: dir });
    await kernel.ingestArtifact({
        filename: 'sensitive-doc.md',
        content: Buffer.from(ARTIFACT_CONTENT),
        mimeType: 'text/markdown',
        actorId: 'seed',
    });
}

describe('Wave V5 — S-1: snippet redacted with artifact content on policed retrieveBundle', () => {
    let dir: string;
    let stores: ClusterStores;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'db-cluster-v5-snippet-'));
        stores = createLocalCluster(dir);
        await seedArtifact(stores, dir);
    });
    afterEach(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('PolicyEnforcedKernel.retrieveBundle DROPS snippet under ai-facing content-strip (S-1)', async () => {
        const pk = new PolicyEnforcedKernel(stores, { principal: aiReader }, { policies, trustZones, dataDir: dir });
        const bundle = await pk.retrieveBundle('sensitive');

        expect(bundle.resolvedArtifacts.length).toBeGreaterThan(0);
        const art = bundle.resolvedArtifacts[0];
        // object content IS stripped (storagePath redacted) — proves the strip rule fired.
        expect(art.object.storagePath).toBe('[REDACTED]');
        // THE FIX: the snippet (raw content) must be absent when content is stripped.
        expect(art.snippet).toBeUndefined();
        // Family probe: NO field of the wrapper carries the content marker.
        expect(JSON.stringify(art)).not.toContain(CONTENT_MARKER);
    });

    it('ClusterSDK.retrieveBundle DROPS snippet under ai-facing content-strip (S-1, public surface)', async () => {
        const sdk = new ClusterSDK({ clusterDir: dir, policies, trustZones, principal: aiReader });
        const bundle = await sdk.retrieveBundle('sensitive');

        expect(bundle.resolvedArtifacts.length).toBeGreaterThan(0);
        const art = bundle.resolvedArtifacts[0];
        expect(art.snippet).toBeUndefined();
        expect(JSON.stringify(art)).not.toContain(CONTENT_MARKER);
    });

    it('does NOT over-strip: snippet survives under a content-ALLOWED (internal) policy — kernel', async () => {
        const pk = new PolicyEnforcedKernel(stores, { principal: trustedReader }, { policies, trustZones, dataDir: dir });
        const bundle = await pk.retrieveBundle('sensitive');

        expect(bundle.resolvedArtifacts.length).toBeGreaterThan(0);
        const art = bundle.resolvedArtifacts[0];
        // Content allowed → snippet present and carries the content excerpt (V1 feature intact).
        expect(art.snippet).toBeDefined();
        expect(art.snippet).toContain(CONTENT_MARKER);
        // object content NOT stripped.
        expect(art.object.storagePath).not.toBe('[REDACTED]');
    });

    it('does NOT over-strip: snippet survives under a content-ALLOWED (internal) policy — SDK', async () => {
        const sdk = new ClusterSDK({ clusterDir: dir, policies, trustZones, principal: trustedReader });
        const bundle = await sdk.retrieveBundle('sensitive');

        expect(bundle.resolvedArtifacts.length).toBeGreaterThan(0);
        const art = bundle.resolvedArtifacts[0];
        expect(art.snippet).toBeDefined();
        expect(art.snippet).toContain(CONTENT_MARKER);
    });
});
