/**
 * Demo data — shaped DashboardObject instances for offline rendering.
 *
 * This file mirrors the DashboardObject contract from src/dashboard/dashboard-model.ts
 * and provides representative objects for every inspectable state.
 */

// eslint-disable-next-line no-unused-vars
const DEMO_OBJECTS = {
    'cluster://canonical/entity/ent-project-01': {
        uri: 'cluster://canonical/entity/ent-project-01',
        id: 'ent-project-01',
        type: 'entity',
        name: 'db-cluster',
        ownerStore: 'canonical',
        sourceType: 'owner-truth',
        freshness: 'fresh',
        object: {
            id: 'ent-project-01',
            kind: 'project',
            name: 'db-cluster',
            attributes: { phase: 12, status: 'complete', description: 'Data control plane for AI applications' },
            createdAt: '2026-05-20T10:00:00Z',
            updatedAt: '2026-05-27T16:00:00Z',
        },
        relationships: [
            { uri: 'cluster://artifact/source/art-readme-01', edge: 'evidence', targetStore: 'artifact', targetType: 'artifact' },
            { uri: 'cluster://index/record/idx-project-01', edge: 'indexed-by', targetStore: 'index', targetType: 'index_record' },
        ],
        provenanceGraph: {
            nodes: [
                { id: 'ent-project-01', uri: 'cluster://canonical/entity/ent-project-01', store: 'canonical', label: 'db-cluster' },
                { id: 'art-readme-01', uri: 'cluster://artifact/source/art-readme-01', store: 'artifact', label: 'README.md' },
                { id: 'idx-project-01', uri: 'cluster://index/record/idx-project-01', store: 'index', label: 'index/project' },
            ],
            edges: [
                { from: 'art-readme-01', to: 'ent-project-01', type: 'evidence' },
                { from: 'ent-project-01', to: 'idx-project-01', type: 'projected_into' },
            ],
            warnings: [],
        },
        receipts: [
            { id: 'rcp-01', commandId: 'cmd-01', verb: 'create_entity', summary: 'created project/db-cluster', committedAt: '2026-05-20T10:00:00Z' },
            { id: 'rcp-04', commandId: 'cmd-04', verb: 'update_entity', summary: 'set phase=12, status=complete', committedAt: '2026-05-27T16:00:00Z' },
        ],
        commandState: null,
        policyDecision: null,
        warnings: [],
    },

    'cluster://artifact/source/art-readme-01': {
        uri: 'cluster://artifact/source/art-readme-01',
        id: 'art-readme-01',
        type: 'artifact',
        name: 'README.md',
        ownerStore: 'artifact',
        sourceType: 'source-truth',
        freshness: 'fresh',
        object: {
            id: 'art-readme-01',
            filename: 'README.md',
            contentHash: 'sha256:7f3a9b…c4d2',
            mimeType: 'text/markdown',
            sizeBytes: 3842,
            version: 1,
            ingestedAt: '2026-05-20T09:58:00Z',
        },
        relationships: [
            { uri: 'cluster://canonical/entity/ent-project-01', edge: 'linked-to', targetStore: 'canonical', targetType: 'entity' },
            { uri: 'cluster://index/record/idx-readme-01', edge: 'indexed-by', targetStore: 'index', targetType: 'index_record' },
        ],
        provenanceGraph: {
            nodes: [
                { id: 'art-readme-01', uri: 'cluster://artifact/source/art-readme-01', store: 'artifact', label: 'README.md' },
                { id: 'ent-project-01', uri: 'cluster://canonical/entity/ent-project-01', store: 'canonical', label: 'db-cluster' },
            ],
            edges: [
                { from: 'art-readme-01', to: 'ent-project-01', type: 'evidence' },
            ],
            warnings: [],
        },
        receipts: [
            { id: 'rcp-00', commandId: 'cmd-00', verb: 'ingest_artifact', summary: 'ingested README.md · 3,842 bytes', committedAt: '2026-05-20T09:58:00Z' },
        ],
        commandState: null,
        policyDecision: null,
        warnings: [],
    },

    'cluster://index/record/idx-project-01': {
        uri: 'cluster://index/record/idx-project-01',
        id: 'idx-project-01',
        type: 'index_record',
        name: 'index/project',
        ownerStore: 'index',
        sourceType: 'derivative',
        freshness: 'fresh',
        object: {
            id: 'idx-project-01',
            sourceStore: 'canonical',
            sourceId: 'ent-project-01',
            text: 'db-cluster · project · data control plane · phase 12',
            stale: false,
            sourceExists: true,
        },
        relationships: [
            { uri: 'cluster://canonical/entity/ent-project-01', edge: 'projects', targetStore: 'canonical', targetType: 'entity' },
        ],
        provenanceGraph: {
            nodes: [
                { id: 'idx-project-01', uri: 'cluster://index/record/idx-project-01', store: 'index', label: 'index/project' },
                { id: 'ent-project-01', uri: 'cluster://canonical/entity/ent-project-01', store: 'canonical', label: 'db-cluster' },
            ],
            edges: [
                { from: 'idx-project-01', to: 'ent-project-01', type: 'derived_from' },
            ],
            warnings: [],
        },
        receipts: [],
        commandState: null,
        policyDecision: null,
        warnings: [],
    },

    'cluster://ledger/command/cmd-04': {
        uri: 'cluster://ledger/command/cmd-04',
        id: 'cmd-04',
        type: 'command',
        name: 'update_entity (committed)',
        ownerStore: 'ledger',
        sourceType: 'append-only',
        freshness: 'fresh',
        object: {
            id: 'cmd-04',
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: 'ent-project-01', patch: { attributes: { phase: 12, status: 'complete' } } },
            status: 'committed',
            proposedBy: 'agent:claude',
            proposedAt: '2026-05-27T15:55:00Z',
            committedAt: '2026-05-27T16:00:00Z',
        },
        relationships: [],
        provenanceGraph: { nodes: [], edges: [], warnings: [] },
        receipts: [
            { id: 'rcp-04', commandId: 'cmd-04', verb: 'update_entity', summary: 'set phase=12, status=complete', committedAt: '2026-05-27T16:00:00Z' },
        ],
        commandState: {
            id: 'cmd-04',
            verb: 'update_entity',
            status: 'committed',
            proposedBy: 'agent:claude',
            proposedAt: '2026-05-27T15:55:00Z',
            payload: { entityId: 'ent-project-01', patch: { attributes: { phase: 12, status: 'complete' } } },
            validatedAt: '2026-05-27T15:56:00Z',
            approvedBy: 'operator',
            committedAt: '2026-05-27T16:00:00Z',
        },
        policyDecision: null,
        warnings: [],
    },

    'cluster://ledger/command/cmd-rejected': {
        uri: 'cluster://ledger/command/cmd-rejected',
        id: 'cmd-rejected',
        type: 'command',
        name: 'update_entity (rejected)',
        ownerStore: 'ledger',
        sourceType: 'append-only',
        freshness: 'fresh',
        object: {
            id: 'cmd-rejected',
            verb: 'update_entity',
            targetStore: 'canonical',
            payload: { entityId: 'ent-project-01', patch: { name: 'renamed-without-permission' } },
            status: 'rejected',
            proposedBy: 'agent:claude',
            proposedAt: '2026-05-26T12:00:00Z',
            rejectedBy: 'operator',
            rejectionReason: 'Name changes require explicit approval',
        },
        relationships: [],
        provenanceGraph: { nodes: [], edges: [], warnings: [] },
        receipts: [],
        commandState: {
            id: 'cmd-rejected',
            verb: 'update_entity',
            status: 'rejected',
            proposedBy: 'agent:claude',
            proposedAt: '2026-05-26T12:00:00Z',
            payload: { entityId: 'ent-project-01', patch: { name: 'renamed-without-permission' } },
            validatedAt: '2026-05-26T12:01:00Z',
            rejectedBy: 'operator',
            rejectionReason: 'Name changes require explicit approval',
        },
        policyDecision: null,
        warnings: [{ type: 'rejected_command', severity: 'warn', message: 'Name changes require explicit approval' }],
    },

    'cluster://index/record/idx-stale-01': {
        uri: 'cluster://index/record/idx-stale-01',
        id: 'idx-stale-01',
        type: 'index_record',
        name: 'index/stale-finding',
        ownerStore: 'index',
        sourceType: 'derivative',
        freshness: 'stale',
        object: {
            id: 'idx-stale-01',
            sourceStore: 'canonical',
            sourceId: 'ent-finding-01',
            text: 'restore gap · old text',
            stale: true,
            sourceExists: true,
        },
        relationships: [
            { uri: 'cluster://canonical/entity/ent-finding-01', edge: 'projects', targetStore: 'canonical', targetType: 'entity' },
        ],
        provenanceGraph: {
            nodes: [
                { id: 'idx-stale-01', uri: 'cluster://index/record/idx-stale-01', store: 'index', label: 'stale-finding' },
                { id: 'ent-finding-01', uri: 'cluster://canonical/entity/ent-finding-01', store: 'canonical', label: 'finding' },
            ],
            edges: [
                { from: 'idx-stale-01', to: 'ent-finding-01', type: 'stale_projection_of', isWarning: true },
            ],
            warnings: [{ type: 'stale_index', message: 'Index text does not match current canonical name', subjectUri: 'cluster://index/record/idx-stale-01' }],
        },
        receipts: [],
        commandState: null,
        policyDecision: null,
        warnings: [
            { type: 'stale_index', severity: 'warn', message: 'Index text does not match current canonical name', subjectUri: 'cluster://index/record/idx-stale-01', repairSuggestion: 'Run `db-cluster reindex`' },
        ],
    },
};

// Policy-redacted view example
const POLICY_VIEWS = {
    operator: {
        principal: 'operator',
        trustZone: 'internal',
        visible: ['canonical', 'artifact', 'index', 'ledger'],
        redacted: [],
    },
    agent: {
        principal: 'agent:claude',
        trustZone: 'internal',
        visible: ['canonical', 'index', 'ledger'],
        redacted: ['artifact.content'],
    },
    observer: {
        principal: 'observer',
        trustZone: 'external-read',
        visible: ['index', 'ledger'],
        redacted: ['canonical.attributes', 'artifact.content', 'artifact.storagePath'],
    },
    external: {
        principal: 'external-api',
        trustZone: 'external',
        visible: ['index'],
        redacted: ['canonical.*', 'artifact.*', 'ledger.receipts'],
    },
};

// Operations health example
const OPERATIONS_STATUS = {
    doctor: {
        overall: 'healthy',
        checks: [
            { name: 'canonical_reachable', status: 'healthy', store: 'canonical' },
            { name: 'artifact_reachable', status: 'healthy', store: 'artifact' },
            { name: 'index_reachable', status: 'healthy', store: 'index' },
            { name: 'ledger_reachable', status: 'healthy', store: 'ledger' },
        ],
    },
    indexHealth: { total: 22, fresh: 21, stale: 1, missing: 0 },
    provenanceHealth: { events: 45, receipts: 12, orphanEvents: 0 },
    artifactIntegrity: { total: 12, verified: 12, corrupt: 0 },
    backup: { lastBackup: '2026-05-27T12:00:00Z', artifactContent: true },
};

// Expose for component consumption
window.DEMO_OBJECTS = DEMO_OBJECTS;
window.POLICY_VIEWS = POLICY_VIEWS;
window.OPERATIONS_STATUS = OPERATIONS_STATUS;
