// FIXTURE (R9 — should NOT match): the sanctioned post-REDACT-001 shape.
// Both artifact-bearing reads route resolvedArtifacts through
// sanitizeArtifactForOutput before returning. Scanned only by the R9
// meta-test.

interface FindSourcesResult {
    resolvedArtifacts: unknown[];
}
interface EvidenceBundle {
    resolvedArtifacts: unknown[];
}

declare class FakeKernel {
    findSources(input: { query: string }): Promise<FindSourcesResult>;
    retrieveBundle(query: string): Promise<EvidenceBundle>;
}

declare function sanitizeArtifactForOutput(a: unknown): unknown;

export class GoodSdk {
    private kernel!: FakeKernel;

    // GOOD: resolvedArtifacts sanitized inline before leaving the SDK.
    async findSources(query: string): Promise<FindSourcesResult> {
        const result = await this.kernel.findSources({ query });
        return {
            ...result,
            resolvedArtifacts: result.resolvedArtifacts.map((a) => sanitizeArtifactForOutput(a)),
        };
    }

    // GOOD: bundle's resolvedArtifacts sanitized before return.
    async retrieveBundle(query: string): Promise<EvidenceBundle> {
        const bundle = await this.kernel.retrieveBundle(query);
        return {
            ...bundle,
            resolvedArtifacts: bundle.resolvedArtifacts.map((a) => sanitizeArtifactForOutput(a)),
        };
    }
}
