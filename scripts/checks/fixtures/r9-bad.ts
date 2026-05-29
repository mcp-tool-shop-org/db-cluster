// FIXTURE (R9 — should MATCH): SDK-shaped read methods that forward an
// artifact-bearing kernel result WITHOUT sanitizeArtifactForOutput — the
// REDACT-001 leak shape. Scanned only by the R9 meta-test (with the rule's
// path-scope stripped so this out-of-src fixture is reachable).

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

export class BadSdk {
    private kernel!: FakeKernel;

    // BAD: pure pass-through — raw Artifact[] leaves the SDK boundary.
    async findSources(query: string): Promise<FindSourcesResult> {
        return this.kernel.findSources({ query });
    }

    // BAD: forwards the bundle (carrying resolvedArtifacts) un-sanitized.
    async retrieveBundle(query: string): Promise<EvidenceBundle> {
        const bundle = await this.kernel.retrieveBundle(query);
        return bundle;
    }
}
