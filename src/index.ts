/**
 * db-cluster — public API surface.
 *
 * PUBLIC (exported here):
 *   - Store contracts (interfaces)
 *   - Domain types (Entity, Artifact, IndexRecord, ProvenanceEvent, Command, Receipt)
 *   - Store factory (createCluster, createClusterFromEnv, createLocalCluster)
 *   - Ops (doctor, verify, backup, restore)
 *   - URI utilities
 *
 * SUBPATH EXPORTS (import from 'db-cluster/sdk', 'db-cluster/mcp', etc.):
 *   - db-cluster/sdk — ClusterSDK high-level client (recommended for application code)
 *   - db-cluster/mcp — MCP server tools + handler
 *   - db-cluster/policy — PolicyEnforcedKernel + redaction (use this for in-process callers
 *                          who need direct kernel access — DO NOT bypass with raw ClusterKernel)
 *   - db-cluster/types — all type re-exports
 *
 * NOT PUBLIC (internal, not exported):
 *   - Raw `ClusterKernel` class (KERNEL-013): exporting this publicly bypassed
 *     PolicyEnforcedKernel entirely. The only legitimate ways to drive the
 *     kernel are now via ClusterSDK (db-cluster/sdk) or PolicyEnforcedKernel
 *     (db-cluster/policy). Tests / dogfood scripts that still need the raw
 *     class import it from the internal-only `./kernel/cluster-kernel.js`
 *     path inside this package.
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

// --- Kernel-shaped public types (no class; use SDK or PolicyEnforcedKernel) ---
// The `ClusterKernel` class is intentionally NOT exported here (KERNEL-013).
// Input/result types remain public so callers can satisfy the SDK signature.
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
