/**
 * db-cluster — public API surface.
 *
 * PUBLIC (exported here):
 *   - ClusterKernel + input/result types
 *   - Store contracts (interfaces)
 *   - Domain types (Entity, Artifact, IndexRecord, ProvenanceEvent, Command, Receipt)
 *   - Store factory (createCluster, createClusterFromEnv, createLocalCluster)
 *   - Ops (doctor, verify, backup, restore)
 *   - URI utilities
 *
 * SUBPATH EXPORTS (import from 'db-cluster/sdk', 'db-cluster/mcp', etc.):
 *   - db-cluster/sdk — ClusterSDK high-level client
 *   - db-cluster/mcp — MCP server tools + handler
 *   - db-cluster/policy — PolicyEnforcedKernel + redaction
 *   - db-cluster/types — all type re-exports
 *
 * NOT PUBLIC (internal, not exported):
 *   - Raw adapter implementations (local stores, postgres store)
 *   - Test helpers
 *   - Dashboard demo internals
 *   - Integration harnesses (repo-knowledge adapter)
 *   - Dogfood/phase scripts
 *   - Kernel internals (provenance recording, command queue)
 */

// --- Domain types ---
export type { Entity } from './types/entity.js';
export type { Artifact } from './types/artifact.js';
export type { IndexRecord } from './types/index-record.js';
export type { ProvenanceEvent } from './types/provenance-event.js';
export type { Command, CommandVerb, CommandStatus } from './types/command.js';
export type { Receipt } from './types/receipt.js';
export type { ClusterHealth, HealthCheck } from './types/health.js';
export type { EvidenceBundle } from './types/evidence-bundle.js';

// --- Store contracts ---
export type {
    CanonicalStore,
    ArtifactStore,
    IndexStore,
    LedgerStore,
    ClusterStores,
} from './contracts/index.js';

// --- Kernel ---
export { ClusterKernel } from './kernel/cluster-kernel.js';
export type {
    KernelOptions,
    IngestArtifactInput,
    CreateEntityInput,
    LinkEvidenceInput,
    FindSourcesInput,
    FindSourcesResult,
    ProposeMutationInput,
    CommitMutationResult,
} from './kernel/cluster-kernel.js';

// --- Store factory ---
export { createCluster, createClusterFromEnv } from './adapters/factory.js';
export type { ClusterConfig, ClusterWithPool } from './adapters/factory.js';
export { createLocalCluster } from './adapters/local/index.js';

// --- Ops ---
export { doctor } from './ops/doctor.js';
export { verify } from './ops/verify.js';
export { backup, restore } from './ops/backup.js';
export type { DoctorOptions } from './ops/doctor.js';
export type { VerifyOptions } from './ops/verify.js';
export type { BackupOptions, RestoreOptions, ClusterBackup, RestoreResult } from './ops/backup.js';

// --- URI ---
export { parseClusterUri, formatClusterUri, isClusterUri, uriForObject, ClusterUriError } from './uri/index.js';
export type { ClusterUri, ClusterStore } from './uri/index.js';
