import { ClusterKernel } from '../kernel/cluster-kernel.js';
import { ClusterResolver } from '../resolver/index.js';
import { createLocalCluster } from '../adapters/local/index.js';
import type { EvidenceBundle } from '../types/evidence-bundle.js';
import type { ProvenanceGraph, TraceOptions } from '../types/provenance-graph.js';
import type { Command } from '../types/command.js';
import type { Receipt } from '../types/receipt.js';
import type { FindSourcesResult } from '../kernel/cluster-kernel.js';

export interface SDKOptions {
    clusterDir: string;
}

/**
 * ClusterSDK — the programmatic API for db-cluster.
 *
 * Exposes cluster verbs, not store internals.
 * SDK cannot bypass validation, approval, or command lifecycle.
 * Every operation goes through the kernel.
 */
export class ClusterSDK {
    private readonly kernel: ClusterKernel;
    private readonly resolver: ClusterResolver;

    constructor(options: SDKOptions) {
        const stores = createLocalCluster(options.clusterDir);
        this.kernel = new ClusterKernel(stores, { dataDir: options.clusterDir });
        this.resolver = new ClusterResolver(stores);
    }

    // ─── Retrieval ─────────────────────────────────────────────────

    async findSources(query: string, limit?: number): Promise<FindSourcesResult> {
        return this.kernel.findSources({ query, limit });
    }

    async retrieveBundle(query: string, options?: { limit?: number }): Promise<EvidenceBundle> {
        return this.kernel.retrieveBundle(query, options);
    }

    async explainRetrieval(bundle: EvidenceBundle): Promise<{ summary: string; resolvedCount: number; missingCount: number; allFresh: boolean }> {
        const explanation = await this.kernel.explainRetrieval(bundle);
        return {
            summary: explanation.summary,
            resolvedCount: explanation.resolvedCount,
            missingCount: explanation.missingCount,
            allFresh: explanation.allFresh,
        };
    }

    // ─── Resolution ────────────────────────────────────────────────

    async resolve(uri: string): Promise<{ store: string; object: unknown }> {
        const resolved = await this.resolver.resolve(uri);
        return { store: resolved.store, object: resolved.object };
    }

    // ─── Provenance ────────────────────────────────────────────────

    async traceObject(uri: string, options?: Partial<TraceOptions>): Promise<ProvenanceGraph> {
        return this.kernel.traceObject(uri, options);
    }

    async why(uri: string): Promise<string> {
        return this.kernel.why(uri);
    }

    // ─── Command lifecycle ─────────────────────────────────────────

    async proposeMutation(input: {
        verb: Command['verb'];
        targetStore: Command['targetStore'];
        payload: Record<string, unknown>;
        proposedBy: string;
    }): Promise<Command> {
        return this.kernel.proposeMutation(input);
    }

    async validateMutation(commandId: string): Promise<Command> {
        return this.kernel.validateMutation(commandId);
    }

    async approveMutation(commandId: string, approvedBy: string, note?: string): Promise<Command> {
        return this.kernel.approveMutation(commandId, approvedBy, note);
    }

    async rejectMutation(commandId: string, rejectedBy: string, reason: string): Promise<Command> {
        return this.kernel.rejectMutation(commandId, rejectedBy, reason);
    }

    async commitMutation(commandId: string, actorId: string): Promise<{ command: Command; receipt: Receipt }> {
        return this.kernel.commitMutation(commandId, actorId);
    }

    async compensateMutation(commandId: string, compensatedBy: string, reason: string): Promise<{ compensatingCommand: Command; originalCommand: Command; receipt: Receipt }> {
        return this.kernel.compensateMutation(commandId, compensatedBy, reason);
    }

    async inspectCommand(commandId: string): Promise<Command> {
        return this.kernel.inspectCommand(commandId);
    }

    async listReceipts(filter?: { commandId?: string; since?: string; limit?: number }): Promise<Receipt[]> {
        return this.kernel.listReceipts(filter);
    }
}
